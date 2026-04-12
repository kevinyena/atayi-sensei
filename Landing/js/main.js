// Atayi Sensei — landing page main script.
// Flow: Download button → Plan Chooser → Create Account (Google + email/pwd) → OTP → Stripe or Trial Success

import { api } from "./api.js?v=3";

const GOOGLE_CLIENT_ID = "665011541151-pglu1e7pij41rsboli7e8pshopekf0gq.apps.googleusercontent.com";

let selectedPlatform = "mac";

let authState = {
  email: "",
  sessionToken: null,
  userId: null,
  licenseCode: null,
  plan: null,
  selectedPlan: null, // the plan the user picked in the plan chooser
};

api.trackEvent("page_view", "index").catch(() => {});

// ──────────────────────────────────────────────────────────────
// Google Sign-In SDK
// ──────────────────────────────────────────────────────────────

let googleScriptLoaded = false;

function loadGoogleSignInScript() {
  if (googleScriptLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => { googleScriptLoaded = true; resolve(); };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ──────────────────────────────────────────────────────────────
// Modal shell
// ──────────────────────────────────────────────────────────────

function getOrCreateModalOverlay() {
  let overlay = document.getElementById("atayi-auth-modal");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "atayi-auth-modal";
  overlay.style.cssText = `
    position:fixed;inset:0;
    background:rgba(0,0,0,0.85);backdrop-filter:blur(12px);
    display:flex;align-items:center;justify-content:center;
    z-index:10000;opacity:0;transition:opacity 0.25s ease;
  `;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.style.opacity = "1"; });
  return overlay;
}

function setModalContent(html, maxWidth = "440px") {
  const overlay = getOrCreateModalOverlay();
  overlay.innerHTML = `
    <div style="
      background:#0f1011;border:1px solid rgba(255,255,255,0.08);
      border-radius:20px;padding:32px 28px 28px;
      max-width:${maxWidth};width:calc(100% - 32px);
      box-shadow:0 24px 80px rgba(0,0,0,0.6);
      font-family:system-ui,-apple-system,sans-serif;color:white;
    ">${html}</div>
  `;
}

function closeModal() {
  const overlay = document.getElementById("atayi-auth-modal");
  if (!overlay) return;
  overlay.style.opacity = "0";
  setTimeout(() => overlay.remove(), 250);
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.style.display = "block"; }
}

function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}

// ──────────────────────────────────────────────────────────────
// Screen 1: Plan Chooser (FIRST screen)
// ──────────────────────────────────────────────────────────────

function renderPlanCard({ key, title, price, period = "", subtitle, features, ctaLabel, accent, isPopular = false }) {
  return `
    <div data-plan-key="${key}" style="
      background:#15171a;
      border:1px solid ${isPopular ? accent : "rgba(255,255,255,0.08)"};
      border-radius:14px;padding:20px 18px;position:relative;
      display:flex;flex-direction:column;cursor:pointer;
      transition:transform 0.15s ease, border-color 0.15s ease;
    "
    onmouseover="this.style.transform='translateY(-2px)';this.style.borderColor='${accent}';"
    onmouseout="this.style.transform='translateY(0)';this.style.borderColor='${isPopular ? accent : "rgba(255,255,255,0.08)"}';">
      ${isPopular ? `<div style="position:absolute;top:-10px;left:0;right:0;display:flex;justify-content:center;"><span style="background:${accent};color:black;font-size:10px;font-weight:700;padding:3px 10px;border-radius:99px;letter-spacing:0.5px;">MOST POPULAR</span></div>` : ""}
      <div style="font-size:14px;color:rgba(255,255,255,0.6);margin-bottom:4px;">${title}</div>
      <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:2px;">
        <span style="font-size:28px;font-weight:700;color:white;">${price}</span>
        <span style="font-size:13px;color:rgba(255,255,255,0.5);">${period}</span>
      </div>
      <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:14px;">${subtitle}</div>
      <ul style="list-style:none;padding:0;margin:0 0 16px;flex:1;">
        ${features.map(f => `<li style="font-size:12px;color:rgba(255,255,255,0.7);padding:4px 0;display:flex;align-items:start;"><span style="color:${accent};margin-right:6px;">&#10003;</span>${f}</li>`).join("")}
      </ul>
      <button class="atayi-plan-cta" data-plan-key="${key}" style="
        background:${accent};color:${accent === "#eab308" ? "black" : "white"};border:none;
        padding:10px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;
        transition:filter 0.15s;
      "
      onmouseover="this.style.filter='brightness(1.1)';"
      onmouseout="this.style.filter='brightness(1)';"
      >${ctaLabel}</button>
    </div>
  `;
}

function showPlanChooserScreen() {
  const overlay = getOrCreateModalOverlay();
  overlay.innerHTML = `
    <div style="
      background:#0f1011;border:1px solid rgba(255,255,255,0.08);
      border-radius:20px;padding:32px 28px 28px;
      max-width:720px;width:calc(100% - 32px);
      box-shadow:0 24px 80px rgba(0,0,0,0.6);
      font-family:system-ui,-apple-system,sans-serif;color:white;
    ">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:22px;">
        <div>
          <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;">How do you want to start?</h2>
          <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.6);">Pick a plan or try for 7 days on us.</p>
        </div>
        <button id="atayi-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:0;width:32px;height:32px;border-radius:8px;">&#215;</button>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
        ${renderPlanCard({
          key: "trial",
          title: "Free trial",
          price: "7 days free",
          subtitle: "15 min / day of talk time",
          features: [selectedPlatform === "windows" ? "1 PC" : "1 Mac", "Full feature access", "No credit card"],
          ctaLabel: "Start free trial",
          accent: "#3b82f6",
        })}
        ${renderPlanCard({
          key: "starter",
          title: "Starter",
          price: "$19",
          period: "/ month",
          subtitle: "~11 hours of talk time",
          features: [selectedPlatform === "windows" ? "1 PC" : "1 Mac", "40 000 Atayi credits / month", "Cancel anytime"],
          ctaLabel: "Choose Starter",
          accent: "#eab308",
        })}
        ${renderPlanCard({
          key: "ultra",
          title: "Ultra",
          price: "$49",
          period: "/ month",
          subtitle: "~44 hours of talk time",
          features: [selectedPlatform === "windows" ? "Up to 3 PCs shared" : "Up to 3 Macs shared", "160 000 Atayi credits / month", "Priority support"],
          ctaLabel: "Choose Ultra",
          accent: "#a855f7",
          isPopular: true,
        })}
      </div>

      <p style="margin:20px 0 0;font-size:11px;color:rgba(255,255,255,0.4);text-align:center;">
        Already have an account? <a href="#" id="atayi-login-link" style="color:#60a5fa;text-decoration:none;">Log in</a>
      </p>
    </div>
  `;

  document.getElementById("atayi-close").addEventListener("click", closeModal);
  document.getElementById("atayi-login-link").addEventListener("click", (e) => {
    e.preventDefault();
    showLoginScreen();
  });

  overlay.querySelectorAll(".atayi-plan-cta").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const planKey = button.getAttribute("data-plan-key");
      authState.selectedPlan = planKey;
      api.trackEvent("plan_selected", "index", { plan: planKey, platform: selectedPlatform }).catch(() => {});
      showCreateAccountScreen();
    });
  });

  api.trackEvent("modal_open", "index", { source: "download_button" }).catch(() => {});
}

// ──────────────────────────────────────────────────────────────
// Screen 2: Create Account (Google + email/password)
// ──────────────────────────────────────────────────────────────

function getPlanLabel() {
  if (authState.selectedPlan === "ultra") return "Ultra ($49/mo)";
  if (authState.selectedPlan === "starter") return "Starter ($19/mo)";
  return "Free Trial";
}

function showCreateAccountScreen() {
  setModalContent(`
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:20px;">
      <div>
        <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;">Create your account</h2>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.6);">Plan: ${getPlanLabel()}</p>
      </div>
      <button id="atayi-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:0;width:32px;height:32px;border-radius:8px;">&#215;</button>
    </div>

    <button id="atayi-google-btn" style="
      width:100%;display:flex;align-items:center;justify-content:center;gap:10px;
      background:white;color:#333;border:none;border-radius:10px;
      padding:12px 16px;font-size:14px;font-weight:600;cursor:pointer;
      transition:filter 0.15s;font-family:inherit;
    ">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Sign up with Google
    </button>

    <div style="display:flex;align-items:center;gap:12px;margin:18px 0;">
      <div style="flex:1;height:1px;background:rgba(255,255,255,0.1);"></div>
      <span style="font-size:12px;color:rgba(255,255,255,0.4);">or</span>
      <div style="flex:1;height:1px;background:rgba(255,255,255,0.1);"></div>
    </div>

    <label style="display:block;font-size:12px;color:rgba(255,255,255,0.7);margin-bottom:6px;font-weight:500;">Email</label>
    <input type="email" id="atayi-email" placeholder="you@example.com" style="
      width:100%;background:#15171a;border:1px solid rgba(255,255,255,0.08);
      border-radius:10px;padding:12px 14px;color:white;font-size:14px;
      outline:none;margin-bottom:12px;box-sizing:border-box;
    " />

    <label style="display:block;font-size:12px;color:rgba(255,255,255,0.7);margin-bottom:6px;font-weight:500;">Password</label>
    <input type="password" id="atayi-password" placeholder="8+ characters" style="
      width:100%;background:#15171a;border:1px solid rgba(255,255,255,0.08);
      border-radius:10px;padding:12px 14px;color:white;font-size:14px;
      outline:none;margin-bottom:16px;box-sizing:border-box;
    " />

    <button id="atayi-signup-btn" style="
      width:100%;background:#3b82f6;color:white;border:none;padding:13px;
      border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;
    ">Create account</button>

    <div id="atayi-signup-error" style="
      display:none;margin-top:12px;background:rgba(239,68,68,0.1);
      border:1px solid rgba(239,68,68,0.3);border-radius:8px;
      padding:10px 12px;font-size:13px;color:#f87171;
    "></div>

    <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.4);text-align:center;">
      <a href="#" id="atayi-back-link" style="color:#60a5fa;text-decoration:none;">&#8592; Back to plans</a>
    </p>
  `);

  document.getElementById("atayi-close").addEventListener("click", closeModal);
  document.getElementById("atayi-back-link").addEventListener("click", (e) => {
    e.preventDefault();
    showPlanChooserScreen();
  });
  document.getElementById("atayi-signup-btn").addEventListener("click", handleEmailSignup);
  document.getElementById("atayi-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleEmailSignup();
  });
  document.getElementById("atayi-google-btn").addEventListener("click", handleGoogleSignIn);
}

async function handleEmailSignup() {
  const emailInput = document.getElementById("atayi-email");
  const passwordInput = document.getElementById("atayi-password");
  const submitBtn = document.getElementById("atayi-signup-btn");

  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError("atayi-signup-error", "Please enter a valid email address.");
    return;
  }
  if (password.length < 8) {
    showError("atayi-signup-error", "Password must be at least 8 characters.");
    return;
  }

  hideError("atayi-signup-error");
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating account\u2026";

  try {
    const response = await api.signup(email, password);
    if (response.ok) {
      authState.email = email;
      showOTPScreen();
    } else {
      showError("atayi-signup-error", response.body.message || "Signup failed. Try again.");
    }
  } catch (error) {
    showError("atayi-signup-error", error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create account";
  }
}

async function handleGoogleSignIn() {
  const btn = document.getElementById("atayi-google-btn");
  btn.disabled = true;
  btn.textContent = "Loading\u2026";

  try {
    await loadGoogleSignInScript();

    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredentialResponse,
      auto_select: false,
    });

    // Render a hidden button and click it to trigger the popup
    let container = document.getElementById("atayi-google-hidden");
    if (!container) {
      container = document.createElement("div");
      container.id = "atayi-google-hidden";
      container.style.cssText = "position:fixed;top:-9999px;left:-9999px;";
      document.body.appendChild(container);
    }
    google.accounts.id.renderButton(container, { type: "icon", size: "large" });

    const innerBtn = container.querySelector('[role="button"]') || container.querySelector("div");
    if (innerBtn) innerBtn.click();

    // Fallback to prompt
    setTimeout(() => { google.accounts.id.prompt(); }, 500);
  } catch {
    showError("atayi-signup-error", "Could not load Google Sign-In. Try email instead.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Sign up with Google
    `;
  }
}

async function handleGoogleCredentialResponse(response) {
  if (!response.credential) return;

  setModalContent(`
    <div style="text-align:center;padding:40px 0;">
      <div style="display:inline-block;width:24px;height:24px;border:2px solid rgba(255,255,255,0.2);border-top-color:white;border-radius:50%;animation:atayi-spin 0.8s linear infinite;"></div>
      <p style="margin-top:16px;font-size:14px;color:rgba(255,255,255,0.7);">Signing in with Google\u2026</p>
      <style>@keyframes atayi-spin { to { transform:rotate(360deg); } }</style>
    </div>
  `);

  try {
    const plan = authState.selectedPlan || "trial";
    const result = await api.googleAuth(response.credential, plan);
    if (result.ok) {
      authState.email = result.body.email;
      authState.sessionToken = result.body.session_token;
      authState.userId = result.body.user_id;
      authState.licenseCode = result.body.license_code;
      authState.plan = result.body.plan;
      localStorage.setItem("atayi_session_token", result.body.session_token);

      proceedAfterAuth();
    } else {
      showCreateAccountScreen();
      setTimeout(() => showError("atayi-signup-error", result.body.message || "Google sign-in failed"), 100);
    }
  } catch (error) {
    showCreateAccountScreen();
    setTimeout(() => showError("atayi-signup-error", error.message), 100);
  }
}

// ──────────────────────────────────────────────────────────────
// Screen 2b: Login (existing users)
// ──────────────────────────────────────────────────────────────

function showLoginScreen() {
  setModalContent(`
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:20px;">
      <div>
        <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;">Welcome back</h2>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.6);">Log in to your account.</p>
      </div>
      <button id="atayi-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:0;width:32px;height:32px;border-radius:8px;">&#215;</button>
    </div>

    <button id="atayi-google-btn" style="
      width:100%;display:flex;align-items:center;justify-content:center;gap:10px;
      background:white;color:#333;border:none;border-radius:10px;
      padding:12px 16px;font-size:14px;font-weight:600;cursor:pointer;
      transition:filter 0.15s;font-family:inherit;
    ">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Sign in with Google
    </button>

    <div style="display:flex;align-items:center;gap:12px;margin:18px 0;">
      <div style="flex:1;height:1px;background:rgba(255,255,255,0.1);"></div>
      <span style="font-size:12px;color:rgba(255,255,255,0.4);">or</span>
      <div style="flex:1;height:1px;background:rgba(255,255,255,0.1);"></div>
    </div>

    <label style="display:block;font-size:12px;color:rgba(255,255,255,0.7);margin-bottom:6px;font-weight:500;">Email</label>
    <input type="email" id="atayi-email" placeholder="you@example.com" style="
      width:100%;background:#15171a;border:1px solid rgba(255,255,255,0.08);
      border-radius:10px;padding:12px 14px;color:white;font-size:14px;
      outline:none;margin-bottom:12px;box-sizing:border-box;
    " />

    <label style="display:block;font-size:12px;color:rgba(255,255,255,0.7);margin-bottom:6px;font-weight:500;">Password</label>
    <input type="password" id="atayi-password" placeholder="your password" style="
      width:100%;background:#15171a;border:1px solid rgba(255,255,255,0.08);
      border-radius:10px;padding:12px 14px;color:white;font-size:14px;
      outline:none;margin-bottom:16px;box-sizing:border-box;
    " />

    <button id="atayi-login-btn" style="
      width:100%;background:#3b82f6;color:white;border:none;padding:13px;
      border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;
    ">Log in</button>

    <div id="atayi-login-error" style="
      display:none;margin-top:12px;background:rgba(239,68,68,0.1);
      border:1px solid rgba(239,68,68,0.3);border-radius:8px;
      padding:10px 12px;font-size:13px;color:#f87171;
    "></div>

    <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.4);text-align:center;">
      Don't have an account? <a href="#" id="atayi-back-link" style="color:#60a5fa;text-decoration:none;">&#8592; Back to plans</a>
    </p>
  `);

  document.getElementById("atayi-close").addEventListener("click", closeModal);
  document.getElementById("atayi-back-link").addEventListener("click", (e) => {
    e.preventDefault();
    showPlanChooserScreen();
  });
  document.getElementById("atayi-login-btn").addEventListener("click", handleEmailLogin);
  document.getElementById("atayi-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleEmailLogin();
  });
  document.getElementById("atayi-google-btn").addEventListener("click", handleGoogleSignIn);
}

async function handleEmailLogin() {
  const email = document.getElementById("atayi-email").value.trim().toLowerCase();
  const password = document.getElementById("atayi-password").value;
  const submitBtn = document.getElementById("atayi-login-btn");

  if (!email || !password) {
    showError("atayi-login-error", "Enter your email and password.");
    return;
  }

  hideError("atayi-login-error");
  submitBtn.disabled = true;
  submitBtn.textContent = "Logging in\u2026";

  try {
    const response = await api.login(email, password);
    if (response.ok) {
      authState.email = email;
      authState.sessionToken = response.body.session_token;
      authState.userId = response.body.user_id;
      authState.licenseCode = response.body.license_code;
      authState.plan = response.body.plan;
      localStorage.setItem("atayi_session_token", response.body.session_token);
      showSuccessScreen();
    } else {
      if (response.body.error === "email_not_verified") {
        authState.email = email;
        showOTPScreen();
      } else {
        showError("atayi-login-error", response.body.message || "Login failed.");
      }
    }
  } catch (error) {
    showError("atayi-login-error", error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Log in";
  }
}

// ──────────────────────────────────────────────────────────────
// Screen 3: OTP Verification
// ──────────────────────────────────────────────────────────────

function showOTPScreen() {
  setModalContent(`
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:20px;">
      <div>
        <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;">Check your email</h2>
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.6);">
          We sent a 6-digit code to <strong style="color:white;">${authState.email}</strong>
        </p>
      </div>
      <button id="atayi-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:0;width:32px;height:32px;border-radius:8px;">&#215;</button>
    </div>

    <label style="display:block;font-size:12px;color:rgba(255,255,255,0.7);margin-bottom:6px;font-weight:500;">Verification code</label>
    <input type="text" id="atayi-otp" placeholder="000000" maxlength="6" inputmode="numeric" pattern="[0-9]*" style="
      width:100%;background:#15171a;border:1px solid rgba(255,255,255,0.08);
      border-radius:10px;padding:14px 16px;color:white;font-size:20px;
      font-weight:600;letter-spacing:6px;text-align:center;
      outline:none;margin-bottom:16px;box-sizing:border-box;
    " autofocus />

    <button id="atayi-verify-btn" style="
      width:100%;background:#3b82f6;color:white;border:none;padding:13px;
      border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;
    ">Verify</button>

    <div id="atayi-otp-error" style="
      display:none;margin-top:12px;background:rgba(239,68,68,0.1);
      border:1px solid rgba(239,68,68,0.3);border-radius:8px;
      padding:10px 12px;font-size:13px;color:#f87171;
    "></div>

    <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.4);text-align:center;">
      Didn't get the code? <a href="#" id="atayi-resend-link" style="color:#60a5fa;text-decoration:none;">Resend</a>
      &nbsp;&#183;&nbsp; Check your spam folder
    </p>
  `);

  document.getElementById("atayi-close").addEventListener("click", closeModal);
  document.getElementById("atayi-verify-btn").addEventListener("click", handleVerifyOTP);
  document.getElementById("atayi-otp").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleVerifyOTP();
  });
  document.getElementById("atayi-resend-link").addEventListener("click", async (e) => {
    e.preventDefault();
    const link = e.target;
    link.textContent = "Sending\u2026";
    try {
      await api.resendOTP(authState.email);
      link.textContent = "Sent! Check your inbox";
      setTimeout(() => { link.textContent = "Resend"; }, 5000);
    } catch {
      link.textContent = "Failed \u2014 try again";
    }
  });
}

async function handleVerifyOTP() {
  const code = document.getElementById("atayi-otp").value.trim();
  const submitBtn = document.getElementById("atayi-verify-btn");

  if (!code || code.length !== 6) {
    showError("atayi-otp-error", "Enter the 6-digit code from your email.");
    return;
  }

  hideError("atayi-otp-error");
  submitBtn.disabled = true;
  submitBtn.textContent = "Verifying\u2026";

  try {
    const plan = authState.selectedPlan || "trial";
    const response = await api.verifyOTP(authState.email, code, plan);
    if (response.ok) {
      authState.sessionToken = response.body.session_token;
      authState.userId = response.body.user_id;
      authState.licenseCode = response.body.license_code;
      authState.plan = response.body.plan;
      localStorage.setItem("atayi_session_token", response.body.session_token);

      proceedAfterAuth();
    } else {
      showError("atayi-otp-error", response.body.message || "Invalid code.");
    }
  } catch (error) {
    showError("atayi-otp-error", error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Verify";
  }
}

// ──────────────────────────────────────────────────────────────
// Post-auth routing: trial → success, paid → Stripe
// ──────────────────────────────────────────────────────────────

async function proceedAfterAuth() {
  const plan = authState.selectedPlan;

  if (plan === "starter" || plan === "ultra") {
    // Redirect to Stripe Checkout
    setModalContent(`
      <div style="text-align:center;padding:40px 0;">
        <div style="display:inline-block;width:24px;height:24px;border:2px solid rgba(255,255,255,0.2);border-top-color:white;border-radius:50%;animation:atayi-spin 0.8s linear infinite;"></div>
        <p style="margin-top:16px;font-size:14px;color:rgba(255,255,255,0.7);">Redirecting to Stripe\u2026</p>
        <style>@keyframes atayi-spin { to { transform:rotate(360deg); } }</style>
      </div>
    `);

    try {
      localStorage.setItem("atayi_checkout_platform", selectedPlatform);
      const response = await api.createCheckoutSession(plan, authState.email);
      if (response.ok && response.body.checkout_url) {
        window.location.href = response.body.checkout_url;
      } else {
        throw new Error(response.body.message || "Could not start checkout");
      }
    } catch (error) {
      setModalContent(`
        <div style="text-align:center;padding:24px 0;">
          <div style="font-size:30px;margin-bottom:12px;">&#9888;&#65039;</div>
          <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;">Payment error</h2>
          <p style="margin:0 0 16px;font-size:13px;color:rgba(255,255,255,0.6);">${error.message}</p>
          <button onclick="document.getElementById('atayi-auth-modal').remove()" style="
            background:#3b82f6;color:white;border:none;padding:11px 24px;
            border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;
          ">Close</button>
        </div>
      `);
    }
  } else {
    // Trial — show success screen
    showSuccessScreen();
  }
}

// ──────────────────────────────────────────────────────────────
// Screen 4: Success (trial activated — download + email notice)
// ──────────────────────────────────────────────────────────────

function showSuccessScreen() {
  const downloadUrl = selectedPlatform === "windows"
    ? "https://github.com/kevinyena/atayi-sensei/releases/download/v1.0.0/Atayi.Sensei.exe"
    : "/downloads/Atayi-Sensei-1.0.dmg";
  const downloadLabel = selectedPlatform === "windows" ? "Download for Windows" : "Download for macOS";

  setModalContent(`
    <div style="text-align:center;">
      <div style="font-size:40px;margin-bottom:12px;">&#127881;</div>
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;">You're all set!</h2>
      <p style="margin:0 0 24px;font-size:13px;color:rgba(255,255,255,0.6);">
        Your account has been created. Download the app and start talking to your AI Sensei.
      </p>

      <a href="${downloadUrl}" download style="
        display:block;width:100%;background:#111;color:white;border:none;
        border-radius:10px;padding:13px;font-size:14px;font-weight:600;
        cursor:pointer;text-align:center;text-decoration:none;
        box-sizing:border-box;margin-bottom:14px;
      ">${downloadLabel}</a>

      <div style="
        background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.25);
        border-radius:10px;padding:14px 16px;font-size:13px;color:#93c5fd;
        line-height:1.5;text-align:left;
      ">
        Your license code has been sent to <strong style="color:white;">${authState.email}</strong>.<br/>
        Check your spam folder if you don't see it within a few minutes.
      </div>

      <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.4);">
        <a href="/account.html" style="color:#60a5fa;text-decoration:none;">Manage your account</a>
      </p>
    </div>
  `);

  // Auto-trigger download after a short delay
  setTimeout(() => {
    const tempLink = document.createElement("a");
    tempLink.href = downloadUrl;
    tempLink.setAttribute("download", "");
    tempLink.style.display = "none";
    document.body.appendChild(tempLink);
    tempLink.click();
    document.body.removeChild(tempLink);
  }, 1500);
}

// ──────────────────────────────────────────────────────────────
// Wire up download buttons
// ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const macDownloadButton = document.getElementById("downloadMacBtn");
  if (macDownloadButton) {
    macDownloadButton.addEventListener("click", (event) => {
      event.preventDefault();
      selectedPlatform = "mac";
      showPlanChooserScreen();
    });
  }

  const winDownloadButton = document.getElementById("downloadWinBtn");
  if (winDownloadButton) {
    winDownloadButton.addEventListener("click", (event) => {
      event.preventDefault();
      selectedPlatform = "windows";
      showPlanChooserScreen();
    });
  }
});
