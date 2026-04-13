/**
 * Stripe billing endpoints:
 *   POST /api/billing/checkout      → create Checkout Session
 *   POST /api/billing/webhook       → Stripe webhook receiver
 *   GET  /api/billing/session/:id   → retrieve session for the success page
 */

import { SupabaseClient } from "../db/supabase";
import { generateLicenseCode } from "../lib/license-code";
import { errorResponse, jsonResponse } from "../lib/response";
import {
  STRIPE_PRICE_IDS,
  createBillingPortalSession,
  createCheckoutSession,
  createCustomer,
  planFromPriceId,
  retrieveCheckoutSession,
  retrieveSubscription,
  verifyStripeWebhookSignature,
} from "../lib/stripe-helpers";
import type { Env, Plan } from "../types";
import { PLAN_LIMITS } from "../types";

export async function handleCheckoutCreate(request: Request, env: Env): Promise<Response> {
  let body: { plan?: "starter" | "ultra" | "sensei"; email?: string; existing_license_code?: string; origin?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse("invalid_json", "Request body must be JSON", 400);
  }

  const plan = body.plan;
  if (plan !== "starter" && plan !== "ultra" && plan !== "sensei") {
    return errorResponse("invalid_plan", "plan must be 'starter', 'ultra', or 'sensei'", 400);
  }
  const email = body.email?.trim().toLowerCase() ?? "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse("invalid_email", "Please provide a valid email address", 400);
  }

  const priceId = STRIPE_PRICE_IDS[plan];
  const origin = body.origin ?? new URL(request.url).origin;

  const supabase = new SupabaseClient(env);

  // Find-or-create the user in Supabase. If they're upgrading from trial,
  // we want to reuse the existing user_id so their license code + devices
  // carry over.
  let user = await supabase.findUserByEmail(email);
  if (!user) {
    user = await supabase.createUser({ email });
  }

  // Ensure a Stripe customer exists so that all subscriptions attach to
  // the same customer record.
  let stripeCustomerId = user.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await createCustomer(env.STRIPE_SECRET_KEY, {
      email,
      metadata: { atayi_user_id: user.id },
    });
    stripeCustomerId = customer.id;
    await supabase.updateUser(user.id, { stripe_customer_id: stripeCustomerId });
  }

  const checkoutSession = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
    priceId,
    successUrl: `${origin}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/checkout-cancel.html`,
    customerId: stripeCustomerId,
    metadata: {
      atayi_user_id: user.id,
      plan,
      existing_license_code: body.existing_license_code ?? "",
    },
  });

  // Log landing event
  await supabase.logLandingEvent({
    event_type: "checkout_started",
    user_id: user.id,
    metadata: { plan, checkout_session_id: checkoutSession.id },
  });

  return jsonResponse({ checkout_url: checkoutSession.url });
}

/**
 * Stripe webhook receiver. Handles the subscription lifecycle events.
 *
 * Expected events:
 *   - checkout.session.completed       → create/activate subscription, generate license code
 *   - invoice.paid                     → reset credits for new period
 *   - customer.subscription.updated    → sync status / cancel_at_period_end
 *   - customer.subscription.deleted    → mark canceled
 *   - invoice.payment_failed           → past_due
 */
export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const signatureHeader = request.headers.get("stripe-signature");
  if (!signatureHeader) {
    return errorResponse("missing_signature", "Stripe-Signature header is required", 400);
  }

  const rawBody = await request.text();
  const signatureValid = await verifyStripeWebhookSignature(
    rawBody,
    signatureHeader,
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!signatureValid) {
    return errorResponse("invalid_signature", "Webhook signature verification failed", 400);
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return errorResponse("invalid_json", "Webhook body is not valid JSON", 400);
  }

  const supabase = new SupabaseClient(env);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(event.data.object, supabase, env);
        break;
      }
      case "invoice.paid": {
        await handleInvoicePaid(event.data.object, supabase, env);
        break;
      }
      case "customer.subscription.updated": {
        await handleSubscriptionUpdated(event.data.object, supabase);
        break;
      }
      case "customer.subscription.deleted": {
        await handleSubscriptionDeleted(event.data.object, supabase);
        break;
      }
      case "invoice.payment_failed": {
        await handlePaymentFailed(event.data.object, supabase);
        break;
      }
      default:
        // We don't care about this event type.
        break;
    }
  } catch (error) {
    console.error(`[stripe webhook ${event.type}]`, error);
    return errorResponse("webhook_handler_error", String(error), 500);
  }

  return jsonResponse({ received: true });
}

async function handleCheckoutCompleted(
  session: Record<string, unknown>,
  supabase: SupabaseClient,
  env: Env,
): Promise<void> {
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  const userId = metadata.atayi_user_id;
  const plan = metadata.plan as Plan;
  const subscriptionId = session.subscription as string | null;

  if (!userId || (plan !== "starter" && plan !== "ultra") || !subscriptionId) {
    console.error("[checkout.session.completed] missing metadata", { userId, plan, subscriptionId });
    return;
  }

  // Retrieve the Stripe subscription to get period dates and price id
  const stripeSubscription = await retrieveSubscription(env.STRIPE_SECRET_KEY, subscriptionId);
  const priceId = stripeSubscription.items.data[0]?.price.id ?? "";
  const resolvedPlan = planFromPriceId(priceId) ?? plan;

  // Check if a subscription row already exists
  const existingSubscription = await supabase.findSubscriptionByStripeId(subscriptionId);
  if (existingSubscription) {
    await supabase.updateSubscription(existingSubscription.id, {
      status: stripeSubscription.status as Parameters<SupabaseClient["updateSubscription"]>[1]["status"],
      current_period_start: new Date(stripeSubscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: stripeSubscription.cancel_at_period_end,
    });
  } else {
    await supabase.createPaidSubscription({
      user_id: userId,
      stripe_subscription_id: subscriptionId,
      stripe_price_id: priceId,
      plan: resolvedPlan,
      status: stripeSubscription.status,
      current_period_start: new Date(stripeSubscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: stripeSubscription.cancel_at_period_end,
    });
  }

  // Reuse the existing license code if the user already has one (e.g. upgrading
  // from trial to paid). This way the user keeps the same code across plan changes
  // and doesn't need to re-activate in the app. Only generate a new code if none exists.
  const existingLicenses = await supabase.findLicensesByUserId(userId);
  const activeLicense = existingLicenses.find((l) => l.revoked_at === null);
  let licenseCode: string;
  if (activeLicense) {
    licenseCode = activeLicense.code;
  } else {
    licenseCode = generateLicenseCode(resolvedPlan);
    await supabase.createLicenseCode(userId, licenseCode);
  }

  await supabase.logLandingEvent({
    event_type: "checkout_completed",
    user_id: userId,
    metadata: { plan: resolvedPlan, subscription_id: subscriptionId, license_code: licenseCode },
  });
}

async function handleInvoicePaid(
  invoice: Record<string, unknown>,
  supabase: SupabaseClient,
  env: Env,
): Promise<void> {
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) return;

  const stripeSubscription = await retrieveSubscription(env.STRIPE_SECRET_KEY, subscriptionId);
  const subscription = await supabase.findSubscriptionByStripeId(subscriptionId);
  if (!subscription) return;

  const newPeriodEnd = new Date(stripeSubscription.current_period_end * 1000).toISOString();

  // Reset credits for the new billing period.
  await supabase.resetSubscriptionCreditsForNewPeriod(subscription.id, newPeriodEnd);
  await supabase.updateSubscription(subscription.id, {
    status: stripeSubscription.status as Parameters<SupabaseClient["updateSubscription"]>[1]["status"],
    current_period_start: new Date(stripeSubscription.current_period_start * 1000).toISOString(),
  });
}

async function handleSubscriptionUpdated(
  stripeSub: Record<string, unknown>,
  supabase: SupabaseClient,
): Promise<void> {
  const stripeSubscriptionId = stripeSub.id as string;
  const subscription = await supabase.findSubscriptionByStripeId(stripeSubscriptionId);
  if (!subscription) return;

  await supabase.updateSubscription(subscription.id, {
    status: stripeSub.status as Parameters<SupabaseClient["updateSubscription"]>[1]["status"],
    cancel_at_period_end: Boolean(stripeSub.cancel_at_period_end),
    current_period_start: new Date((stripeSub.current_period_start as number) * 1000).toISOString(),
    current_period_end: new Date((stripeSub.current_period_end as number) * 1000).toISOString(),
  });
}

async function handleSubscriptionDeleted(
  stripeSub: Record<string, unknown>,
  supabase: SupabaseClient,
): Promise<void> {
  const stripeSubscriptionId = stripeSub.id as string;
  const subscription = await supabase.findSubscriptionByStripeId(stripeSubscriptionId);
  if (!subscription) return;

  await supabase.updateSubscription(subscription.id, {
    status: "canceled",
  });
}

async function handlePaymentFailed(
  invoice: Record<string, unknown>,
  supabase: SupabaseClient,
): Promise<void> {
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) return;

  const subscription = await supabase.findSubscriptionByStripeId(subscriptionId);
  if (!subscription) return;

  await supabase.updateSubscription(subscription.id, {
    status: "past_due",
  });
}

/**
 * GET /api/billing/session/:session_id
 *
 * Called by checkout-success.html. Returns the license code that was
 * generated for this checkout session, so the user can copy it.
 */
export async function handleCheckoutSessionRetrieve(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const stripeSession = await retrieveCheckoutSession(env.STRIPE_SECRET_KEY, sessionId);
  if (stripeSession.payment_status !== "paid") {
    return errorResponse("payment_not_complete", "Payment is not yet complete", 402, {
      payment_status: stripeSession.payment_status,
    });
  }

  const metadata = stripeSession.metadata ?? {};
  const userId = metadata.atayi_user_id;
  if (!userId) {
    return errorResponse("missing_metadata", "Session has no user metadata", 500);
  }

  const supabase = new SupabaseClient(env);
  const user = await supabase.findUserById(userId);
  if (!user) {
    return errorResponse("user_not_found", "User not found", 404);
  }

  // Return the most recent active license code for this user
  const licenses = await supabase.findLicensesByUserId(userId);
  const activeLicense = licenses.find((l) => l.revoked_at === null);
  if (!activeLicense) {
    return errorResponse("license_not_issued", "License code not yet issued — retry in a few seconds", 503);
  }

  const subscription = await supabase.findLatestSubscriptionForUser(userId);
  const plan = subscription?.plan ?? "starter";
  const limits = PLAN_LIMITS[plan];

  return jsonResponse({
    license_code: activeLicense.code,
    plan,
    user_email: user.email,
    max_devices: limits.max_devices,
    monthly_allowance: limits.monthly_credit_allowance,
    current_period_end: subscription?.current_period_end,
  });
}

/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Customer Portal session so the user can manage their
 * payment method, view invoices, or cancel from Stripe's hosted UI.
 */
export async function handleBillingPortal(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; return_url?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse("invalid_json", "Body must be JSON", 400);
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  if (!email) return errorResponse("missing_email", "email is required", 400);

  const supabase = new SupabaseClient(env);
  const user = await supabase.findUserByEmail(email);
  if (!user || !user.stripe_customer_id) {
    return errorResponse("no_customer", "No Stripe customer found for this email", 404);
  }

  const returnUrl = body.return_url || "https://atayisensei.com/account";
  const portalSession = await createBillingPortalSession(env.STRIPE_SECRET_KEY, user.stripe_customer_id, returnUrl);

  return jsonResponse({ portal_url: portalSession.url });
}
