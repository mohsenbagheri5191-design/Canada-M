(() => {
    const $ = id => document.getElementById(id);
    let advanced = false;

    function decorate() {
        document.querySelectorAll('#t1,#t2,#t3').forEach((host, ix) => {
            const table = host.querySelector('table');
            if (!table) return;
            host.classList.add('intelTable');
            table.classList.add('productIntelTable');
            let bar = host.previousElementSibling;
            if (!bar?.classList.contains('intelToolbar')) {
                bar = document.createElement('div');
                bar.className = 'intelToolbar';
                bar.innerHTML = `<span>Viewing <b>${table.tBodies[0]?.rows.length||0}</b> items</span><div><label><input type="checkbox" class="advancedSwitch"> Show Advanced Product Details</label><button class="secondary intelCustomize">⚙ Customize</button><button class="blue intelExport">⇩ Export Data</button></div>`;
                host.before(bar);
                bar.querySelector('.advancedSwitch').onchange = e => {
                    advanced = e.target.checked;
                    host.classList.toggle('showAdvanced', advanced)
                };
                bar.querySelector('.intelCustomize').onclick = () => document.getElementById('settingsBtn')?.click();
                bar.querySelector('.intelExport').onclick = () => document.getElementById(ix === 0 ? 'csv1' : ix === 1 ? 'xlsx2' : 'exportAll')?.click()
            }
            host.classList.toggle('showAdvanced', advanced);
            let heads = [...table.querySelectorAll('thead th')].map(x => x.textContent.trim().toLowerCase());
            table.querySelectorAll('tbody tr').forEach(tr => {
                let asinIndex = heads.findIndex(x => x === 'asin'),
                    titleIndex = heads.findIndex(x => x.includes('title')),
                    imageIndex = heads.findIndex(x => x === 'image');
                if (asinIndex >= 0 && titleIndex >= 0) {
                    const asin = tr.cells[asinIndex]?.textContent.trim(),
                        title = tr.cells[titleIndex];
                    title?.classList.add('productIdentity');
                    if (imageIndex >= 0) {
                        const img = tr.cells[imageIndex]?.querySelector('img');
                        if (img && !title.querySelector('img')) title.prepend(img.cloneNode())
                    }
                    if (asin && !title.querySelector('.intelMeta')) title.insertAdjacentHTML('beforeend', `<small class="intelMeta">🇨🇦 · ${asin} · Amazon</small>`)
                }
                let r = tr.cells[heads.findIndex(x => x.includes('rating'))];
                if (r) r.classList.add('ratingGold')
            })
        })
    }
    new MutationObserver(decorate).observe(document.body, {
        subtree: true,
        childList: true
    });
    decorate()
})();