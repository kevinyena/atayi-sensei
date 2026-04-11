/**
 * POST /api/auth/trial-signup
 *
 * Starts a 7-day trial for a new user. Idempotent: if the email already has
 * an account, returns the existing license code so the user doesn't get
 * stranded after closing the browser tab.
 */

import { SupabaseClient } from "../db/supabase";
import { generateLicenseCode } from "../lib/license-code";
import { errorResponse, jsonResponse } from "../lib/response";
import type { Env } from "../types";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function handleTrialSignup(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; visitor_id?: string };
  try {
    body = (await request.json()) as { email?: string; visitor_id?: string };
  } catch {
    return errorResponse("invalid_json", "Request body must be JSON with an `email` field", 400);
  }

  const normalizedEmail = body.email?.trim().toLowerCase() ?? "";
  if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
    return errorResponse("invalid_email", "Please provide a valid email address", 400);
  }

  const supabase = new SupabaseClient(env);

  // Idempotent: if user already exists, return their most recent active license.
  const existingUser = await supabase.findUserByEmail(normalizedEmail);
  if (existingUser) {
    if (existingUser.is_blocked) {
      return errorResponse("account_blocked", "This account is blocked. Contact support.", 403);
    }
    const licenses = await supabase.findLicensesByUserId(existingUser.id);
    const activeLicense = licenses.find((l) => l.revoked_at === null);
    const subscription = await supabase.findLatestSubscriptionForUser(existingUser.id);
    if (activeLicense && subscription) {
      return jsonResponse({
        license_code: activeLicense.code,
        plan: subscription.plan,
        trial_expires_at: existingUser.trial_expires_at,
        daily_cap_credits: 1800,
        message: "existing_account",
      });
    }
    return errorResponse("account_without_license", "Existing account has no active license. Contact support.", 409);
  }

  // Create fresh user + trial subscription + trial license code.
  const user = await supabase.createUser({ email: normalizedEmail });
  const subscription = await supabase.createTrialSubscription(user.id);
  const licenseCode = generateLicenseCode("trial");
  await supabase.createLicenseCode(user.id, licenseCode);

  // Analytics
  await supabase.logLandingEvent({
    event_type: "trial_signup",
    user_id: user.id,
    visitor_id: body.visitor_id,
  });

  return jsonResponse({
    license_code: licenseCode,
    plan: subscription.plan,
    trial_expires_at: subscription.current_period_end,
    daily_cap_credits: 1800,
    message: "trial_created",
  });
}
