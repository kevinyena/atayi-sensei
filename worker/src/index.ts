/**
 * Atayi Sensei — Cloudflare Worker router.
 *
 * All API routes live under /api/*. The Landing page hits /api/landing/event
 * and /api/billing/checkout. The Swift app hits /api/license/*, /api/session/*.
 * The admin dashboard hits /api/admin/*.
 *
 * WebSocket proxy for Gemini Live is handled by a Durable Object (GeminiSessionDO)
 * routed by session_id, one DO instance per concurrent session.
 */

import { handleTrialSignup } from "./routes/trial";
import {
  handleSignup,
  handleVerifyOTP,
  handleGoogleAuth,
  handleLogin,
  handleResendOTP,
  handleAccountProfile,
} from "./routes/auth";
import { handleLicenseActivate, handleLicenseStatus } from "./routes/license";
import {
  handleCheckoutCreate,
  handleCheckoutSessionRetrieve,
  handleStripeWebhook,
} from "./routes/billing";
import { handleSessionPreflight } from "./routes/session";
import { handleLandingEvent, handleRefreshStats } from "./routes/landing";
import {
  handleAdminLogin,
  handleAdminGoogleLogin,
  handleAdminStats,
  handleAdminSignupStats,
  handleAdminUsers,
  handleAdminUserDetail,
  handleAdminBlockUser,
  handleAdminUnblockUser,
  handleAdminBlockDevice,
  handleAdminUnblockDevice,
  handleAdminPauseUser,
  handleAdminUnpauseUser,
  handleAdminDeleteUser,
} from "./routes/admin";
import {
  corsPreflightResponse,
  errorResponse,
  methodNotAllowedResponse,
  notFoundResponse,
} from "./lib/response";
import type { Env } from "./types";

export { GeminiSessionDO } from "./do/gemini-session";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight for any /api/* route
    if (method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return corsPreflightResponse();
    }

    try {
      // ========== Landing analytics (public) ==========
      if (url.pathname === "/api/landing/event" && method === "POST") {
        return await handleLandingEvent(request, env);
      }

      // ========== Auth ==========
      if (url.pathname === "/api/auth/trial-signup" && method === "POST") {
        return await handleTrialSignup(request, env);
      }
      if (url.pathname === "/api/auth/signup" && method === "POST") {
        return await handleSignup(request, env);
      }
      if (url.pathname === "/api/auth/verify-otp" && method === "POST") {
        return await handleVerifyOTP(request, env);
      }
      if (url.pathname === "/api/auth/google" && method === "POST") {
        return await handleGoogleAuth(request, env);
      }
      if (url.pathname === "/api/auth/login" && method === "POST") {
        return await handleLogin(request, env);
      }
      if (url.pathname === "/api/auth/resend-otp" && method === "POST") {
        return await handleResendOTP(request, env);
      }
      if (url.pathname === "/api/account/profile" && method === "GET") {
        return await handleAccountProfile(request, env);
      }

      // ========== License ==========
      if (url.pathname === "/api/license/activate" && method === "POST") {
        return await handleLicenseActivate(request, env);
      }
      if (url.pathname === "/api/license/status" && method === "GET") {
        return await handleLicenseStatus(request, env);
      }

      // ========== Billing ==========
      if (url.pathname === "/api/billing/checkout" && method === "POST") {
        return await handleCheckoutCreate(request, env);
      }
      if (url.pathname === "/api/billing/webhook" && method === "POST") {
        return await handleStripeWebhook(request, env);
      }
      const checkoutSessionMatch = url.pathname.match(/^\/api\/billing\/session\/([A-Za-z0-9_]+)$/);
      if (checkoutSessionMatch && method === "GET") {
        return await handleCheckoutSessionRetrieve(request, env, checkoutSessionMatch[1]);
      }

      // ========== Session ==========
      if (url.pathname === "/api/session/preflight" && method === "POST") {
        return await handleSessionPreflight(request, env);
      }

      // Session WebSocket routed to Durable Object, one instance per session_id
      if (url.pathname === "/api/session/live") {
        const sessionToken = url.searchParams.get("session_token");
        if (!sessionToken) {
          return errorResponse("missing_session_token", "session_token query param required", 401);
        }
        // We use the session_token hash as the DO name so each concurrent session
        // gets its own isolated DO instance. Since JWTs are per-session, no two
        // sessions share the same DO.
        const doName = await sha256Hex(sessionToken);
        const doId = env.GEMINI_SESSION_DO.idFromName(doName);
        const doStub = env.GEMINI_SESSION_DO.get(doId);
        return doStub.fetch(request);
      }

      // ========== Admin ==========
      if (url.pathname === "/api/admin/login" && method === "POST") {
        return await handleAdminLogin(request, env);
      }
      if (url.pathname === "/api/admin/google-login" && method === "POST") {
        return await handleAdminGoogleLogin(request, env);
      }
      if (url.pathname === "/api/admin/stats" && method === "GET") {
        return await handleAdminStats(request, env);
      }
      if (url.pathname === "/api/admin/signup-stats" && method === "GET") {
        return await handleAdminSignupStats(request, env);
      }
      if (url.pathname === "/api/admin/users" && method === "GET") {
        return await handleAdminUsers(request, env);
      }
      const userDetailMatch = url.pathname.match(/^\/api\/admin\/user\/([a-f0-9-]{36})$/);
      if (userDetailMatch && method === "GET") {
        return await handleAdminUserDetail(request, env, userDetailMatch[1]);
      }
      if (url.pathname === "/api/admin/block-user" && method === "POST") {
        return await handleAdminBlockUser(request, env);
      }
      if (url.pathname === "/api/admin/unblock-user" && method === "POST") {
        return await handleAdminUnblockUser(request, env);
      }
      if (url.pathname === "/api/admin/block-device" && method === "POST") {
        return await handleAdminBlockDevice(request, env);
      }
      if (url.pathname === "/api/admin/unblock-device" && method === "POST") {
        return await handleAdminUnblockDevice(request, env);
      }
      if (url.pathname === "/api/admin/pause-user" && method === "POST") {
        return await handleAdminPauseUser(request, env);
      }
      if (url.pathname === "/api/admin/unpause-user" && method === "POST") {
        return await handleAdminUnpauseUser(request, env);
      }
      if (url.pathname === "/api/admin/delete-user" && method === "POST") {
        return await handleAdminDeleteUser(request, env);
      }

      // Backwards-compat: the legacy route still exists so existing builds of
      // the Swift app (pre-license system) don't crash. It's scheduled for
      // removal once all distributed builds are upgraded.
      if (url.pathname === "/gemini-live-token" && method === "POST") {
        return errorResponse(
          "deprecated_route",
          "This endpoint is deprecated. Upgrade the Atayi Sensei app to continue.",
          410,
        );
      }

      if (url.pathname.startsWith("/api/")) {
        return method === "GET" || method === "POST" ? notFoundResponse() : methodNotAllowedResponse();
      }

      return new Response("Atayi Sensei API — use /api/*", { status: 200 });
    } catch (error) {
      console.error(`[${url.pathname}] unhandled`, error);
      return errorResponse("internal_error", String(error), 500);
    }
  },

  /**
   * Cron trigger: refresh the admin_user_stats matview every 5 minutes
   * so the admin dashboard shows near-real-time consumption without
   * hitting the db on every page load.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleRefreshStats(env).catch((error) => console.error("[cron refresh-stats]", error)));
  },
};

async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
