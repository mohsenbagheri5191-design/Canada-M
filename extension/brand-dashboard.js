/**
 * Sandboxed renderer for the brand market share dashboard.
 *
 * Draws a finished analysis. It does not aggregate, does not weight, does not
 * threshold and does not score: all of that arrives already computed from the
 * research Edge Function via market-v21.js.
 *
 * The comparison in V29 is worth keeping in mind while reading this file. The
 * old version of this page held aggregate(), the HHI formula, the big-brand
 * threshold and eight competitive advisory rules with their multipliers, all
 * in plain sight inside the extension bundle. What is left here is drawing
 * code: SVG paths, table rows and number formatting.
 */

(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    }[c]));

  const fmtCAD = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  });
  const fmtNum = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });
  const fmtPct = new Intl.NumberFormat("en-CA", {
    style: "percent",
    maximumFractionDigits: 1,
  });

  const COLORS = [
    "#14b8a6", "#60a5fa", "#a78bfa", "#fbbf24", "#fb7185", "#34d399",
    "#f472b6", "#c084fc", "#4ade80", "#f97316", "#93c5fd", "#facc15",
  ];
  const OUR_COLOR = "#2563eb";

  /** Everything posted in from market-v21.js. */
  let analysis = null;
  let products = [];
  let ourBrandKey = "";

  let sortBrand = { key: "revenue", dir: "desc" };
  let sortProduct = { key: "revenue", dir: "desc" };
  let lastBrandRows = [];
  let lastProductRows = [];

  const brandKey = (b) =>
    String(b ?? "").replace(/\s+/g, " ").trim().toLowerCase() || "unknown";

  const isOurs = (key) => Boolean(ourBrandKey) && key === ourBrandKey;

  // -------------------------------------------------------------------------
  // Filtering (presentation only; totals come from the server)
  // -------------------------------------------------------------------------

  function visibleProducts() {
    const brand = el("brandFilter").value;
    const q = el("searchBox").value.toLowerCase().trim();

    return products.filter((p) => {
      if (brand !== "__all__" && brandKey(p.brand) !== brand) return false;
      if (q) {
        const haystack = [p.name, p.asin, p.brand, p.seller, p.fulfillment]
          .map((x) => String(x ?? "")).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  function populateFilters() {
    const current = el("brandFilter").value || "__all__";
    const names = new Map();
    for (const b of analysis.brands) names.set(b.brandKey, b.brand);

    el("brandFilter").innerHTML =
      '<option value="__all__">All brands</option>' +
      [...names.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`)
        .join("");

    if ([...el("brandFilter").options].some((o) => o.value === current)) {
      el("brandFilter").value = current;
    }
  }

  // -------------------------------------------------------------------------
  // KPIs
  // -------------------------------------------------------------------------

  function renderKpis() {
    const k = analysis.kpis;

    const cards = [
      ["Total Revenue", fmtCAD.format(k.totalRevenue), "Estimated, all tracked products"],
      ["Total Units", fmtNum.format(k.totalUnits), "Estimated monthly units"],
      ["Brands", fmtNum.format(k.brandCount), `${k.bigBrandCount} big brands`],
      ["ASINs", fmtNum.format(k.asinCount), "Unique products tracked"],
      ["Top Brand", k.topBrand, `${fmtPct.format(k.topBrandShare)} · ${fmtCAD.format(k.topBrandRevenue)}`],
      ["Top 3 Share", fmtPct.format(k.top3Share), `HHI ${fmtNum.format(k.hhi)} · ${k.concentration}`],
    ];

    el("kpis").innerHTML = cards.map((c) =>
      `<div class="card kpi"><div class="label">${esc(c[0])}</div>` +
      `<div class="value">${esc(c[1])}</div>` +
      `<div class="sub">${esc(c[2])}</div></div>`
    ).join("");
  }

  // -------------------------------------------------------------------------
  // Charts
  // -------------------------------------------------------------------------

  const svg = (content, height = 360) =>
    `<svg viewBox="0 0 920 ${height}" preserveAspectRatio="xMidYMid meet" role="img">${content}</svg>`;

  function renderBar() {
    const top = analysis.brands.slice(0, 20);
    const max = Math.max(1, ...top.map((b) => b.share * 100));

    let out =
      '<text x="8" y="18" font-size="13" font-weight="800" fill="currentColor">Brand</text>' +
      '<text x="820" y="18" font-size="13" font-weight="800" text-anchor="end" fill="currentColor">Share</text>';

    top.forEach((b, i) => {
      const y = 34 + i * 26;
      const width = ((b.share * 100) / max) * 610;
      const ours = isOurs(b.brandKey);
      const color = ours ? OUR_COLOR : COLORS[i % COLORS.length];
      const stroke = ours ? ' stroke="#93c5fd" stroke-width="3"' : "";
      const name = esc(b.brand).slice(0, 30) + (ours ? " ★" : "");

      out +=
        `<text x="8" y="${y + 15}" font-size="13" font-weight="650" fill="currentColor">${name}</text>` +
        `<rect x="215" y="${y}" width="${width}" height="18" rx="9" fill="${color}"${stroke}></rect>` +
        `<text x="${230 + width}" y="${y + 14}" font-size="13" font-weight="800" fill="currentColor">` +
        `${(b.share * 100).toFixed(1)}%</text>`;
    });

    el("shareChart").innerHTML = svg(out, Math.max(120, 44 + top.length * 26));
  }

  function polar(cx, cy, r, angle) {
    const rad = ((angle - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function arc(cx, cy, r, a0, a1) {
    const p0 = polar(cx, cy, r, a1);
    const p1 = polar(cx, cy, r, a0);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${p1[0]} ${p1[1]} A ${r} ${r} 0 ${large} 1 ${p0[0]} ${p0[1]} Z`;
  }

  function renderMix() {
    const total = analysis.total || 1;
    const big = analysis.brands.filter((b) => b.revenue > 0).slice(0, analysis.kpis.bigBrandCount);

    const items = big.map((b, i) => ({
      name: b.brand,
      value: b.revenue,
      share: b.share,
      color: isOurs(b.brandKey) ? OUR_COLOR : COLORS[i % COLORS.length],
      ours: isOurs(b.brandKey),
    }));

    const otherValue = Math.max(0, total - big.reduce((s, b) => s + b.revenue, 0));
    if (otherValue > 0) {
      items.push({
        name: "Other Brands",
        value: otherValue,
        share: otherValue / total,
        color: "rgba(148,163,184,.65)",
        ours: false,
      });
    }

    let angle = 0;
    let paths = "";
    let legend = "";

    for (const item of items) {
      const sweep = total ? (item.value / total) * 360 : 0;
      paths += `<path d="${arc(260, 205, 155, angle, angle + sweep)}" fill="${item.color}"></path>`;
      legend +=
        `<div class="mix-item"><span class="dot" style="background:${item.color}"></span>` +
        `<span class="mix-name">${esc(item.name)}${item.ours ? " ★" : ""}</span>` +
        `<span class="mix-val">${fmtPct.format(item.share)} · ${fmtCAD.format(item.value)}</span></div>`;
      angle += sweep;
    }

    paths +=
      '<circle cx="260" cy="205" r="84" fill="var(--card)"></circle>' +
      `<text x="260" y="206" text-anchor="middle" font-size="26" font-weight="850" fill="currentColor">${items.length}</text>` +
      '<text x="260" y="232" text-anchor="middle" font-size="13" fill="currentColor">Segments</text>';

    el("mixChart").innerHTML =
      `<div class="mix-layout"><div>${svg(paths, 430)}</div><div>` +
      `<div class="mix-title">Segment detail (${items.length})</div>` +
      `<div class="mix-list">${legend}</div></div></div>`;
  }

  function renderScatter() {
    const data = analysis.brands.filter((b) => b.avgPrice > 0 && b.avgRating > 0 && b.revenue > 0);
    const maxPrice = Math.max(1, ...data.map((d) => d.avgPrice));
    const total = analysis.total || 1;

    let out =
      '<line x1="70" y1="310" x2="850" y2="310" stroke="currentColor" opacity=".25"/>' +
      '<line x1="70" y1="30" x2="70" y2="310" stroke="currentColor" opacity=".25"/>' +
      '<text x="455" y="344" text-anchor="middle" font-size="12" fill="currentColor">Average Price</text>' +
      '<text x="20" y="170" transform="rotate(-90 20 170)" text-anchor="middle" font-size="12" fill="currentColor">Average Rating</text>';

    data.forEach((b, i) => {
      const x = 70 + (b.avgPrice / maxPrice) * 760;
      const y = 310 - (b.avgRating / 5) * 270;
      const r = Math.max(5, Math.min(26, Math.sqrt(b.revenue / total) * 55));
      const ours = isOurs(b.brandKey);
      const color = ours ? OUR_COLOR : COLORS[i % COLORS.length];
      const stroke = ours ? ' stroke="#93c5fd" stroke-width="4"' : "";

      out +=
        `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity=".86"${stroke}>` +
        `<title>${esc(b.brand)} | ${fmtCAD.format(b.avgPrice)} | ${b.avgRating.toFixed(1)} | ${fmtPct.format(b.share)}</title>` +
        `</circle>`;
    });

    el("scatterChart").innerHTML = svg(out, 360);
  }

  // -------------------------------------------------------------------------
  // Advisories and insights (server-authored text)
  // -------------------------------------------------------------------------

  function renderOurBrand() {
    const panel = el("ourBrandPanel");

    if (!ourBrandKey) {
      panel.innerHTML =
        '<div class="suggest warn"><b>No Our Brand selected</b>' +
        '<span class="small">Set "Our Brand" in this market\'s settings to compare it ' +
        "against the leader on share, price, ratings, reviews, assortment, fulfilment and sponsored coverage.</span></div>";
      return;
    }

    const ours = analysis.brands.find((b) => b.brandKey === ourBrandKey);
    if (!ours) {
      panel.innerHTML =
        '<div class="suggest bad"><b>Our Brand is not in this market</b>' +
        '<span class="small">No tracked product carries that brand name. Check the spelling in the market settings.</span></div>';
      return;
    }

    const rank = analysis.brands.indexOf(ours) + 1;

    const cards =
      '<div class="our-grid">' +
      `<div class="our-box"><div class="our-label">Our Brand</div><div class="our-value">${esc(ours.brand)}</div></div>` +
      `<div class="our-box"><div class="our-label">Revenue Share</div><div class="our-value">${fmtPct.format(ours.share)}</div></div>` +
      `<div class="our-box"><div class="our-label">Revenue</div><div class="our-value">${fmtCAD.format(ours.revenue)}</div></div>` +
      `<div class="our-box"><div class="our-label">Rank</div><div class="our-value">#${rank} of ${analysis.brands.length}</div></div>` +
      "</div>";

    const suggestions = (analysis.advisories ?? []).map((a) =>
      `<div class="suggest ${esc(a.tone)}"><b>${esc(a.title)}</b>` +
      `<span class="small">${esc(a.message)}</span></div>`
    ).join("");

    panel.innerHTML = cards + `<div class="suggest-list">${suggestions}</div>`;
  }

  function renderInsights() {
    el("insights").innerHTML = (analysis.insights ?? []).map((x, i) =>
      `<div class="insight"><div class="ico">${i + 1}</div><div>` +
      `<b>${esc(x.title)}</b><span class="small">${esc(x.message)}</span></div></div>`
    ).join("");
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  function sortRows(rows, sort) {
    return rows.slice().sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av ?? "").localeCompare(String(bv ?? ""));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }

  const th = (label, key, type) =>
    `<th data-key="${key}" data-type="${type || "brand"}">${label}</th>`;

  function renderBrandTable() {
    lastBrandRows = analysis.brands.map((b) => ({
      Brand: b.brand,
      brandKey: b.brandKey,
      OurBrand: isOurs(b.brandKey) ? "Yes" : "No",
      share: b.share,
      revenue: b.revenue,
      units: b.units,
      asins: b.asinCount,
      avgPrice: b.avgPrice,
      avgRating: b.avgRating,
      reviews: b.reviews,
      avgBsr: b.avgBsr,
      topAsin: b.topAsin,
    }));

    const rows = sortRows(lastBrandRows, sortBrand);

    el("brandTable").innerHTML =
      "<thead><tr>" +
      th("Brand", "Brand") + th("Our", "OurBrand") + th("Share %", "share") +
      th("Revenue", "revenue") + th("Units", "units") + th("ASINs", "asins") +
      th("Avg Price", "avgPrice") + th("Avg Rating", "avgRating") +
      th("Reviews", "reviews") + th("Avg BSR", "avgBsr") + th("Top ASIN", "topAsin") +
      "</tr></thead><tbody>" +
      rows.map((r) => {
        const ours = r.OurBrand === "Yes";
        return `<tr class="${ours ? "our" : ""}">` +
          `<td><span class="badge ${ours ? "ourbrand" : ""}">${ours ? "★ " : ""}${esc(r.Brand)}</span></td>` +
          `<td>${r.OurBrand}</td>` +
          `<td class="num">${fmtPct.format(r.share)}</td>` +
          `<td class="num">${fmtCAD.format(r.revenue)}</td>` +
          `<td class="num">${fmtNum.format(r.units)}</td>` +
          `<td class="num">${fmtNum.format(r.asins)}</td>` +
          `<td class="num">${r.avgPrice ? fmtCAD.format(r.avgPrice) : "—"}</td>` +
          `<td class="num">${r.avgRating ? r.avgRating.toFixed(2) : "—"}</td>` +
          `<td class="num">${fmtNum.format(r.reviews)}</td>` +
          `<td class="num">${r.avgBsr ? fmtNum.format(r.avgBsr) : "—"}</td>` +
          `<td>${esc(r.topAsin || "—")}</td></tr>`;
      }).join("") +
      "</tbody>";
  }

  function renderProductTable() {
    const total = analysis.total || 1;

    lastProductRows = visibleProducts().map((p) => ({
      Product: p.name || "",
      asin: p.asin || "",
      Brand: p.brand || "",
      brandKey: brandKey(p.brand),
      price: Number(p.priceNumber) || 0,
      units: Number(p.units) || 0,
      revenue: Number(p.revenue) || 0,
      share: (Number(p.revenue) || 0) / total,
      rating: Number(p.review) || 0,
      reviews: Number(p.reviewCount) || 0,
      bsr: Number(String(p.rank ?? "").replace(/[^\d]/g, "")) || 0,
      Fulfillment: p.fulfillment || "",
      Seller: p.seller || "",
      image: p.imageLink || "",
      url: p.itemLink || "",
    }));

    const rows = sortRows(lastProductRows, sortProduct);

    el("productTable").innerHTML =
      "<thead><tr>" +
      th("Product", "Product", "product") + th("ASIN", "asin", "product") +
      th("Brand", "Brand", "product") + th("Price", "price", "product") +
      th("Units", "units", "product") + th("Revenue", "revenue", "product") +
      th("Share %", "share", "product") + th("Rating", "rating", "product") +
      th("Reviews", "reviews", "product") + th("BSR", "bsr", "product") +
      th("Fulfillment", "Fulfillment", "product") + th("Seller", "Seller", "product") +
      "</tr></thead><tbody>" +
      rows.map((r) => {
        const ours = isOurs(r.brandKey);
        return `<tr class="${ours ? "our" : ""}">` +
          `<td><div class="product">${
            r.image ? `<img src="${esc(r.image)}" onerror="this.style.display='none'">` : ""
          }<div class="pname"><a href="${esc(r.url || "#")}" target="_blank" rel="noopener">` +
          `${esc(r.Product || "Untitled product")}</a></div></div></td>` +
          `<td>${esc(r.asin)}</td>` +
          `<td><span class="badge ${ours ? "ourbrand" : ""}">${esc(r.Brand)}</span></td>` +
          `<td class="num">${r.price ? fmtCAD.format(r.price) : "—"}</td>` +
          `<td class="num">${fmtNum.format(r.units)}</td>` +
          `<td class="num">${fmtCAD.format(r.revenue)}</td>` +
          `<td class="num">${fmtPct.format(r.share)}</td>` +
          `<td class="num">${r.rating ? r.rating.toFixed(1) : "—"}</td>` +
          `<td class="num">${fmtNum.format(r.reviews)}</td>` +
          `<td class="num">${r.bsr ? fmtNum.format(r.bsr) : "—"}</td>` +
          `<td>${esc(r.Fulfillment || "—")}</td>` +
          `<td>${esc(r.Seller || "—")}</td></tr>`;
      }).join("") +
      "</tbody>";
  }

  // -------------------------------------------------------------------------
  // CSV export
  //
  // A sandboxed page cannot use chrome.downloads, so it builds a blob and
  // clicks its own anchor. That works inside the iframe and needs no
  // extension privileges.
  // -------------------------------------------------------------------------

  function downloadCsv(filename, rows) {
    if (!rows.length) return;

    const keys = Object.keys(rows[0]).filter((k) => !["image", "url", "brandKey"].includes(k));

    const cell = (v) => {
      let text = String(v ?? "");
      if (/^[=+\-@]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };

    const csv = [
      keys.join(","),
      ...rows.map((r) => keys.map((k) => cell(r[k])).join(",")),
    ].join("\n");

    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function render() {
    if (!analysis) return;
    populateFilters();
    renderKpis();
    renderBar();
    renderMix();
    renderOurBrand();
    renderScatter();
    renderInsights();
    renderBrandTable();
    renderProductTable();
  }

  el("brandFilter").addEventListener("input", renderProductTable);
  el("searchBox").addEventListener("input", renderProductTable);

  el("themeBtn").onclick = () => {
    document.body.classList.toggle("dark");
    el("themeBtn").textContent =
      document.body.classList.contains("dark") ? "Light mode" : "Dark mode";
  };

  el("pdfBtn").onclick = () => setTimeout(() => window.print(), 50);
  el("exportBrands").onclick = () => downloadCsv("brand_market_share.csv", lastBrandRows);
  el("exportProducts").onclick = () => downloadCsv("asin_detail.csv", lastProductRows);

  document.addEventListener("click", (event) => {
    if (event.target.tagName !== "TH") return;
    const key = event.target.dataset.key;
    if (!key) return;

    if (event.target.dataset.type === "product") {
      sortProduct = {
        key,
        dir: sortProduct.key === key && sortProduct.dir === "desc" ? "asc" : "desc",
      };
      renderProductTable();
    } else {
      sortBrand = {
        key,
        dir: sortBrand.key === key && sortBrand.dir === "desc" ? "asc" : "desc",
      };
      renderBrandTable();
    }
  });

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type !== "RENDER_BRAND_ANALYSIS") return;

    try {
      analysis = data.analysis;
      products = Array.isArray(data.products) ? data.products : [];
      ourBrandKey = data.ourBrand ? brandKey(data.ourBrand) : "";

      if (data.marketName) {
        document.title = `${data.marketName} - Brand Market Share`;
        el("marketTitle").textContent = data.marketName;
      }

      el("pillrow").innerHTML = [
        `${fmtNum.format(analysis.kpis.asinCount)} ASINs`,
        `${fmtNum.format(analysis.kpis.brandCount)} brands`,
        `Revenue ${fmtCAD.format(analysis.kpis.totalRevenue)}`,
        `HHI ${fmtNum.format(analysis.kpis.hhi)} (${analysis.kpis.concentration})`,
      ].map((t) => `<span class="pill">${esc(t)}</span>`).join("");

      el("fileStatus").textContent =
        `${fmtNum.format(products.length)} products in this market.`;

      render();
    } catch (err) {
      document.body.insertAdjacentHTML(
        "afterbegin",
        `<div style="padding:12px;background:#fee2e2;color:#7f1d1d;font-family:Arial">` +
        `Dashboard error: ${esc(err.message)}</div>`,
      );
    }
  });
})();
