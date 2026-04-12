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
      <p style="color: #999; font-size: 12px; margin-top: 24px;">If you believe this is a mistake, contact <a href="mailto:support@atayisensei.io" style="color: #3b82f6;">support@atayisensei.io</a>.</p>
    </div>
  `);
}

export async function sendLicenseCodeEmail(
  resendApiKey: string,
  to: string,
  licenseCode: string,
  plan: string,
): Promise<boolean> {
  const planLabel = plan === "ultra" ? "Ultra" : plan === "starter" ? "Starter" : "Free Trial";
  return sendEmail(resendApiKey, to, `Your Atayi Sensei license code (${planLabel})`, `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #fff; margin-bottom: 8px;">Welcome to Atayi Sensei!</h2>
      <p style="color: #aaa; font-size: 14px;">Your <strong>${planLabel}</strong> plan is active. Here's your license code — paste it in the app after installing:</p>
      <div style="background: #0a0b0d; border: 2px dashed #3b82f6; border-radius: 12px; padding: 24px; text-align: center; margin: 20px 0;">
        <span style="font-family: monospace; font-size: 18px; font-weight: 700; color: #60a5fa; letter-spacing: 2px;">${licenseCode}</span>
      </div>
      <p style="color: #aaa; font-size: 13px;">Save this code in your password manager. You can also retrieve it anytime from your <a href="https://atayisensei.com/account" style="color: #60a5fa;">account page</a>.</p>
      <p style="color: #666; font-size: 12px;">— Atayi Sensei Team</p>
    </div>
  `);
}
