(() => {
    'use strict';
    const D = new TextDecoder(),
        u16 = (d, o) => d.getUint16(o, true),
        u32 = (d, o) => d.getUint32(o, true),
        dec = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    async function inf(x) {
        return new Uint8Array(await new Response(new Blob([x]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
    }
    async function unzip(ab) {
        const d = new DataView(ab),
            b = new Uint8Array(ab);
        let e = -1;
        for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--)
            if (u32(d, i) === 0x06054b50) {
                e = i;
                break
            } if (e < 0) throw Error('Invalid XLSX file.');
        let total = u16(d, e + 10),
            p = u32(d, e + 16),
            f = {};
        for (let j = 0; j < total; j++) {
            if (u32(d, p) !== 0x02014b50) break;
            let m = u16(d, p + 10),
                sz = u32(d, p + 20),
                nl = u16(d, p + 28),
                xl = u16(d, p + 30),
                cl = u16(d, p + 32),
                lo = u32(d, p + 42),
                n = D.decode(b.slice(p + 46, p + 46 + nl)),
                ln = u16(d, lo + 26),
                lx = u16(d, lo + 28),
                st = lo + 30 + ln + lx,
                x = b.slice(st, st + sz);
            if (m === 8) x = await inf(x);
            else if (m !== 0) throw Error('Unsupported XLSX compression.');
            f[n] = D.decode(x);
            p += 46 + nl + xl + cl
        }
        return f
    }

    function col(r) {
        let m = String(r).match(/[A-Z]+/);
        return m ? m[0].split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1 : 0
    }

    function csv(t) {
        let z = [],
            r = [],
            c = '',
            q = false;
        for (let i = 0; i < t.length; i++) {
            let x = t[i],
                n = t[i + 1];
            if (q) {
                if (x === '"' && n === '"') {
                    c += '"';
                    i++
                } else if (x === '"') q = false;
                else c += x
            } else if (x === '"') q = true;
            else if (x === ',') {
                r.push(c);
                c = ''
            } else if (x === '\n') {
                r.push(c);
                z.push(r);
                r = [];
                c = ''
            } else if (x !== '\r') c += x
        }
        r.push(c);
        z.push(r);
        let h = (z.shift() || []).map(x => x.trim());
        return z.filter(r => r.some(x => String(x).trim())).map(r => Object.fromEntries(h.map((x, i) => [x, r[i] || ''])))
    }
    async function xlsx(ab) {
        let f = await unzip(ab),
            ss = [];
        (f['xl/sharedStrings.xml'] || '').match(/<si[\s\S]*?<\/si>/g)?.forEach(si => {
            let a = [],
                m, re = /<t[^>]*>([\s\S]*?)<\/t>/g;
            while ((m = re.exec(si))) a.push(m[1]);
            ss.push(dec(a.join('')))
        });
        let w = f['xl/workbook.xml'] || '',
            rels = f['xl/_rels/workbook.xml.rels'] || '',
            rid = (w.match(/<sheet[^>]*name="Product Details"[^>]*r:id="([^"]+)"/) || w.match(/<sheet[^>]*r:id="([^"]+)"/) || [])[1],
            target = 'worksheets/sheet1.xml';
        if (rid) {
            let m = new RegExp('<Relationship[^>]*Id="' + rid + '"[^>]*Target="([^"]+)"').exec(rels);
            if (m) target = m[1]
        }
        target = target.startsWith('xl/') ? target : 'xl/' + target.replace(/^\//, '');
        let sh = f[target] || f['xl/worksheets/sheet1.xml'];
        if (!sh) throw Error('Product Details worksheet not found.');
        let rows = [];
        (sh.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []).forEach(rr => {
            let a = [],
                m, re = /<c([^>]*)>([\s\S]*?)<\/c>/g;
            while ((m = re.exec(rr))) {
                let at = m[1],
                    body = m[2],
                    ref = (at.match(/r="([^"]+)"/) || [])[1],
                    typ = (at.match(/t="([^"]+)"/) || [])[1],
                    v = ((body.match(/<v[^>]*>([\s\S]*?)<\/v>/) || body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]) || '';
                a[col(ref)] = typ === 's' ? (ss[+v] || '') : dec(v)
            }
            if (a.some(x => String(x || '').trim())) rows.push(a)
        });
        let h = (rows.shift() || []).map(x => String(x || '').trim());
        return rows.map(r => Object.fromEntries(h.map((x, i) => [x, r[i] || ''])))
    }
    async function read(file) {
        if (!file) throw Error('Choose a file.');
        if (/\.csv$/i.test(file.name)) return csv(await file.text());
        if (!/\.xlsx$/i.test(file.name)) throw Error('Use .xlsx or .csv.');
        return xlsx(await file.arrayBuffer())
    }
    window.ProductWorkbook = {
        read
    };
})();