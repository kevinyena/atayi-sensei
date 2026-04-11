// Atayi Sensei — admin dashboard logic.
// Renders the stats tiles, user list with filters, and per-user drawer with
// block actions. All data comes from /api/admin/* which requires the admin
// JWT stored in localStorage after admin-login.html.

import { api } from "./api.js";

const adminToken = localStorage.getItem("atayi_admin_token");
if (!adminToken) {
  window.location.replace("/admin-login.html");
}

const statsGrid = document.getElementById("statsGrid");
const usersBody = document.getElementById("usersBody");
const searchInput = document.getElementById("searchInput");
const planFilter = document.getElementById("planFilter");
const userDrawer = document.getElementById("userDrawer");
const drawerContent = document.getElementById("drawerContent");
const logoutButton = document.getElementById("logoutButton");

let debounceTimerId;

// ── Stats tiles ──────────────────────────────────────────────────────
async function loadStats() {
  const response = await api.adminStats(adminToken);
  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("atayi_admin_token");
      window.location.replace("/admin-login.html");
      return;
    }
    statsGrid.innerHTML = `<div class="admin-stat-card"><div class="label">Error</div><div class="value" style="font-size:14px;">${response.body.message || "failed"}</div></div>`;
    return;
  }
  const stats = response.body;
  statsGrid.innerHTML = `
    ${renderStatCard("Today's visits", stats.today_visits ?? 0, "page views")}
    ${renderStatCard("Downloads today", stats.today_downloads ?? 0, "click events")}
    ${renderStatCard("Checkouts today", stats.today_checkouts ?? 0, "completed")}
    ${renderStatCard("Total users", stats.total_users ?? 0, "all time")}
    ${renderStatCard(
      "Active subs",
      (stats.active_subscriptions?.total ?? 0).toString(),
      `${stats.active_subscriptions?.starter ?? 0} starter · ${stats.active_subscriptions?.ultra ?? 0} ultra`,
    )}
    ${renderStatCard("Trials in progress", stats.trials_in_progress ?? 0, "")}
    ${renderStatCard("MRR (est.)", `$${stats.estimated_mrr_usd ?? 0}`, "monthly")}
  `;
}

function renderStatCard(label, value, sub) {
  return `
    <div class="admin-stat-card">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ""}
    </div>
  `;
}

// ── Users table ──────────────────────────────────────────────────────
async function loadUsers() {
  const response = await api.adminUsers(adminToken, {
    search: searchInput.value.trim(),
    plan: planFilter.value,
    limit: 200,
  });
  if (!response.ok) {
    usersBody.innerHTML = `<tr><td colspan="6" style="color:#f87171;">Error: ${response.body.message || "failed"}</td></tr>`;
    return;
  }
  const users = response.body.users || [];
  if (users.length === 0) {
    usersBody.innerHTML = `<tr><td colspan="6" style="color:rgba(255,255,255,0.4); padding:20px; text-align:center;">No users match your filters.</td></tr>`;
    return;
  }
  usersBody.innerHTML = users.map(renderUserRow).join("");

  // Wire click handlers for drawer
  document.querySelectorAll(".user-row").forEach((row) => {
    row.addEventListener("click", () => {
      const userId = row.getAttribute("data-user-id");
      openUserDrawer(userId);
    });
  });
}

function renderUserRow(user) {
  const plan = user.plan || "trial";
  const used = user.credits_used_this_period ?? 0;
  const allowance = user.monthly_credit_allowance ?? 1;
  const usagePct = Math.min(100, (used / allowance) * 100);
  const fillClass = usagePct > 90 ? "danger" : usagePct > 75 ? "warning" : "";
  const status = user.subscription_status || "unknown";
  const lastActive = user.last_device_activity
    ? new Date(user.last_device_activity).toLocaleString()
    : "—";

  return `
    <tr class="user-row" data-user-id="${user.id}">
      <td><strong>${escapeHTML(user.email)}</strong></td>
      <td><span class="plan-badge ${plan}">${plan}</span></td>
      <td>
        <div style="font-size:11px; color:rgba(255,255,255,0.6); margin-bottom:3px;">${used.toLocaleString()} / ${allowance.toLocaleString()}</div>
        <div class="credits-bar"><div class="fill ${fillClass}" style="width: ${usagePct}%;"></div></div>
      </td>
      <td>${user.active_devices ?? 0} / ${user.max_devices ?? 1}</td>
      <td style="color:rgba(255,255,255,0.6); font-size:12px;">${lastActive}</td>
      <td>
        ${user.user_is_blocked ? '<span class="blocked-tag">BLOCKED</span>' : `<span class="status-dot ${status}"></span>${status}`}
      </td>
    </tr>
  `;
}

// ── User drawer (single user detail) ─────────────────────────────────
async function openUserDrawer(userId) {
  drawerContent.innerHTML = '<div style="padding:40px 0; text-align:center;"><span class="atayi-spinner"></span></div>';
  userDrawer.classList.add("open");

  const response = await api.adminUserDetail(adminToken, userId);
  if (!response.ok) {
    drawerContent.innerHTML = `<div style="color:#f87171;">Error: ${response.body.message || "failed"}</div>`;
    return;
  }

  const { user, subscription, devices, recent_sessions } = response.body;

  drawerContent.innerHTML = `
    <h2>${escapeHTML(user.email)}</h2>
    <div class="email">User ID: <code>${user.id}</code></div>

    <div class="drawer-section">
      <h3>Subscription</h3>
      ${
        subscription
          ? `<div class="device-row">
              <div><span class="plan-badge ${subscription.plan}">${subscription.plan}</span> <span style="color:rgba(255,255,255,0.5);">${subscription.status}</span></div>
              <div style="margin-top:6px; font-size:11px; color:rgba(255,255,255,0.6);">
                ${subscription.credits_used_this_period} / ${subscription.monthly_credit_allowance} credits used
              </div>
              ${subscription.current_period_end ? `<div style="margin-top:3px; font-size:11px; color:rgba(255,255,255,0.4);">Period ends: ${new Date(subscription.current_period_end).toLocaleString()}</div>` : ""}
            </div>`
          : '<div style="color:rgba(255,255,255,0.4); font-size:12px;">No active subscription</div>'
      }
    </div>

    <div class="drawer-section">
      <h3>Devices (${devices.length})</h3>
      ${devices
        .map(
          (d) => `
        <div class="device-row">
          <div><strong>${escapeHTML(d.device_name || "Unknown Mac")}</strong></div>
          <div style="font-size:10px; color:rgba(255,255,255,0.4); margin-top:2px;">${d.os_version || "?"} · app ${d.app_version || "?"}</div>
          <div style="font-size:10px; color:rgba(255,255,255,0.4);">fingerprint: <code>${d.device_fingerprint.slice(0, 12)}…</code></div>
          <div style="margin-top:8px; display:flex; gap:6px; align-items:center;">
            ${
              d.is_blocked
                ? `<span class="blocked-tag">BLOCKED</span><button class="btn-small" onclick="window.unblockDevice('${d.id}')">Unblock</button>`
                : `<button class="btn-small danger" onclick="window.blockDevice('${d.id}')">Block this device</button>`
            }
          </div>
        </div>
      `,
        )
        .join("")}
    </div>

    <div class="drawer-section">
      <h3>Recent sessions (${recent_sessions.length})</h3>
      ${recent_sessions
        .slice(0, 10)
        .map(
          (s) => `
        <div class="session-row">
          <div>${new Date(s.started_at).toLocaleString()}</div>
          <div style="font-size:10px; color:rgba(255,255,255,0.4); margin-top:2px;">
            ${s.credits_consumed} credits · $${parseFloat(s.estimated_cost_usd ?? "0").toFixed(4)} · ${s.termination_reason || "active"}
          </div>
        </div>
      `,
        )
        .join("") || '<div style="color:rgba(255,255,255,0.4); font-size:12px;">No sessions yet</div>'}
    </div>

    <div class="drawer-section">
      <h3>Account actions</h3>
      ${
        user.is_blocked
          ? `<button class="btn-small" onclick="window.unblockUser('${user.id}')">Unblock user</button>`
          : `<button class="btn-small danger" onclick="window.blockUser('${user.id}')">Block user (all devices)</button>`
      }
    </div>
  `;
}

// ── Block / unblock action handlers (exposed on window for inline onclick) ──
window.blockUser = async (userId) => {
  const reason = prompt("Reason for blocking this user:", "");
  if (reason === null) return;
  await api.adminBlockUser(adminToken, userId, reason || "admin block");
  await loadUsers();
  openUserDrawer(userId);
};

window.unblockUser = async (userId) => {
  await api.adminUnblockUser(adminToken, userId);
  await loadUsers();
  openUserDrawer(userId);
};

window.blockDevice = async (deviceId) => {
  const reason = prompt("Reason for blocking this device:", "");
  if (reason === null) return;
  await api.adminBlockDevice(adminToken, deviceId, reason || "admin block");
  // Refresh the currently open drawer
  const openUserRow = document.querySelector(".user-row[data-user-id]");
  const currentUserId = document.querySelector(".admin-drawer.open [data-user-id]")?.getAttribute("data-user-id");
  if (currentUserId) await openUserDrawer(currentUserId);
};

window.unblockDevice = async (deviceId) => {
  await api.adminUnblockDevice(adminToken, deviceId);
  // Refresh drawer
  const currentUserId = document.querySelector(".admin-drawer.open [data-user-id]")?.getAttribute("data-user-id");
  if (currentUserId) await openUserDrawer(currentUserId);
};

// ── Search + filter debouncing ───────────────────────────────────────
searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimerId);
  debounceTimerId = setTimeout(loadUsers, 250);
});

planFilter.addEventListener("change", loadUsers);

// ── Logout ───────────────────────────────────────────────────────────
logoutButton.addEventListener("click", () => {
  localStorage.removeItem("atayi_admin_token");
  window.location.replace("/admin-login.html");
});

// ── Utilities ────────────────────────────────────────────────────────
function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Initial load + periodic refresh (every 30s) ──────────────────────
loadStats();
loadUsers();
setInterval(loadStats, 30_000);
setInterval(loadUsers, 30_000);
