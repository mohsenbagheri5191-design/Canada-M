/**
 * Tab 2: Market Intelligence.
 *
 * A market is a saved workspace: a name, a marketplace, keywords, a tracked
 * ASIN list, and the enriched catalogue behind them. Running a market crawls
 * its keywords, enriches what it finds, and files anything new as a suggestion.
 *
 * Two fixes from V29 are worth calling out:
 *
 *   1. draw() bound click handlers to #mTpl and #mUp, which no markup ever
 *      created. `$('mTpl').onclick = ...` threw TypeError on null and aborted
 *      draw() before the dashboard iframe was ever appended, so this tab
 *      rendered its header and nothing else. The buttons now exist.
 *
 *   2. Brand aggregation, market share, HHI and the competitive advisories
 *      used to run inside the sandboxed iframe. They now come from the
 *      research Edge Function, and the iframe only draws them. A sandboxed
 *      page has no chrome.* access, so this file makes the call and posts the
 *      finished analysis in.
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const E = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  const load = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  const save = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

  const send = (message) =>
    new Promise((resolve) => {
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

  async function call(message) {
    const response = await send(message);
    if (response?.ok) {
      if (response.quota) window.amrUpdateQuota?.(response.quota);
      return response;
    }
    const text = window.amrHandleError?.(response?.error) ??
      response?.error?.message ?? "Request failed.";
    throw new Error(text);
  }

  const asinsFrom = (v) =>
    [...new Set(String(v || "").toUpperCase().match(/[A-Z0-9]{10}/g) || [])];

  const keywordsFrom = (v) =>
    [...new Set(String(v || "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))]
      .slice(0, 10);

  let markets = [];
  let activeId = "";
  let view = "dashboard";
  let selected = new Set();

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  function initShell() {
    document.querySelector('[data-tab="light"]')?.remove();
    document.getElementById("light")?.remove();

    const label = (tab, text) => {
      const el = document.querySelector(`[data-tab="${tab}"]`);
      if (el) el.textContent = text;
    };
    label("deep", "1 Deep Search");
    label("market", "2 Market Intelligence");
    label("myproducts", "3 My Products");

    $("market").innerHTML = `
      <div class="m25">
        <aside>
          <header><img src="icon48.png"><b>Markets</b><button id="mn" title="New market">+</button></header>
          <div id="mt"></div>
        </aside>
        <main id="mm"></main>
      </div>
      <dialog id="md" class="m25Dialog">
        <button class="closeX" type="button">&times;</button>
        <h2>Market settings</h2>
        <label>Name<input id="n"></label>
        <label>Our Brand<input id="ob" placeholder="Used for the competitive comparison"></label>
        <label>Marketplace<select id="mp"><option value="ca">Amazon.ca</option><option value="com">Amazon.com</option></select></label>
        <label>Keywords<textarea id="kw" placeholder="One per line, up to 10"></textarea></label>
        <label>ASINs<textarea id="aa" placeholder="One per line"></textarea></label>
        <div class="m25SetGrid">
          <label>Pages<input id="pg" type="number" value="3" min="0"></label>
          <label>Workers<input id="wk" type="number" value="2" min="1" max="4"></label>
          <label>Delay<input id="dl" type="number" value="4" min="1"></label>
          <label>Schedule<select id="sc">
            <option value="off">Off</option><option value="daily">Daily</option>
            <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
          </select></label>
        </div>
        <button id="sv" class="green" type="button">Save</button>
      </dialog>`;

    $("mn").onclick = () => edit();
    $("md").querySelector(".closeX").onclick = () => $("md").close();
    $("sv").onclick = saveMarket;
  }

  async function reload() {
    markets = (await load(["marketWorkspaces"])).marketWorkspaces || [];
    activeId = activeId || markets[0]?.id || "";
    renderTabs();
    draw();
  }

  function renderTabs() {
    $("mt").innerHTML = markets.map((m) =>
      `<button data-id="${m.id}" class="${m.id === activeId ? "active" : ""}">
        <b>${E(m.name)}</b>
        <small>${m.asins?.length || 0} products &middot; ${m.suggestions?.length || 0} new</small>
      </button>`
    ).join("") || "<p>Create a market to begin.</p>";

    $("mt").querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        activeId = b.dataset.id;
        view = "dashboard";
        selected.clear();
        renderTabs();
        draw();
      };
    });
  }

  function edit(market) {
    const m = market || {
      id: "", name: "", market: "ca", myBrand: "", keywords: [], asins: [],
      settings: { pages: 3, workers: 2, delay: 4, schedule: "off" },
    };

    $("md").dataset.id = m.id;
    $("n").value = m.name;
    $("ob").value = m.myBrand || "";
    $("mp").value = m.market || "ca";
    $("kw").value = (m.keywords || []).join("\n");
    $("aa").value = (m.asins || []).join("\n");
    $("pg").value = m.settings?.pages ?? 3;
    $("wk").value = m.settings?.workers ?? 2;
    $("dl").value = m.settings?.delay ?? 4;
    $("sc").value = m.settings?.schedule || "off";
    $("md").showModal();
  }

  async function saveMarket() {
    const existingId = $("md").dataset.id;
    const previous = markets.find((x) => x.id === existingId) || {};

    const market = {
      ...previous,
      id: existingId || crypto.randomUUID(),
      name: $("n").value.trim() || "Untitled Market",
      myBrand: $("ob").value.trim(),
      market: $("mp").value,
      keywords: keywordsFrom($("kw").value),
      asins: asinsFrom($("aa").value),
      settings: {
        pages: +$("pg").value || 3,
        workers: Math.max(1, Math.min(4, +$("wk").value || 2)),
        delay: Math.max(1, +$("dl").value || 4),
        schedule: $("sc").value,
      },
      catalog: previous.catalog || [],
      suggestions: previous.suggestions || [],
      ignoredAsins: previous.ignoredAsins || [],
    };

    const index = markets.findIndex((x) => x.id === market.id);
    if (index < 0) markets.push(market);
    else markets[index] = market;

    activeId = market.id;
    await save({ marketWorkspaces: markets });

    await send({
      type: "SET_MARKET_SCHEDULE",
      marketId: market.id,
      frequency: market.settings.schedule,
    });

    $("md").close();
    renderTabs();
    draw();
  }

  // -------------------------------------------------------------------------
  // Main panel
  // -------------------------------------------------------------------------

  async function draw() {
    const market = markets.find((x) => x.id === activeId);

    if (!market) {
      $("mm").innerHTML =
        '<div class="p5Empty"><h2>Create a market</h2>' +
        "<p>A market saves a keyword set and its tracked products so you can re-run it on a schedule.</p></div>";
      return;
    }

    $("mm").innerHTML = `
      <header class="m25Head">
        <div>
          <small>MARKET INTELLIGENCE</small>
          <h1>${E(market.name)}</h1>
          <p>${market.keywords.length} keywords &middot; ${market.market === "com" ? "Amazon.com" : "Amazon.ca"}</p>
        </div>
        <div>
          <button id="runm" class="green" type="button">Run Deep Search</button>
          <button id="used" class="blue" type="button">Use Current Deep Search</button>
          <button id="mUp" class="secondary" type="button">Upload Data</button>
          <button id="mTpl" class="secondary" type="button">Template</button>
          <button id="cfg" class="secondary" type="button">Edit Market</button>
          <button id="delm" class="red" type="button">Remove Market</button>
        </div>
      </header>
      <nav class="m25Sub">
        <button data-v="dashboard" type="button">Market Share Dashboard</button>
        <button data-v="products" type="button">Products ${market.asins.length}</button>
        <button data-v="suggestions" type="button">New Suggestions ${market.suggestions.length}</button>
      </nav>
      <section id="prog" class="m25Progress hidden"></section>
      <div id="mb"></div>`;

    document.querySelectorAll("[data-v]").forEach((b) => {
      b.classList.toggle("active", b.dataset.v === view);
      b.onclick = () => {
        view = b.dataset.v;
        selected.clear();
        draw();
      };
    });

    $("cfg").onclick = () => edit(market);
    $("runm").onclick = () => runScan(market);
    $("used").onclick = () => useDeepSearch(market);
    $("mTpl").onclick = downloadTemplate;
    $("mUp").onclick = () => uploadData(market);

    $("delm").onclick = async () => {
      if (!confirm(`Remove market "${market.name}"? Its saved products and suggestions go with it.`)) return;
      markets = markets.filter((x) => x.id !== market.id);
      activeId = markets[0]?.id || "";
      await save({ marketWorkspaces: markets });
      await send({ type: "SET_MARKET_SCHEDULE", marketId: market.id, frequency: "off" });
      renderTabs();
      draw();
    };

    if (view === "dashboard") await drawDashboard(market);
    else drawTable(market, view === "suggestions" ? market.suggestions : market.catalog, view === "suggestions");
  }

  /**
   * Asks the server for the brand analysis, then hands it to the sandboxed
   * renderer.
   *
   * The iframe is sandboxed, so it cannot call chrome.runtime itself. Doing
   * the call here keeps the sandbox a pure drawing surface with no access to
   * anything, which is exactly what a sandbox is for.
   */
  async function drawDashboard(market) {
    const rows = market.catalog || [];

    if (!rows.length) {
      $("mb").innerHTML =
        '<div class="p5Empty"><h2>No data yet</h2>' +
        "<p>Run a Deep Search, import your current Deep Search results, or upload a workbook.</p></div>";
      return;
    }

    $("mb").innerHTML = '<div class="m25Loading">Building market share analysis on the server...</div>';

    let analysis;
    try {
      const result = await call({
        type: "BRAND_ANALYSIS",
        rows,
        ourBrand: market.myBrand || null,
        bigThreshold: 0.05,
      });
      analysis = result.brandAnalysis;
    } catch (err) {
      $("mb").innerHTML = `<div class="p5Empty"><h2>Could not build the dashboard</h2><p>${E(err.message)}</p></div>`;
      return;
    }

    $("mb").innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "m25Frame";
    frame.src = "brand-dashboard.html";
    $("mb").appendChild(frame);

    frame.onload = () => {
      frame.contentWindow.postMessage(
        {
          type: "RENDER_BRAND_ANALYSIS",
          analysis,
          products: rows.map((r) => ({
            asin: r.asin,
            name: r.name,
            brand: r.brand,
            imageLink: r.imageLink,
            itemLink: r.itemLink,
            price: r.price,
            priceNumber: r.priceNumber,
            units: r.bsrEstimatedUnitsMid,
            revenue: r.bsrEstimatedRevenueMid,
            review: r.review,
            reviewCount: r.reviewCount,
            rank: r.rank,
            fulfillment: r.fulfillment || "",
            seller: r.buyBoxSeller || "",
          })),
          marketName: market.name,
          ourBrand: market.myBrand || "",
        },
        "*",
      );
    };
  }

  function drawTable(market, rows, isSuggestions) {
    $("mb").innerHTML = `
      <div class="m25Filter">
        <input id="q" placeholder="Search all product details">
        <span id="cnt"></span>
      </div>
      <div class="p5Table m25Table"></div>
      <div class="m25Actions">
        <b id="ss">0 selected</b>
        ${isSuggestions ? '<button id="adA" class="green" type="button">Add All</button>' : ""}
        ${isSuggestions ? '<button id="adS" class="blue" type="button">Add Selected</button>' : ""}
        <button id="rmA" class="red" type="button">Remove All</button>
        <button id="rmS" class="secondary" type="button">Remove Selected</button>
      </div>`;

    const paint = () => {
      const q = $("q").value.toLowerCase();
      const visible = rows.filter((x) => !q || Object.values(x).join(" ").toLowerCase().includes(q));

      $("cnt").textContent = `${visible.length} items`;
      $("ss").textContent = `${selected.size} selected`;

      document.querySelector(".m25Table").innerHTML = `
        <table><thead><tr>
          <th><input id="all" type="checkbox"></th>
          <th>Product</th><th>Brand</th><th>Price</th><th>Revenue</th><th>Units</th>
          <th>Main BSR</th><th>Sub BSR</th><th>Rating</th><th>Reviews</th>
          <th>Seller</th><th>Ships From</th>
        </tr></thead><tbody>${
          visible.map((x) => `
            <tr>
              <td><input class="ck" data-a="${E(x.asin)}" type="checkbox" ${selected.has(x.asin) ? "checked" : ""}></td>
              <td><div class="m25Product"><img src="${E(x.imageLink || "icon128.png")}">
                <span><b>${E(x.name || x.asin)}</b><small>${E(x.asin)}</small></span></div></td>
              <td>${E(x.brand || "")}</td>
              <td>${E(x.price || "")}</td>
              <td>$${Number(x.bsrEstimatedRevenueMid || 0).toLocaleString()}</td>
              <td>${Number(x.bsrEstimatedUnitsMid || 0).toLocaleString()}</td>
              <td>${E(x.rank || "")}</td>
              <td>${E(x.subcategoryRank || "")}</td>
              <td>${E(x.review || "")}</td>
              <td>${E(x.reviewCount || "")}</td>
              <td>${E(x.buyBoxSeller || "")}</td>
              <td>${E(x.shipsFrom || "")}</td>
            </tr>`).join("")
        }</tbody></table>`;

      $("all").onchange = (e) => {
        visible.forEach((x) => (e.target.checked ? selected.add(x.asin) : selected.delete(x.asin)));
        paint();
      };

      document.querySelectorAll(".ck").forEach((c) => {
        c.onchange = () => {
          if (c.checked) selected.add(c.dataset.a);
          else selected.delete(c.dataset.a);
          paint();
        };
      });

      if (isSuggestions) {
        $("adA").onclick = () => accept(market, visible);
        $("adS").onclick = () => accept(market, rows.filter((x) => selected.has(x.asin)));
      }
      $("rmA").onclick = () => remove(market, visible, isSuggestions);
      $("rmS").onclick = () => remove(market, rows.filter((x) => selected.has(x.asin)), isSuggestions);
    };

    $("q").oninput = paint;
    paint();
  }

  /** Promotes suggestions into the tracked catalogue. */
  async function accept(market, items) {
    if (!items.length) return;

    market.asins = [...new Set([...market.asins, ...items.map((x) => x.asin)])];
    market.catalog = [
      ...market.catalog,
      ...items.filter((x) => !market.catalog.some((y) => y.asin === x.asin)),
    ];
    market.suggestions = market.suggestions.filter((x) => !items.some((y) => y.asin === x.asin));

    selected.clear();
    await save({ marketWorkspaces: markets });
    renderTabs();
    draw();
  }

  async function remove(market, items, isSuggestions) {
    if (!items.length || !confirm(`Remove ${items.length} item(s)?`)) return;

    const ids = new Set(items.map((x) => x.asin));

    if (isSuggestions) {
      market.suggestions = market.suggestions.filter((x) => !ids.has(x.asin));
      // Remembered so a later scan does not re-suggest what was just rejected.
      market.ignoredAsins = [...new Set([...(market.ignoredAsins || []), ...ids])];
    } else {
      market.asins = market.asins.filter((x) => !ids.has(x));
      market.catalog = market.catalog.filter((x) => !ids.has(x.asin));
    }

    selected.clear();
    await save({ marketWorkspaces: markets });
    renderTabs();
    draw();
  }

  // -------------------------------------------------------------------------
  // Import and export
  // -------------------------------------------------------------------------

  function downloadTemplate() {
    window.writeExactProductXlsx(
      [{
        ASIN: "B000000000", "Product Title": "", Brand: "", "Current Price": "",
        Rating: "", "Review Count": "", "Main Rank": "", Fulfillment: "", Seller: "",
      }],
      "amazon-market-product-details-template.xlsx",
    );
  }

  async function uploadData(market) {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".xlsx,.csv";

    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;

      try {
        const raw = await ProductWorkbook.read(file);

        const aliases = {
          producttitle: "name", title: "name", asin: "asin", brand: "brand",
          manufacturer: "manufacturer", currentprice: "price", price: "price",
          pricenumber: "priceNumber", rating: "review", reviewcount: "reviewCount",
          mainrank: "rank", mainrankcategory: "rankCategory",
          subcategoryrank: "subcategoryRank", rankedsubcategory: "rankedSubcategory",
          availability: "availability", buyboxseller: "buyBoxSeller",
          seller: "buyBoxSeller", shipsfrom: "shipsFrom", parentasin: "parentAsin",
          variationcount: "variationCount", fulfillment: "fulfillment",
          sponsored: "sponsored", productlink: "itemLink", imagelink: "imageLink",
        };

        const rows = raw.map((r) => {
          const out = {};
          for (const [k, v] of Object.entries(r)) {
            const key = aliases[String(k).toLowerCase().replace(/[^a-z0-9]/g, "")];
            if (key && v !== "" && v != null) out[key] = v;
          }
          out.asin = String(out.asin || "").toUpperCase().match(/[A-Z0-9]{10}/)?.[0] || "";
          return out;
        }).filter((x) => x.asin);

        if (!rows.length) throw new Error("No valid ASIN rows found.");

        // Uploaded figures are re-scored so the dashboard compares like with
        // like, whatever tool the file came from.
        const scored = await call({ type: "SCORE", items: rows });

        const merged = new Map((market.catalog || []).map((x) => [x.asin, x]));
        scored.items.forEach((x) => merged.set(x.asin, { ...(merged.get(x.asin) || {}), ...x }));

        market.catalog = [...merged.values()];
        market.asins = [...new Set([...(market.asins || []), ...scored.items.map((x) => x.asin)])];

        await save({ marketWorkspaces: markets });
        alert(`Imported and scored ${scored.items.length} products into ${market.name}.`);
        draw();
      } catch (err) {
        alert("Upload failed: " + err.message);
      }
    };

    picker.click();
  }

  async function useDeepSearch(market) {
    const rows = window.getV19DeepSearchRows?.() || [];
    if (!rows.length) return alert("Run a Deep Search on tab 1 first.");

    const merged = new Map(market.catalog.map((x) => [x.asin, x]));
    rows.forEach((x) => merged.set(x.asin, x));

    market.catalog = [...merged.values()];
    market.asins = [...new Set([...market.asins, ...rows.map((x) => x.asin)])];

    await save({ marketWorkspaces: markets });
    alert(`Imported ${rows.length} products from the current Deep Search.`);
    draw();
  }

  // -------------------------------------------------------------------------
  // Scans
  // -------------------------------------------------------------------------

  async function runScan(market) {
    $("prog").classList.remove("hidden");
    $("prog").innerHTML = '<b>Starting market scan...</b><div class="m25Track"><i></i></div>';

    const response = await send({ type: "RUN_MARKET_SCAN", marketId: market.id });

    if (response?.ok) {
      await reload();
      return;
    }

    const message = window.amrHandleError?.(response?.error) ??
      response?.error?.message ?? "Scan failed.";
    $("prog").innerHTML = `<b>Scan failed:</b> ${E(message)}`;
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type !== "MARKET_PROGRESS" || m.marketId !== activeId) return;

    const pct = Math.round(
      ((m.index || 0) + (m.stage === "Complete" ? 1 : 0.5)) / Math.max(1, m.total || 1) * 100,
    );

    const prog = $("prog");
    if (!prog) return;
    prog.classList.remove("hidden");
    prog.innerHTML = `
      <b>${E(m.stage)} ${E(m.keyword || "")}</b><span>${pct}%</span>
      <div class="m25Track"><i style="width:${pct}%"></i></div>
      <small>Pages ${m.pages || 0} &middot; Found ${m.found || 0} &middot; Enriched ${m.enriched || 0}</small>`;
  });

  // -------------------------------------------------------------------------
  // Boot
  //
  // Waits for the gate. Before amr:ready there is no session, and every call
  // this file makes would be refused.
  // -------------------------------------------------------------------------

  function init() {
    initShell();
    if (window.amrSession?.ready) reload();
    else document.addEventListener("amr:ready", reload, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
