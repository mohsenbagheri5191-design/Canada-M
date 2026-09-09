/**
 * CORS: strict allowlist, no wildcard.
 *
 * The allowlist resolves from two places, in order:
 *
 *   1. The ALLOWED_ORIGINS secret, comma-separated. Standard Edge Function
 *      configuration and the fastest path, since it needs no query.
 *   2. app_settings.allowed_origins, when that secret is unset. Lets the
 *      allowlist be changed with SQL or from the admin dashboard without a
 *      redeploy, which matters when a new extension build changes its ID.
 *
 * A request whose Origin is not on the list gets no
 * Access-Control-Allow-Origin header and a 403. Both matter: the missing
 * header stops the browser from exposing the body, and the 403 stops a
 * non-browser client from getting a useful answer regardless.
 */

import { ApiError, ErrorCode } from "./errors.ts";
import { adminClient } from "./supabase.ts";

/** Requests with no Origin header at all (curl, server-to-server). */
const NO_ORIGIN = "__no_origin__";

/**
 * Database lookups are cached per warm instance. Short enough that adding an
 * origin takes effect almost immediately, long enough that a burst of calls
 * does not become a burst of queries.
 */
const CACHE_TTL_MS = 30_000;

let cachedList: string[] | null = null;
let cachedAt = 0;

function parseList(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function resolveAllowlist(): Promise<string[]> {
  const fromEnv = parseList(Deno.env.get("ALLOWED_ORIGINS"));
  if (fromEnv.length > 0) return fromEnv;

  const now = Date.now();
  if (cachedList !== null && now - cachedAt < CACHE_TTL_MS) return cachedList;

  try {
    const { data } = await adminClient()
      .from("app_settings")
      .select("allowed_origins")
      .eq("id", true)
      .single();

    cachedList = parseList(data?.allowed_origins as string | undefined);
    cachedAt = now;
    return cachedList;
  } catch (err) {
    console.error("allowlist lookup failed, failing closed:", err);
    // Deliberately do not cache a failure: the next request retries rather
    // than staying locked out for the full TTL because of one blip.
    return [];
  }
}

/**
 * True when the origin may talk to us.
 *
 * A literal "null" origin (file:// pages, sandboxed iframes) is only honoured
 * if it is spelled out in the allowlist, never by accident.
 */
export async function isOriginAllowed(origin: string | null): Promise<boolean> {
  const list = await resolveAllowlist();

  // An empty allowlist is a misconfiguration, not an invitation. Fail closed:
  // a missing configuration should break loudly during setup rather than
  // quietly turn into "allow everything" in production.
  if (list.length === 0) return false;

  if (origin === null) return list.includes(NO_ORIGIN);
  return list.includes(origin);
}

/**
 * Headers to attach to a response for this origin.
 *
 * `Vary: Origin` is required because the response differs per origin; without
 * it a shared cache can hand extension A the headers computed for extension B.
 */
export async function corsHeaders(
  origin: string | null,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Vary: "Origin" };

  if (origin && (await isOriginAllowed(origin))) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] =
      "authorization, x-client-info, apikey, content-type";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "86400";
  }

  return headers;
}

/** Answers a CORS preflight, or null when this is not a preflight. */
export async function preflight(req: Request): Promise<Response | null> {
  if (req.method !== "OPTIONS") return null;

  const origin = req.headers.get("Origin");
  if (!(await isOriginAllowed(origin))) {
    return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  }
  return new Response(null, { status: 204, headers: await corsHeaders(origin) });
}

/** Rejects a disallowed origin before any work, and before any auth check. */
export async function assertOriginAllowed(req: Request): Promise<void> {
  const origin = req.headers.get("Origin");
  if (!(await isOriginAllowed(origin))) {
    throw new ApiError(
      ErrorCode.ORIGIN_NOT_ALLOWED,
      "This origin is not allowed to call the API.",
    );
  }
}
