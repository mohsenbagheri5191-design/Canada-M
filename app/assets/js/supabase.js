/**
 * A minimal Supabase client: auth tokens and PostgREST, nothing else.
 *
 * Written by hand rather than pulled from the SDK for the same reason the rest
 * of this repository has no build step — the app is four HTTP shapes, and a
 * dependency that ships an entire realtime and storage client to do them is
 * weight on the phone of someone standing on a roof with one bar of signal.
 *
 * The parts that are easy to get wrong and are therefore handled here:
 *   · one refresh in flight at a time, so a burst of 401s does not spend the
 *     refresh token several times over and log the user out
 *   · the refresh token rotating on every use, so the new one is stored before
 *     anything else can read it
 *   · a failed refresh clearing the session rather than leaving a dead one
 */

import { config } from "./config.js";

const STORAGE_KEY = "canada.session";
const EXPIRY_SKEW_MS = 60_000;

/* ---------------------------------------------------------------------------
   Session storage
   --------------------------------------------------------------------------- */

let session = read();
let refreshing = null;
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Private mode, cleared site data, a corrupt value: all mean "no session",
    // none of them should stop the app booting.
    return null;
  }
}

function write(next) {
  session = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* the session simply will not survive a reload */
  }
  for (const fn of listeners) fn(next);
}

/** Subscribe to sign-in and sign-out. Returns an unsubscribe. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getSession = () => session;
export const getUser = () => session?.user ?? null;

/* ---------------------------------------------------------------------------
   Auth
   --------------------------------------------------------------------------- */

const authUrl = (path) => `${config.supabaseUrl}/auth/v1${path}`;

async function authFetch(path, body) {
  const response = await fetch(authUrl(path), {
    method: "POST",
    headers: { apikey: config.supabaseKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.msg || payload.message || `Auth failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function store(payload) {
  write({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    // expires_in is seconds from now; store an absolute time so a sleeping
    // device wakes up knowing the token is stale rather than trusting a countdown.
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    user: payload.user ? { id: payload.user.id, email: payload.user.email } : session?.user ?? null,
  });
  return session;
}

export async function signIn(email, password) {
  return store(await authFetch("/token?grant_type=password", { email, password }));
}

export async function signOut() {
  const token = session?.accessToken;
  write(null);
  if (!token) return;
  // Best effort: the local session is already gone, so a failure here is not
  // something the user can act on.
  try {
    await fetch(authUrl("/logout"), {
      method: "POST",
      headers: { apikey: config.supabaseKey, authorization: `Bearer ${token}` },
    });
  } catch {
    /* offline sign-out is still a sign-out */
  }
}

async function refresh() {
  if (!session?.refreshToken) throw new Error("No refresh token");

  // One refresh at a time. Supabase rotates the refresh token on use, so two
  // concurrent refreshes mean the second presents a token the first just
  // invalidated, and the user is signed out mid-task.
  refreshing ??= authFetch("/token?grant_type=refresh_token", { refresh_token: session.refreshToken })
    .then(store)
    .catch((error) => {
      write(null);
      throw error;
    })
    .finally(() => {
      refreshing = null;
    });

  return refreshing;
}

/** A valid access token, refreshing first if it is close to expiry. */
export async function accessToken() {
  if (!session) return null;
  if (session.expiresAt - EXPIRY_SKEW_MS > Date.now()) return session.accessToken;
  try {
    return (await refresh()).accessToken;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
   PostgREST
   --------------------------------------------------------------------------- */

async function request(path, { method = "GET", body, headers = {}, anon = false, keepalive = false, retry = true } = {}) {
  const token = anon ? null : await accessToken();

  // Every request is bounded. A server that accepts the connection and then
  // never answers is a real state — a captive portal, a proxy holding the
  // socket, a phone handing off between towers — and without a deadline the
  // promise simply never settles: the write neither succeeds nor fails, the
  // outbox never sees it, and the user is left looking at a change that is not
  // going anywhere. An abort produces a rejection, which everything downstream
  // already knows how to treat as "unreachable".
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
      method,
      keepalive,
      signal: controller.signal,
      headers: {
        apikey: config.supabaseKey,
        authorization: `Bearer ${token ?? config.supabaseKey}`,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // No `status`: the server never decided, so callers may retry or queue.
    throw Object.assign(
      new Error(error?.name === "AbortError" ? `${method} ${path} timed out` : `${method} ${path} could not reach the server`),
      { cause: error },
    );
  } finally {
    clearTimeout(deadline);
  }

  // A 401 on a token that looked valid means the server disagrees — revoked,
  // or the device clock is off. Refresh once and retry; if the refresh itself
  // fails the session is already cleared, so report the original 401 rather
  // than firing a second request that is guaranteed to fail the same way.
  if (response.status === 401 && retry && !anon && session) {
    try {
      await refresh();
    } catch {
      throw Object.assign(new Error(`${method} ${path} unauthorized; session ended`), { status: 401 });
    }
    return request(path, { method, body, headers, anon, keepalive, retry: false });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`${method} ${path} failed (${response.status}) ${detail}`.trim());
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

/** Call a Postgres function. `anon` sends the publishable key alone. */
export const rpc = (name, args = {}, options = {}) =>
  request(`/rpc/${name}`, { method: "POST", body: args, ...options });

/** Read rows. `query` is a PostgREST query string without the leading "?". */
export const select = (table, query = "") => request(`/${table}${query ? `?${query}` : ""}`);

/**
 * Insert rows. Returns nothing unless `returning` is asked for.
 *
 * `keepalive` lets the request outlive the page, which is how the last screen
 * of a session gets recorded. sendBeacon would be the obvious choice and is the
 * wrong one: it cannot set an Authorization header, and PostgREST will not read
 * a JWT from the query string, so a beaconed insert arrives as `anon` and is
 * refused by the row-level policy. It would also have put a bearer token in a
 * URL, where it lands in every log along the way.
 */
export const insert = (table, rows, { returning = false, keepalive = false } = {}) =>
  request(`/${table}`, {
    method: "POST",
    body: rows,
    keepalive,
    headers: { prefer: returning ? "return=representation" : "return=minimal" },
  });

export const update = (table, query, patch) =>
  request(`/${table}?${query}`, { method: "PATCH", body: patch, headers: { prefer: "return=minimal" } });
