/**
 * Service worker: the extension's only door to the network.
 *
 * Everything that touches a token or an API lives here. The dashboard, popup
 * and offscreen document send messages and receive plain JSON. None of them
 * ever holds a credential, and none of them can compute a score.
 *
 * Every product action is gated on a live `me` check first, so a disabled
 * account, an expired account, an exhausted quota or the kill switch stops the
 * work before a single Amazon page is fetched.
 */

import {
  clearSession,
  getIdentity,
  hasRefreshToken,
  lockDownSessionStorage,
  refreshSession,
  signIn,
  signOut,
} from "./lib/session.js";
import { ApiError, ApiErrorCode, callFunction, fetchMe, research } from "./lib/api.js";
import { enrich, requestStop, search } from "./lib/amazon.js";

lockDownSessionStorage();

/** Uniform success envelope, mirroring ApiError.toJSON()'s failure envelope. */
const ok = (data) => ({ ok: true, ...data });

function fail(err) {
  if (err instanceof ApiError) return err.toJSON();
  return {
    ok: false,
    error: {
      code: "client_error",
      message: err?.message ?? "Something went wrong.",
      status: 0,
      detail: null,
    },
  };
}

/**
 * Confirms the caller may do product work right now.
 *
 * Deliberately re-asked on every action rather than cached. That is what makes
 * "disable a user and their very next request fails" true: the answer comes
 * from the server, not from anything this extension remembers.
 */
async function requireActiveSession() {
  const me = await fetchMe();
  return me;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

const handlers = {
  /** Current auth state, for deciding whether to show the login screen. */
  async AUTH_STATE() {
    if (!(await hasRefreshToken())) {
      return ok({ signedIn: false });
    }
    try {
      const me = await requireActiveSession();
      return ok({ signedIn: true, ...me });
    } catch (err) {
      // A blocked account is still signed in; the UI needs to say why rather
      // than bouncing the user back to a login form that will not help.
      if (err instanceof ApiError && err.code !== ApiErrorCode.NEEDS_LOGIN) {
        return { ...fail(err), signedIn: true };
      }
      return { ...fail(err), signedIn: false };
    }
  },

  async AUTH_SIGN_IN({ email, password }) {
    if (!email || !password) {
      throw new Error("Enter your email and password.");
    }
    await signIn(email, password);

    // Signing in proves the credentials; `me` proves the account is allowed to
    // work. An invited-then-disabled user passes the first and fails this one.
    const me = await requireActiveSession();
    return ok({ signedIn: true, ...me });
  },

  async AUTH_SIGN_OUT() {
    await signOut();
    return ok({ signedIn: false });
  },

  async AUTH_IDENTITY() {
    return ok({ identity: await getIdentity() });
  },

  /** Forces a refresh. Used by the "retry" affordance on session errors. */
  async AUTH_REFRESH() {
    const token = await refreshSession();
    if (!token) {
      await clearSession();
      return ok({ signedIn: false });
    }
    return ok({ signedIn: true });
  },

  /** Keyword search across Amazon result pages. */
  async SEARCH({ settings }) {
    await requireActiveSession();
    return ok(await search(settings));
  },

  /**
   * Detail fetch plus scoring.
   *
   * Amazon is read in the browser; the numbers come from the server. The two
   * are joined here so callers get one finished list back.
   */
  async ENRICH({ items, settings, query }) {
    await requireActiveSession();

    const collected = await enrich(items, settings);
    if (!collected.items.length) return ok({ items: [], quota: null });

    const scored = await research("score", collected.items, { query });
    return ok(mergeScores(collected.items, scored));
  },

  /** Scores an existing set of rows without re-fetching Amazon. */
  async SCORE({ items, query }) {
    await requireActiveSession();
    const scored = await research("score", items, { query });
    return ok(mergeScores(items, scored));
  },

  /** Scores plus the full KPI and chart payload for the analysis view. */
  async ANALYZE({ items, query }) {
    await requireActiveSession();
    const result = await research("analyze", items, { query });
    return ok({
      ...mergeScores(items, result),
      analysis: result.analysis,
    });
  },

  /** Brand market share, HHI and competitive advisories. */
  async BRAND_ANALYSIS({ rows, ourBrand, bigThreshold }) {
    await requireActiveSession();
    const result = await research("brand", rows, { ourBrand, bigThreshold });
    return ok({
      brandAnalysis: result.brandAnalysis,
      quota: result.quota,
    });
  },

  /** Admin endpoints, proxied so the dashboard never handles tokens either. */
  async ADMIN({ endpoint, body }) {
    if (endpoint !== "admin-users" && endpoint !== "admin-usage") {
      throw new Error("Unknown admin endpoint.");
    }
    return ok(await callFunction(endpoint, body));
  },

  /**
   * Runs a saved market: crawl its keywords, enrich what is new, score it, and
   * file anything not already tracked as a suggestion.
   */
  async RUN_MARKET_SCAN({ marketId }) {
    await requireActiveSession();
    return ok(await runMarketScan(marketId));
  },

  /** Arms or clears the recurring alarm for a market. */
  async SET_MARKET_SCHEDULE({ marketId, frequency }) {
    const name = ALARM_PREFIX + marketId;
    await chrome.alarms.clear(name);

    if (frequency && frequency !== "off") {
      chrome.alarms.create(name, {
        when: Date.now() + 60_000,
        periodInMinutes:
          frequency === "daily" ? 1440 : frequency === "weekly" ? 10080 : 43200,
      });
    }
    return ok({});
  },

  async STOP() {
    requestStop();
    return ok({});
  },
};

const ALARM_PREFIX = "marketScan:";

/** Keywords crawled per scan. Caps how long one run can hold the worker. */
const MAX_SCAN_KEYWORDS = 10;

function progress(marketId, stage, extra = {}) {
  chrome.runtime
    .sendMessage({ type: "MARKET_PROGRESS", marketId, stage, ...extra })
    .catch(() => {});
}

async function runMarketScan(marketId) {
  const stored = await chrome.storage.local.get("marketWorkspaces");
  const markets = stored.marketWorkspaces || [];
  const market = markets.find((m) => m.id === marketId);
  if (!market) throw new Error("That market no longer exists.");

  const catalog = new Map((market.catalog || []).map((x) => [x.asin, x]));
  const tracked = new Set(market.asins || []);
  const ignored = new Set(market.ignoredAsins || []);
  const suggested = new Set((market.suggestions || []).map((x) => x.asin));

  const keywords = (market.keywords || []).slice(0, MAX_SCAN_KEYWORDS);
  const fresh = [];
  let enrichedCount = 0;
  let pagesCrawled = 0;

  // Tracked ASINs with no price yet have never been enriched. Fill them first
  // so the dashboard has real numbers even if the keyword crawl finds nothing.
  const missing = (market.asins || [])
    .filter((asin) => !catalog.get(asin)?.priceNumber)
    .map((asin) => ({
      asin,
      market: market.market,
      itemLink: `https://www.amazon.${market.market === "com" ? "com" : "ca"}/dp/${asin}`,
    }));

  if (missing.length) {
    progress(marketId, "Enriching tracked ASINs", {
      index: 0,
      total: Math.max(1, keywords.length || 1),
      found: missing.length,
      enriched: 0,
      pages: 0,
    });

    const enriched = await enrich(missing, market.settings);
    const scored = await research("score", enriched.items, { query: market.name });
    const byAsin = new Map((scored.items ?? []).map((s) => [s.asin, s]));

    for (const item of enriched.items) {
      const merged = { ...item, ...(byAsin.get(String(item.asin).toUpperCase()) ?? {}) };
      catalog.set(merged.asin, merged);
    }
    enrichedCount += enriched.items.length;
  }

  for (const [index, keyword] of keywords.entries()) {
    progress(marketId, "Searching keyword", {
      keyword,
      index: index + 1,
      total: keywords.length,
      found: fresh.length,
      enriched: enrichedCount,
      pages: pagesCrawled,
    });

    const found = await search({
      keyword,
      market: market.market,
      pages: market.settings?.pages ?? 3,
      delay: market.settings?.delay ?? 4,
    });
    pagesCrawled += found.pagesProcessed || 0;

    const candidates = (found.items || []).filter(
      (x) => !tracked.has(x.asin) && !ignored.has(x.asin) && !suggested.has(x.asin),
    );
    if (!candidates.length) continue;

    const enriched = await enrich(candidates, market.settings);
    const scored = await research("score", enriched.items, { query: keyword });
    const byAsin = new Map((scored.items ?? []).map((s) => [s.asin, s]));

    for (const item of enriched.items) {
      const merged = {
        ...item,
        ...(byAsin.get(String(item.asin).toUpperCase()) ?? {}),
        foundKeyword: keyword,
        foundAt: new Date().toISOString(),
      };
      fresh.push(merged);
      suggested.add(merged.asin);
    }
    enrichedCount += enriched.items.length;
  }

  market.catalog = [...catalog.values()];
  market.suggestions = [...(market.suggestions || []), ...fresh];
  market.lastUpdate = new Date().toISOString();

  await chrome.storage.local.set({ marketWorkspaces: markets });

  progress(marketId, "Complete", {
    index: keywords.length || 1,
    total: keywords.length || 1,
    found: fresh.length,
    enriched: enrichedCount,
    pages: pagesCrawled,
  });

  return { suggestions: fresh.length, enriched: enrichedCount };
}

/**
 * Scheduled scans.
 *
 * A scan that fires while the account is disabled, expired, over quota or
 * during a kill switch simply logs and stops. It must never sit in a retry
 * loop against a server that is refusing it.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const marketId = alarm.name.slice(ALARM_PREFIX.length);

  requireActiveSession()
    .then(() => runMarketScan(marketId))
    .catch((err) => {
      console.warn(`scheduled scan for ${marketId} skipped:`, err.message);
    });
});

/**
 * Re-attaches server-computed figures to the rows the client already holds,
 * matching on ASIN.
 *
 * The client keeps titles, images and links; the server owns every number.
 */
function mergeScores(rows, payload) {
  const scores = new Map(
    (payload.items ?? []).map((item) => [String(item.asin).toUpperCase(), item]),
  );

  const merged = rows.map((row) => {
    const score = scores.get(String(row.asin ?? "").toUpperCase());
    return score ? { ...row, ...score } : row;
  });

  return { items: merged, quota: payload.quota ?? null };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Offscreen parser replies are routed by the offscreen document itself.
  if (message?.target === "offscreen") return false;

  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message ?? {})
    .then(sendResponse)
    .catch((err) => sendResponse(fail(err)));

  // Keeps the message channel open for the async reply.
  return true;
});

/**
 * Opens the dashboard from the toolbar icon.
 *
 * The dashboard decides whether to render the login screen or the workspace;
 * there is no separate signed-out entry point to keep in sync.
 */
chrome.action.onClicked?.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});
