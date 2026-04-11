// Atayi Sensei — thin fetch wrapper around the Cloudflare Worker API.
// Every page that needs to talk to the backend imports this module.
//
// The worker URL is hardcoded here for now. When we bind a custom domain
// (e.g. api.atayisensei.io), we change this single line and redeploy the
// landing page.

const WORKER_BASE_URL = "https://clicky-proxy.kevinyena9.workers.dev";

// Stable visitor id persisted in localStorage. Used by landing_events for
// basic funnel analytics without ever touching PII.
function getOrCreateVisitorId() {
  try {
    let visitorId = localStorage.getItem("atayi_visitor_id");
    if (!visitorId) {
      visitorId = "v_" + crypto.randomUUID();
      localStorage.setItem("atayi_visitor_id", visitorId);
    }
    return visitorId;
  } catch {
    return "v_unknown";
  }
}

async function postJSON(path, body, extraHeaders = {}) {
  const response = await fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const parsedBody = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body: parsedBody };
}

async function getJSON(path, extraHeaders = {}) {
  const response = await fetch(`${WORKER_BASE_URL}${path}`, {
    method: "GET",
    headers: extraHeaders,
  });
  const parsedBody = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body: parsedBody };
}

export const api = {
  workerBaseUrl: WORKER_BASE_URL,
  visitorId: getOrCreateVisitorId(),

  // ── Landing analytics ──────────────────────────────────────────
  async trackEvent(eventType, page, extraMetadata = {}) {
    return postJSON("/api/landing/event", {
      event_type: eventType,
      page,
      visitor_id: this.visitorId,
      metadata: extraMetadata,
    });
  },

  // ── Trial signup ───────────────────────────────────────────────
  async trialSignup(email) {
    return postJSON("/api/auth/trial-signup", {
      email,
      visitor_id: this.visitorId,
    });
  },

  // ── Stripe checkout ────────────────────────────────────────────
  async createCheckoutSession(plan, email) {
    return postJSON("/api/billing/checkout", {
      plan,
      email,
      origin: window.location.origin,
    });
  },

  async retrieveCheckoutSession(stripeSessionId) {
    return getJSON(`/api/billing/session/${encodeURIComponent(stripeSessionId)}`);
  },

  // ── Admin dashboard ────────────────────────────────────────────
  async adminLogin(password) {
    return postJSON("/api/admin/login", { password });
  },

  async adminStats(adminToken) {
    return getJSON("/api/admin/stats", {
      Authorization: `Bearer ${adminToken}`,
    });
  },

  async adminUsers(adminToken, { search, plan, limit, offset } = {}) {
    const queryParams = new URLSearchParams();
    if (search) queryParams.set("search", search);
    if (plan && plan !== "all") queryParams.set("plan", plan);
    if (limit) queryParams.set("limit", limit.toString());
    if (offset) queryParams.set("offset", offset.toString());
    return getJSON(`/api/admin/users?${queryParams.toString()}`, {
      Authorization: `Bearer ${adminToken}`,
    });
  },

  async adminUserDetail(adminToken, userId) {
    return getJSON(`/api/admin/user/${userId}`, {
      Authorization: `Bearer ${adminToken}`,
    });
  },

  async adminBlockUser(adminToken, userId, reason) {
    return postJSON(
      "/api/admin/block-user",
      { user_id: userId, reason },
      { Authorization: `Bearer ${adminToken}` },
    );
  },

  async adminUnblockUser(adminToken, userId) {
    return postJSON(
      "/api/admin/unblock-user",
      { user_id: userId },
      { Authorization: `Bearer ${adminToken}` },
    );
  },

  async adminBlockDevice(adminToken, deviceId, reason) {
    return postJSON(
      "/api/admin/block-device",
      { device_id: deviceId, reason },
      { Authorization: `Bearer ${adminToken}` },
    );
  },

  async adminUnblockDevice(adminToken, deviceId) {
    return postJSON(
      "/api/admin/unblock-device",
      { device_id: deviceId },
      { Authorization: `Bearer ${adminToken}` },
    );
  },
};
