# Start here

**Open `index.html` in a browser. That's it.** No install, no build, no
dependencies. If you just ran `npm install` and it did nothing, that's expected
— there is no `package.json` because there is nothing to install.

If your browser blocks ES modules on `file://`, serve the folder instead:

```sh
python3 -m http.server 8777     # then open http://localhost:8777
```

You should see a dark dashboard with eight tabs in the left rail, loaded with
demo data. Press `⌘K` / `Ctrl+K` for the command palette, `?` for shortcuts.

---

## What this is

A desktop admin and design dashboard for a **server-driven mobile app**: build
the app's screens visually, decide which users see which version, manage the
records the app serves, and switch features on per client organisation.

The idea it is built around: **the app's layout is data, not code.** A design is
a JSON document. The app fetches it at runtime and renders it. Changing a screen
is a database write, not a deploy.

## What it is not

**It has no backend.** Every read and write goes to a seeded fixture in
`assets/js/data/db.js`, persisted to `localStorage`. The organisations, users,
jobs and designs you see are invented. Nothing is real, nothing is saved to a
server, and there is no login.

Connecting it to your backend is the whole job. That job is described in
`INTEGRATION.md`, and the client half of it is already written for you.

---

## The five things to know before you touch anything

**1. There is exactly one seam.** Every piece of data enters through
`assets/js/data/db.js`. No tab builds a URL or knows where data comes from.
`assets/js/data/db.api.js` is a finished HTTP replacement with a byte-for-byte
identical method surface. Switching is one import line per file — not a rewrite.

**2. Don't make it async.** `db.api.js` is cache-backed on purpose. Every tab
calls it synchronously inside render expressions. Turning the adapter async
means adding `await` to several hundred call sites and making every render
function async — a large, risky refactor with nothing to show for it. The
adapter hydrates once, serves reads from the snapshot, and writes through
optimistically with rollback on failure, which is how the UI already behaves.

**3. The registry and the renderer are shared with the mobile app.**
`assets/js/data/registry.js` and `assets/js/render/renderer.js` must be imported
by *both* the dashboard and the app — one module, two importers. Never two
copies. Every drift bug in this kind of system comes from breaking that rule.

**4. The resolution rule belongs on the server.** It decides what each user
sees. If the dashboard computes it and the runtime computes it separately, the
Paths tab will confidently explain an outcome that isn't happening. One
implementation, server-side, called by both.

**5. When docs disagree, the code wins.** `BRIEF.md` is the original
specification and is aspirational in places. `db.api.js` is what the client
actually sends and expects. Trust `db.api.js`.

---

## Where to go next

| You want to | Read |
|---|---|
| Understand the architecture and every feature | `README.md` |
| Wire it to a real backend | `INTEGRATION.md` ← **start here for that** |
| See the original spec, SQL schema, full API contract | `BRIEF.md` |
| See the exact requests the client makes | `assets/js/data/db.api.js` |
| Understand what a component is | `assets/js/data/registry.js` |

## Map

```
index.html                    the entry point
assets/css/                   tokens first, then base, components, shell, tabs, studio
assets/js/
  main.js                     boot
  core/                       DOM helper, store, history, icons, UI primitives
  data/
    registry.js       ★       what a component is — shared with the app
    presets.js                section blocks, screen templates, themes
    db.js             ✖       seeded fixture — delete once db.api.js is live
    db.api.js         ★       the HTTP adapter to implement against
  render/
    renderer.js       ★       layout document → DOM — shared with the app
  studio/                     canvas, layers, inspector, theme editor, publish
  tabs/                       one module per tab
```

★ = the integration surface. ✖ = throw away.

---

## First real milestone

Not "make it compile" — make a design change reach a user without a deploy:

1. Reconcile `registry.js` with your app's real components.
2. Implement `GET /api/v1/bootstrap`, swap the import to `db.api.js`, add
   `await db.hydrate()` before `boot()` in `main.js`.
3. Implement `GET /api/v1/layout/resolve` and add the renderer to the app.
4. Edit a layout document row in the database. Watch the app change.

Step 4 is the proof the whole system works. Everything else is surface area.
