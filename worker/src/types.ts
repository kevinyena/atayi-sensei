/**
 * Shared types for the Atayi Sensei worker.
 */

import type { GeminiSessionDO } from "./do/gemini-session";

export interface Env {
  // Cloudflare bindings
  GEMINI_SESSION_DO: DurableObjectNamespace<GeminiSessionDO>;
  // ATAYI_DOWNLOADS: R2Bucket;  // enable in Phase 7

  // Secrets (wrangler secret put)
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  JWT_SIGNING_SECRET: string;
  ADMIN_PASSWORD_HASH: string; // pbkdf2 format: "iterations.saltHex.hashHex"
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  // Hardcoded Stripe price IDs for the two plans
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_ULTRA?: string;
}

export type Plan = "trial" | "starter" | "ultra";
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

export interface User {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  created_at: string;
  trial_started_at: string | null;
  trial_expires_at: string | null;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: string | null;
  admin_notes: string | null;
}

export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  plan: Plan;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  max_devices: number;
  monthly_credit_allowance: number;
  credits_used_this_period: number;
  created_at: string;
  updated_at: string;
}

export interface LicenseCode {
  id: string;
  user_id: string;
  code: string;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface Device {
  id: string;
  user_id: string;
  device_fingerprint: string;
  device_name: string | null;
  os_version: string | null;
  app_version: string | null;
  registered_at: string;
  last_active_at: string;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: string | null;
}

export interface Session {
  id: string;
  user_id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  credits_consumed: number;
  audio_input_tokens: number;
  audio_output_tokens: number;
  text_input_tokens: number;
  text_output_tokens: number;
  estimated_cost_usd: string;
  termination_reason: string | null;
}

// Payload encoded in the JWT we issue to a device after license activation.
// This is what the Swift app stores in Keychain.
export interface DeviceTokenPayload {
  sub: string; // user_id
  device_id: string;
  plan: Plan;
  subscription_id: string;
  exp: number; // unix seconds
  iat: number;
}

// Payload encoded in the short-lived session token issued by /api/session/preflight.
// Passed by the Swift app when opening the WS to the Durable Object.
export interface SessionTokenPayload {
  sub: string; // user_id
  device_id: string;
  session_id: string;
  plan: Plan;
  subscription_id: string;
  monthly_allowance: number;
  monthly_used_before_session: number;
  daily_cap?: number; // only for trial
  daily_used_before_session?: number;
  exp: number;
  iat: number;
}

// Payload for admin JWT
export interface AdminTokenPayload {
  admin_email: string;
  scope: "admin";
  exp: number;
  iat: number;
}

// Plan limits (kept in sync with the SQL allowance values)
export const PLAN_LIMITS: Record<Plan, { max_devices: number; monthly_credit_allowance: number; daily_cap?: number }> = {
  trial: {
    max_devices: 1,
    monthly_credit_allowance: 12600, // 7 days × 1800/day, matches trial duration
    daily_cap: 1800, // 30 minutes of talk per day
  },
  starter: {
    max_devices: 1,
    monthly_credit_allowance: 40000, // ≈11 hours of talk
  },
  ultra: {
    max_devices: 3,
    monthly_credit_allowance: 160000, // ≈44 hours of talk, shared across up to 3 Macs
  },
};

// 1 credit = 1 second of talk. Derived from Gemini Live pricing:
//   audio in  : $3 / 1M tokens, 25 tokens/sec
//   audio out : $12 / 1M tokens, 25 tokens/sec
//   Mixed 40/60 user/AI = ~$0.013/min of conversation
export const TOKENS_PER_SECOND = 25;
export const AUDIO_IN_USD_PER_M_TOKENS = 3;
export const AUDIO_OUT_USD_PER_M_TOKENS = 12;
