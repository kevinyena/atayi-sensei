-- Atayi Sensei — Supabase schema
-- Run this in the Supabase SQL editor (dashboard.supabase.com → SQL Editor → New query → paste → Run)
-- or via psql with the connection string from Settings → Database
--
-- This file is idempotent: safe to re-run (uses IF NOT EXISTS + CREATE OR REPLACE where possible).

-- =========================================================================
-- USERS: one row per Atayi Sensei account
-- =========================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    trial_started_at TIMESTAMPTZ,
    trial_expires_at TIMESTAMPTZ,
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    blocked_reason TEXT,
    blocked_at TIMESTAMPTZ,
    admin_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_trial_expires ON users(trial_expires_at) WHERE trial_expires_at IS NOT NULL;

-- =========================================================================
-- SUBSCRIPTIONS: Stripe subscription state mirror
-- =========================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT UNIQUE,
    stripe_price_id TEXT,
    plan TEXT NOT NULL CHECK (plan IN ('trial', 'starter', 'ultra')),
    status TEXT NOT NULL, -- trialing / active / past_due / canceled / incomplete / incomplete_expired / unpaid
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    max_devices INT NOT NULL,
    monthly_credit_allowance INT NOT NULL,
    credits_used_this_period INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status) WHERE status IN ('active', 'trialing');

-- =========================================================================
-- LICENSE_CODES: unique codes handed to users (trial or paid)
-- Format: ATAYI-<TYPE>-XXXX-XXXX-XXXX
-- =========================================================================
CREATE TABLE IF NOT EXISTS license_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_license_codes_active ON license_codes(code) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_license_codes_user ON license_codes(user_id);

-- =========================================================================
-- DEVICES: Macs activated with a license code
-- Enforces per-user device limits (1 for Starter, 3 for Ultra)
-- =========================================================================
CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_fingerprint TEXT NOT NULL, -- SHA256(IOPlatformUUID) hex
    device_name TEXT,
    os_version TEXT,
    app_version TEXT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    blocked_reason TEXT,
    blocked_at TIMESTAMPTZ,
    UNIQUE(user_id, device_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_devices_user_active ON devices(user_id) WHERE NOT is_blocked;
CREATE INDEX IF NOT EXISTS idx_devices_last_active ON devices(last_active_at DESC);

-- =========================================================================
-- SESSIONS: one row per Gemini Live session (connect→disconnect)
-- =========================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    device_id UUID NOT NULL REFERENCES devices(id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    credits_consumed INT NOT NULL DEFAULT 0,
    audio_input_tokens BIGINT NOT NULL DEFAULT 0,
    audio_output_tokens BIGINT NOT NULL DEFAULT 0,
    text_input_tokens BIGINT NOT NULL DEFAULT 0,
    text_output_tokens BIGINT NOT NULL DEFAULT 0,
    estimated_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
    termination_reason TEXT, -- user_closed / credits_exhausted / daily_cap / subscription_inactive / error / admin_block
    ip_address INET,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_time ON sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_device_time ON sessions(device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id) WHERE ended_at IS NULL;

-- =========================================================================
-- DAILY_USAGE: per-user per-day credit sum (for trial daily cap + analytics)
-- Upserted by the Durable Object every ~30s during active sessions
-- =========================================================================
CREATE TABLE IF NOT EXISTS daily_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date DATE NOT NULL,
    credits_consumed INT NOT NULL DEFAULT 0,
    session_count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date DESC);

-- =========================================================================
-- LANDING_EVENTS: landing page analytics (visits, downloads, checkouts)
-- Written by POST /api/landing/event, read by admin dashboard
-- =========================================================================
CREATE TABLE IF NOT EXISTS landing_events (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL, -- page_view / trial_signup / download_click / checkout_started / checkout_completed
    visitor_id TEXT,
    user_id UUID REFERENCES users(id),
    page TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_landing_events_type_date ON landing_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_landing_events_visitor ON landing_events(visitor_id) WHERE visitor_id IS NOT NULL;

-- =========================================================================
-- ADMIN_AUDIT_LOG: all admin actions (block / unblock / refund / override)
-- =========================================================================
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_email TEXT NOT NULL,
    action TEXT NOT NULL, -- block_user / unblock_user / block_device / unblock_device / manual_credit_adjustment / login
    target_user_id UUID REFERENCES users(id),
    target_device_id UUID REFERENCES devices(id),
    reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_date ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target_user ON admin_audit_log(target_user_id) WHERE target_user_id IS NOT NULL;

-- =========================================================================
-- ADMIN_USER_STATS: materialized view powering the admin dashboard
-- Refreshed every 5 min by a Cloudflare cron → POST /api/internal/refresh-stats
-- =========================================================================
DROP MATERIALIZED VIEW IF EXISTS admin_user_stats;
CREATE MATERIALIZED VIEW admin_user_stats AS
SELECT
    u.id,
    u.email,
    u.created_at AS user_created_at,
    u.is_blocked AS user_is_blocked,
    u.trial_expires_at,
    s.plan,
    s.status AS subscription_status,
    s.credits_used_this_period,
    s.monthly_credit_allowance,
    s.current_period_end,
    s.max_devices,
    (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND NOT d.is_blocked)::INT AS active_devices,
    (SELECT MAX(d.last_active_at) FROM devices d WHERE d.user_id = u.id) AS last_device_activity,
    COALESCE((
        SELECT SUM(sess.credits_consumed)::INT
        FROM sessions sess
        WHERE sess.user_id = u.id
          AND sess.started_at > now() - interval '24 hours'
    ), 0) AS credits_last_24h,
    COALESCE((
        SELECT SUM(sess.credits_consumed)::INT
        FROM sessions sess
        WHERE sess.user_id = u.id
          AND sess.started_at > now() - interval '30 days'
    ), 0) AS credits_last_30d,
    (SELECT COUNT(*)::INT FROM sessions sess WHERE sess.user_id = u.id) AS total_sessions
FROM users u
LEFT JOIN LATERAL (
    SELECT *
    FROM subscriptions sub
    WHERE sub.user_id = u.id
    ORDER BY sub.created_at DESC
    LIMIT 1
) s ON true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_user_stats_id ON admin_user_stats(id);
CREATE INDEX IF NOT EXISTS idx_admin_user_stats_email ON admin_user_stats(email);
CREATE INDEX IF NOT EXISTS idx_admin_user_stats_plan ON admin_user_stats(plan);

-- =========================================================================
-- HELPER RPC FUNCTIONS
-- Called from the worker via supabase.rpc(...)
-- =========================================================================

-- Atomically increment credits_used on a subscription. Returns the new total.
-- Used by the Durable Object on each accounting flush.
CREATE OR REPLACE FUNCTION increment_subscription_credits(
    subscription_id_input UUID,
    credits_delta INT
) RETURNS INT AS $$
DECLARE
    new_total INT;
BEGIN
    UPDATE subscriptions
    SET credits_used_this_period = credits_used_this_period + credits_delta,
        updated_at = now()
    WHERE id = subscription_id_input
    RETURNING credits_used_this_period INTO new_total;
    RETURN new_total;
END;
$$ LANGUAGE plpgsql;

-- Atomically increment daily usage. UPSERT pattern.
CREATE OR REPLACE FUNCTION increment_daily_usage(
    user_id_input UUID,
    credits_delta INT
) RETURNS INT AS $$
DECLARE
    new_total INT;
BEGIN
    INSERT INTO daily_usage (user_id, usage_date, credits_consumed, session_count)
    VALUES (user_id_input, CURRENT_DATE, credits_delta, 0)
    ON CONFLICT (user_id, usage_date)
    DO UPDATE SET credits_consumed = daily_usage.credits_consumed + credits_delta
    RETURNING credits_consumed INTO new_total;
    RETURN new_total;
END;
$$ LANGUAGE plpgsql;

-- Refresh the admin stats matview (called by Cloudflare cron every 5 min).
CREATE OR REPLACE FUNCTION refresh_admin_stats() RETURNS VOID AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY admin_user_stats;
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- ROW-LEVEL SECURITY: disabled on all tables (only service_role accesses)
-- The worker is the only client with service_role; the landing page hits
-- the worker API, never Supabase directly.
-- =========================================================================
-- If you ever expose Supabase directly to the browser, enable RLS here.
-- For now, it's off by design.
