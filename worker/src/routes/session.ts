/**
 * POST /api/session/preflight
 *
 * The Swift app calls this right after ctrl+option is pressed, before
 * opening the WebSocket to the Durable Object. The worker:
 *   - validates the device_token JWT
 *   - checks that the subscription is active and not over quota
 *   - checks the daily cap (for trials)
 *   - creates a `sessions` row in Supabase
 *   - issues a short-lived session_token (5 min) that the client uses to
 *     open the WS to the DO
 *
 * Returns { session_id, ws_url, session_token, credits_remaining, daily_remaining }
 */

import { SupabaseClient } from "../db/supabase";
import { extractBearerToken, signJWT, verifyJWT } from "../auth/jwt";
import { errorResponse, jsonResponse } from "../lib/response";
import type { DeviceTokenPayload, Env, SessionTokenPayload } from "../types";
import { PLAN_LIMITS } from "../types";

const SESSION_TOKEN_TTL_SECONDS = 300; // 5 minutes

export async function handleSessionPreflight(request: Request, env: Env): Promise<Response> {
  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!token) {
    return errorResponse("unauthorized", "Missing device token", 401);
  }

  const deviceToken = await verifyJWT<DeviceTokenPayload>(token, env.JWT_SIGNING_SECRET);
  if (!deviceToken) {
    return errorResponse("unauthorized", "Invalid or expired device token", 401);
  }

  const supabase = new SupabaseClient(env);

  // Check user blocked
  const user = await supabase.findUserById(deviceToken.sub);
  if (!user || user.is_blocked) {
    return errorResponse("account_blocked", user?.blocked_reason ?? "Account is blocked", 403);
  }

  // Check device blocked
  const device = await supabase.findDeviceById(deviceToken.device_id);
  if (!device || device.is_blocked) {
    return errorResponse("device_blocked", device?.blocked_reason ?? "Device is blocked", 403);
  }

  // Load subscription
  const subscription = await supabase.findLatestSubscriptionForUser(deviceToken.sub);
  if (!subscription) {
    return errorResponse("no_subscription", "No subscription found", 403);
  }

  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return errorResponse(
      "subscription_inactive",
      `Subscription is ${subscription.status}`,
      403,
      { subscription_status: subscription.status },
    );
  }

  // Trial hard-stop: past the 7-day window
  if (subscription.plan === "trial" && subscription.current_period_end) {
    if (Date.now() > new Date(subscription.current_period_end).getTime()) {
      return errorResponse("trial_expired", "Trial ended. Upgrade to keep using Atayi Sensei.", 403);
    }
  }

  // Monthly cap
  if (subscription.credits_used_this_period >= subscription.monthly_credit_allowance) {
    return errorResponse(
      "credits_exhausted",
      "Monthly credit allowance exhausted",
      403,
      {
        credits_used: subscription.credits_used_this_period,
        credits_allowance: subscription.monthly_credit_allowance,
      },
    );
  }

  // Daily cap (trial only)
  let dailyUsed = 0;
  let dailyCap: number | undefined;
  if (subscription.plan === "trial") {
    dailyCap = PLAN_LIMITS.trial.daily_cap ?? 1800;
    dailyUsed = await supabase.getDailyUsageForToday(deviceToken.sub);
    if (dailyUsed >= dailyCap) {
      return errorResponse(
        "daily_cap_reached",
        `Daily trial cap of ${dailyCap / 60} minutes reached. Come back tomorrow or upgrade.`,
        403,
        { daily_used: dailyUsed, daily_cap: dailyCap },
      );
    }
  }

  // Create the session row
  const session = await supabase.createSession({
    user_id: deviceToken.sub,
    device_id: deviceToken.device_id,
    ip_address: request.headers.get("cf-connecting-ip") ?? undefined,
    user_agent: request.headers.get("user-agent") ?? undefined,
  });

  // Touch device last_active
  await supabase.touchDeviceLastActive(deviceToken.device_id);

  // Issue a short-lived session token that the client uses to open the WS
  const sessionToken = await signJWT<SessionTokenPayload>(
    {
      sub: deviceToken.sub,
      device_id: deviceToken.device_id,
      session_id: session.id,
      plan: subscription.plan,
      subscription_id: subscription.id,
      monthly_allowance: subscription.monthly_credit_allowance,
      monthly_used_before_session: subscription.credits_used_this_period,
      daily_cap: dailyCap,
      daily_used_before_session: dailyUsed,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + SESSION_TOKEN_TTL_SECONDS,
    },
    env.JWT_SIGNING_SECRET,
  );

  // Construct the WS URL. Use the request's own origin so the app hits the
  // same deployment it just preflighted against.
  const requestUrl = new URL(request.url);
  const wsProtocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${requestUrl.host}/api/session/live?session_token=${encodeURIComponent(sessionToken)}`;

  const creditsRemaining = subscription.monthly_credit_allowance - subscription.credits_used_this_period;
  const dailyRemaining = dailyCap !== undefined ? Math.max(0, dailyCap - dailyUsed) : null;

  return jsonResponse({
    session_id: session.id,
    ws_url: wsUrl,
    session_token: sessionToken,
    credits_remaining: creditsRemaining,
    daily_remaining: dailyRemaining,
    plan: subscription.plan,
  });
}
