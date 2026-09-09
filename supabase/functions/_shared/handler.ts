/**
 * The wrapper every Edge Function is served through.
 *
 * Centralises the four things that must not vary between endpoints: CORS
 * preflight, origin enforcement, method checking, and error shaping. A handler
 * only has to return a value; throwing an ApiError anywhere inside it produces
 * a correctly shaped, correctly CORS-headed response.
 */

import { assertOriginAllowed, corsHeaders, preflight } from "./cors.ts";
import { ApiError, ErrorCode, errorResponse, jsonResponse } from "./errors.ts";

export type Handler = (
  req: Request,
  headers: Record<string, string>,
) => Promise<Response>;

export function serveApi(handler: Handler): void {
  Deno.serve(async (req: Request) => {
    const origin = req.headers.get("Origin");

    const pre = await preflight(req);
    if (pre) return pre;

    const headers = await corsHeaders(origin);

    try {
      // Origin first: a caller we do not recognise gets no further, and in
      // particular never reaches the auth code or the database.
      await assertOriginAllowed(req);

      if (req.method !== "POST") {
        throw new ApiError(
          ErrorCode.METHOD_NOT_ALLOWED,
          "This endpoint only accepts POST.",
        );
      }

      return await handler(req, headers);
    } catch (err) {
      return errorResponse(err, headers);
    }
  });
}

/** Parses a JSON body, turning malformed input into a clean 400. */
export async function readJson<T = Record<string, unknown>>(
  req: Request,
): Promise<T> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("body must be a JSON object");
    }
    return body as T;
  } catch {
    throw new ApiError(
      ErrorCode.BAD_REQUEST,
      "Request body must be a JSON object.",
    );
  }
}

export { jsonResponse };
