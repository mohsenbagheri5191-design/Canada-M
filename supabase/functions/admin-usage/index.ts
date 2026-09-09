/**
 * admin-usage - aggregated usage for the admin dashboard.
 *
 * All of the work happens in the admin_usage_summary() SQL function, which is
 * granted to service_role only. This endpoint is the authorisation wrapper
 * around it: verify the caller is an active admin, then hand back the document.
 *
 * Like admin-users, the kill switch does not gate this: you should be able to
 * see what the system is doing while it is in maintenance mode.
 */

import { serveApi, readJson, jsonResponse } from "../_shared/handler.ts";
import { authenticate } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase.ts";
import { ApiError, ErrorCode } from "../_shared/errors.ts";

interface Body {
  days?: number;
  recent?: number;
}

serveApi(async (req, headers) => {
  await authenticate(req, { requireAdmin: true, enforceKillSwitch: false });

  const admin = adminClient();
  const body = await readJson<Body>(req).catch(() => ({} as Body));

  // The SQL clamps this too; validating here gives a clear 400 instead of
  // silently scanning a different window than the caller asked for.
  const days = body.days === undefined ? 30 : Number(body.days);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    throw new ApiError(ErrorCode.BAD_REQUEST, "`days` must be between 1 and 365.");
  }

  const { data: summary, error } = await admin.rpc("admin_usage_summary", {
    p_days: Math.trunc(days),
  });
  if (error) throw new Error(`usage summary failed: ${error.message}`);

  // A tail of raw events, for the "what just happened" panel.
  const recent = Math.max(0, Math.min(Number(body.recent) || 50, 200));
  let events: unknown[] = [];

  if (recent > 0) {
    const { data, error: eventsError } = await admin
      .from("usage_events")
      .select("id, user_id, endpoint, reference, item_count, response_status, duration_ms, billable, created_at")
      .order("created_at", { ascending: false })
      .limit(recent);
    if (eventsError) throw new Error(`recent events failed: ${eventsError.message}`);
    events = data ?? [];
  }

  return jsonResponse({ summary, recentEvents: events }, 200, headers);
});
