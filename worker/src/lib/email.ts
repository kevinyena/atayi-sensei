/**
 * Email sending via Resend API.
 * Used for OTP verification codes and license code delivery.
 */

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_EMAIL = "Atayi Sensei <noreply@atayisensei.com>";

async function sendEmail(
  resendApiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[email] Resend error ${response.status}: ${errorBody}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] send failed:", error);
    return false;
  }
}

export async function sendOTPEmail(resendApiKey: string, to: string, code: string): Promise<boolean> {
  return sendEmail(resendApiKey, to, "Your Atayi Sensei verification code", `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #fff; margin-bottom: 8px;">Verify your email</h2>
      <p style="color: #aaa; font-size: 14px;">Enter this code in the signup form to create your Atayi Sensei account:</p>
      <div style="background: #0a0b0d; border: 2px dashed #3b82f6; border-radius: 12px; padding: 24px; text-align: center; margin: 20px 0;">
        <span style="font-family: monospace; font-size: 32px; font-weight: 700; color: #60a5fa; letter-spacing: 8px;">${code}</span>
      </div>
      <p style="color: #666; font-size: 12px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
    </div>
  `);
}

export async function sendAccountStatusEmail(
  resendApiKey: string,
  to: string,
  action: "paused" | "blocked" | "deleted",
  reason: string,
): Promise<boolean> {
  const titles: Record<string, string> = {
    paused: "Your Atayi Sensei account has been paused",
    blocked: "Your Atayi Sensei account has been blocked",
    deleted: "Your Atayi Sensei account has been deleted",
  };
  const descriptions: Record<string, string> = {
    paused: "Your account has been temporarily paused. You will not be able to use Atayi Sensei until your account is reactivated.",
    blocked: "Your account has been blocked due to a policy violation. You will not be able to use Atayi Sensei.",
    deleted: "Your account and all associated data have been permanently deleted from Atayi Sensei.",
  };
  return sendEmail(resendApiKey, to, titles[action], `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #111; margin-bottom: 8px;">${titles[action]}</h2>
      <p style="color: #555; font-size: 14px; line-height: 1.5;">${descriptions[action]}</p>
      ${reason ? `<p style="color: #555; font-size: 14px;"><strong>Reason:</strong> ${reason}</p>` : ""}
      <p style="color: #999; font-size: 12px; margin-top: 24px;">If you believe this is a mistake, contact <a href="mailto:hello@atayisensei.com" style="color: #3b82f6;">hello@atayisensei.com</a>.</p>
    </div>
  `);
}

export async function sendLicenseCodeEmail(
  resendApiKey: string,
  to: string,
  licenseCode: string,
  plan: string,
): Promise<boolean> {
  const planLabel = plan === "sensei" ? "Sensei" : plan === "ultra" ? "Ultra" : plan === "starter" ? "Starter" : "Free Trial";
  return sendEmail(resendApiKey, to, `Your Atayi Sensei license code (${planLabel})`, `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; color: #333;">
      <h2 style="color: #111; margin-bottom: 8px;">Welcome to Atayi Sensei!</h2>
      <p style="color: #555; font-size: 14px; line-height: 1.5;">Your <strong>${planLabel}</strong> plan is active. Here's your license code:</p>

      <div style="background: #f5f5f5; border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
        <span style="font-family: monospace; font-size: 18px; font-weight: 700; color: #3b82f6; letter-spacing: 2px;">${licenseCode}</span>
      </div>

      <h3 style="color: #111; font-size: 15px; margin: 24px 0 12px;">How to get started</h3>

      <div style="margin-bottom: 16px;">
        <p style="color: #111; font-size: 13px; font-weight: 600; margin-bottom: 6px;">On macOS:</p>
        <ol style="color: #555; font-size: 13px; line-height: 1.8; padding-left: 20px; margin: 0;">
          <li>Find <strong>Atayi-Sensei-1.0.dmg</strong> in your Downloads folder</li>
          <li>Double-click the DMG file to open it</li>
          <li>Drag the Atayi Sensei icon into the Applications folder</li>
          <li>Open Atayi Sensei from Applications (right-click > Open the first time)</li>
          <li>Paste your license code when prompted</li>
        </ol>
      </div>

      <div style="margin-bottom: 16px;">
        <p style="color: #111; font-size: 13px; font-weight: 600; margin-bottom: 6px;">On Windows:</p>
        <ol style="color: #555; font-size: 13px; line-height: 1.8; padding-left: 20px; margin: 0;">
          <li>Find <strong>Atayi.Sensei.exe</strong> in your Downloads folder</li>
          <li>Double-click the installer and follow the setup wizard</li>
          <li>Launch Atayi Sensei from the Start menu or Desktop</li>
          <li>Paste your license code when prompted</li>
        </ol>
      </div>

      <p style="color: #999; font-size: 12px; margin-top: 20px;">You can retrieve your license code anytime from your <a href="https://atayisensei.com/account" style="color: #3b82f6;">account page</a>.</p>
      <p style="color: #999; font-size: 12px;">Need help? Contact <a href="mailto:hello@atayisensei.com" style="color: #3b82f6;">hello@atayisensei.com</a></p>
    </div>
  `);
}
