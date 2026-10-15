/**
 * The live platform, for the few things the dashboard cannot do against seeded
 * data.
 *
 * Almost everything in this dashboard runs on `db.js`, an in-browser store, so
 * the whole tool can be opened and driven with no backend at all. That is the
 * right default: a designer should be able to lay out a screen without an
 * account.
 *
 * But some actions have no honest local equivalent. Minting a preview link is
 * one: the token is a real credential, checked by the database against a real
 * design version, and a locally invented string is not a preview link — it is a
 * string that looks like one. This module is the seam where the dashboard
 * reaches the real project for those, and where it reports plainly that it
 * cannot when there is no session.
 */

const defaults = {
  supabaseUrl: "https://sxsbeavdmfuznigslfnp.supabase.co",
  supabaseKey: "sb_publishable_BALtodXYHyXJ41amq26zhA_17o7gMTI",
  /** Where the app is served from, for building a shareable preview URL. */
  appBase: "../app/",
};

export const platformConfig = Object.freeze({ ...defaults, ...(globalThis.__DASHBOARD_CONFIG__ ?? {}) });

/** The app and the dashboard share a session when served from one origin. */
const SESSION_KEY = "canada.session";

function session() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.accessToken ? parsed : null;
  } catch {
    return null;
  }
}

/** Is there a signed-in session this tab can act with? */
export const hasSession = () => Boolean(session());

export const signedInAs = () => session()?.user?.email ?? null;

/**
 * Call a database function.
 *
 * Errors carry `status` so a caller can tell "you are not allowed" from "the
 * server is unreachable" — they need different words in front of a user.
 */
export async function rpc(name, args = {}) {
  const current = session();
  if (!current) {
    const error = new Error("Not signed in to the platform.");
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${platformConfig.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: platformConfig.supabaseKey,
      authorization: `Bearer ${current.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(
      response.status === 403 || response.status === 401
        ? "Your account is not allowed to do that."
        : `The server refused the request (${response.status}).`,
    );
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  return response.json().catch(() => null);
}

/**
 * Mint a preview link for a design version.
 *
 * Returns `{ token, expiresAt, url }`. The token is generated in the database
 * from 32 random bytes and expires; nothing here invents it.
 */
export async function issuePreviewToken(designVersionId, { hours = 24, label = null } = {}) {
  const result = await rpc("issue_preview_token", {
    p_design_version_id: designVersionId,
    p_hours: hours,
    p_label: label,
  });

  if (!result?.token) throw new Error("The server did not return a token.");

  return { ...result, url: previewUrl(result.token) };
}

/** The URL a reviewer opens. Absolute, because it is going to be pasted. */
export function previewUrl(token) {
  const base = new URL(platformConfig.appBase, location.href);
  base.searchParams.set("preview", token);
  return base.href;
}

/**
 * Is this id something the live database could know about?
 *
 * The seeded store uses readable ids like `dsg_fieldops_v3`; the real one uses
 * uuids. Checking the shape lets the UI explain that a seeded design has no
 * counterpart to share, instead of sending a request that will only 404.
 */
export const isLiveId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id ?? ""));
