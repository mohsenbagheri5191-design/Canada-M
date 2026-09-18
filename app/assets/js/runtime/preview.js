/**
 * Preview mode.
 *
 * `?preview=<token>` renders a specific design version instead of whatever is
 * assigned to the signed-in user. It is how somebody reviews a draft before it
 * is published, from a link, on a real phone.
 *
 * Three constraints shape it:
 *
 *   · **It does not require a session.** A review link is usually sent to
 *     somebody who has no account — a client, a stakeholder. So the resolver
 *     behind it is callable with the publishable key alone, and the token is
 *     the entire credential. Which means the token has to be unguessable,
 *     short-lived and revocable, and it must return a layout and nothing else.
 *     No records, no tasks, no notes, no org secrets.
 *
 *   · **It is read-only and says so.** A preview that silently wrote to the
 *     tenant's data would be worse than useless.
 *
 *   · **It is never counted.** Telemetry is off in preview. A stakeholder
 *     clicking through a draft twenty times is not usage, and letting it into
 *     path_events corrupts the only numbers the Paths tab reports.
 */

import { rpc } from "../supabase.js";
import { normaliseTheme } from "./theme.js";

/** The token in the address bar, if there is one. */
export function previewToken() {
  const fromQuery = new URLSearchParams(location.search).get("preview");
  if (fromQuery) return fromQuery.trim();

  // Also accept it after the hash, because a link pasted into a chat app is
  // often reshaped and the query can end up on the wrong side of the "#".
  const hash = location.hash.replace(/^#/, "");
  const at = hash.indexOf("?");
  if (at === -1) return null;
  return new URLSearchParams(hash.slice(at + 1)).get("preview")?.trim() ?? null;
}

/**
 * Resolve a preview layout. Throws with a `reason` the shell can explain,
 * because "expired" and "revoked" need different words than "wrong link".
 */
export async function resolvePreview(token) {
  const payload = await rpc("resolve_preview", { p_token: token }, { anon: true });

  if (!payload || payload.error) {
    const error = new Error(payload?.error ?? "invalid");
    error.reason = payload?.error ?? "invalid";
    throw error;
  }

  return {
    designVersionId: payload.designVersionId ?? null,
    designName: payload.designName ?? "Preview",
    versionNumber: payload.versionNumber ?? null,
    schemaVersion: payload.schemaVersion ?? 1,
    builtIn: false,
    preview: true,
    features: payload.features ?? [],
    strippedScreens: payload.strippedScreens ?? [],
    settings: payload.settings ?? {},
    organization: payload.organization ?? null,
    theme: normaliseTheme(payload.theme),
    screens: Array.isArray(payload.screens) ? payload.screens : [],
    trace: [{ step: "Preview token", detail: payload.designName ?? "", hit: true }],
    source: "preview",
    fetchedAt: Date.now(),
  };
}

export const PREVIEW_REASONS = {
  invalid: "This preview link is not valid.",
  expired: "This preview link has expired.",
  revoked: "This preview link has been turned off.",
  missing: "This preview link points at a design that no longer exists.",
};
