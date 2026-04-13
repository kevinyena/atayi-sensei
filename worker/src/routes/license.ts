/**
 * License activation / status endpoints.
 *
 * POST /api/license/activate  → bind a license code + device → return JWT
 * GET  /api/license/status    → check current license state for a device
 * POST /api/license/deactivate → user-initiated device removal
 */

import { SupabaseClient } from "../db/supabase";
import { extractBearerToken, signJWT, verifyJWT } from "../auth/jwt";
import { normalizeLicenseCode } from "../lib/license-code";
import { errorResponse, jsonResponse } from "../lib/response";
import type { DeviceTokenPayload, Env, SubscriptionStatus } from "../types";

function isSubscriptionActive(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

function deviceTokenExpirySeconds(): number {
  // 7 days
  return Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
}

export async function handleLicenseActivate(request: Request, env: Env): Promise<Response> {
  let body: {
    license_code?: string;
    device_fingerprint?: string;
    device_name?: string;
    os_version?: string;
    app_version?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse("invalid_json", "Request body must be JSON", 400);
  }

  const licenseCodeRaw = body.license_code ?? "";
  const deviceFingerprint = body.device_fingerprint?.trim() ?? "";
  if (!licenseCodeRaw || !deviceFingerprint) {
    return errorResponse("missing_fields", "license_code and device_fingerprint are required", 400);
  }

  const licenseCode = normalizeLicenseCode(licenseCodeRaw);
  const supabase = new SupabaseClient(env);

  const licenseRow = await supabase.findLicenseByCode(licenseCode);
  if (!licenseRow) {
    return errorResponse("invalid_license", "License code not found or revoked", 404);
  }

  const user = await supabase.findUserById(licenseRow.user_id);
  if (!user) {
    return errorResponse("invalid_license", "License owner not found", 404);
  }
  if (user.is_blocked) {
    return errorResponse("account_blocked", user.blocked_reason ?? "Account is blocked", 403);
  }

  const subscription = await supabase.findLatestSubscriptionForUser(user.id);
  if (!subscription) {
    return errorResponse("no_subscription", "No subscription found for this license", 403);
  }
  if (!isSubscriptionActive(subscription.status)) {
    return errorResponse(
      "subscription_inactive",
      `Subscription is ${subscription.status}. Renew to continue.`,
      403,
      { subscription_status: subscription.status },
    );
  }

  // Check trial expiry explicitly (status=trialing but past the 7-day window)
  if (subscription.plan === "trial" && subscription.current_period_end) {
    const expiresAt = new Date(subscription.current_period_end).getTime();
    if (Date.now() > expiresAt) {
      return errorResponse("trial_expired", "Trial period has ended. Upgrade to keep using Atayi Sensei.", 403);
    }
  }

  // Check if this device already exists for this user (re-activation from same Mac)
  const existingDevice = await supabase.findDeviceByFingerprint(user.id, deviceFingerprint);
  if (existingDevice) {
    if (existingDevice.is_blocked) {
      return errorResponse("device_blocked", existingDevice.blocked_reason ?? "Device is blocked", 403);
    }
    await supabase.touchDeviceLastActive(existingDevice.id);

    const deviceToken = await signJWT<DeviceTokenPayload>(
      {
        sub: user.id,
        device_id: existingDevice.id,
        plan: subscription.plan,
        subscription_id: subscription.id,
        iat: Math.floor(Date.now() / 1000),
        exp: deviceTokenExpirySeconds(),
      },
      env.JWT_SIGNING_SECRET,
    );

    const activeDevices = await supabase.findActiveDevicesForUser(user.id);
    return jsonResponse({
      device_token: deviceToken,
      plan: subscription.plan,
      credits_used: subscription.credits_used_this_period,
      credits_allowance: subscription.monthly_credit_allowance,
      max_devices: subscription.max_devices,
      active_devices: activeDevices.length,
      current_period_end: subscription.current_period_end,
      reactivation: true,
    });
  }

  // New device → enforce device limit
  const activeDevices = await supabase.findActiveDevicesForUser(user.id);
  if (activeDevices.length >= subscription.max_devices) {
    return errorResponse(
      "device_limit_reached",
      `This subscription allows ${subscription.max_devices} device(s). You already have ${activeDevices.length} active.`,
      403,
      {
        max_devices: subscription.max_devices,
        active_devices: activeDevices.length,
        device_fingerprints: activeDevices.map((d) => ({
          id: d.id,
          name: d.device_name,
          last_active: d.last_active_at,
        })),
      },
    );
  }

  const newDevice = await supabase.createDevice({
    user_id: user.id,
    device_fingerprint: deviceFingerprint,
    device_name: body.device_name,
    os_version: body.os_version,
    app_version: body.app_version,
  });

  const deviceToken = await signJWT<DeviceTokenPayload>(
    {
      sub: user.id,
      device_id: newDevice.id,
      plan: subscription.plan,
      subscription_id: subscription.id,
      iat: Math.floor(Date.now() / 1000),
      exp: deviceTokenExpirySeconds(),
    },
    env.JWT_SIGNING_SECRET,
  );

  return jsonResponse({
    device_token: deviceToken,
    plan: subscription.plan,
    credits_used: subscription.credits_used_this_period,
    credits_allowance: subscription.monthly_credit_allowance,
    max_devices: subscription.max_devices,
    active_devices: activeDevices.length + 1,
    current_period_end: subscription.current_period_end,
    reactivation: false,
  });
}

export async function handleLicenseStatus(request: Request, env: Env): Promise<Response> {
  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!token) {
    return errorResponse("unauthorized", "Missing device token", 401);
  }

  const payload = await verifyJWT<DeviceTokenPayload>(token, env.JWT_SIGNING_SECRET);
  if (!payload) {
    return errorResponse("unauthorized", "Invalid or expired device token", 401);
  }

  const supabase = new SupabaseClient(env);

  // Check if user still exists (may have been deleted by admin)
  const user = await supabase.findUserById(payload.sub);
  if (!user) {
    return errorResponse("account_deleted", "This account no longer exists. Please create a new account at atayisensei.com.", 404);
  }
  if (user.is_blocked) {
    return errorResponse("account_blocked", user.blocked_reason ?? "Account is blocked", 403);
  }
  if (user.is_paused) {
    return errorResponse("account_paused", user.paused_reason ?? "Account is paused", 403);
  }

  const subscription = await supabase.findLatestSubscriptionForUser(payload.sub);
  if (!subscription) {
    return errorResponse("no_subscription", "Subscription not found", 404);
  }

  const device = await supabase.findDeviceById(payload.device_id);
  if (!device || device.is_blocked) {
    return errorResponse("device_blocked", device?.blocked_reason ?? "Device no longer active", 403);
  }

  const dailyCreditsConsumed = await supabase.getDailyUsageForToday(payload.sub);

  return jsonResponse({
    plan: subscription.plan,
    status: subscription.status,
    credits_used: subscription.credits_used_this_period,
    credits_allowance: subscription.monthly_credit_allowance,
    credits_remaining: Math.max(0, subscription.monthly_credit_allowance - subscription.credits_used_this_period),
    daily_used: dailyCreditsConsumed,
    daily_cap: subscription.plan === "trial" ? 1800 : null,
    current_period_end: subscription.current_period_end,
    max_devices: subscription.max_devices,
  });
}
