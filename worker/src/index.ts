/**
 * Clicky Proxy Worker
 *
 * Vends the Gemini API key for the Gemini Live WebSocket session
 * so the app never ships with raw API keys. Key is stored as a
 * Cloudflare secret.
 *
 * Routes:
 *   POST /gemini-live-token  → Returns Gemini API key for Live WebSocket sessions
 */

interface Env {
  GEMINI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/gemini-live-token") {
        return await handleGeminiLiveToken(env);
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

/**
 * Returns the Gemini API key so the Swift client can open a Gemini Live
 * WebSocket directly. The key is stored as a Cloudflare secret and never
 * ships in the app binary.
 */
async function handleGeminiLiveToken(env: Env): Promise<Response> {
  return new Response(JSON.stringify({ key: env.GEMINI_API_KEY }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
