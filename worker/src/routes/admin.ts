/**
 * Admin dashboard endpoints.
 *
 * Auth:
 *   - POST /api/admin/login → compares password against PBKDF2 hash in env,
 *     returns admin JWT (scope="admin", exp=24h)
 *   - All other /api/admin/* routes require a valid admin JWT in the
 *     Authorization header.
 *
 * Endpoints:
 *   POST /api/admin/login
 *   GET  /api/admin/stats        → tiles (visits, downloads, mrr, active subs, trials)
 *   GET  /api/admin/users        → list with filters + pagination
 *   GET  /api/admin/user/:id     → single user with devices + recent sessions
 *   POST /api/admin/block-user
 *   POST /api/admin/unblock-user
 *   POST /api/admin/block-device
 *   POST /api/admin/unblock-device
 */

import { SupabaseClient } from "../db/supabase";
import { extractBearerToken, signJWT, verifyJWT } from "../auth/jwt";
import { verifyPassword } from "../auth/password";
import { errorResponse, jsonResponse } from "../lib/response";
import type { AdminTokenPayload, Env } from "../types";

const ADMIN_EMAIL = "admin@atayisensei.io"; // hardcoded — single admin account

async function verifyAdminToken(request: Request, env: Env): Promise<AdminTokenPayload | null> {
  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!token) return null;
  return await verifyJWT<AdminTokenPayload>(token, env.JWT_SIGNING_SECRET);
}

export async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  let body: { password?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse("invalid_json", "Body must be JSON", 400);
  }

  const password = body.password ?? "";
  if (!password) {
    return errorResponse("missing_password", "Password required", 400);
  }

  const isValid = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!isValid) {
    // Log failed login
    const supabase = new SupabaseClient(env);
    await supabase.logAdminAction({
      admin_email: ADMIN_EMAIL,
      action: "login_failed",
      metadata: { ip: request.headers.get("cf-connecting-ip") ?? "unknown" },
    });
    return errorResponse("invalid_credentials", "Wrong password", 401);
  }

  const adminToken = await signJWT<AdminTokenPayload>(
    {
      admin_email: ADMIN_EMAIL,
      scope: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    },
    env.JWT_SIGNING_SECRET,
  );

  const supabase = new SupabaseClient(env);
  await supabase.logAdminAction({
    admin_email: ADMIN_EMAIL,
    action: "login",
    metadata: { ip: request.headers.get("cf-connecting-ip") ?? "unknown" },
  });

  return jsonResponse({ admin_token: adminToken, expires_in: 24 * 60 * 60 });
}

export async function handleAdminStats(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const supabase = new SupabaseClient(env);

  // Parallel queries for the dashboard tiles
  const [todayVisits, todayDownloads, totalUsers, activeSubscriptions, trialsInProgress, todayCheckouts] =
    await Promise.all([
      supabase
        .searchUsersForAdmin({ limit: 1 })
        .then(() =>
          // We'll query landing_events directly for these counters
          fetch(
            `${env.SUPABASE_URL}/rest/v1/landing_events?event_type=eq.page_view&created_at=gte.${todayISO()}&select=id`,
            { headers: supabaseHeaders(env) },
          ).then((r) => r.json().then((rows) => (rows as unknown[]).length)),
        ),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/landing_events?event_type=eq.download_click&created_at=gte.${todayISO()}&select=id`,
        { headers: supabaseHeaders(env) },
      ).then((r) => r.json().then((rows) => (rows as unknown[]).length)),
      fetch(`${env.SUPABASE_URL}/rest/v1/users?select=id`, { headers: supabaseHeaders(env) })
        .then((r) => r.json())
        .then((rows) => (rows as unknown[]).length),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/subscriptions?status=in.(active,trialing)&plan=in.(starter,ultra)&select=id,plan`,
        { headers: supabaseHeaders(env) },
      )
        .then((r) => r.json())
        .then((rows) => rows as Array<{ plan: string }>),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/subscriptions?status=eq.trialing&plan=eq.trial&select=id`,
        { headers: supabaseHeaders(env) },
      )
        .then((r) => r.json())
        .then((rows) => (rows as unknown[]).length),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/landing_events?event_type=eq.checkout_completed&created_at=gte.${todayISO()}&select=id`,
        { headers: supabaseHeaders(env) },
      )
        .then((r) => r.json())
        .then((rows) => (rows as unknown[]).length),
    ]);

  const starterCount = activeSubscriptions.filter((s) => s.plan === "starter").length;
  const ultraCount = activeSubscriptions.filter((s) => s.plan === "ultra").length;
  const estimatedMRR = starterCount * 19 + ultraCount * 49;

  return jsonResponse({
    today_visits: todayVisits,
    today_downloads: todayDownloads,
    today_checkouts: todayCheckouts,
    total_users: totalUsers,
    active_subscriptions: {
      total: activeSubscriptions.length,
      starter: starterCount,
      ultra: ultraCount,
    },
    trials_in_progress: trialsInProgress,
    estimated_mrr_usd: estimatedMRR,
  });
}

export async function handleAdminUsers(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const url = new URL(request.url);
  const supabase = new SupabaseClient(env);
  const users = await supabase.searchUsersForAdmin({
    searchTerm: url.searchParams.get("search") ?? undefined,
    plan: url.searchParams.get("plan") ?? undefined,
    limit: parseInt(url.searchParams.get("limit") ?? "100", 10),
    offset: parseInt(url.searchParams.get("offset") ?? "0", 10),
  });

  return jsonResponse({ users });
}

export async function handleAdminUserDetail(request: Request, env: Env, userId: string): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const supabase = new SupabaseClient(env);
  const [user, subscription, devices, recentSessions] = await Promise.all([
    supabase.findUserById(userId),
    supabase.findLatestSubscriptionForUser(userId),
    supabase.findDevicesForUser(userId),
    supabase.getRecentSessionsForUser(userId, 20),
  ]);

  if (!user) return errorResponse("not_found", "User not found", 404);

  return jsonResponse({
    user,
    subscription,
    devices,
    recent_sessions: recentSessions,
  });
}

export async function handleAdminBlockUser(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const body = (await request.json()) as { user_id?: string; reason?: string };
  if (!body.user_id) return errorResponse("missing_user_id", "user_id required", 400);

  const supabase = new SupabaseClient(env);
  await supabase.blockUser(body.user_id, body.reason ?? "blocked by admin");
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "block_user",
    target_user_id: body.user_id,
    reason: body.reason,
  });
  return jsonResponse({ blocked: true });
}

export async function handleAdminUnblockUser(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const body = (await request.json()) as { user_id?: string };
  if (!body.user_id) return errorResponse("missing_user_id", "user_id required", 400);

  const supabase = new SupabaseClient(env);
  await supabase.unblockUser(body.user_id);
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "unblock_user",
    target_user_id: body.user_id,
  });
  return jsonResponse({ unblocked: true });
}

export async function handleAdminBlockDevice(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const body = (await request.json()) as { device_id?: string; reason?: string };
  if (!body.device_id) return errorResponse("missing_device_id", "device_id required", 400);

  const supabase = new SupabaseClient(env);
  await supabase.blockDevice(body.device_id, body.reason ?? "blocked by admin");
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "block_device",
    target_device_id: body.device_id,
    reason: body.reason,
  });
  return jsonResponse({ blocked: true });
}

export async function handleAdminUnblockDevice(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const body = (await request.json()) as { device_id?: string };
  if (!body.device_id) return errorResponse("missing_device_id", "device_id required", 400);

  const supabase = new SupabaseClient(env);
  await supabase.unblockDevice(body.device_id);
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "unblock_device",
    target_device_id: body.device_id,
  });
  return jsonResponse({ unblocked: true });
}

// ========== helpers ==========

function todayISO(): string {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today.toISOString();
}

function supabaseHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}
