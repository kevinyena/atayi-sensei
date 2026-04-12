// Atayi Sensei — landing page main script.
// Wires up the download button to open a plan-chooser modal, fires a
// page_view analytics event, and redirects to the right follow-up page
// based on what the user picks.

import { api } from "./api.js";

// Track the landing page view immediately on load.
api.trackEvent("page_view", "index").catch(() => {
  // Non-blocking — analytics failures shouldn't break the page.
});

// The modal element is injected into the DOM on first open. Kept outside
// the main HTML so the index.html stays compact and easy to translate.
function createPlanChooserModal() {
  const modalOverlay = document.createElement("div");
  modalOverlay.id = "atayi-plan-modal";
  modalOverlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    opacity: 0;
    transition: opacity 0.25s ease;
  `;

  modalOverlay.innerHTML = `
    <div style="
      background: #0f1011;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 32px 28px 28px;
      max-width: 720px;
      width: calc(100% - 32px);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
      font-family: system-ui, -apple-system, sans-serif;
      color: white;
    ">
      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 22px;">
        <div>
          <h2 style="margin: 0 0 6px; font-size: 22px; font-weight: 700;">How do you want to start?</h2>
          <p style="margin: 0; font-size: 13px; color: rgba(255, 255, 255, 0.6);">Pick a plan or try for 7 days on us.</p>
        </div>
        <button id="atayi-plan-close" style="
          background: none;
          border: none;
          color: rgba(255, 255, 255, 0.5);
          font-size: 22px;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          transition: background 0.15s;
        ">×</button>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;">
        ${renderPlanCard({
          key: "trial",
          title: "Free trial",
          price: "7 days free",
          subtitle: "15 min / day of talk time",
          features: ["1 Mac", "Full feature access", "No credit card"],
          ctaLabel: "Start free trial",
          accent: "#3b82f6",
        })}
        ${renderPlanCard({
          key: "starter",
          title: "Starter",
          price: "$19",
          period: "/ month",
          subtitle: "~11 hours of talk time",
          features: ["1 Mac", "40 000 Atayi credits / month", "Cancel anytime"],
          ctaLabel: "Choose Starter",
          accent: "#eab308",
        })}
        ${renderPlanCard({
          key: "ultra",
          title: "Ultra",
          price: "$49",
          period: "/ month",
          subtitle: "~44 hours of talk time",
          features: ["Up to 3 Macs shared", "160 000 Atayi credits / month", "Priority support"],
          ctaLabel: "Choose Ultra",
          accent: "#a855f7",
          isPopular: true,
        })}
      </div>

      <p style="margin: 20px 0 0; font-size: 11px; color: rgba(255, 255, 255, 0.4); text-align: center;">
        After payment or trial signup, you'll receive a license code to paste in the app. No account required to download.
      </p>
    </div>
  `;

  return modalOverlay;
}

function renderPlanCard({ key, title, price, period = "", subtitle, features, ctaLabel, accent, isPopular = false }) {
  return `
    <div data-plan-key="${key}" style="
      background: #15171a;
      border: 1px solid ${isPopular ? accent : "rgba(255, 255, 255, 0.08)"};
      border-radius: 14px;
      padding: 20px 18px;
      position: relative;
      display: flex;
      flex-direction: column;
      cursor: pointer;
      transition: transform 0.15s ease, border-color 0.15s ease;
    "
    onmouseover="this.style.transform='translateY(-2px)';this.style.borderColor='${accent}';"
    onmouseout="this.style.transform='translateY(0)';this.style.borderColor='${isPopular ? accent : "rgba(255, 255, 255, 0.08)"}';"
    >
      ${isPopular ? `<div style="position: absolute; top: -10px; left: 0; right: 0; display: flex; justify-content: center;"><span style="background: ${accent}; color: black; font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 99px; letter-spacing: 0.5px;">MOST POPULAR</span></div>` : ""}
      <div style="font-size: 14px; color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">${title}</div>
      <div style="display: flex; align-items: baseline; gap: 4px; margin-bottom: 2px;">
        <span style="font-size: 28px; font-weight: 700; color: white;">${price}</span>
        <span style="font-size: 13px; color: rgba(255, 255, 255, 0.5);">${period}</span>
      </div>
      <div style="font-size: 12px; color: rgba(255, 255, 255, 0.5); margin-bottom: 14px;">${subtitle}</div>
      <ul style="list-style: none; padding: 0; margin: 0 0 16px; flex: 1;">
        ${features.map((f) => `<li style="font-size: 12px; color: rgba(255, 255, 255, 0.7); padding: 4px 0; display: flex; align-items: start;"><span style="color: ${accent}; margin-right: 6px;">✓</span>${f}</li>`).join("")}
      </ul>
      <button class="atayi-plan-cta" data-plan-key="${key}" style="
        background: ${accent};
        color: ${accent === "#eab308" ? "black" : "white"};
        border: none;
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: filter 0.15s;
      "
      onmouseover="this.style.filter='brightness(1.1)';"
      onmouseout="this.style.filter='brightness(1)';"
      >${ctaLabel}</button>
    </div>
  `;
}

function openPlanChooserModal() {
  let modalOverlay = document.getElementById("atayi-plan-modal");
  if (!modalOverlay) {
    modalOverlay = createPlanChooserModal();
    document.body.appendChild(modalOverlay);

    // Close handlers
    modalOverlay.addEventListener("click", (event) => {
      if (event.target === modalOverlay) closePlanChooserModal();
    });
    modalOverlay.querySelector("#atayi-plan-close").addEventListener("click", closePlanChooserModal);

    // Plan selection handlers
    modalOverlay.querySelectorAll(".atayi-plan-cta").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const planKey = button.getAttribute("data-plan-key");
        handlePlanSelection(planKey);
      });
    });
  }

  // Fade in
  requestAnimationFrame(() => {
    modalOverlay.style.opacity = "1";
  });

  api.trackEvent("modal_open", "index", { source: "download_button" }).catch(() => {});
}

function closePlanChooserModal() {
  const modalOverlay = document.getElementById("atayi-plan-modal");
  if (!modalOverlay) return;
  modalOverlay.style.opacity = "0";
  setTimeout(() => modalOverlay.remove(), 250);
}

async function handlePlanSelection(planKey) {
  api.trackEvent("download_click", "index", { plan: planKey }).catch(() => {});

  if (planKey === "trial") {
    window.location.href = "/trial.html";
    return;
  }

  // For Starter / Ultra, we need an email to create the Stripe checkout session.
  // Grab it from the hero input if it's filled, otherwise send the user to /trial.html
  // which has an email field.
  const heroEmailInput = document.getElementById("emailInput");
  const enteredEmail = heroEmailInput?.value.trim();
  if (!enteredEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enteredEmail)) {
    window.location.href = `/trial.html?plan=${planKey}`;
    return;
  }

  // Have an email → go straight to Stripe
  try {
    const response = await api.createCheckoutSession(planKey, enteredEmail);
    if (response.ok && response.body.checkout_url) {
      window.location.href = response.body.checkout_url;
    } else {
      alert("Could not start checkout: " + (response.body.message || "unknown error"));
    }
  } catch (error) {
    alert("Network error starting checkout: " + error.message);
  }
}

// Wire up the download button
document.addEventListener("DOMContentLoaded", () => {
  const macDownloadButton = document.getElementById("downloadMacBtn");
  if (macDownloadButton) {
    macDownloadButton.addEventListener("click", (event) => {
      event.preventDefault();
      openPlanChooserModal();
    });
  }

  // Wire Windows download to the GitHub Release asset (157 MB, too large for Pages)
  const winDownloadButton = document.getElementById("downloadWinBtn");
  if (winDownloadButton) {
    winDownloadButton.href = "https://github.com/kevinyena/atayi-sensei/releases/download/v1.0.0/Atayi.Sensei.exe";
    winDownloadButton.setAttribute("download", "");
    winDownloadButton.addEventListener("click", () => {
      api.trackEvent("download_click", "index", { platform: "windows" }).catch(() => {});
    });
  }
});
