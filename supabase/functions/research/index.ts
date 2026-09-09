/**
 * research - the endpoint that holds the value.
 *
 * The extension sends observable facts scraped from Amazon pages and gets back
 * finished numbers. It never learns the coefficients, the confidence bands or
 * the advisory thresholds that produced them.
 *
 * Three operations:
 *   score    per-listing unit and revenue estimates plus opportunity scores
 *   analyze  the above, plus every KPI and chart series for the analysis view
 *   brand    brand-level market share, HHI, and competitive advisories
 *
 * One call costs one billable request regardless of item count, so batching is
 * rewarded rather than punished.
 */

import { serveApi, readJson, jsonResponse } from "../_shared/handler.ts";
import { authenticate, enforceQuota } from "../_shared/auth.ts";
import { logUsage } from "../_shared/usage.ts";
import { ApiError, ErrorCode } from "../_shared/errors.ts";
import { analyzeBrands, analyzeMarket, estimateBatch, type RawItem } from "./scoring.ts";

/**
 * Cap on items per call. Generous enough for a full Deep Search page set,
 * small enough that one request cannot pin an Edge Function instance.
 */
const MAX_ITEMS = 1000;

interface ResearchBody {
  op?: string;
  items?: unknown;
  market?: string;
  query?: string;
  ourBrand?: string | null;
  bigThreshold?: number;
}

function readItems(body: ResearchBody): RawItem[] {
  if (!Array.isArray(body.items)) {
    throw new ApiError(ErrorCode.BAD_REQUEST, "`items` must be an array.");
  }
  if (body.items.length === 0) {
    throw new ApiError(ErrorCode.BAD_REQUEST, "`items` must not be empty.");
  }
  if (body.items.length > MAX_ITEMS) {
    throw new ApiError(
      ErrorCode.BAD_REQUEST,
      `Too many items in one request. Send at most ${MAX_ITEMS}.`,
      { limit: MAX_ITEMS, received: body.items.length },
    );
  }
  return body.items.filter(
    (x): x is RawItem => x !== null && typeof x === "object" && !Array.isArray(x),
  );
}

serveApi(async (req, headers) => {
  const startedAt = Date.now();

  // Auth first. A rejection here is logged by the catch in serveApi and never
  // reaches the scoring code, so an unauthenticated caller cannot even measure
  // how long a computation takes.
  const ctx = await authenticate(req);

  const body = await readJson<ResearchBody>(req);
  const op = String(body.op ?? "score").toLowerCase();

  let quota;
  try {
    quota = await enforceQuota(ctx);
  } catch (err) {
    // Log the rejected attempt without billing for it, so the admin usage view
    // shows who is hitting their ceiling.
    await logUsage({
      userId: ctx.userId,
      endpoint: `research.${op}`,
      reference: body.query ?? null,
      responseStatus: 403,
      durationMs: Date.now() - startedAt,
      billable: false,
    });
    throw err;
  }

  const items = readItems(body);
  let payload: Record<string, unknown>;

  switch (op) {
    case "score": {
      payload = { items: estimateBatch(items) };
      break;
    }

    case "analyze": {
      const scored = estimateBatch(items);
      payload = { items: scored, analysis: analyzeMarket(items, scored) };
      break;
    }

    case "brand": {
      payload = {
        brandAnalysis: analyzeBrands(
          items,
          body.ourBrand ?? null,
          Number(body.bigThreshold),
        ),
      };
      break;
    }

    default:
      throw new ApiError(
        ErrorCode.BAD_REQUEST,
        "`op` must be one of: score, analyze, brand.",
        { received: op },
      );
  }

  const durationMs = Date.now() - startedAt;

  await logUsage({
    userId: ctx.userId,
    endpoint: `research.${op}`,
    // Single-ASIN lookups are the interesting case for "most requested ASINs";
    // a batch is recorded under its keyword instead.
    reference: body.query ?? (items.length === 1 ? String(items[0].asin ?? "") : null),
    itemCount: items.length,
    responseStatus: 200,
    durationMs,
    billable: true,
  });

  return jsonResponse(
    {
      ...payload,
      quota: {
        used: quota.used + 1,
        limit: quota.limit,
        remaining: Math.max(0, quota.remaining - 1),
      },
      meta: { op, itemCount: items.length, durationMs },
    },
    200,
    headers,
  );
});
