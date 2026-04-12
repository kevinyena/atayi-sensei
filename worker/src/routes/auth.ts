/**
 * Auth endpoints for the new account system:
 *   POST /api/auth/signup          email+password → create user → send OTP
 *   POST /api/auth/verify-otp      verify code → mark email_verified
 *   POST /api/auth/google          Google ID token → find-or-create user
 *   POST /api/auth/login           email+password → return session
 *   POST /api/auth/resend-otp      resend verification code
 */

import { SupabaseClient } from "../db/supabase";
import { hashPassword, verifyPassword } from "../auth/password";
import { signJWT } from "../auth/jwt";
import { generateLicenseCode } from "../lib/license-code";
import { sendOTPEmail, sendLicenseCodeEmail } from "../lib/email";
import { errorResponse, jsonResponse } from "../lib/response";
import type { Env, Plan } from "../types";
import { PLAN_LIMITS } from "../types";

function generateOTP(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const num = ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 1000000;
  return num.toString().padStart(6, "0");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password: string): boolean {
  return password.length >= 8;
}

interface AuthSessionPayload {
  sub: string;
  email: string;
  plan?: string;
  scope: "user";
  exp: number;
  iat: number;
}

async function issueUserSession(userId: string, email: string, plan: string | undefined, env: Env): Promise<string> {
  return signJWT<AuthSessionPayload>(
    {
      sub: userId,
      email,
      plan,
      scope: "user",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    },
    env.JWT_SIGNING_SECRET,
  );
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/auth/signup — email + password → create user → send OTP
// ═══════════════════════════════════════════════════════════════════

export async function handleSignup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
  if (!body) return errorResponse("invalid_json", "Body must be JSON", 400);

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  if (!isValidEmail(email)) return errorResponse("invalid_email", "Invalid email address", 400);
  if (!isStrongPassword(password)) return errorResponse("weak_password", "Password must be at least 8 characters", 400);

  const supabase = new SupabaseClient(env);

  // Check if email already exists
  const existingUser = await supabase.findUserByEmail(email);
  if (existingUser && existingUser.email_verified) {
    return errorResponse("email_exists", "An account with this email already exists. Log in instead.", 409);
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  let userId: string;
  if (existingUser && !existingUser.email_verified) {
    // User started signup but never verified — update password and resend OTP
    await supabase.updateUser(existingUser.id, { password_hash: passwordHash } as any);
    userId = existingUser.id;
  } else {
    // Create new user
    const user = await supabase.createUser({ email });
    await supabase.updateUser(user.id, {
      password_hash: passwordHash,
      auth_provider: "email",
      email_verified: false,
    } as any);
    userId = user.id;
  }

  // Generate and store OTP
  const otpCode = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  await supabase.request("/otps", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ email, code: otpCode, purpose: "email_verification", expires_at: expiresAt }),
  });

  // Send OTP email via Resend
  const emailSent = await sendOTPEmail(env.RESEND_API_KEY, email, otpCode);
  if (!emailSent) {
    return errorResponse("email_failed", "Could not send verification email. Try again.", 500);
  }

  return jsonResponse({ message: "Verification code sent to your email", user_id: userId });
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/auth/verify-otp — verify code → mark email_verified
// ═══════════════════════════════════════════════════════════════════

export async function handleVerifyOTP(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string; code?: string; plan?: string } | null;
  if (!body) return errorResponse("invalid_json", "Body must be JSON", 400);

  const email = body.email?.trim().toLowerCase() ?? "";
  const code = body.code?.trim() ?? "";
  const requestedPlan = (body.plan ?? "trial") as Plan;

  if (!email || !code) return errorResponse("missing_fields", "email and code are required", 400);

  const supabase = new SupabaseClient(env);

  // Find the latest unused OTP for this email
  const otps = await supabase.request<Array<{ id: string; code: string; expires_at: string; used_at: string | null }>>(
    `/otps?email=eq.${encodeURIComponent(email)}&purpose=eq.email_verification&used_at=is.null&order=created_at.desc&limit=1`,
  );

  if (!otps || otps.length === 0) {
    return errorResponse("no_otp", "No pending verification code found. Request a new one.", 404);
  }

  const otp = otps[0];
  if (new Date(otp.expires_at) < new Date()) {
    return errorResponse("otp_expired", "Verification code expired. Request a new one.", 410);
  }
  if (otp.code !== code) {
    return errorResponse("invalid_otp", "Incorrect verification code", 400);
  }

  // Mark OTP as used
  await supabase.request(`/otps?id=eq.${otp.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });

  // Mark user as verified
  const user = await supabase.findUserByEmail(email);
  if (!user) return errorResponse("user_not_found", "User not found", 404);

  await supabase.updateUser(user.id, { email_verified: true } as any);

  // Create trial subscription + license code if this is initial signup
  const existingSubscription = await supabase.findLatestSubscriptionForUser(user.id);
  let licenseCode: string | null = null;

  if (!existingSubscription) {
    // Create trial subscription
    await supabase.createTrialSubscription(user.id);
    licenseCode = generateLicenseCode("trial");
    await supabase.createLicenseCode(user.id, licenseCode);

    // Send license code by email
    await sendLicenseCodeEmail(env.RESEND_API_KEY, email, licenseCode, "trial");
  } else {
    // Already has a subscription, just retrieve existing license
    const licenses = await supabase.findLicensesByUserId(user.id);
    licenseCode = licenses.find((l) => l.revoked_at === null)?.code ?? null;
  }

  // Issue session JWT
  const sessionToken = await issueUserSession(user.id, email, requestedPlan, env);

  // Log event
  await supabase.logLandingEvent({ event_type: "signup_completed", user_id: user.id });

  return jsonResponse({
    message: "Email verified successfully",
    session_token: sessionToken,
    user_id: user.id,
    email,
    license_code: licenseCode,
    plan: requestedPlan,
  });
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/auth/google — Google ID token → find-or-create user
// ═══════════════════════════════════════════════════════════════════

export async function handleGoogleAuth(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { id_token?: string; plan?: string } | null;
  if (!body?.id_token) return errorResponse("missing_token", "Google id_token is required", 400);

  const requestedPlan = (body.plan ?? "trial") as Plan;

  // Verify the Google ID token using Google's tokeninfo endpoint
  const tokenInfoResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.id_token)}`,
  );
  if (!tokenInfoResponse.ok) {
    return errorResponse("invalid_google_token", "Google token verification failed", 401);
  }

  const tokenInfo = (await tokenInfoResponse.json()) as {
    aud: string;
    sub: string;
    email: string;
    email_verified: string;
    name?: string;
  };

  // Verify the token was issued for our app
  if (tokenInfo.aud !== env.GOOGLE_CLIENT_ID) {
    return errorResponse("invalid_audience", "Token was not issued for this application", 401);
  }

  const googleId = tokenInfo.sub;
  const email = tokenInfo.email.toLowerCase();

  const supabase = new SupabaseClient(env);

  // Find existing user by google_id or email
  let user = await supabase.findUserByEmail(email);

  if (user) {
    // Link Google if not already linked
    if (!user.google_id) {
      await supabase.updateUser(user.id, {
        google_id: googleId,
        auth_provider: "google",
        email_verified: true,
      } as any);
    }
  } else {
    // Create new user
    user = await supabase.createUser({ email });
    await supabase.updateUser(user.id, {
      google_id: googleId,
      auth_provider: "google",
      email_verified: true,
    } as any);
  }

  // Create trial subscription + license code if no subscription exists
  const existingSubscription = await supabase.findLatestSubscriptionForUser(user.id);
  let licenseCode: string | null = null;

  if (!existingSubscription) {
    await supabase.createTrialSubscription(user.id);
    licenseCode = generateLicenseCode("trial");
    await supabase.createLicenseCode(user.id, licenseCode);

    // Send license code by email
    await sendLicenseCodeEmail(env.RESEND_API_KEY, email, licenseCode, "trial");
  } else {
    const licenses = await supabase.findLicensesByUserId(user.id);
    licenseCode = licenses.find((l) => l.revoked_at === null)?.code ?? null;
  }

  // Issue session JWT
  const sessionToken = await issueUserSession(user.id, email, requestedPlan, env);

  await supabase.logLandingEvent({ event_type: "google_signup", user_id: user.id });

  return jsonResponse({
    message: "Google sign-in successful",
    session_token: sessionToken,
    user_id: user.id,
    email,
    license_code: licenseCode,
    plan: existingSubscription?.plan ?? "trial",
  });
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/auth/login — email + password → session
// ═══════════════════════════════════════════════════════════════════

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
  if (!body) return errorResponse("invalid_json", "Body must be JSON", 400);

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  if (!email || !password) return errorResponse("missing_fields", "email and password required", 400);

  const supabase = new SupabaseClient(env);
  const user = await supabase.findUserByEmail(email);

  if (!user) return errorResponse("invalid_credentials", "Invalid email or password", 401);
  if (!user.email_verified) return errorResponse("email_not_verified", "Please verify your email first", 403);
  if (!user.password_hash) return errorResponse("use_google", "This account uses Google Sign-In", 403);
  if (user.is_blocked) return errorResponse("account_blocked", user.blocked_reason ?? "Account blocked", 403);

  const passwordValid = await verifyPassword(password, user.password_hash);
  if (!passwordValid) return errorResponse("invalid_credentials", "Invalid email or password", 401);

  const subscription = await supabase.findLatestSubscriptionForUser(user.id);

  const sessionToken = await issueUserSession(user.id, email, subscription?.plan, env);

  // Get license code
  const licenses = await supabase.findLicensesByUserId(user.id);
  const activeLicense = licenses.find((l) => l.revoked_at === null);

  return jsonResponse({
    session_token: sessionToken,
    user_id: user.id,
    email,
    plan: subscription?.plan ?? "trial",
    license_code: activeLicense?.code ?? null,
    credits_used: subscription?.credits_used_this_period ?? 0,
    credits_allowance: subscription?.monthly_credit_allowance ?? 0,
  });
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/auth/resend-otp — resend verification code
// ═══════════════════════════════════════════════════════════════════

export async function handleResendOTP(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  if (!body?.email) return errorResponse("missing_email", "email is required", 400);

  const email = body.email.trim().toLowerCase();
  const supabase = new SupabaseClient(env);
  const user = await supabase.findUserByEmail(email);

  if (!user) return errorResponse("not_found", "No account with this email", 404);
  if (user.email_verified) return jsonResponse({ message: "Email already verified" });

  const otpCode = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await supabase.request("/otps", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ email, code: otpCode, purpose: "email_verification", expires_at: expiresAt }),
  });

  await sendOTPEmail(env.RESEND_API_KEY, email, otpCode);
  return jsonResponse({ message: "New verification code sent" });
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/account/profile — authenticated user's account info
// ═══════════════════════════════════════════════════════════════════

export async function handleAccountProfile(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "") ?? "";
  if (!token) return errorResponse("unauthorized", "Session token required", 401);

  const payload = await import("../auth/jwt").then((m) => m.verifyJWT<AuthSessionPayload>(token, env.JWT_SIGNING_SECRET));
  if (!payload || payload.scope !== "user") return errorResponse("unauthorized", "Invalid session", 401);

  const supabase = new SupabaseClient(env);
  const user = await supabase.findUserById(payload.sub);
  if (!user) return errorResponse("not_found", "User not found", 404);

  const subscription = await supabase.findLatestSubscriptionForUser(user.id);
  const devices = await supabase.findDevicesForUser(user.id);
  const licenses = await supabase.findLicensesByUserId(user.id);
  const activeLicense = licenses.find((l) => l.revoked_at === null);
  const dailyUsed = await supabase.getDailyUsageForToday(user.id);
  const recentSessions = await supabase.getRecentSessionsForUser(user.id, 10);

  return jsonResponse({
    user: { id: user.id, email: user.email, auth_provider: user.auth_provider, created_at: user.created_at },
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          credits_used: subscription.credits_used_this_period,
          credits_allowance: subscription.monthly_credit_allowance,
          credits_remaining: Math.max(0, subscription.monthly_credit_allowance - subscription.credits_used_this_period),
          current_period_end: subscription.current_period_end,
          max_devices: subscription.max_devices,
          cancel_at_period_end: subscription.cancel_at_period_end,
        }
      : null,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.device_name,
      os_version: d.os_version,
      last_active: d.last_active_at,
      is_blocked: d.is_blocked,
    })),
    license_code: activeLicense?.code ?? null,
    daily_used: dailyUsed,
    recent_sessions: recentSessions.map((s) => ({
      started_at: s.started_at,
      ended_at: s.ended_at,
      credits_consumed: s.credits_consumed,
      termination_reason: s.termination_reason,
    })),
  });
}
