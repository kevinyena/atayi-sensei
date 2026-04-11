/**
 * Thin Supabase client for the worker.
 *
 * We talk to PostgREST directly via fetch() instead of using the `@supabase/supabase-js`
 * library because that library pulls in a large dependency tree and isn't optimized
 * for the Workers runtime. Our queries are simple enough that raw fetch is cleaner.
 *
 * All queries use the service_role key, which bypasses Row-Level Security.
 * NEVER expose this key to the client — the worker is the only layer that uses it.
 */

import type { Device, Env, LicenseCode, Plan, Session, Subscription, User } from "../types";
import { PLAN_LIMITS } from "../types";

export class SupabaseClient {
  private readonly supabaseBaseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(env: Env) {
    this.supabaseBaseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
    this.serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.supabaseBaseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: init.method === "POST" || init.method === "PATCH" ? "return=representation" : "",
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase ${response.status} on ${path}: ${body}`);
    }

    if (response.status === 204) return null as T;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return null as T;
  }

  private async rpc<T>(functionName: string, params: Record<string, unknown>): Promise<T> {
    return this.request<T>(`/rpc/${functionName}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ========== USERS ==========

  async findUserByEmail(email: string): Promise<User | null> {
    const rows = await this.request<User[]>(`/users?email=eq.${encodeURIComponent(email)}&limit=1`);
    return rows[0] ?? null;
  }

  async findUserById(userId: string): Promise<User | null> {
    const rows = await this.request<User[]>(`/users?id=eq.${userId}&limit=1`);
    return rows[0] ?? null;
  }

  async findUserByStripeCustomerId(stripeCustomerId: string): Promise<User | null> {
    const rows = await this.request<User[]>(
      `/users?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&limit=1`,
    );
    return rows[0] ?? null;
  }

  async createUser(params: { email: string; stripe_customer_id?: string }): Promise<User> {
    const rows = await this.request<User[]>("/users", {
      method: "POST",
      body: JSON.stringify({
        email: params.email,
        stripe_customer_id: params.stripe_customer_id ?? null,
      }),
    });
    return rows[0];
  }

  async updateUser(userId: string, patch: Partial<User>): Promise<User | null> {
    const rows = await this.request<User[]>(`/users?id=eq.${userId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return rows[0] ?? null;
  }

  async blockUser(userId: string, reason: string): Promise<void> {
    await this.request(`/users?id=eq.${userId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        is_blocked: true,
        blocked_reason: reason,
        blocked_at: new Date().toISOString(),
      }),
    });
  }

  async unblockUser(userId: string): Promise<void> {
    await this.request(`/users?id=eq.${userId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        is_blocked: false,
        blocked_reason: null,
        blocked_at: null,
      }),
    });
  }

  // ========== SUBSCRIPTIONS ==========

  async findLatestSubscriptionForUser(userId: string): Promise<Subscription | null> {
    const rows = await this.request<Subscription[]>(
      `/subscriptions?user_id=eq.${userId}&order=created_at.desc&limit=1`,
    );
    return rows[0] ?? null;
  }

  async findSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
    const rows = await this.request<Subscription[]>(
      `/subscriptions?stripe_subscription_id=eq.${stripeSubscriptionId}&limit=1`,
    );
    return rows[0] ?? null;
  }

  async createTrialSubscription(userId: string): Promise<Subscription> {
    const limits = PLAN_LIMITS.trial;
    const trialStart = new Date();
    const trialEnd = new Date(trialStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Update the user with trial dates in parallel
    await this.updateUser(userId, {
      trial_started_at: trialStart.toISOString(),
      trial_expires_at: trialEnd.toISOString(),
    });

    const rows = await this.request<Subscription[]>("/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        plan: "trial",
        status: "trialing",
        current_period_start: trialStart.toISOString(),
        current_period_end: trialEnd.toISOString(),
        max_devices: limits.max_devices,
        monthly_credit_allowance: limits.monthly_credit_allowance,
        credits_used_this_period: 0,
      }),
    });
    return rows[0];
  }

  async createPaidSubscription(params: {
    user_id: string;
    stripe_subscription_id: string;
    stripe_price_id: string;
    plan: Plan;
    status: string;
    current_period_start: string;
    current_period_end: string;
    cancel_at_period_end: boolean;
  }): Promise<Subscription> {
    const limits = PLAN_LIMITS[params.plan];
    const rows = await this.request<Subscription[]>("/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        user_id: params.user_id,
        stripe_subscription_id: params.stripe_subscription_id,
        stripe_price_id: params.stripe_price_id,
        plan: params.plan,
        status: params.status,
        current_period_start: params.current_period_start,
        current_period_end: params.current_period_end,
        cancel_at_period_end: params.cancel_at_period_end,
        max_devices: limits.max_devices,
        monthly_credit_allowance: limits.monthly_credit_allowance,
        credits_used_this_period: 0,
      }),
    });
    return rows[0];
  }

  async updateSubscription(subscriptionId: string, patch: Partial<Subscription>): Promise<Subscription | null> {
    const body: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
    const rows = await this.request<Subscription[]>(`/subscriptions?id=eq.${subscriptionId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return rows[0] ?? null;
  }

  async incrementSubscriptionCredits(subscriptionId: string, creditsDelta: number): Promise<number> {
    return await this.rpc<number>("increment_subscription_credits", {
      subscription_id_input: subscriptionId,
      credits_delta: creditsDelta,
    });
  }

  async resetSubscriptionCreditsForNewPeriod(subscriptionId: string, newPeriodEnd: string): Promise<void> {
    await this.request(`/subscriptions?id=eq.${subscriptionId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        credits_used_this_period: 0,
        current_period_end: newPeriodEnd,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  // ========== LICENSE CODES ==========

  async findLicenseByCode(code: string): Promise<LicenseCode | null> {
    const rows = await this.request<LicenseCode[]>(
      `/license_codes?code=eq.${encodeURIComponent(code)}&revoked_at=is.null&limit=1`,
    );
    return rows[0] ?? null;
  }

  async findLicensesByUserId(userId: string): Promise<LicenseCode[]> {
    return await this.request<LicenseCode[]>(
      `/license_codes?user_id=eq.${userId}&order=created_at.desc`,
    );
  }

  async createLicenseCode(userId: string, code: string): Promise<LicenseCode> {
    const rows = await this.request<LicenseCode[]>("/license_codes", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, code }),
    });
    return rows[0];
  }

  // ========== DEVICES ==========

  async findDevicesForUser(userId: string): Promise<Device[]> {
    return await this.request<Device[]>(`/devices?user_id=eq.${userId}&order=registered_at.desc`);
  }

  async findActiveDevicesForUser(userId: string): Promise<Device[]> {
    return await this.request<Device[]>(`/devices?user_id=eq.${userId}&is_blocked=eq.false`);
  }

  async findDeviceByFingerprint(userId: string, deviceFingerprint: string): Promise<Device | null> {
    const rows = await this.request<Device[]>(
      `/devices?user_id=eq.${userId}&device_fingerprint=eq.${encodeURIComponent(deviceFingerprint)}&limit=1`,
    );
    return rows[0] ?? null;
  }

  async findDeviceById(deviceId: string): Promise<Device | null> {
    const rows = await this.request<Device[]>(`/devices?id=eq.${deviceId}&limit=1`);
    return rows[0] ?? null;
  }

  async createDevice(params: {
    user_id: string;
    device_fingerprint: string;
    device_name?: string;
    os_version?: string;
    app_version?: string;
  }): Promise<Device> {
    const rows = await this.request<Device[]>("/devices", {
      method: "POST",
      body: JSON.stringify({
        user_id: params.user_id,
        device_fingerprint: params.device_fingerprint,
        device_name: params.device_name ?? null,
        os_version: params.os_version ?? null,
        app_version: params.app_version ?? null,
      }),
    });
    return rows[0];
  }

  async touchDeviceLastActive(deviceId: string): Promise<void> {
    await this.request(`/devices?id=eq.${deviceId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_active_at: new Date().toISOString() }),
    });
  }

  async blockDevice(deviceId: string, reason: string): Promise<void> {
    await this.request(`/devices?id=eq.${deviceId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        is_blocked: true,
        blocked_reason: reason,
        blocked_at: new Date().toISOString(),
      }),
    });
  }

  async unblockDevice(deviceId: string): Promise<void> {
    await this.request(`/devices?id=eq.${deviceId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        is_blocked: false,
        blocked_reason: null,
        blocked_at: null,
      }),
    });
  }

  // ========== SESSIONS ==========

  async createSession(params: {
    user_id: string;
    device_id: string;
    ip_address?: string;
    user_agent?: string;
  }): Promise<Session> {
    const rows = await this.request<Session[]>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        user_id: params.user_id,
        device_id: params.device_id,
        ip_address: params.ip_address ?? null,
        user_agent: params.user_agent ?? null,
      }),
    });
    return rows[0];
  }

  async updateSessionTokens(
    sessionId: string,
    deltas: {
      audio_input_tokens: number;
      audio_output_tokens: number;
      text_input_tokens?: number;
      text_output_tokens?: number;
      credits_consumed: number;
      estimated_cost_usd: number;
    },
  ): Promise<void> {
    // We store incrementally, but for simplicity we do a straight PATCH to absolute values.
    // The Durable Object holds the running totals and flushes them here.
    await this.request(`/sessions?id=eq.${sessionId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(deltas),
    });
  }

  async finalizeSession(sessionId: string, terminationReason: string): Promise<void> {
    await this.request(`/sessions?id=eq.${sessionId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        ended_at: new Date().toISOString(),
        termination_reason: terminationReason,
      }),
    });
  }

  async getRecentSessionsForUser(userId: string, limit = 20): Promise<Session[]> {
    return await this.request<Session[]>(
      `/sessions?user_id=eq.${userId}&order=started_at.desc&limit=${limit}`,
    );
  }

  // ========== DAILY USAGE ==========

  async incrementDailyUsage(userId: string, creditsDelta: number): Promise<number> {
    return await this.rpc<number>("increment_daily_usage", {
      user_id_input: userId,
      credits_delta: creditsDelta,
    });
  }

  async getDailyUsageForToday(userId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const rows = await this.request<Array<{ credits_consumed: number }>>(
      `/daily_usage?user_id=eq.${userId}&usage_date=eq.${today}&limit=1`,
    );
    return rows[0]?.credits_consumed ?? 0;
  }

  // ========== LANDING EVENTS ==========

  async logLandingEvent(params: {
    event_type: string;
    visitor_id?: string;
    user_id?: string;
    page?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.request("/landing_events", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        event_type: params.event_type,
        visitor_id: params.visitor_id ?? null,
        user_id: params.user_id ?? null,
        page: params.page ?? null,
        metadata: params.metadata ?? null,
      }),
    });
  }

  // ========== ADMIN ==========

  async refreshAdminStats(): Promise<void> {
    await this.rpc("refresh_admin_stats", {});
  }

  async searchUsersForAdmin(params: {
    searchTerm?: string;
    plan?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown[]> {
    const queryParts: string[] = ["order=user_created_at.desc"];
    if (params.searchTerm) {
      queryParts.push(`email=ilike.*${encodeURIComponent(params.searchTerm)}*`);
    }
    if (params.plan && params.plan !== "all") {
      queryParts.push(`plan=eq.${params.plan}`);
    }
    queryParts.push(`limit=${params.limit ?? 100}`);
    if (params.offset) queryParts.push(`offset=${params.offset}`);
    return await this.request<unknown[]>(`/admin_user_stats?${queryParts.join("&")}`);
  }

  async logAdminAction(params: {
    admin_email: string;
    action: string;
    target_user_id?: string;
    target_device_id?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.request("/admin_audit_log", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        admin_email: params.admin_email,
        action: params.action,
        target_user_id: params.target_user_id ?? null,
        target_device_id: params.target_device_id ?? null,
        reason: params.reason ?? null,
        metadata: params.metadata ?? null,
      }),
    });
  }
}
