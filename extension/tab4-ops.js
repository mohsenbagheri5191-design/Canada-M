(() => {
    const $ = id => document.getElementById(id),
        N = v => {
            const m = String(v ?? '').replace(/[$,%(),]/g, '').match(/-?[\d.]+/);
            return m ? +m[0] : 0
        },
        E = v => String(v ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        } [c]));
    const money = v => '$' + N(v).toLocaleString(undefined, {
            maximumFractionDigits: 0
        }),
        pct = v => Number.isFinite(v) ? `${v>=0?'+':''}${(v*100).toFixed(1)}%` : 'N/A',
        date = v => new Date(v).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    const units = x => window.tab4MetricMode === 'actual' ? N(x.myUnits) : (N(x.myUnits) || N(x.bsrEstimatedUnitsMid)),
        revenue = x => window.tab4MetricMode === 'actual' ? N(x.myRevenue) : (N(x.myRevenue) || N(x.bsrEstimatedRevenueMid));
    const rating = x => {
            const m = String(x.review || x.rating || '').match(/[0-5](?:\.\d)?/);
            return m ? +m[0] : 0
        },
        reviews = x => N(x.reviewCount);
    const state = () => window.myPortfolioState?.() || {
        products: [],
        history: {},
        view: []
    };
    let activeKpi = 'price',
        donutExpanded = false;

    function link(x) {
        const host = x.market === 'com' ? 'www.amazon.com' : 'www.amazon.ca';
        return x.itemLink || x.canonicalUrl || `https://${host}/dp/${x.asin}`
    }

    function itemLink(x) {
        return `<a class="amazonLink" href="${E(link(x))}" target="_blank" title="Open ${E(x.asin)} on Amazon" aria-label="Open on Amazon"><svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3Z"/><path d="M5 5h6v2H5v12h12v-6h2v8H3V5h2Z"/></svg></a>`
    }

    function getStatus(x) {
        return x.itemStatus || ((Date.now() - new Date(x.trackedSince || x.lastUpdated || 0).getTime()) < 45 * 864e5 ? 'New item' : 'Active')
    }

    function selectedProducts() {
        const s = state(),
            v = $('proItemStatus')?.value || 'all',
            base = s.view?.length ? s.view : s.products;
        return v === 'all' ? base : base.filter(x => getStatus(x) === v)
    }

    function weekStart(v) {
        const d = new Date(v),
            day = (d.getDay() + 6) % 7;
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - day);
        return d
    }
    const kpis = {
        price: {
            label: 'Price',
            get: x => N(x.priceNumber) || N(x.price),
            fmt: v => '$' + N(v).toFixed(2)
        },
        revenue: {
            label: 'Revenue estimate',
            get: revenue,
            fmt: money
        },
        units: {
            label: 'Units estimate',
            get: units,
            fmt: v => Math.round(N(v)).toLocaleString()
        },
        mainRank: {
            label: 'Main BSR',
            get: x => N(x.rank),
            fmt: v => N(v) ? Math.round(N(v)).toLocaleString() : 'N/A',
            inverse: true
        },
        subRank: {
            label: 'Subcategory BSR',
            get: x => N(x.subcategoryRank),
            fmt: v => N(v) ? Math.round(N(v)).toLocaleString() : 'N/A',
            inverse: true
        },
        rating: {
            label: 'Rating',
            get: rating,
            fmt: v => N(v).toFixed(1) + ' ★'
        },
        reviews: {
            label: 'Review count',
            get: reviews,
            fmt: v => Math.round(N(v)).toLocaleString()
        },
        stock: {
            label: 'In-stock status',
            get: x => /currently unavailable|out of stock|no active offer/i.test(x.availability || '') ? 0 : (N(x.priceNumber) || /in stock|ships within|available/i.test(x.availability || '')) ? 1 : 0,
            fmt: v => N(v) >= .5 ? 'In stock' : 'Out of stock'
        }
    };

    function weeklyData(k) {
        const s = state(),
            spec = kpis[k],
            products = selectedProducts(),
            weeks = new Map();
        for (const x of products) {
            const rows = [...(s.history[x.asin] || []), x].filter(r => r.snapshotAt || r.lastUpdated);
            for (const r of rows) {
                const w = weekStart(r.snapshotAt || r.lastUpdated),
                    key = w.toISOString().slice(0, 10);
                if (!weeks.has(key)) weeks.set(key, new Map());
                const map = weeks.get(key),
                    old = map.get(x.asin);
                if (!old || new Date(r.snapshotAt || r.lastUpdated) > new Date(old.snapshotAt || old.lastUpdated)) map.set(x.asin, r)
            }
        }
        const keys = [...weeks.keys()].sort();
        return {
            products,
            weeks,
            keys,
            spec
        }
    }

    function renderWeekly() {
        const tabs = $('proHistoryTabs');
        if (!tabs) return;
        tabs.innerHTML = Object.entries(kpis).map(([k, v]) => `<button data-k="${k}" class="${k===activeKpi?'active':''}">${E(v.label)}</button>`).join('');
        tabs.querySelectorAll('button').forEach(b => b.onclick = () => {
            activeKpi = b.dataset.k;
            renderWeekly()
        });
        const {
            products,
            weeks,
            keys,
            spec
        } = weeklyData(activeKpi), show = keys.slice(-12);
        let html = '<table><thead><tr><th class="identity">ASIN</th><th class="identity">Item title</th><th class="identity">Amazon</th>' + show.map((w, i) => `<th class="weekCol">${E(spec.label)}<small>Week ${i+1} · ${date(w)}</small></th><th class="changeCol">Change<small>vs prior week</small></th>`).join('') + '</tr></thead><tbody>';
        for (const x of products) {
            let prior = null;
            html += `<tr><td><b>${E(x.asin)}</b></td><td>${E((x.name||'').slice(0,80))}</td><td>${itemLink(x)}</td>`;
            for (const w of show) {
                const r = weeks.get(w)?.get(x.asin),
                    v = r ? spec.get(r) : null,
                    chg = v != null && prior != null && prior !== 0 ? (v - prior) / Math.abs(prior) : NaN,
                    good = Number.isFinite(chg) ? (spec.inverse ? chg <= 0 : chg >= 0) : null;
                html += `<td class="weekCol">${v==null?'N/A':spec.fmt(v)}</td><td class="changeCol"><span class="weeklyChange ${good==null?'neutral':good?'up':'down'}">${pct(chg)}</span></td>`;
                if (v != null) prior = v
            }
            html += '</tr>'
        }
        html += '</tbody></table>';
        $('proWeeklyHistory').innerHTML = html
    }

    function exportWeekly() {
        const wb = XLSX.utils.book_new();
        for (const [k, spec] of Object.entries(kpis)) {
            const {
                products,
                weeks,
                keys
            } = weeklyData(k), show = keys.slice(-52), rows = products.map(x => {
                const o = {
                    ASIN: x.asin,
                    'Item Title': x.name || '',
                    Amazon: link(x)
                };
                let prior = null;
                show.forEach((w, i) => {
                    const r = weeks.get(w)?.get(x.asin),
                        v = r ? spec.get(r) : null,
                        chg = v != null && prior != null && prior !== 0 ? (v - prior) / Math.abs(prior) : null;
                    o[`${spec.label} Week ${i+1} (${w})`] = v;
                    o[`Change Week ${i+1} (${w})`] = chg;
                    if (v != null) prior = v
                });
                return o
            });
            const ws = XLSX.utils.json_to_sheet(rows);
            ws['!freeze'] = {
                xSplit: 3,
                ySplit: 1
            };
            XLSX.utils.book_append_sheet(wb, ws, spec.label.slice(0, 31))
        }
        XLSX.writeFile(wb, 'my-products-weekly-kpi-history.xlsx')
    }

    function stars(v) {
        return `<span class="stars" aria-label="${v.toFixed(1)} out of 5">${[1,2,3,4,5].map(n=>`<svg viewBox="0 0 24 24" class="${v>=n-.5?'on':''}"><path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 2.5Z"/></svg>`).join('')}</span>`
    }

    function baseline(asin, days) {
        const h = state().history[asin] || [],
            cut = Date.now() - days * 864e5;
        return [...h].reverse().find(r => new Date(r.snapshotAt || r.lastUpdated).getTime() <= cut)
    }

    function renderReviews() {
        const sort = $('proReviewSort')?.value || 'ratingAsc',
            a = selectedProducts().map(x => {
                const b = baseline(x.asin, 30);
                return {
                    x,
                    r: rating(x),
                    n: reviews(x),
                    d: b ? reviews(x) - reviews(b) : null
                }
            });
        a.sort((u, v) => sort === 'ratingAsc' ? u.r - v.r : sort === 'ratingDesc' ? v.r - u.r : sort === 'change' ? (v.d || 0) - (u.d || 0) : v.n - u.n);
        const bands = [1, 2, 3, 4, 5].map(n => a.filter(z => z.r > n - 1 && z.r <= n).length);
        $('proReviewSummary').innerHTML = bands.map((v, i) => `<div><b>${i+1} ★</b><strong>${v}</strong><span>${a.length?(v/a.length*100).toFixed(1):0}% of items</span></div>`).join('');
        $('proReviewTable').innerHTML = '<table><thead><tr><th>ASIN</th><th>Item title</th><th>Amazon</th><th>Current rating</th><th>Reviews</th><th>30-day change</th></tr></thead><tbody>' + a.map(({
            x,
            r,
            n,
            d
        }) => `<tr><td><b>${E(x.asin)}</b></td><td>${E((x.name||'').slice(0,85))}</td><td>${itemLink(x)}</td><td><div class="ratingCell">${stars(r)}<b>${r?r.toFixed(1):'N/A'}</b></div></td><td>${n.toLocaleString()}</td><td><span class="weeklyChange ${d==null?'neutral':d>=0?'up':'down'}">${d==null?'N/A':(d>=0?'+':'')+d.toLocaleString()}</span></td></tr>`).join('') + '</tbody></table>'
    }

    function renderManage() {
        const box = $('myManage');
        if (!box) return;
        const term = ($('proManageSearch')?.value || '').toLowerCase(),
            rows = state().products.filter(x => [x.asin, x.sku, x.name, getStatus(x)].join(' ').toLowerCase().includes(term));
        $('proManageCount').textContent = `${rows.length} products`;
        box.innerHTML = '<table><thead><tr><th>Product</th><th>ASIN</th><th>Amazon</th><th>SKU</th><th>Item status</th><th>Revenue mid</th><th>Actions</th></tr></thead><tbody>' + rows.map(x => `<tr><td><div class="productCell"><img src="${E(x.imageLink||'icon128.png')}" onerror="this.src='icon128.png'"><span>${E((x.name||'').slice(0,70))}</span></div></td><td><b>${E(x.asin)}</b></td><td>${itemLink(x)}</td><td>${E(x.sku||'')}</td><td><select class="statusSelect status-${getStatus(x).replace(/\s/g,'')}" data-asin="${E(x.asin)}">${['New item','Active','Disco','Stopped','With issue'].map(v=>`<option ${v===getStatus(x)?'selected':''}>${v}</option>`).join('')}</select></td><td>${money(N(x.bsrEstimatedRevenueMid))}</td><td><button class="miniBtn quickEdit" data-asin="${E(x.asin)}">Edit details</button></td></tr>`).join('') + '</tbody></table>';
        box.querySelectorAll('.statusSelect').forEach(sel => sel.onchange = async () => {
            const o = await chrome.storage.local.get(['myProducts']),
                products = o.myProducts || [],
                x = products.find(z => z.asin === sel.dataset.asin);
            if (x) {
                x.itemStatus = sel.value;
                await chrome.storage.local.set({
                    myProducts: products
                });
                await window.myPortfolioReload?.()
            }
        });
        box.querySelectorAll('.quickEdit').forEach(b => b.onclick = () => {
            const x = state().products.find(z => z.asin === b.dataset.asin),
                sku = prompt('SKU', x.sku || '');
            if (sku === null) return;
            const notes = prompt('Notes', x.notes || '');
            chrome.storage.local.get(['myProducts'], async o => {
                const y = (o.myProducts || []).find(z => z.asin === x.asin);
                if (y) {
                    y.sku = sku;
                    y.notes = notes ?? y.notes;
                    await chrome.storage.local.set({
                        myProducts: o.myProducts
                    });
                    await window.myPortfolioReload?.()
                }
            })
        })
    }

    function combineDonuts() {
        const box = $('myShare');
        if (!box) return;
        const metric = $('proContributionMetric')?.value || 'revenue',
            get = metric === 'units' ? units : metric === 'reviews' ? reviews : metric === 'rank' ? x => N(x.subcategoryRank) ? 1 / N(x.subcategoryRank) : 0 : metric === 'mainRank' ? x => N(x.rank) ? 1 / N(x.rank) : 0 : revenue,
            groups = {};
        for (const x of selectedProducts()) {
            const c = x.mySubcategory || x.rankedSubcategory || 'Uncategorized';
            (groups[c] || (groups[c] = [])).push(x)
        }
        const entries = Object.entries(groups).map(([c, a]) => [c, a, a.reduce((s, x) => s + get(x), 0)]).sort((a, b) => b[2] - a[2]),
            major = entries.filter(e => e[1].length >= 3),
            small = entries.filter(e => e[1].length < 3);
        if (small.length) major.push(['Other subcategories', small.flatMap(e => e[1]), small.reduce((s, e) => s + e[2], 0)]);
        const colors = ['#2563eb', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444'];
        box.innerHTML = major.map(([c, a]) => {
            const sorted = [...a].sort((x, y) => get(y) - get(x)),
                shown = donutExpanded ? sorted : sorted.slice(0, 5),
                rest = sorted.slice(5),
                total = sorted.reduce((s, x) => s + get(x), 0) || 1,
                segments = [...shown];
            if (!donutExpanded && rest.length) segments.push({
                asin: 'REST',
                sku: `Other ${rest.length}`,
                imageLink: 'icon128.png',
                _v: rest.reduce((s, x) => s + get(x), 0)
            });
            let deg = 0,
                grad = segments.map((x, i) => {
                    const v = x._v ?? get(x),
                        st = deg;
                    deg += v / total * 360;
                    return `${colors[i%colors.length]} ${st}deg ${deg}deg`
                }).join(',');
            return `<article class="shareCard unifiedDonut"><header><span class="sectionIcon">◔</span><div><b>${E(c)}</b><small>${sorted.length} ASINs · ${E(metric)}</small></div></header><div class="shareDonut proDonut" style="background:conic-gradient(${grad})"></div><div class="shareRows">${segments.map((x,i)=>{const v=x._v??get(x);return`<div><img src="${E(x.imageLink||'icon128.png')}" onerror="this.src='icon128.png'"><i style="background:${colors[i%colors.length]}"></i><span>${E(x.sku||x.asin)}</span><b>${(v/total*100).toFixed(1)}%</b><em>${metric==='revenue'?money(v):Math.round(v).toLocaleString()}</em></div>`}).join('')}</div></article>`
        }).join('') + `<button id="toggleAllDonuts" class="secondary donutToggle">${donutExpanded?'Show top 5 only':'Show all ASINs'}</button>`;
        $('toggleAllDonuts').onclick = () => {
            donutExpanded = !donutExpanded;
            combineDonuts()
        }
    }

    function expandFamilies() {
        const box = $('proParentCards');
        if (!box) return;
        box.querySelectorAll('.familyCard').forEach((card, i) => {
            if (card.querySelector('.familyExpand')) return;
            const b = document.createElement('button');
            b.className = 'familyExpand';
            b.textContent = 'View full variation family';
            b.onclick = () => {
                const table = $('proParentTable'),
                    rows = [...table.querySelectorAll('tbody tr')],
                    parent = card.querySelector('.familyHead b')?.textContent;
                rows.forEach(r => r.classList.toggle('familyFocus', r.cells[1]?.textContent === parent));
                table.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                })
            };
            card.appendChild(b)
        })
    }

    function enhanceLatest() {
        const table = $('myLatest')?.querySelector('table');
        if (!table) return;
        const range = $('proLatestRange')?.value || 'last',
            days = range === '7' ? 7 : range === '30' ? 30 : range === 'week' ? 7 : 0,
            prods = state().products;
        for (const [i, x] of prods.entries()) {
            const tr = table.tBodies[0]?.rows[i];
            if (!tr) continue;
            if (!table.querySelector('th[data-pro-delta]')) {}
            const base = days ? baseline(x.asin, days) : (state().history[x.asin] || []).slice(-2)[0],
                changes = [
                    ['Price', N(x.priceNumber), base ? N(base.priceNumber) : 0, false],
                    ['Revenue', N(x.bsrEstimatedRevenueMid), base ? N(base.bsrEstimatedRevenueMid) : 0, false],
                    ['Main BSR', N(x.rank), base ? N(base.rank) : 0, true],
                    ['Reviews', reviews(x), base ? reviews(base) : 0, false]
                ];
            let td = tr.querySelector('.latestDeltas');
            if (!td) {
                td = document.createElement('td');
                td.className = 'latestDeltas';
                tr.appendChild(td)
            }
            td.innerHTML = changes.map(([l, v, b, inv]) => {
                const c = b ? (v - b) / Math.abs(b) : NaN,
                    good = Number.isFinite(c) ? (inv ? c <= 0 : c >= 0) : null;
                return `<span class="deltaChip ${good==null?'neutral':good?'up':'down'}"><small>${l}</small>${pct(c)}</span>`
            }).join('')
        }
        const hr = table.tHead?.rows[0];
        if (hr && !hr.querySelector('[data-pro-delta]')) {
            const th = document.createElement('th');
            th.dataset.proDelta = '1';
            th.textContent = '% change from range';
            hr.appendChild(th)
        }
    }

    function linkAllTables() {
        const map = new Map(state().products.map(x => [x.asin, x]));
        document.querySelectorAll('#myproducts table tbody tr').forEach(tr => {
            if (tr.querySelector('.amazonLink')) return;
            const cell = [...tr.cells].find(c => /\b[A-Z0-9]{10}\b/.test(c.textContent));
            if (!cell) return;
            const a = (cell.textContent.match(/\b[A-Z0-9]{10}\b/) || [])[0],
                x = map.get(a);
            if (x) cell.insertAdjacentHTML('beforeend', itemLink(x))
        })
    }

    function all() {
        renderWeekly();
        renderReviews();
        renderManage();
        combineDonuts();
        setTimeout(() => {
            expandFamilies();
            enhanceLatest();
            linkAllTables();
            document.querySelectorAll('#myproducts table').forEach(t => t.classList.add('gridTable'))
        }, 80)
    }
    $('proExportWeekly').onclick = exportWeekly;
    $('proReviewSort').onchange = renderReviews;
    $('proManageSearch').oninput = renderManage;
    $('proItemStatus').onchange = () => {
        const v = $('proItemStatus').value,
            search = $('mySearch');
        search.dataset.status = v;
        all()
    };
    $('proLatestRange').onchange = enhanceLatest;
    window.renderTab4Ops = all;
    setTimeout(all, 350);
    const old = window.renderTab4Pro;
    window.renderTab4Pro = () => {
        old?.();
        setTimeout(all, 80)
    };
})();