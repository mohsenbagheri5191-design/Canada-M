/**
 * Error shaping.
 *
 * Every failure leaves an Edge Function in the same envelope so the extension
 * can branch on a stable code instead of pattern-matching prose:
 *
 *     { "error": { "code": "quota_exceeded", "message": "...", "detail": {...} } }
 *
 * Status codes follow the brief: 401 for bad auth, 403 for a disabled or
 * out-of-quota account. Kill switch returns 503 rather than 403, because it is
 * a maintenance state that applies to everyone rather than a judgement about
 * this particular caller, and 503 is what a client should back off from.
 */

export const ErrorCode = {
  // 401 - the caller is not who they say they are
  MISSING_TOKEN: "missing_token",
  INVALID_TOKEN: "invalid_token",

  // 403 - the caller is authenticated but not allowed
  NO_PROFILE: "no_profile",
  ACCOUNT_DISABLED: "account_disabled",
  ACCOUNT_EXPIRED: "account_expired",
  QUOTA_EXCEEDED: "quota_exceeded",
  NOT_ADMIN: "not_admin",
  ORIGIN_NOT_ALLOWED: "origin_not_allowed",

  // 400 - the request itself is malformed
  BAD_REQUEST: "bad_request",

  // 405 / 500 / 503
  METHOD_NOT_ALLOWED: "method_not_allowed",
  SERVER_ERROR: "server_error",
  KILL_SWITCH: "kill_switch",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Maps each code to the status it should be returned with. */
const STATUS: Record<ErrorCodeValue, number> = {
  [ErrorCode.MISSING_TOKEN]: 401,
  [ErrorCode.INVALID_TOKEN]: 401,
  [ErrorCode.NO_PROFILE]: 403,
  [ErrorCode.ACCOUNT_DISABLED]: 403,
  [ErrorCode.ACCOUNT_EXPIRED]: 403,
  [ErrorCode.QUOTA_EXCEEDED]: 403,
  [ErrorCode.NOT_ADMIN]: 403,
  [ErrorCode.ORIGIN_NOT_ALLOWED]: 403,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.METHOD_NOT_ALLOWED]: 405,
  [ErrorCode.SERVER_ERROR]: 500,
  [ErrorCode.KILL_SWITCH]: 503,
};

/**
 * Thrown anywhere inside a handler to abort with a shaped response. The
 * top-level `serve` wrapper catches it and renders the envelope, so handlers
 * never have to thread status codes back up by hand.
 */
export class ApiError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: ErrorCodeValue,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.detail = detail;
  }
}

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function errorResponse(
  err: unknown,
  headers: Record<string, string>,
): Response {
  if (err instanceof ApiError) {
    return jsonResponse(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.detail ? { detail: err.detail } : {}),
        },
      },
      err.status,
      headers,
    );
  }

  // Anything unexpected is logged server side and returned as an opaque 500.
  // Internal messages never reach the client: they leak table names, column
  // names and occasionally connection strings.
  console.error("unhandled error:", err);
  return jsonResponse(
    {
      error: {
        code: ErrorCode.SERVER_ERROR,
        message: "Something went wrong on our side. Please try again.",
      },
    },
    500,
    headers,
  );
}
