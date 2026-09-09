(() => {
    'use strict';
    const t = (r, s) => r.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() || '',
        n = v => +(String(v || '').replace(/,/g, '').match(/[\d.]+/) || [0])[0],
        d = h => new DOMParser().parseFromString(h, 'text/html'),
        c = v => String(v || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

    function search(h, b) {
        let q = d(h),
            a = [];
        q.querySelectorAll('[data-asin]').forEach(x => {
            let asin = x.dataset.asin;
            if (!/^[A-Z0-9]{10}$/.test(asin || '')) return;
            let l = x.querySelector('h2 a,a[href*="/dp/"]'),
                p = t(x, '.a-price .a-offscreen');
            a.push({
                asin,
                name: t(x, 'h2'),
                price: p,
                priceNumber: n(p),
                imageLink: x.querySelector('img.s-image')?.src || '',
                review: n(t(x, '.a-icon-alt')),
                reviewCount: n(t(x, '.s-underline-text')),
                sponsored: /sponsored/i.test(x.textContent),
                itemLink: l ? new URL(l.getAttribute('href'), b).href : b + '/dp/' + asin
            })
        });
        return {
            items: a,
            next: q.querySelector('a.s-pagination-next:not(.s-pagination-disabled)')?.getAttribute('href') || ''
        }
    }

    function detail(h, u) {
        let q = d(h),
            asin = (u.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1],
            all = {};
        q.querySelectorAll('#productDetails_techSpec_section_1 tr,#productDetails_detailBullets_sections1 tr,.a-expander-content tr').forEach(r => {
            let k = t(r, 'th,.a-text-bold'),
                v = t(r, 'td,.a-list-item').replace(k, '').trim();
            if (k && v) all[c(k).replace(/\s*:\s*$/, '')] = c(v)
        });
        let f = (...z) => {
                for (let s of z) {
                    let k = Object.keys(all).find(k => k.toLowerCase().includes(s.toLowerCase()));
                    if (k) return c(all[k]).replace(new RegExp('^' + k + '\\s*:\\s*', 'i'), '')
                }
                return ''
            },
            p = t(q, '.priceToPay .a-offscreen,#corePrice_feature_div .a-offscreen'),
            seller = c(t(q, '#sellerProfileTriggerId,#merchant-info a[href*="seller"],#tabular-buybox-truncate-1 .a-truncate-full')).replace(/Tax Invoice[\s\S]*/i, '').trim(),
            ship = c(t(q, '#tabular-buybox-truncate-0 .a-truncate-full')).replace(/Tax Invoice[\s\S]*/i, '').trim(),
            body = (f('Best Sellers Rank') || q.body.textContent.match(/Best Sellers Rank[\s\S]{0,400}/i)?.[0] || ''),
            rs = [...body.matchAll(/#([\d,]+)\s+in\s+([^#(]+)/g)];
        return {
            asin,
            requestedAsin: asin,
            canonicalAsin: asin,
            canonicalUrl: u,
            name: t(q, '#productTitle'),
            imageLink: q.querySelector('#landingImage,#imgBlkFront')?.src || '',
            price: p,
            priceNumber: n(p),
            review: n(t(q, '#acrPopover .a-icon-alt')),
            reviewCount: n(t(q, '#acrCustomerReviewText')),
            availability: t(q, '#availability'),
            brand: c(t(q, '#bylineInfo')).replace(/^Brand\s*:\s*/i, ''),
            manufacturer: f('Manufacturer'),
            itemModelNumber: f('Item Model Number', 'Model Number'),
            productDimensions: f('Product Dimensions', 'Item Dimensions'),
            packageDimensions: f('Package Dimensions'),
            itemWeight: f('Item Weight'),
            countryOfOrigin: f('Country of Origin'),
            upc: f('UPC'),
            ean: f('EAN'),
            rank: rs[0] ? n(rs[0][1]) : '',
            rankCategory: rs[0]?.[2]?.trim() || '',
            subcategoryRank: rs[1] ? n(rs[1][1]) : '',
            rankedSubcategory: rs[1]?.[2]?.trim() || '',
            buyBoxSeller: seller,
            shipsFrom: ship,
            parentAsin: (h.match(/"parentAsin"\s*:\s*"([A-Z0-9]{10})"/) || [])[1] || '',
            allProductDetails: all,
            itemLink: u,
            status: 'Complete'
        }
    }
    chrome.runtime.onMessage.addListener((m, s, z) => {
        if (m.target !== 'offscreen') return;
        if (m.type === 'PARSE_SEARCH') z(search(m.html, m.base));
        if (m.type === 'PARSE_DETAIL') z(detail(m.html, m.url));
        return true
    })
})();