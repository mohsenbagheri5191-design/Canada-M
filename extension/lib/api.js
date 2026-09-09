/**
 * Edge Function client. Service worker only.
 *
 * Every call to the backend goes through callFunction(). It owns the one piece
 * of retry logic in the product: on a 401 it refreshes once, retries once, and
 * if that also fails it clears the session and reports NEEDS_LOGIN. Exactly one
 * silent retry, never a loop.
 */

import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "../config.js";
import { clearSession, getAccessToken, refreshSession } from "./session.js";

/**
 * Error codes the UI branches on. These mirror the server's codes, plus
 * NEEDS_LOGIN and NETWORK which are decided client side.
 */
export const ApiErrorCode = {
  NEEDS_LOGIN: "needs_login",
  NETWORK: "network_error",
};

export class ApiError extends Error {
  constructor(code, message, status = 0, detail = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  /** Plain object, because Error does not survive chrome.runtime messaging. */
  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        detail: this.detail,
      },
    };
  }
}

async function post(name, body, token) {
  return fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
}

/**
 * Calls an Edge Function and returns its parsed body.
 *
 * Throws ApiError for every failure, so callers branch on `code` rather than
 * on status numbers or message text.
 */
export async function callFunction(name, body = {}) {
  let token = await getAccessToken();
  if (!token) {
    throw new ApiError(
      ApiErrorCode.NEEDS_LOGIN,
      "Please sign in to continue.",
      401,
    );
  }

  let response;
  try {
    response = await post(name, body, token);
  } catch {
    throw new ApiError(
      ApiErrorCode.NETWORK,
      "Could not reach the server. Check your connection and try again.",
    );
  }

  // The one silent retry. A 401 here means the access token was rejected
  // despite looking unexpired, which happens when it was issued before a
  // server-side change or the clock drifted.
  if (response.status === 401) {
    const refreshed = await refreshSession();

    if (!refreshed) {
      await clearSession();
      throw new ApiError(
        ApiErrorCode.NEEDS_LOGIN,
        "Your session has ended. Please sign in again.",
        401,
      );
    }

    try {
      response = await post(name, body, refreshed);
    } catch {
      throw new ApiError(
        ApiErrorCode.NETWORK,
        "Could not reach the server. Check your connection and try again.",
      );
    }

    // Still 401 after a successful refresh: the account itself is gone or the
    // token is being rejected for a reason a refresh cannot fix. Stop here
    // rather than refreshing again, which is how refresh loops start.
    if (response.status === 401) {
      await clearSession();
      throw new ApiError(
        ApiErrorCode.NEEDS_LOGIN,
        "Your session has ended. Please sign in again.",
        401,
      );
    }
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(
      err.code ?? "server_error",
      err.message ?? "The server rejected that request.",
      response.status,
      err.detail ?? null,
    );
  }

  return payload;
}

/** Profile, status and quota for the signed-in user. */
export function fetchMe() {
  return callFunction("me");
}

/**
 * The scoring endpoint.
 *
 * `items` carry only observable page facts. Everything derived comes back from
 * the server; nothing in this file knows how units or revenue are computed.
 */
export function research(op, items, extra = {}) {
  return callFunction("research", { op, items, ...extra });
}
