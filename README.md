# Amazon Market Research Pro

An invite-only Amazon seller and agency research tool: a Chrome Manifest V3
extension backed by Supabase, with an admin console for managing access.

Previously everything ran client-side. Every scoring coefficient, confidence
band and advisory threshold sat in the extension folder, where any installed
user could open `chrome://extensions`, enable developer mode, and read them.
This version moves all of it server-side and gates the product behind a login
that an administrator controls.

---

## What runs where

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CHROME EXTENSION (Manifest V3)          the bundle any user can read   │
│                                                                          │
│   popup.html ─┐                                                          │
│               ├──▶ dashboard.html ──▶ auth.js ──▶ the gate               │
│   toolbar ────┘         │                                                │
│                         ├── dashboard.js       Deep Search + analysis    │
│                         ├── market-v21.js      Market Intelligence       │
│                         │      └── brand-dashboard.html   (sandboxed)    │
│                         └── tab4-*.js          My Products portfolio     │
│                                    │                                     │
│                         chrome.runtime messages    ← no tokens cross     │
│                                    │                  this line          │
│  ┌─────────────────────────────────▼─────────────────────────────────┐  │
│  │  SERVICE WORKER (background.js)   the only door to the network    │  │
│  │                                                                   │  │
│  │   lib/session.js   access token → storage.session (memory)        │  │
│  │                    refresh token → storage.local  (disk)          │  │
│  │   lib/api.js       one silent retry on 401, then clean re-login   │  │
│  │   lib/amazon.js    fetch + parse Amazon (commodity, stays local)  │  │
│  │                                                                   │  │
│  │   config.js  ── project URL + anon key. Nothing else. ──          │  │
│  └───────────────────┬───────────────────────────┬───────────────────┘  │
└──────────────────────┼───────────────────────────┼──────────────────────┘
                       │                           │
        user's cookies │                           │ HTTPS + Bearer JWT
        user's own IP  │                           │ CORS allowlist, no wildcard
                       ▼                           ▼
        ┌──────────────────────┐   ┌──────────────────────────────────────┐
        │  amazon.ca / .com    │   │  SUPABASE EDGE FUNCTIONS (Deno)      │
        │  raw HTML            │   │                                       │
        └──────────────────────┘   │  ┌─────────────────────────────────┐ │
                                   │  │ _shared/                        │ │
        ┌──────────────────────┐   │  │   auth.ts     verify + gate     │ │
        │  ADMIN CONSOLE       │   │  │   cors.ts     origin allowlist  │ │
        │  3 static files      │   │  │   handler.ts  one wrapper       │ │
        │  no build step       │──▶│  │   usage.ts    log + audit       │ │
        │  anon key only       │   │  └─────────────────────────────────┘ │
        └──────────────────────┘   │                                       │
                                   │  research     ★ scoring.ts            │
                                   │               the whole product       │
                                   │  me           profile + quota         │
                                   │  admin-users  CRUD + kill switch      │
                                   │  admin-usage  aggregates              │
                                   │                                       │
                                   │  service role key (env only) ─────┐   │
                                   └───────────────────────────────────┼───┘
                                                                       │
                                   ┌───────────────────────────────────▼───┐
                                   │  POSTGRES — RLS on every table        │
                                   │                                       │
                                   │  profiles      invited accounts       │
                                   │  usage_events  quota + analytics      │
                                   │  app_settings  kill switch, defaults  │
                                   │  audit_log     append-only            │
                                   │                                       │
                                   │  anon role: denied on all four        │
                                   │  user role: own rows only             │
                                   │  all writes: service role only        │
                                   └───────────────────────────────────────┘
```

The line that matters is between the service worker and everything above it.
No page script holds a token, and no page script can compute a score.

---

## How a search works

1. The dashboard asks the service worker to run a search.
2. The service worker calls `me` first. A disabled account, an expired one, a
   spent quota or an active kill switch stops the work here — before a single
   Amazon page is fetched.
3. It crawls Amazon from the user's browser, with the user's cookies, and hands
   the HTML to an offscreen document for parsing.
4. It posts the parsed facts — rank, price, review count, badge units,
   variation count — to `research`.
5. `research` re-verifies the caller, checks the quota, runs the model, logs
   the call, and returns finished numbers.
6. The dashboard draws them.

The extension never learns the mapping in step 5.

---

## Why scraping stayed in the browser

The brief asked for everything server-side. Collection is the one part that
stayed local, for two reasons.

**Practical.** Those requests carry the user's own Amazon cookies from their
own residential IP, which is what makes them look like browsing. From a
datacenter IP with no session, a robot check arrives within a page or two, and
a multi-page crawl would not fit inside an Edge Function's wall clock anyway.

**Substantive.** Selectors and pagination are not the intellectual property.
Anyone can rewrite them by reading a product page in dev tools. The value is in
what the numbers mean, and that is what moved.

The requirement the brief actually cares about still holds: the extension
cannot reproduce the results on its own.

---

## Repository layout

```
extension/                 Chrome MV3 extension
  config.js                project URL + anon key. The whole of the config.
  background.js            service worker: auth, network, market scans
  lib/session.js           token custody
  lib/api.js               Edge Function client + retry policy
  lib/amazon.js            Amazon fetch + crawl orchestration
  auth.js / auth.css       the login gate and every blocked state
  dashboard.js             Deep Search + analysis (draws, does not compute)
  market-v21.js            Market Intelligence workspaces
  brand-dashboard.*        sandboxed brand share renderer
  tab4-*.js, myproducts.js My Products portfolio tracking

supabase/
  migrations/              schema, RLS, helpers, admin RPCs
  functions/
    _shared/               auth, CORS, errors, usage logging, handler wrapper
    research/scoring.ts    ★ every coefficient and threshold
    research/index.ts      score | analyze | brand
    me/                    profile, status, quota
    admin-users/           user CRUD, password reset, settings, audit
    admin-usage/           usage aggregates

admin/                     admin console (3 static files, no build)
scripts/verify-bundle.sh   proves the bundle carries no formulas or secrets
```

---

## Getting started

Deployment, the first admin account, and the three dashboard settings that
still need a human: **[SETUP.md](SETUP.md)**

What is protected, what a determined user can still see, and the residual
risks: **[SECURITY.md](SECURITY.md)**

Before packaging a release:

```bash
./scripts/verify-bundle.sh
```

---

## Notes on the rebuild

**Numerically identical.** The scoring port was verified against the original
V29 client code over 20,000 randomised listings — including missing ranks,
missing prices, zero reviews, comma-formatted numbers and both models —
comparing 16 output fields each. 320,000 comparisons, zero mismatches. Existing
users see the same numbers.

**Three defects fixed along the way.**

`dashboard.js` called the SheetJS `XLSX` global in three places, but SheetJS
was never bundled and never loaded from a CDN. Every CSV export and every file
upload on tabs 1–3 threw `ReferenceError`. The bundle already contained working
hand-rolled replacements (`product-workbook.js` for reading, `xlsx-export.js`
for writing) that were never wired up; they are now.

`market-v21.js` bound click handlers to `#mTpl` and `#mUp`, elements no markup
ever created. The resulting `TypeError` aborted `draw()` before the dashboard
iframe was appended, so Market Intelligence rendered its header and nothing
else. The buttons now exist.

`estimate()` was duplicated in `background.js` and `dashboard.js` with
different behaviour — the background copy silently dropped the confidence
bands. There is now one implementation, on the server.

**201KB of customer data removed.** `brand-dashboard.html` inlined a real
Helium 10 export: 273 ASINs with brands, sellers and revenue figures, shipped
to every user who installed the extension. The file is now a renderer that
receives its data at runtime.

**A note on the brief.** It described the theme as dark forest and ink and the
charts as Chart.js. The V29 source was actually light blue and navy with forest
only as an accent in newer sections, and the charts were hand-rolled SVG and
CSS conic-gradients with no Chart.js anywhere. The new auth chrome and admin
console are built in dark forest and ink as asked; the existing dashboards keep
their look, and the charts stay hand-rolled — they were already dependency-free
and adding a library would have been a regression.
