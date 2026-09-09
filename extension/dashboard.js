/**
 * Deep Search and analysis dashboards.
 *
 * What changed in the rebuild: this file no longer knows how to turn a sales
 * rank into a number of units. It collects observable facts, sends them to the
 * service worker, and renders whatever comes back. Searching `Math.exp` or
 * `Math.log` in this file finds nothing, and that is the point.
 *
 * It also no longer calls the SheetJS `XLSX` global, which the V29 build
 * referenced in three places without ever loading it. Every CSV export and
 * every file upload threw ReferenceError. Reading now goes through
 * ProductWorkbook (product-workbook.js) and writing through
 * writeExactProductXlsx (xlsx-export.js), both of which were already in the
 * bundle and already worked.
 */

// --------------------------------------------------------------------------
// Service worker bridge
// --------------------------------------------------------------------------

/**
 * Every network call in this file goes through here. Nothing else may fetch.
 *
 * Failures are routed to window.amrHandleError, which decides whether the
 * session is over (back to the gate) or just this action failed (a toast), and
 * hands back a message suitable for an inline status line.
 */
function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: { code: "network_error", message: chrome.runtime.lastError.message },
        });
        return;
      }
      resolve(response);
    });
  });
}

/** Throws on failure so callers can use one try/catch around a whole flow. */
async function call(message) {
  const response = await send(message);
  if (response?.ok) {
    if (response.quota) window.amrUpdateQuota?.(response.quota);
    return response;
  }
  const text = window.amrHandleError?.(response?.error) ??
    (response?.error?.message ?? "Request failed.");
  const err = new Error(text);
  err.code = response?.error?.code;
  throw err;
}

/** Refuses to start work the gate has not cleared. */
function requireSession() {
  if (!window.amrSession?.ready) {
    throw new Error("Sign in to run a search.");
  }
}

// --------------------------------------------------------------------------
// DOM helpers
//
// The V29 build used a Proxy that silently absorbed writes to missing
// elements. That is what hid the crash in market-v21.js for so long, so this
// version keeps the null-safety but complains in the console.
// --------------------------------------------------------------------------

const NOOP_CLASSLIST = { add() {}, remove() {}, toggle() { return false; } };

const NOOP_ELEMENT = new Proxy(
  {
    value: "",
    files: [],
    style: {},
    dataset: {},
    classList: NOOP_CLASSLIST,
    selectedOptions: [{ text: "" }],
    querySelector: () => NOOP_ELEMENT,
    querySelectorAll: () => [],
    prepend() {},
    insertAdjacentElement() {},
    insertAdjacentHTML() {},
    addEventListener() {},
  },
  {
    get: (target, key) => (key in target ? target[key] : ""),
    set: (target, key, value) => ((target[key] = value), true),
  },
);

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el && !$.warned.has(id)) {
    $.warned.add(id);
    console.warn(`[dashboard] missing element #${id}`);
  }
  return el || NOOP_ELEMENT;
};
$.warned = new Set();

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const num = (value) => {
  const m = String(value ?? "").replace(/,/g, "").match(/[\d.]+/);
  return m ? +m[0] : null;
};

const money = (v) => "$" + Math.round(Number(v) || 0).toLocaleString();

// --------------------------------------------------------------------------
// Loader
// --------------------------------------------------------------------------

function inlineLoaderHost() {
  const active = document.querySelector(".tab:not(.hidden)") || $("light");
  const loader = $("searchLoader");
  loader.classList.add("inlineSearchLoader");
  loader.classList.remove("hidden");
  const status = active.querySelector?.(".status");
  if (status) status.insertAdjacentElement("afterend", loader);
  else active.prepend(loader);
  return loader;
}

function showLoader(title = "Starting search", message = "Preparing Amazon...") {
  inlineLoaderHost();
  $("loaderTitle").textContent = title;
  $("loaderMessage").textContent = message;
  $("loaderBar").style.width = "4%";
  $("loaderStep").textContent = "1";
  $("loaderPage").textContent = "0 / 0";
  $("loaderProducts").textContent = "0";
  $("loaderDone").textContent = "0 / 0";
  $("loaderCurrent").textContent = message;
}

function updateLoader(o = {}) {
  if (o.title) $("loaderTitle").textContent = o.title;
  if (o.message) $("loaderMessage").textContent = o.message;
  if (o.stage) $("loaderStep").textContent = o.stage;
  if (o.page != null) $("loaderPage").textContent = `${o.page} / ${o.total || o.page}`;
  if (o.count != null) $("loaderProducts").textContent = o.count;
  if (o.done != null) $("loaderDone").textContent = `${o.done} / ${o.total || o.done}`;
  if (o.current) $("loaderCurrent").textContent = o.current;

  const pct = o.percent ??
    (o.done != null && o.total
      ? (o.done / o.total) * 100
      : o.page != null && o.total
      ? (o.page / o.total) * 42
      : 8);
  $("loaderBar").style.width = Math.max(4, Math.min(100, pct)) + "%";
}

function hideLoader(success = true) {
  updateLoader({
    title: success ? "Search complete" : "Search stopped",
    message: success ? "Results are ready." : "The operation ended.",
    percent: 100,
  });
  setTimeout(() => $("searchLoader").classList.add("hidden"), success ? 900 : 250);
}

$("loaderStop").onclick = () => {
  send({ type: "STOP" });
  hideLoader(false);
};

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

let lightRaw = [];
let lightView = [];
let deepAll = [];
let deepView = [];
let analysisFileRows = [];
let analysisRows = [];
let asinFileRows = [];
let lightAsinFileRows = [];

/** Server-computed analysis payload. Never rebuilt locally. */
let serverAnalysis = null;

// --------------------------------------------------------------------------
// Filter and table controls
// --------------------------------------------------------------------------

const input = (p, id, label, type = "text", extra = "") =>
  `<div><label>${label}</label><input id="${p}${id}" type="${type}" ${extra}></div>`;

const select = (p, id, label, options) =>
  `<div><label>${label}</label><select id="${p}${id}">${
    options.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("")
  }</select></div>`;

function filters(p) {
  return input(p, "Min", "Price Min", "number", 'step=".01"') +
    input(p, "Max", "Price Max", "number", 'step=".01"') +
    input(p, "In", "Title Contains") +
    input(p, "Out", "Title Does Not Contain") +
    input(p, "Brand", "Brand") +
    select(p, "Sponsored", "Sponsored", [["exclude", "No"], ["all", "All"], ["only", "Only sponsored"]]) +
    select(p, "Dedupe", "Remove Duplicates", [["yes", "Yes"], ["no", "No"]]) +
    select(p, "Sort", "Sort By", [
      ["name", "Title"],
      ["priceNumber", "Price"],
      ["rankNumber", "Main Rank"],
      ["bsrEstimatedUnitsMid", "Monthly Units"],
      ["reviewCountNumber", "Reviews"],
      ["opportunityScore", "Opportunity Score"],
    ]) +
    select(p, "Dir", "Direction", [["asc", "Low to high / A-Z"], ["desc", "High to low / Z-A"]]);
}

$("f1").innerHTML =
  select("a", "Market", "Marketplace", [["ca", "Amazon.ca"], ["com", "Amazon.com"]]) +
  input("a", "Keyword", "Keyword / Search Term") +
  input("a", "Pages", "Pages (0 = all available)", "number", 'value="3" min="0" step="1"') +
  filters("a");

$("f2").innerHTML = filters("b") +
  select("b", "Con", "Parallel Background Workers",
    [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]) +
  input("b", "Delay", "Delay Seconds", "number", 'value="4"');

$("f3").innerHTML = filters("c");

$("deepInputs").innerHTML =
  input("d", "Keyword", "Keyword for Deep Search") +
  select("d", "Market", "Marketplace", [["ca", "Amazon.ca"], ["com", "Amazon.com"]]) +
  input("d", "Pages", "Pages (0 = all available)", "number", 'value="3" min="0" step="1"') +
  `<div><label>Upload ASIN file</label><input id="asinFile" type="file" accept=".txt,.csv,.xlsx"></div>
   <div style="grid-column:span 2"><label>Or paste ASINs</label>
   <textarea id="asinPaste" placeholder="One ASIN per line, or comma-separated"></textarea></div>`;

const cols = [
  "imageLink", "name", "asin", "parentAsin", "variationCount", "packQuantity",
  "price", "review", "reviewCount", "amazonBadgeMinimumUnits",
  "bsrEstimatedUnitsMid", "bsrEstimatedRevenueMid", "opportunityScore",
  "estimateConfidence", "rank", "rankCategory", "subcategoryRank", "rankedSubcategory",
  "brand", "manufacturer", "productDimensions", "itemWeight", "countryOfOrigin",
  "availability", "buyBoxSeller", "shipsFrom", "sponsored", "itemLink", "status",
];

const labels = {
  imageLink: "Image", name: "Title", asin: "ASIN", parentAsin: "Parent ASIN",
  variationCount: "Family Size", packQuantity: "Pack Qty", price: "Price",
  review: "Rating", reviewCount: "Reviews", amazonBadgeMinimumUnits: "Badge Units",
  bsrEstimatedUnitsMid: "Estimated Monthly Units",
  bsrEstimatedRevenueMid: "Estimated Sales Value",
  opportunityScore: "Opportunity Score", estimateConfidence: "Confidence",
  rank: "Main Rank", rankCategory: "Main Category", subcategoryRank: "Sub Rank",
  rankedSubcategory: "Subcategory", brand: "Brand", manufacturer: "Manufacturer",
  productDimensions: "Product Size", itemWeight: "Weight", countryOfOrigin: "Origin",
  availability: "Availability", buyBoxSeller: "Buy Box Seller", shipsFrom: "Ships From",
  sponsored: "Sponsored", itemLink: "Product Link", status: "Status",
};

const terms = (id) =>
  $(id).value.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);

function filterRows(rows, p) {
  const inc = terms(p + "In");
  const out = terms(p + "Out");
  const brands = terms(p + "Brand");
  const min = $(p + "Min").value === "" ? null : +$(p + "Min").value;
  const max = $(p + "Max").value === "" ? null : +$(p + "Max").value;
  const sponsored = $(p + "Sponsored").value;
  const seen = new Set();

  const filtered = rows.filter((x) => {
    const title = (x.name || "").toLowerCase();
    const brand = (x.brand || "").toLowerCase();
    const duplicate = seen.has(x.asin);
    seen.add(x.asin);

    return ($(p + "Dedupe").value === "no" || !duplicate) &&
      (sponsored === "all" || (sponsored === "only" ? x.sponsored : !x.sponsored)) &&
      (min == null || x.priceNumber >= min) &&
      (max == null || x.priceNumber <= max) &&
      (!inc.length || inc.some((w) => title.includes(w))) &&
      !out.some((w) => title.includes(w)) &&
      (!brands.length || brands.some((w) => brand.includes(w)));
  });

  const key = $(p + "Sort").value;
  const dir = $(p + "Dir").value === "desc" ? -1 : 1;

  return filtered.sort((a, b) => {
    const av = a[key] ?? "";
    const bv = b[key] ?? "";
    const cmp = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { numeric: true });
    return cmp * dir;
  });
}

const headerState = {};

function applyHeader(rows, id) {
  let out = rows;
  for (const [key, f] of Object.entries(headerState[id] || {})) {
    if (f.op === "asc" || f.op === "desc") {
      const dir = f.op === "desc" ? -1 : 1;
      out = [...out].sort((a, b) =>
        String(a[key] ?? "").localeCompare(String(b[key] ?? ""), undefined, { numeric: true }) * dir
      );
    } else {
      out = out.filter((x) => {
        const s = String(x[key] ?? "").toLowerCase();
        const w = String(f.v).toLowerCase();
        const n = num(x[key]);
        const q = num(f.v);
        return f.op === "contains" ? s.includes(w)
          : f.op === "not" ? !s.includes(w)
          : f.op === "lt" ? n < q
          : f.op === "gt" ? n > q
          : s === w;
      });
    }
  }
  return out;
}

function render(id, rows) {
  const view = applyHeader([...rows], id);

  const menu = (k) =>
    `<select class="hf" data-k="${k}"><option value="">Filter</option>` +
    `<option value="asc">Low to High</option><option value="desc">High to Low</option>` +
    `<option value="lt">Less than</option><option value="gt">Greater than</option>` +
    `<option value="contains">Contains</option><option value="not">Does not contain</option>` +
    `<option value="clear">Clear</option></select>`;

  let html = "<table><thead><tr>" +
    cols.map((k) => `<th>${labels[k]}<br>${menu(k)}</th>`).join("") +
    "</tr></thead><tbody>";

  for (const row of view) {
    html += "<tr>" + cols.map((k) =>
      k === "imageLink" && row[k]
        ? `<td><img class="thumb" src="${esc(row[k])}"></td>`
        : `<td>${esc(typeof row[k] === "boolean" ? (row[k] ? "Yes" : "No") : row[k])}</td>`
    ).join("") + "</tr>";
  }

  $(id).innerHTML = html + "</tbody></table>";

  document.querySelectorAll(`#${id} .hf`).forEach((sel) => {
    sel.onchange = () => {
      const op = sel.value;
      const key = sel.dataset.k;
      headerState[id] ??= {};

      if (op === "clear" || !op) {
        delete headerState[id][key];
      } else if (op === "asc" || op === "desc") {
        headerState[id][key] = { op };
      } else {
        const v = prompt(`${labels[key]} value`);
        if (v !== null) headerState[id][key] = { op, v };
      }
      render(id, rows);
    };
  });
}

// --------------------------------------------------------------------------
// ASIN input parsing
// --------------------------------------------------------------------------

function extractAsins(value) {
  const text = String(value ?? "").toUpperCase();
  const found = new Set();
  const patterns = [
    /(?:\/DP\/|\/GP\/PRODUCT\/)([A-Z0-9]{10})(?:[/?]|$)/g,
    /(?:^|[\s,;|"'])([A-Z0-9]{10})(?=$|[\s,;|"'])/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) found.add(m[1]);
  }
  return [...found];
}

const productItem = (asin, market = "ca") => ({
  asin,
  market,
  itemLink: `https://${market === "com" ? "www.amazon.com" : "www.amazon.ca"}/dp/${asin}`,
  status: "Queued",
});

const itemsFromText = (text, market = "ca") =>
  [...new Set(extractAsins(text))].map((a) => productItem(a, market));

/**
 * Reads an uploaded ASIN list.
 *
 * Uses the bundled ProductWorkbook reader. The V29 build called XLSX.read here
 * against a library that was never loaded.
 */
async function parseFile(file, market = "ca") {
  if (!file) throw new Error("No file selected.");

  let values = [];
  if (/\.(txt)$/i.test(file.name)) {
    values = [await file.text()];
  } else {
    const rows = await ProductWorkbook.read(file);
    for (const row of rows) values.push(...Object.values(row));
  }

  const asins = [...new Set(values.flatMap(extractAsins))];
  return asins.map((a) => productItem(a, market));
}

function downloadAsinTemplate() {
  window.writeExactProductXlsx(
    [
      { ASIN: "B000000000", "Product URL (optional)": "" },
      { ASIN: "", "Product URL (optional)": "https://www.amazon.ca/dp/B000000001" },
    ],
    "amazon-asin-input-template.xlsx",
  );
}

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------

const exportColumns = [
  "name", "asin", "parentAsin", "variationCount", "packQuantity", "brand", "manufacturer",
  "price", "priceNumber", "review", "reviewCount", "amazonBadgeMinimumUnits",
  "rank", "rankCategory", "subcategoryRank", "rankedSubcategory",
  "bsrEstimatedUnitsLow", "bsrEstimatedUnitsMid", "bsrEstimatedUnitsHigh",
  "bsrEstimatedRevenueLow", "bsrEstimatedRevenueMid", "bsrEstimatedRevenueHigh",
  "opportunityScore", "estimateModel", "estimateConfidence", "estimateReason",
  "productDimensions", "packageDimensions", "itemWeight", "countryOfOrigin",
  "availability", "buyBoxSeller", "shipsFrom", "sponsored", "itemLink", "imageLink", "status",
];

const exportLabels = {
  name: "Product Title", asin: "ASIN", parentAsin: "Parent ASIN",
  variationCount: "Variation Count", packQuantity: "Pack Quantity", brand: "Brand",
  manufacturer: "Manufacturer", price: "Current Price", priceNumber: "Price Number",
  review: "Rating", reviewCount: "Review Count",
  amazonBadgeMinimumUnits: "Badge Minimum Units", rank: "Main Rank",
  rankCategory: "Main Rank Category", subcategoryRank: "Subcategory Rank",
  rankedSubcategory: "Ranked Subcategory",
  bsrEstimatedUnitsLow: "Estimated Units Low", bsrEstimatedUnitsMid: "Estimated Units Mid",
  bsrEstimatedUnitsHigh: "Estimated Units High",
  bsrEstimatedRevenueLow: "Estimated Revenue Low",
  bsrEstimatedRevenueMid: "Estimated Revenue Mid",
  bsrEstimatedRevenueHigh: "Estimated Revenue High",
  opportunityScore: "Opportunity Score", estimateModel: "Estimate Model",
  estimateConfidence: "Estimate Confidence", estimateReason: "Estimate Reason",
  productDimensions: "Product Dimensions", packageDimensions: "Package Dimensions",
  itemWeight: "Item Weight", countryOfOrigin: "Country of Origin",
  availability: "Availability", buyBoxSeller: "Buy Box Seller", shipsFrom: "Ships From",
  sponsored: "Sponsored", itemLink: "Product Link", imageLink: "Image Link", status: "Status",
};

/** Strips a repeated field label out of a scraped detail value ("Brand: Acme" -> "Acme"). */
function cleanLabeledDetail(value, label = "") {
  const text = String(value ?? "")
    .replace(/[‎‏‪-‮⁦-⁩­]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const names = [label, "Manufacturer", "Item Model Number", "Model Number",
    "Product Dimensions", "Item Dimensions", "Country of Origin"]
    .filter(Boolean)
    .map((x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  return text.replace(new RegExp("^(?:" + names.join("|") + ")\\s*[:：-]\\s*", "i"), "").trim();
}

function exportCell(row, key) {
  if (["manufacturer", "productDimensions", "countryOfOrigin"].includes(key)) {
    return cleanLabeledDetail(row[key], exportLabels[key]);
  }
  return row[key] ?? "";
}

const cleanRows = (rows) =>
  rows.map((row) =>
    Object.fromEntries(exportColumns.map((k) => [exportLabels[k], exportCell(row, k)]))
  );

/**
 * CSV writer.
 *
 * Replaces XLSX.utils.sheet_to_csv, which never existed at runtime. Leading
 * =, +, - and @ are prefixed with a quote so a scraped product title cannot
 * become a formula when the file is opened in Excel.
 */
function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);

  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };

  return [
    headers.map(cell).join(","),
    ...rows.map((row) => headers.map((h) => cell(row[h])).join(",")),
  ].join("\r\n");
}

function exportCsv(rows, filename) {
  if (!rows.length) return alert("Nothing to export yet.");

  const blob = new Blob(["﻿" + toCsv(cleanRows(rows))], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
}

// --------------------------------------------------------------------------
// Tab 1: keyword and ASIN search
// --------------------------------------------------------------------------

$("run").onclick = async () => {
  showLoader("Starting keyword search", "Checking your access and connecting to Amazon...");
  try {
    requireSession();

    const mode = document.querySelector("[name=lightMode]:checked")?.value || "keyword";
    $("s1").textContent = "Preparing input...";

    if (mode === "keyword") {
      const keyword = $("aKeyword").value.trim();
      if (!keyword) throw new Error("Enter a keyword or ASIN.");

      const direct = itemsFromText(keyword, $("aMarket").value);

      if (direct.length) {
        $("s1").textContent = `ASIN detected. Retrieving details for ${direct.length} product(s)...`;
        const result = await call({
          type: "ENRICH",
          items: direct,
          settings: { concurrency: settings.workers, delay: settings.delay },
          query: keyword,
        });
        lightRaw = result.items;
        $("s1").textContent = `ASIN detail search completed: ${lightRaw.length} products.`;
      } else {
        const result = await call({
          type: "SEARCH",
          settings: {
            keyword,
            market: $("aMarket").value,
            pages: +$("aPages").value,
            delay: settings.delay,
          },
        });
        lightRaw = result.items;
        $("s1").textContent = `Keyword search completed: ${lightRaw.length} products.`;
      }
    } else {
      const items = mode === "file"
        ? lightAsinFileRows
        : itemsFromText($("lightAsinPaste").value, $("aMarket").value);

      if (!items.length) {
        throw new Error(
          mode === "file"
            ? "Upload a file containing a valid ASIN or Amazon URL."
            : "Paste at least one valid ASIN or Amazon product URL.",
        );
      }

      $("s1").textContent = `Retrieving details for ${items.length} ASINs...`;
      const result = await call({
        type: "ENRICH",
        items,
        settings: { concurrency: settings.workers, delay: settings.delay },
      });
      lightRaw = result.items;
      $("s1").textContent = `ASIN detail search completed: ${lightRaw.length} products.`;
    }

    lightView = filterRows(lightRaw, "a");
    render("t1", lightView);
    highlightBestSellers();
    hideLoader(true);
  } catch (err) {
    $("s1").textContent = err.message;
    hideLoader(false);
  }
};

$("apply1").onclick = () => {
  lightView = filterRows(lightRaw, "a");
  render("t1", lightView);
};

$("lightAsinFile").onchange = async (event) => {
  try {
    lightAsinFileRows = await parseFile(event.target.files[0], $("aMarket").value);
    $("s1").textContent = `Loaded ${lightAsinFileRows.length} unique ASINs from ${event.target.files[0].name}.`;
  } catch (err) {
    lightAsinFileRows = [];
    $("s1").textContent = `File error: ${err.message}`;
  }
};

$("lightTemplate").onclick = downloadAsinTemplate;
$("csv1").onclick = () => exportCsv(lightView, "amazon-light-search.csv");

// --------------------------------------------------------------------------
// Tab 2: Deep Search
// --------------------------------------------------------------------------

$("asinFile").onchange = async (event) => {
  try {
    asinFileRows = await parseFile(event.target.files[0], $("dMarket").value);
    $("s2").textContent = `Loaded ${asinFileRows.length} unique ASINs from ${event.target.files[0].name}.`;
  } catch (err) {
    asinFileRows = [];
    $("s2").textContent = `File error: ${err.message}`;
  }
};

$("deepTemplate").onclick = downloadAsinTemplate;

$("deepRun").onclick = async () => {
  showLoader("Starting Deep Search", "Finding products and preparing full detail extraction...");
  try {
    requireSession();

    const mode = document.querySelector("[name=deepMode]:checked")?.value || "tab1";
    let input = [];
    let query = "";

    if (mode === "file") {
      input = [...asinFileRows, ...itemsFromText($("asinPaste").value, $("dMarket").value)];
    } else {
      query = $("dKeyword").value.trim();
      if (!query) throw new Error("Enter a keyword for Deep Search.");

      const result = await call({
        type: "SEARCH",
        settings: {
          keyword: query,
          market: $("dMarket").value,
          pages: +$("dPages").value,
          delay: settings.delay,
        },
      });
      input = result.items;
    }

    input = [...new Map(input.filter((x) => x.asin).map((x) => [x.asin, x])).values()];
    if (!input.length) {
      throw new Error("No valid input products. Upload a file, paste ASINs, or enter a keyword.");
    }

    $("s2").textContent = `Retrieving full details for ${input.length} products...`;

    const enriched = await call({
      type: "ENRICH",
      items: input,
      settings: { concurrency: settings.workers, delay: settings.delay },
      query,
    });

    deepAll = enriched.items;
    deepView = filterRows(deepAll, "b");
    render("t2", deepView);
    $("s2").textContent = `Deep Search completed ${deepAll.length}; showing ${deepView.length}.`;
    highlightBestSellers();
    hideLoader(true);
  } catch (err) {
    $("s2").textContent = err.message;
    hideLoader(false);
  }
};

$("apply2").onclick = () => {
  deepView = filterRows(deepAll, "b");
  render("t2", deepView);
};

$("xlsx2").onclick = async () => {
  if (!deepAll.length) return alert("No Deep Search results to export.");
  await window.writeExactProductXlsx(cleanRows(deepAll), "amazon-product-details.xlsx");
};

$("csv2").onclick = () => exportCsv(deepView, "amazon-product-details.csv");

// --------------------------------------------------------------------------
// Tab 3: analysis
//
// Every KPI, band and chart series below is computed server side. This section
// draws numbers; it does not produce them.
// --------------------------------------------------------------------------

$("analysisFile").onchange = async (event) => {
  try {
    requireSession();
    const file = event.target.files[0];
    const raw = await ProductWorkbook.read(file);

    const rows = raw.map(normalizeObject).filter((x) => x.asin);
    if (!rows.length) throw new Error("No valid ASIN rows found in that file.");

    // An uploaded workbook may carry stale or third-party figures. Re-score it
    // so every row in the analysis came from the same model.
    const scored = await call({ type: "SCORE", items: rows });
    analysisFileRows = scored.items;

    $("insights").textContent =
      `Loaded and scored ${analysisFileRows.length} product rows from ${file.name}.`;
  } catch (err) {
    analysisFileRows = [];
    $("insights").textContent = err.message;
  }
};

const headerAliases = {
  producttitle: "name", title: "name", asin: "asin", parentasin: "parentAsin",
  variationcount: "variationCount", brand: "brand", manufacturer: "manufacturer",
  currentprice: "price", price: "price", pricenumber: "priceNumber",
  rating: "review", reviewcount: "reviewCount",
  badgeminimumunits: "amazonBadgeMinimumUnits", mainrank: "rank",
  mainrankcategory: "rankCategory", subcategoryrank: "subcategoryRank",
  rankedsubcategory: "rankedSubcategory", availability: "availability",
  buyboxseller: "buyBoxSeller", shipsfrom: "shipsFrom", sponsored: "sponsored",
  productlink: "itemLink", imagelink: "imageLink", status: "status",
  fulfillment: "fulfillment", seller: "seller",
};

/**
 * Maps arbitrary spreadsheet headers onto the field names the server expects.
 *
 * Column-name mapping is not proprietary, so it stays client side; it saves a
 * round trip and keeps the server contract to one fixed shape.
 */
function normalizeObject(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    const mapped = headerAliases[normalized] || (key.charAt(0).toLowerCase() + key.slice(1));
    if (out[mapped] == null || out[mapped] === "") out[mapped] = value;
  }
  out.asin = String(out.asin ?? "").toUpperCase().match(/[A-Z0-9]{10}/)?.[0] ?? "";
  out.priceNumber = num(out.priceNumber) ?? num(out.price);
  return out;
}

function bars(title, entries, isMoney = false) {
  const top = entries.slice(0, 10);
  const max = top[0]?.[1] || 1;
  return `<div class="chart"><h3>${esc(title)}</h3>${
    top.map(([k, v]) =>
      `<div class="barrow"><span>${esc(k)}</span><div class="track">` +
      `<i style="width:${(v / max) * 100}%"></i></div>` +
      `<b>${isMoney ? money(v) : Math.round(v).toLocaleString()}</b></div>`
    ).join("")
  }</div>`;
}

function donut(title, obj, isMoney = false) {
  const entries = Object.entries(obj).filter((x) => x[1] > 0);
  const total = entries.reduce((s, x) => s + x[1], 0) || 1;
  const colors = ["#0f766e", "#14b8a6", "#2563eb", "#f59e0b", "#e11d48", "#8b5cf6", "#0891b2"];

  let at = 0;
  const stops = entries.map((x, i) => {
    const start = at;
    at += (x[1] / total) * 360;
    return `${colors[i % colors.length]} ${start}deg ${at}deg`;
  }).join(",");

  return `<div class="chart"><h3>${esc(title)}</h3>` +
    `<div class="donut" style="background:conic-gradient(${stops})"></div>` +
    `<div class="legend">${
      entries.map((x, i) =>
        `<small><i style="background:${colors[i % colors.length]}"></i>${esc(x[0])}: ` +
        `${isMoney ? money(x[1]) : Math.round(x[1]).toLocaleString()} ` +
        `(${((x[1] / total) * 100).toFixed(1)}%)</small>`
      ).join("")
    }</div></div>`;
}

function opportunityChart(opportunities) {
  const top = opportunities.slice(0, 10);
  const max = top[0]?.opportunityScore || 1;

  return `<div class="chart"><h3>Research Opportunity Score (high demand, low reviews)</h3>${
    top.map((x) =>
      `<div class="barrow"><span><a class="asinLink" href="${esc(x.itemLink || "#")}" ` +
      `target="_blank" rel="noopener">${esc(x.asin)}</a></span>` +
      `<div class="track"><i style="width:${(x.opportunityScore / max) * 100}%"></i></div>` +
      `<b>${x.opportunityScore}</b></div>`
    ).join("") || '<div class="barrow"><span>No scored products yet.</span></div>'
  }</div>`;
}

$("analyze").onclick = async () => {
  try {
    requireSession();

    const source = $("marketSource").value === "tab2"
      ? (deepView.length ? deepView : deepAll)
      : analysisFileRows;

    analysisRows = filterRows(source, "c");

    if (!analysisRows.length) {
      $("kpis").innerHTML = "";
      $("charts").innerHTML = "";
      $("insights").textContent =
        "No usable product rows. Run Deep Search or upload a workbook, then build the analysis.";
      return;
    }

    $("insights").textContent = "Building analysis on the server...";

    const result = await call({ type: "ANALYZE", items: analysisRows });
    analysisRows = result.items;
    serverAnalysis = result.analysis;

    const k = serverAnalysis.kpis;
    $("kpis").innerHTML = [
      ["\u{1F4E6} Total Products", k.totalProducts.toLocaleString()],
      ["\u{1F517} Avg. Price", "$" + Number(k.averagePrice).toFixed(2)],
      ["\u{1F3E6} Est. Market Value", money(k.estimatedMarketValue)],
      ["\u{1F4CA} Monthly Units", Math.round(k.monthlyUnits).toLocaleString() + "+"],
      ["\u{1F9FE} Avg. Reviews", Math.round(k.averageReviews).toLocaleString()],
      ["\u{2699} Sponsored %", Number(k.sponsoredPercent).toFixed(1) + "%"],
      ["\u{1F4DA} Unique Brands", k.uniqueBrands.toLocaleString()],
    ].map((x) => `<div class="kpi">${x[0]}<strong>${x[1]}</strong></div>`).join("");

    const c = serverAnalysis.charts;
    $("charts").innerHTML =
      donut("Products by Price Range", c.priceBands) +
      donut("Brand Market Share by Estimated Revenue", c.brandShare, true) +
      bars("Top 10 Brands by Estimated Market Value", c.brandValue, true) +
      donut("Monthly Units Distribution", c.unitBands) +
      bars("Top 10 Categories by Product Count", c.categories) +
      donut("Rating Distribution", c.ratings) +
      opportunityChart(serverAnalysis.opportunities) +
      bars("Estimated Market Value by Main Rank Band", Object.entries(c.rankBandValue), true) +
      `<div class="chart dashExport"><h3>Export & Report</h3>
        <button id="dashAll" class="green">Export All Results (CSV)</button>
        <button id="dashFiltered" class="red">Export Filtered Results (CSV)</button>
        <button id="dashOpportunity" class="blue">Export Opportunity Table (CSV)</button>
        <button id="dashPdf" class="purple">Export Market Analysis (PDF)</button></div>`;

    $("dashAll").onclick = () =>
      exportCsv($("marketSource").value === "tab2" ? deepAll : analysisFileRows, "amazon-all-results.csv");
    $("dashFiltered").onclick = () => exportCsv(analysisRows, "amazon-filtered-analysis.csv");
    $("dashOpportunity").onclick = () => exportOpportunities();
    $("dashPdf").onclick = () => window.print();

    $("insights").textContent =
      `Analysis of ${analysisRows.length} products from ${$("marketSource").selectedOptions[0].text}. ` +
      `Every figure was computed on the server.`;

    render("t3", analysisRows);
    highlightBestSellers();
  } catch (err) {
    $("insights").textContent = err.message;
  }
};

function exportOpportunities() {
  const list = serverAnalysis?.opportunities ?? [];
  if (!list.length) return alert("Build the analysis first.");

  const blob = new Blob(["﻿" + toCsv(list.map((x) => ({
    ASIN: x.asin,
    "Product Title": x.name,
    Brand: x.brand,
    "Opportunity Score": x.opportunityScore,
    "Estimated Monthly Units": x.estimatedUnits,
    "Review Count": x.reviewCount,
    "Product Link": x.itemLink,
  })))], { type: "text/csv;charset=utf-8" });

  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: "amazon-opportunity-results.csv", saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 30_000),
  );
}

$("toggleReport").onclick = () => $("t3").classList.toggle("hiddenReport");
$("exportAll").onclick = () =>
  exportCsv($("marketSource").value === "tab2" ? deepAll : analysisFileRows, "amazon-all-results.csv");
$("exportFiltered").onclick = () => exportCsv(analysisRows, "amazon-filtered-analysis.csv");
$("exportOpportunity").onclick = () => exportOpportunities();
$("pdf").onclick = () => window.print();

document.querySelectorAll(".stop").forEach((b) => {
  b.onclick = () => send({ type: "STOP" });
});

// --------------------------------------------------------------------------
// Presentation extras
// --------------------------------------------------------------------------

function highlightBestSellers() {
  document.querySelectorAll(".table table,.myTable table").forEach((table) => {
    const heads = [...table.querySelectorAll("thead th")].map((x) => x.textContent.toLowerCase());
    const idx = heads.findIndex((x) => x.includes("sub rank"));
    if (idx < 0) return;

    table.querySelectorAll("tbody tr").forEach((tr) => {
      const cell = tr.cells[idx];
      const value = Number((cell?.textContent || "").replace(/[^0-9]/g, ""));
      if (value === 1) {
        tr.classList.add("bestSellerRow");
        if (!cell.querySelector(".bestSellerBadge")) {
          cell.insertAdjacentHTML(
            "beforeend",
            '<span class="bestSellerBadge">★ #1 BEST SELLER</span>',
          );
        }
      }
    });
  });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "SEARCH_PROGRESS") {
    $("s1").textContent = `Amazon search page ${m.page}/${m.total}; ${m.count} products found`;
    updateLoader({
      stage: 2,
      title: "Collecting products",
      message: `Search page ${m.page} completed`,
      page: m.page,
      total: m.total,
      count: m.count,
      current: `Found ${m.count} unique products`,
    });
  }

  if (m.type === "PROGRESS") {
    $("s2").textContent = `Deep Search ${m.done}/${m.total}`;
    updateLoader({
      stage: 3,
      title: "Retrieving product details",
      message: "Opening product pages and reading full details",
      done: m.done,
      total: m.total,
      count: m.unique,
      current: `${m.done} of ${m.total} products completed`,
      percent: 42 + (m.done / Math.max(1, m.total)) * 56,
    });
  }
});

new MutationObserver(() => highlightBestSellers())
  .observe(document.body, { childList: true, subtree: true });

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

const DEFAULT_SETTINGS = { market: "ca", workers: 3, delay: 4, pages: 3 };
let settings = { ...DEFAULT_SETTINGS };

function applySettings() {
  for (const id of ["aMarket", "dMarket"]) $(id).value = settings.market;
  $("bCon").value = String(settings.workers);
  $("bDelay").value = String(settings.delay);
  for (const id of ["aPages", "dPages"]) $(id).value = String(settings.pages);
  $("setMarket").value = settings.market;
  $("setWorkers").value = settings.workers;
  $("setDelay").value = settings.delay;
  $("setPages").value = settings.pages;
}

chrome.storage.local.get("researchSettings", (stored) => {
  settings = { ...DEFAULT_SETTINGS, ...(stored.researchSettings || {}) };
  applySettings();
});

$("settingsBtn").onclick = () => {
  $("settingsModal").classList.remove("hidden");
  applySettings();
};
$("closeSettings").onclick = () => $("settingsModal").classList.add("hidden");
$("settingsModal").onclick = (e) => {
  if (e.target === $("settingsModal")) $("settingsModal").classList.add("hidden");
};

$("saveSettings").onclick = () => {
  settings = {
    market: $("setMarket").value,
    // Capped at 4: the Amazon fetch layer clamps to the same number, and going
    // higher only raises the odds of a robot check.
    workers: Math.max(1, Math.min(4, +$("setWorkers").value || 3)),
    delay: Math.max(1, Math.min(30, +$("setDelay").value || 4)),
    pages: Math.max(0, Math.floor(Number($("setPages").value) || 0)),
  };
  chrome.storage.local.set({ researchSettings: settings }, () => {
    $("settingsStatus").textContent = "Settings saved locally.";
    applySettings();
  });
};

$("resetSettings").onclick = () => {
  settings = { ...DEFAULT_SETTINGS };
  chrome.storage.local.set({ researchSettings: settings }, () => {
    $("settingsStatus").textContent = "Defaults restored.";
    applySettings();
  });
};

$("bCon").onchange = () => {
  settings.workers = Math.max(1, Math.min(4, +$("bCon").value || 3));
};
$("bDelay").onchange = () => {
  settings.delay = Math.max(1, Math.min(30, +$("bDelay").value || 4));
};
$("aMarket").onchange = () => (settings.market = $("aMarket").value);
$("dMarket").onchange = () => (settings.market = $("dMarket").value);

$("helpBtn").onclick = () => alert(
  "Tab 1: search by keyword, paste ASINs or product URLs, or upload a file.\n" +
  "Tab 2: Deep Search pulls full details for every product found.\n" +
  "Tab 3: build the analysis from Deep Search results or an uploaded workbook.\n\n" +
  "Recommended: 2-3 workers and a 4 second delay.\n\n" +
  "All estimates are calculated on the server. One search costs one request " +
  "against your monthly quota, however many products it covers.",
);

$("savedDataBtn").onclick = () => {
  const count = (lightRaw?.length || 0) + (deepAll?.length || 0);
  alert(`${count} products are held in this dashboard session. Export to save a permanent copy.`);
};

document.querySelectorAll(".proTabs button[data-tab]").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.add("hidden"));
    document.querySelectorAll(".proTabs button").forEach((x) => x.classList.remove("active"));
    $(b.dataset.tab).classList.remove("hidden");
    b.classList.add("active");
  };
});

/** Consumed by market-v21.js to seed a market from the current Deep Search. */
window.getV19DeepSearchRows = () => deepAll.map((x) => ({ ...x }));
