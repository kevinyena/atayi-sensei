/**
 * Minimal Stripe API client for the worker.
 *
 * We intentionally don't use the official `stripe` npm package because it pulls
 * in Node-specific APIs. Instead we talk to the Stripe REST API directly via fetch()
 * with the form-urlencoded encoding Stripe expects.
 *
 * The worker only needs a handful of operations:
 *   - Create a Checkout Session (for the pay-now flow)
 *   - Verify a webhook signature (for /api/billing/webhook)
 *   - Retrieve a Checkout Session (for /api/billing/session/:id — success page)
 *   - Retrieve / create a Customer (on trial-to-paid upgrade)
 */

const STRIPE_API_BASE = "https://api.stripe.com/v1";

function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const encodedKey = prefix ? `${prefix}[${key}]` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      pairs.push(...formEncode(value as Record<string, unknown>, encodedKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        if (typeof item === "object") {
          pairs.push(...formEncode(item as Record<string, unknown>, `${encodedKey}[${idx}]`));
        } else {
          pairs.push(`${encodeURIComponent(`${encodedKey}[${idx}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      pairs.push(`${encodeURIComponent(encodedKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs;
}

async function stripeRequest(
  stripeSecretKey: string,
  endpoint: string,
  method: "GET" | "POST" = "GET",
  bodyParams?: Record<string, unknown>,
): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Stripe-Version": "2024-12-18.acacia",
    },
  };
  if (method === "POST" && bodyParams) {
    init.body = formEncode(bodyParams).join("&");
    (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`${STRIPE_API_BASE}${endpoint}`, init);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Stripe ${method} ${endpoint} ${response.status}: ${errorBody}`);
  }
  return response.json();
}

export interface StripeCheckoutSession {
  id: string;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  customer: string | null;
  customer_email: string | null;
  subscription: string | null;
  metadata: Record<string, string>;
  url: string | null;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_start: number;
  current_period_end: number;
  items: {
    data: Array<{
      price: {
        id: string;
        product: string;
      };
    }>;
  };
  metadata: Record<string, string>;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
}

export async function createCheckoutSession(
  stripeSecretKey: string,
  params: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
    customerId?: string;
    metadata: Record<string, string>;
  },
): Promise<StripeCheckoutSession> {
  const bodyParams: Record<string, unknown> = {
    mode: "subscription",
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    allow_promotion_codes: true,
    metadata: params.metadata,
  };
  if (params.customerId) {
    bodyParams.customer = params.customerId;
  } else if (params.customerEmail) {
    bodyParams.customer_email = params.customerEmail;
  }
  return (await stripeRequest(stripeSecretKey, "/checkout/sessions", "POST", bodyParams)) as StripeCheckoutSession;
}

export async function retrieveCheckoutSession(
  stripeSecretKey: string,
  sessionId: string,
): Promise<StripeCheckoutSession> {
  return (await stripeRequest(stripeSecretKey, `/checkout/sessions/${sessionId}`, "GET")) as StripeCheckoutSession;
}

export async function retrieveSubscription(
  stripeSecretKey: string,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return (await stripeRequest(stripeSecretKey, `/subscriptions/${subscriptionId}`, "GET")) as StripeSubscription;
}

export async function createBillingPortalSession(
  stripeSecretKey: string,
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  return (await stripeRequest(stripeSecretKey, "/billing_portal/sessions", "POST", {
    customer: customerId,
    return_url: returnUrl,
  })) as { url: string };
}

export async function createCustomer(
  stripeSecretKey: string,
  params: { email: string; metadata?: Record<string, string> },
): Promise<StripeCustomer> {
  return (await stripeRequest(stripeSecretKey, "/customers", "POST", {
    email: params.email,
    metadata: params.metadata ?? {},
  })) as StripeCustomer;
}

/**
 * Verify a Stripe webhook signature per
 * https://docs.stripe.com/webhooks/signatures
 *
 * Stripe sends `Stripe-Signature: t=<timestamp>,v1=<hmac_hex>`.
 * We recompute HMAC-SHA256(`${t}.${rawBody}`, webhookSecret) and compare.
 */
export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = signatureHeader.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signaturePart = parts.find((p) => p.startsWith("v1="));
  if (!timestampPart || !signaturePart) return false;

  const timestamp = parseInt(timestampPart.slice(2), 10);
  const providedHexSignature = signaturePart.slice(3);
  if (!Number.isFinite(timestamp)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const computedSignatureBuffer = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(signedPayload),
  );
  const computedHexSignature = Array.from(new Uint8Array(computedSignatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare
  if (computedHexSignature.length !== providedHexSignature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computedHexSignature.length; i++) {
    mismatch |= computedHexSignature.charCodeAt(i) ^ providedHexSignature.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Map Stripe price id → plan. Hardcoded to the two known prices.
 */
export function planFromPriceId(priceId: string): "starter" | "ultra" | "sensei" | null {
  if (priceId === "price_1TL3NTBeaBW3Kesq5lRqLLla") return "starter";
  if (priceId === "price_1TL3O8BeaBW3KesqcB5ezIL1") return "ultra";
  if (priceId === "price_1TLoFOBeaBW3KesqancswmE5") return "sensei";
  return null;
}

export const STRIPE_PRICE_IDS = {
  starter: "price_1TL3NTBeaBW3Kesq5lRqLLla",
  ultra: "price_1TL3O8BeaBW3KesqcB5ezIL1",
  sensei: "price_1TLoFOBeaBW3KesqancswmE5",
} as const;
