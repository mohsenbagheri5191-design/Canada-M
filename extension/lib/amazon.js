/**
 * Amazon collection: fetching pages and handing them to the offscreen parser.
 *
 * This is the commodity half of the product and it stays in the extension on
 * purpose. Two reasons, one practical and one about what is actually worth
 * protecting:
 *
 *   Practical. These requests carry the user's own Amazon cookies from their
 *   own residential IP, which is what makes them look like browsing rather
 *   than scraping. Moving them to a datacenter IP with no session would earn a
 *   robot check within a page or two, and a multi-page crawl would not fit
 *   inside an Edge Function's wall clock anyway.
 *
 *   Substantive. Selectors and pagination are not the intellectual property.
 *   Anyone can write them by reading a product page. The value is in what the
 *   numbers mean, and that now lives in supabase/functions/research/scoring.ts
 *   where the extension cannot see it.
 *
 * Nothing here computes an estimate. Parsed facts go to the server and
 * finished numbers come back.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Set by the STOP message to abort an in-flight crawl. */
let stopped = false;

export function requestStop() {
  stopped = true;
}

export function resetStop() {
  stopped = false;
}

function baseUrl(market) {
  return market === "com" ? "https://www.amazon.com" : "https://www.amazon.ca";
}

/** Ensures the offscreen document exists. It owns DOMParser, which a service worker lacks. */
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Parse Amazon HTML off the main thread",
  });
}

async function parse(type, data) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type, ...data });
}

/**
 * Fetches a page, backing off on the two statuses Amazon uses for pressure.
 *
 * A robot check aborts the whole run rather than retrying: hammering through
 * one is how an account gets flagged.
 */
async function fetchHtml(url, attempt = 0) {
  const response = await fetch(url, { credentials: "include" });

  if ((response.status === 429 || response.status === 503) && attempt < 3) {
    await sleep(2500 * Math.pow(2, attempt));
    return fetchHtml(url, attempt + 1);
  }

  if (!response.ok) throw new Error(`Amazon returned ${response.status}`);

  const text = await response.text();
  if (/captcha|robot check/i.test(text)) {
    throw new Error(
      "Amazon robot check detected. The search stopped to protect your account.",
    );
  }
  return text;
}

function notify(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No dashboard tab open. Progress messages are advisory.
  });
}

/** Walks keyword search result pages, de-duplicating by ASIN. */
export async function search(settings) {
  resetStop();

  const base = baseUrl(settings.market);
  const collected = [];
  const seen = new Set();
  const maxPages = Number(settings.pages) || 0;

  let url = `${base}/s?k=${encodeURIComponent(settings.keyword)}`;
  let page = 0;

  while (url && !stopped && (!maxPages || page < maxPages)) {
    page += 1;

    const html = await fetchHtml(url);
    const result = await parse("PARSE_SEARCH", { html, base });

    for (const item of result.items ?? []) {
      if (seen.has(item.asin)) continue;
      seen.add(item.asin);
      collected.push({ ...item, market: settings.market });
    }

    notify({
      type: "SEARCH_PROGRESS",
      page,
      total: maxPages || page,
      count: collected.length,
    });

    url = result.next ? new URL(result.next, base).href : "";
    await sleep(Math.max(1500, (settings.delay || 2) * 1000));
  }

  return { items: collected, pagesProcessed: page };
}

/**
 * Fetches full detail pages for a list of items.
 *
 * Returns raw parsed facts. Scoring happens afterwards, in one server call for
 * the whole batch.
 */
export async function enrich(items, settings = {}) {
  resetStop();

  const out = [];
  const concurrency = Math.max(1, Math.min(4, settings.concurrency || 3));

  for (let i = 0; i < items.length && !stopped; i += concurrency) {
    const slice = items.slice(i, i + concurrency);

    const results = await Promise.all(
      slice.map(async (item) => {
        try {
          const host = (item.itemLink || "").includes("amazon.com/")
            ? "https://www.amazon.com"
            : baseUrl(item.market);
          const url = item.itemLink || `${host}/dp/${item.asin}`;
          const html = await fetchHtml(url);
          return { ...item, ...(await parse("PARSE_DETAIL", { html, url })) };
        } catch (err) {
          return { ...item, status: "Failed", error: err.message };
        }
      }),
    );

    out.push(...results);

    notify({
      type: "PROGRESS",
      done: Math.min(i + concurrency, items.length),
      total: items.length,
      unique: out.length,
    });

    await sleep(Math.max(1500, (settings.delay || 2) * 1000));
  }

  return { items: out };
}
