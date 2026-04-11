/**
 * POST /api/landing/event
 *
 * Called from the landing page JS on pageview / downloadClick / checkoutClick.
 * Stores analytics events in Supabase `landing_events` so the admin dashboard
 * can show funnel stats. Entirely public, no auth (it's just analytics).
 */

import { SupabaseClient } from "../db/supabase";
import { errorResponse, jsonResponse } from "../lib/response";
import type { Env } from "../types";

const ALLOWED_EVENT_TYPES = new Set([
  "page_view",
  "download_click",
  "checkout_started",
  "checkout_completed",
  "trial_signup",
  "modal_open",
]);

export async function handleLandingEvent(request: Request, env: Env): Promise<Response> {
  let body: { event_type?: string; page?: string; visitor_id?: string; metadata?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse("invalid_json", "Body must be JSON", 400);
  }

  const eventType = body.event_type ?? "";
  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    return errorResponse("invalid_event_type", `Unknown event type: ${eventType}`, 400);
  }

  const supabase = new SupabaseClient(env);
  await supabase.logLandingEvent({
    event_type: eventType,
    page: body.page,
    visitor_id: body.visitor_id,
    metadata: body.metadata,
  });

  return jsonResponse({ recorded: true });
}

/**
 * handleRefreshStats — called by the Cloudflare cron trigger (every 5 min)
 * to refresh the materialized view that powers the admin dashboard.
 * Not exposed publicly; the cron trigger invokes the worker's `scheduled()`
 * handler which hits this function directly.
 */
export async function handleRefreshStats(env: Env): Promise<void> {
  const supabase = new SupabaseClient(env);
  await supabase.refreshAdminStats();
}
