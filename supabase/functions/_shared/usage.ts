/**
 * Usage logging and audit trail.
 *
 * usage_events is both the analytics feed and the quota counter, so a write
 * failure here must never fail an otherwise-good request: the user would see
 * an error for work that actually succeeded. Every write is therefore
 * best-effort and swallows its own errors after logging them.
 *
 * Rejected calls are logged too, with billable=false. That gives the admin
 * dashboard an honest picture (including who is repeatedly hitting a disabled
 * account) without charging anyone for a request that did no work.
 */

import { adminClient } from "./supabase.ts";

export interface UsageEvent {
  userId: string;
  endpoint: string;
  reference?: string | null;
  itemCount?: number;
  responseStatus: number;
  durationMs: number;
  billable: boolean;
}

/** Postgres text columns are unbounded, but a caller-supplied one should not be. */
function clamp(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

export async function logUsage(event: UsageEvent): Promise<void> {
  try {
    const admin = adminClient();

    await admin.from("usage_events").insert({
      user_id: event.userId,
      endpoint: clamp(event.endpoint, 100),
      reference: clamp(event.reference, 200),
      item_count: Math.max(0, Math.trunc(event.itemCount ?? 0)),
      response_status: event.responseStatus,
      duration_ms: Math.max(0, Math.trunc(event.durationMs)),
      billable: event.billable,
    });

    // last_active_at powers the "last active" column in the admin user list.
    // Only successful calls count as activity.
    if (event.responseStatus < 400) {
      await admin
        .from("profiles")
        .update({ last_active_at: new Date().toISOString() })
        .eq("id", event.userId);
    }
  } catch (err) {
    console.error("usage logging failed (request itself was unaffected):", err);
  }
}

export interface AuditEntry {
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetUserId?: string | null;
  targetEmail?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Records an admin action. Unlike usage logging this is allowed to throw:
 * an admin action that cannot be attributed should not silently proceed.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  const { error } = await adminClient().from("audit_log").insert({
    actor_id: entry.actorId,
    actor_email: clamp(entry.actorEmail, 320),
    action: clamp(entry.action, 100),
    target_user_id: entry.targetUserId ?? null,
    target_email: clamp(entry.targetEmail, 320),
    details: entry.details ?? {},
  });

  if (error) throw new Error(`audit write failed: ${error.message}`);
}
