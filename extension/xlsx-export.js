(() => {
    'use strict';
    const te = new TextEncoder(),
        crcTable = (() => {
            let t = [];
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                t[n] = c >>> 0
            }
            return t
        })();
    const crc = b => {
            let c = 0xffffffff;
            for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
            return (c ^ 0xffffffff) >>> 0
        },
        u16 = n => new Uint8Array([n & 255, n >>> 8 & 255]),
        u32 = n => new Uint8Array([n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255]),
        cat = (...a) => {
            const z = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
            let p = 0;
            for (const x of a) {
                z.set(x, p);
                p += x.length
            }
            return z
        },
        esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&apos;'
        } [c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''),
        col = n => {
            let s = '';
            for (; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
            return s
        };
    async function deflate(bytes) {
        return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
    }
    async function zip(files) {
        let locals = [],
            centrals = [],
            offset = 0;
        for (const [name, text] of Object.entries(files)) {
            const raw = te.encode(text),
                data = await deflate(raw),
                nb = te.encode(name),
                sum = crc(raw),
                local = cat(u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(sum), u32(data.length), u32(raw.length), u16(nb.length), u16(0), nb, data);
            locals.push(local);
            centrals.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(sum), u32(data.length), u32(raw.length), u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nb));
            offset += local.length
        }
        const central = cat(...centrals),
            body = cat(...locals, central, u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(central.length), u32(offset), u16(0));
        return body
    }

    function rowsXml(rows) {
        return rows.map((r, ri) => `<row r="${ri+1}">${r.map((v,ci)=>{const ref=col(ci+1)+(ri+1),num=typeof v==='number'&&Number.isFinite(v);return num?`<c r="${ref}"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`}).join('')}</row>`).join('')
    }
    async function writeXlsx(rows, name) {
        const headers = rows.length ? Object.keys(rows[0]) : [],
            matrix = [headers, ...rows.map(r => headers.map(h => r[h] ?? ''))],
            last = col(headers.length),
            widths = headers.map(h => Math.min(45, Math.max(12, String(h).length + 3))),
            files = {
                '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
                '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
                'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Product Details" sheetId="1" r:id="rId1"/></sheets></workbook>',
                'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
                'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>',
                'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}${matrix.length}"/><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rowsXml(matrix)}</sheetData><autoFilter ref="A1:${last}${matrix.length}"/></worksheet>`
            };
        const data = await zip(files),
            u = URL.createObjectURL(new Blob([data], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            })),
            a = document.createElement('a');
        a.href = u;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(u), 2000)
    }
    window.writeExactProductXlsx = writeXlsx
})();