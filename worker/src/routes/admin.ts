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
import { sendAccountStatusEmail } from "../lib/email";
import { errorResponse, jsonResponse } from "../lib/response";
import type { AdminTokenPayload, Env } from "../types";

const ADMIN_EMAIL = "admin@atayisensei.io"; // hardcoded — single admin account
const ADMIN_ALLOWED_EMAILS = ["kevinyena9@gmail.com", "toedembo@gmail.com"];

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
  const senseiCount = activeSubscriptions.filter((s) => s.plan === "sensei").length;
  const estimatedMRR = starterCount * 19 + ultraCount * 49 + senseiCount * 99;

  return jsonResponse({
    today_visits: todayVisits,
    today_downloads: todayDownloads,
    today_checkouts: todayCheckouts,
    total_users: totalUsers,
    active_subscriptions: {
      total: activeSubscriptions.length,
      starter: starterCount,
      ultra: ultraCount,
      sensei: senseiCount,
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
  const rawUsers = await supabase.searchUsersForAdmin({
    searchTerm: url.searchParams.get("search") ?? undefined,
    plan: url.searchParams.get("plan") ?? undefined,
    limit: parseInt(url.searchParams.get("limit") ?? "100", 10),
    offset: parseInt(url.searchParams.get("offset") ?? "0", 10),
  }) as Array<Record<string, unknown>>;

  // Enrich each user with license code, device names, and paused status
  const enrichedUsers = await Promise.all(
    rawUsers.map(async (u) => {
      const userId = u.id as string;
      const [licenses, devices, userRecord] = await Promise.all([
        supabase.findLicensesByUserId(userId),
        supabase.findDevicesForUser(userId),
        supabase.findUserById(userId),
      ]);
      const activeLicense = licenses.find((l) => l.revoked_at === null);
      return {
        ...u,
        user_id: userId,
        license_code: activeLicense?.code ?? null,
        device_names: devices.map((d) => d.device_name || "Unknown device"),
        is_paused: userRecord?.is_paused ?? false,
        is_blocked: userRecord?.is_blocked ?? false,
        platform: userRecord?.platform ?? null,
      };
    }),
  );

  return jsonResponse({ users: enrichedUsers });
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
  const blockedUser = await supabase.findUserById(body.user_id);
  if (blockedUser) {
    await sendAccountStatusEmail(env.RESEND_API_KEY, blockedUser.email, "blocked", body.reason ?? "blocked by admin");
  }
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "block_user",
    target_user_id: body.user_id,
    reason: body.reason,
  });
  await supabase.refreshAdminStats();
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

// ========== Google-based admin login ==========

export async function handleAdminGoogleLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { id_token?: string } | null;
  if (!body?.id_token) return errorResponse("missing_token", "Google id_token required", 400);

  // Verify Google ID token
  const tokenInfoResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.id_token)}`,
  );
  if (!tokenInfoResponse.ok) {
    return errorResponse("invalid_google_token", "Google token verification failed", 401);
  }

  const tokenInfo = (await tokenInfoResponse.json()) as { aud: string; email: string };

  if (tokenInfo.aud !== env.GOOGLE_CLIENT_ID) {
    return errorResponse("invalid_audience", "Token not issued for this app", 401);
  }

  const email = tokenInfo.email.toLowerCase();
  if (!ADMIN_ALLOWED_EMAILS.includes(email)) {
    return errorResponse("not_authorized", "This Google account is not authorized for admin access", 403);
  }

  const adminToken = await signJWT<AdminTokenPayload>(
    {
      admin_email: email,
      scope: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    },
    env.JWT_SIGNING_SECRET,
  );

  const supabase = new SupabaseClient(env);
  await supabase.logAdminAction({
    admin_email: email,
    action: "google_login",
    metadata: { ip: request.headers.get("cf-connecting-ip") ?? "unknown" },
  });

  return jsonResponse({ admin_token: adminToken, email, expires_in: 24 * 60 * 60 });
}

// ========== Enhanced stats ==========

export async function handleAdminSignupStats(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const supabase = new SupabaseClient(env);
  const signupStats = await supabase.getSignupStats();

  // Get all download/plan_selected events with metadata for platform breakdown
  const allDownloadEvents = await fetch(
    `${env.SUPABASE_URL}/rest/v1/landing_events?event_type=in.(download_click,plan_selected)&select=metadata,created_at`,
    { headers: supabaseHeaders(env) },
  ).then((r) => r.json()) as Array<{ metadata: { platform?: string } | null; created_at: string }>;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  function countByPlatformAndTime(events: typeof allDownloadEvents) {
    const result = {
      total: { mac: 0, windows: 0 },
      today: { mac: 0, windows: 0 },
      last3days: { mac: 0, windows: 0 },
      last7days: { mac: 0, windows: 0 },
      last30days: { mac: 0, windows: 0 },
    };
    for (const e of events) {
      const platform = (e.metadata?.platform ?? "").toLowerCase();
      const key = platform === "windows" ? "windows" : "mac";
      result.total[key]++;
      if (e.created_at >= todayStart) result.today[key]++;
      if (e.created_at >= threeDaysAgo) result.last3days[key]++;
      if (e.created_at >= sevenDaysAgo) result.last7days[key]++;
      if (e.created_at >= thirtyDaysAgo) result.last30days[key]++;
    }
    return result;
  }

  const downloads = countByPlatformAndTime(allDownloadEvents);

  return jsonResponse({ signups: signupStats, downloads });
}

// ========== Pause / unpause user ==========

export async function handleAdminPauseUser(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const body = (await request.json()) as { user_id?: string; reason?: string };
  if (!body.user_id) return errorResponse("missing_user_id", "user_id required", 400);

  const supabase = new SupabaseClient(env);
  const user = await supabase.findUserById(body.user_id);
  if (!user) return errorResponse("not_found", "User not found", 404);

  await supabase.pauseUser(body.user_id, body.reason ?? "paused by admin");
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "pause_user",
    target_user_id: body.user_id,
    reason: body.reason,
  });

  await sendAccountStatusEmail(env.RESEND_API_KEY, user.email, "paused", body.reason ?? "paused by admin");

  return jsonResponse({ paused: true });
}

export async function handleAdminUnpauseUser(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const body = (await request.json()) as { user_id?: string };
  if (!body.user_id) return errorResponse("missing_user_id", "user_id required", 400);

  const supabase = new SupabaseClient(env);
  await supabase.unpauseUser(body.user_id);
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "unpause_user",
    target_user_id: body.user_id,
  });

  return jsonResponse({ unpaused: true });
}

// ========== Delete user ==========

export async function handleAdminDeleteUser(request: Request, env: Env): Promise<Response> {
  const admin = await verifyAdminToken(request, env);
  if (!admin) return errorResponse("unauthorized", "Admin token required", 401);

  const body = (await request.json()) as { user_id?: string; reason?: string };
  if (!body.user_id) return errorResponse("missing_user_id", "user_id required", 400);

  const supabase = new SupabaseClient(env);
  const user = await supabase.findUserById(body.user_id);
  if (!user) return errorResponse("not_found", "User not found", 404);

  // Send notification email before deletion
  await sendAccountStatusEmail(env.RESEND_API_KEY, user.email, "deleted", body.reason ?? "account deleted by admin");

  await supabase.deleteUser(body.user_id);
  await supabase.logAdminAction({
    admin_email: admin.admin_email,
    action: "delete_user",
    target_user_id: body.user_id,
    reason: body.reason,
    metadata: { deleted_email: user.email },
  });

  return jsonResponse({ deleted: true });
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
