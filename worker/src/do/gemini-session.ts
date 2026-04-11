/**
 * GeminiSessionDO — Durable Object that proxies a Gemini Live WebSocket session.
 *
 * Responsibilities:
 *   1. Accept an incoming WebSocket from the Swift app
 *   2. Verify the session_token (HS256 JWT, 5 min TTL) against env.JWT_SIGNING_SECRET
 *   3. Open an outbound WebSocket to Gemini Live with env.GEMINI_API_KEY
 *   4. Relay frames bidirectionally
 *   5. Count audio tokens on the fly (25 tokens/sec) and flush to Supabase every 30s
 *   6. If credits run out mid-session, send a blocked frame and close both sockets
 *   7. On disconnect, finalize the session row in Supabase
 *
 * Security invariant: the Gemini API key NEVER leaves this DO. The client only
 * sees the proxied frames, which are indistinguishable from the original Gemini
 * Live protocol.
 */

import { DurableObject } from "cloudflare:workers";
import { SupabaseClient } from "../db/supabase";
import { verifyJWT } from "../auth/jwt";
import { audioBytesToTokens, tokensToCredits, tokensToUSDCost } from "../lib/credit-accounting";
import type { Env, SessionTokenPayload } from "../types";

interface RunningTotals {
  audioInputTokens: number;
  audioOutputTokens: number;
  textInputTokens: number;
  textOutputTokens: number;
}

export class GeminiSessionDO extends DurableObject<Env> {
  private clientWebSocket: WebSocket | null = null;
  private upstreamWebSocket: WebSocket | null = null;
  private sessionPayload: SessionTokenPayload | null = null;
  private runningTotals: RunningTotals = {
    audioInputTokens: 0,
    audioOutputTokens: 0,
    textInputTokens: 0,
    textOutputTokens: 0,
  };
  private lastFlushedTotals: RunningTotals = {
    audioInputTokens: 0,
    audioOutputTokens: 0,
    textInputTokens: 0,
    textOutputTokens: 0,
  };
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;
  private sessionFinalized = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const sessionToken = url.searchParams.get("session_token");
    if (!sessionToken) {
      return new Response("Missing session_token", { status: 401 });
    }

    const payload = await verifyJWT<SessionTokenPayload>(sessionToken, this.env.JWT_SIGNING_SECRET);
    if (!payload) {
      return new Response("Invalid or expired session token", { status: 401 });
    }
    this.sessionPayload = payload;

    // Create the client-facing WebSocket pair
    const clientPair = new WebSocketPair();
    const [clientSideWebSocket, serverSideWebSocket] = Object.values(clientPair);

    // Accept the server side so we can send/receive on it
    (serverSideWebSocket as WebSocket).accept();
    this.clientWebSocket = serverSideWebSocket as WebSocket;

    // Open the upstream WS to Gemini Live
    try {
      await this.openUpstreamWebSocket();
    } catch (error) {
      console.error("[GeminiSessionDO] failed to open upstream", error);
      this.sendBlockedFrame("upstream_error", "Could not reach Gemini Live upstream");
      (this.clientWebSocket as WebSocket).close(1011, "upstream_error");
      return new Response(null, { status: 101, webSocket: clientSideWebSocket });
    }

    // Start the credit flush interval (every 30 seconds)
    this.flushIntervalId = setInterval(() => this.flushAccountingToSupabase().catch(console.error), 30_000);

    // Wire up event handlers
    this.wireClientHandlers();
    this.wireUpstreamHandlers();

    return new Response(null, { status: 101, webSocket: clientSideWebSocket });
  }

  private async openUpstreamWebSocket(): Promise<void> {
    const geminiKey = this.env.GEMINI_API_KEY;
    const upstreamURL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${geminiKey}`;

    // Cloudflare Workers support opening outbound WebSockets via fetch() with Upgrade.
    const response = await fetch(upstreamURL, {
      headers: {
        Upgrade: "websocket",
        "x-goog-api-key": geminiKey,
      },
    });

    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Upstream handshake failed: ${response.status}`);
    }

    this.upstreamWebSocket = response.webSocket;
    this.upstreamWebSocket.accept();
  }

  private wireClientHandlers(): void {
    if (!this.clientWebSocket) return;
    const clientWs = this.clientWebSocket;
    const upstreamWs = this.upstreamWebSocket;

    clientWs.addEventListener("message", (event) => {
      const data = event.data;

      // Inspect the frame for audio tokens before relaying
      if (typeof data === "string") {
        this.accountClientFrame(data);
      }

      // Relay to upstream
      if (upstreamWs && upstreamWs.readyState === 1 /* OPEN */) {
        upstreamWs.send(data);
      }
    });

    clientWs.addEventListener("close", async (event) => {
      await this.handleClose(event.reason || "client_closed", "user_closed");
    });

    clientWs.addEventListener("error", async (error) => {
      console.error("[GeminiSessionDO] client ws error", error);
      await this.handleClose("client_error", "error");
    });
  }

  private wireUpstreamHandlers(): void {
    if (!this.upstreamWebSocket) return;
    const upstreamWs = this.upstreamWebSocket;
    const clientWs = this.clientWebSocket;

    upstreamWs.addEventListener("message", (event) => {
      const data = event.data;

      if (typeof data === "string") {
        this.accountUpstreamFrame(data);
      }

      if (clientWs && clientWs.readyState === 1) {
        clientWs.send(data);
      }
    });

    upstreamWs.addEventListener("close", async (event) => {
      await this.handleClose(event.reason || "upstream_closed", "upstream_closed");
    });

    upstreamWs.addEventListener("error", async (error) => {
      console.error("[GeminiSessionDO] upstream ws error", error);
      await this.handleClose("upstream_error", "error");
    });
  }

  /**
   * Inspect a frame from the client (Swift app → Gemini) and count the audio
   * tokens inside. The Swift app sends JSON of shape:
   *   { "realtimeInput": { "audio": { "mimeType": "audio/pcm;rate=16000", "data": "<base64>" } } }
   */
  private accountClientFrame(jsonString: string): void {
    try {
      const frame = JSON.parse(jsonString) as {
        realtimeInput?: { audio?: { mimeType?: string; data?: string } };
      };
      const audio = frame.realtimeInput?.audio;
      if (audio?.data) {
        // base64 bytes ≈ (length × 3/4)
        const approxByteCount = Math.floor((audio.data.length * 3) / 4);
        const sampleRate = audio.mimeType?.includes("24000") ? 24000 : 16000;
        const tokenCount = audioBytesToTokens(approxByteCount, sampleRate);
        this.runningTotals.audioInputTokens += tokenCount;
      }
    } catch {
      // Non-JSON frame (binary, keepalive, etc.) — ignore
    }
  }

  /**
   * Inspect a frame from upstream (Gemini → Swift app) and count audio + text.
   */
  private accountUpstreamFrame(jsonString: string): void {
    try {
      const frame = JSON.parse(jsonString) as {
        serverContent?: {
          modelTurn?: {
            parts?: Array<{
              inlineData?: { mimeType?: string; data?: string };
              text?: string;
            }>;
          };
        };
      };

      const parts = frame.serverContent?.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
          const approxByteCount = Math.floor((part.inlineData.data.length * 3) / 4);
          const sampleRate = part.inlineData.mimeType.includes("24000") ? 24000 : 16000;
          const tokenCount = audioBytesToTokens(approxByteCount, sampleRate);
          this.runningTotals.audioOutputTokens += tokenCount;
        }
        if (part.text) {
          // Rough estimate: 1 token per 4 chars (English text)
          this.runningTotals.textOutputTokens += Math.ceil(part.text.length / 4);
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Flush the accumulated token counts to Supabase. Called every 30 seconds
   * while the session is active, and one final time on close.
   */
  private async flushAccountingToSupabase(): Promise<void> {
    if (!this.sessionPayload || this.sessionFinalized) return;

    const deltaAudioIn = this.runningTotals.audioInputTokens - this.lastFlushedTotals.audioInputTokens;
    const deltaAudioOut = this.runningTotals.audioOutputTokens - this.lastFlushedTotals.audioOutputTokens;
    const deltaTextIn = this.runningTotals.textInputTokens - this.lastFlushedTotals.textInputTokens;
    const deltaTextOut = this.runningTotals.textOutputTokens - this.lastFlushedTotals.textOutputTokens;

    if (deltaAudioIn === 0 && deltaAudioOut === 0 && deltaTextIn === 0 && deltaTextOut === 0) {
      return;
    }

    const creditsDelta = tokensToCredits({
      audioInputTokens: deltaAudioIn,
      audioOutputTokens: deltaAudioOut,
      textInputTokens: deltaTextIn,
      textOutputTokens: deltaTextOut,
    });

    const costDelta = tokensToUSDCost({
      audioInputTokens: deltaAudioIn,
      audioOutputTokens: deltaAudioOut,
      textInputTokens: deltaTextIn,
      textOutputTokens: deltaTextOut,
    });

    const supabase = new SupabaseClient(this.env);

    // Update session with absolute running totals
    await supabase.updateSessionTokens(this.sessionPayload.session_id, {
      audio_input_tokens: this.runningTotals.audioInputTokens,
      audio_output_tokens: this.runningTotals.audioOutputTokens,
      text_input_tokens: this.runningTotals.textInputTokens,
      text_output_tokens: this.runningTotals.textOutputTokens,
      credits_consumed: tokensToCredits(this.runningTotals),
      estimated_cost_usd: tokensToUSDCost(this.runningTotals),
    });

    // Increment subscription + daily usage
    const newSubscriptionTotal = await supabase.incrementSubscriptionCredits(
      this.sessionPayload.subscription_id,
      creditsDelta,
    );
    const newDailyTotal = await supabase.incrementDailyUsage(this.sessionPayload.sub, creditsDelta);

    this.lastFlushedTotals = { ...this.runningTotals };

    // Check if the subscription is now over quota
    if (newSubscriptionTotal >= this.sessionPayload.monthly_allowance) {
      this.sendBlockedFrame("credits_exhausted", "Monthly credits exhausted");
      await this.handleClose("credits_exhausted", "credits_exhausted");
      return;
    }

    // Check trial daily cap
    if (
      this.sessionPayload.daily_cap !== undefined &&
      newDailyTotal >= this.sessionPayload.daily_cap
    ) {
      this.sendBlockedFrame("daily_cap_reached", "Daily trial cap reached");
      await this.handleClose("daily_cap_reached", "daily_cap");
      return;
    }
  }

  /**
   * Send a structured "blocked" frame to the client so the Swift app can
   * show a clean error message instead of just getting a socket close.
   */
  private sendBlockedFrame(reason: string, message: string): void {
    if (this.clientWebSocket && this.clientWebSocket.readyState === 1) {
      try {
        this.clientWebSocket.send(
          JSON.stringify({
            atayiServerEvent: {
              type: "blocked",
              reason,
              message,
            },
          }),
        );
      } catch {
        // ignore
      }
    }
  }

  private async handleClose(reason: string, terminationReason: string): Promise<void> {
    if (this.sessionFinalized) return;
    this.sessionFinalized = true;

    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }

    // Final flush
    try {
      await this.flushAccountingToSupabase();
    } catch (error) {
      console.error("[GeminiSessionDO] final flush failed", error);
    }

    // Mark session ended
    if (this.sessionPayload) {
      try {
        const supabase = new SupabaseClient(this.env);
        await supabase.finalizeSession(this.sessionPayload.session_id, terminationReason);
      } catch (error) {
        console.error("[GeminiSessionDO] finalize failed", error);
      }
    }

    // Close both sockets
    try {
      this.upstreamWebSocket?.close(1000, reason);
    } catch {
      /* ignore */
    }
    try {
      this.clientWebSocket?.close(1000, reason);
    } catch {
      /* ignore */
    }
  }
}
