/**
 * Token custody. Imported only by the service worker.
 *
 * Split storage, on purpose:
 *
 *   access token  -> chrome.storage.session
 *       Lives in memory for the browser session and is gone when the browser
 *       closes. Never written to disk, so it cannot be recovered from a stolen
 *       profile directory after the fact.
 *
 *   refresh token -> chrome.storage.local
 *       Has to survive a browser restart or the user would sign in every
 *       morning. It is the more sensitive of the two, which is why it is
 *       exchangeable exactly once (Supabase rotates it on every use) and why a
 *       rejected refresh clears everything rather than retrying.
 *
 * No page script ever reads either one. The dashboard and popup talk to the
 * service worker over chrome.runtime messages and receive results, never
 * credentials.
 */

import { AUTH_URL, SUPABASE_ANON_KEY } from "../config.js";

const ACCESS_KEY = "amr.accessToken";
const EXPIRY_KEY = "amr.accessExpiresAt";
const REFRESH_KEY = "amr.refreshToken";
const IDENTITY_KEY = "amr.identity";

/**
 * Refresh this many milliseconds before the token actually expires, so a
 * request in flight does not land on the far side of the boundary.
 */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Content scripts must never reach the access token. TRUSTED_CONTEXTS is
 * already the default for storage.session; setting it explicitly means a
 * future change to that default cannot silently widen access.
 */
export async function lockDownSessionStorage() {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch {
    // Older Chrome builds do not expose setAccessLevel; the default is already
    // TRUSTED_CONTEXTS there, so there is nothing to fall back to.
  }
}

async function persist(tokens) {
  const expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;

  await chrome.storage.session.set({
    [ACCESS_KEY]: tokens.access_token,
    [EXPIRY_KEY]: expiresAt,
  });

  await chrome.storage.local.set({
    [REFRESH_KEY]: tokens.refresh_token,
    [IDENTITY_KEY]: {
      email: tokens.user?.email ?? null,
      userId: tokens.user?.id ?? null,
    },
  });
}

/** Wipes every credential. Called on sign-out and on any unrecoverable 401. */
export async function clearSession() {
  await chrome.storage.session.remove([ACCESS_KEY, EXPIRY_KEY]);
  await chrome.storage.local.remove([REFRESH_KEY, IDENTITY_KEY]);
}

export async function getIdentity() {
  const stored = await chrome.storage.local.get(IDENTITY_KEY);
  return stored[IDENTITY_KEY] ?? null;
}

export async function hasRefreshToken() {
  const stored = await chrome.storage.local.get(REFRESH_KEY);
  return Boolean(stored[REFRESH_KEY]);
}

/**
 * Signs in with email and password.
 *
 * There is no sign-up counterpart anywhere in this extension. Accounts exist
 * only because an administrator created them.
 */
export async function signIn(email, password) {
  const response = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: String(email).trim(), password }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // GoTrue does not distinguish "no such account" from "wrong password", and
    // neither should we: it would turn the login form into a way to enumerate
    // which addresses have access.
    const message = response.status === 400
      ? "That email and password do not match an account."
      : body.error_description || body.msg || "Sign in failed. Please try again.";
    throw new Error(message);
  }

  await persist(body);
  return { email: body.user?.email ?? email };
}

/** Signs out locally and best-effort revokes the refresh token server side. */
export async function signOut() {
  const stored = await chrome.storage.session.get(ACCESS_KEY);
  const token = stored[ACCESS_KEY];

  // Clear locally first. If the network call fails the user must still end up
  // signed out on this machine.
  await clearSession();

  if (token) {
    try {
      await fetch(`${AUTH_URL}/logout`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      // Offline sign-out is still a sign-out.
    }
  }
}

/**
 * Exchanges the refresh token for a new pair.
 *
 * Returns null when the refresh token is missing or rejected, which is the
 * signal to force a clean re-login. It never retries: Supabase rotates refresh
 * tokens on use, so a rejected one is dead and retrying it is the classic way
 * to build an infinite refresh loop.
 */
export async function refreshSession() {
  const stored = await chrome.storage.local.get(REFRESH_KEY);
  const refreshToken = stored[REFRESH_KEY];
  if (!refreshToken) return null;

  let response;
  try {
    response = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // A network failure is not a revoked token. Keep the credentials so the
    // next attempt can succeed once connectivity returns.
    return null;
  }

  if (!response.ok) {
    // 400/401 here means revoked, already-used, or expired. Unrecoverable.
    await clearSession();
    return null;
  }

  const body = await response.json();
  await persist(body);
  return body.access_token;
}

/**
 * Returns a usable access token, refreshing pre-emptively if it is close to
 * expiry. Returns null when there is no way to get one without a fresh login.
 */
export async function getAccessToken() {
  const stored = await chrome.storage.session.get([ACCESS_KEY, EXPIRY_KEY]);
  const token = stored[ACCESS_KEY];
  const expiresAt = Number(stored[EXPIRY_KEY]) || 0;

  if (token && Date.now() < expiresAt - EXPIRY_SKEW_MS) return token;

  // Either missing (service worker restarted after the session store was
  // cleared) or about to expire. Both are handled by a refresh.
  return refreshSession();
}
