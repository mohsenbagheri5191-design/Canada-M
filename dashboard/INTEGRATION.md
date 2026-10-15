# Integration brief

For whoever — person or agent — owns the backend and the mobile app.

This dashboard was built in isolation, against a seeded local dataset. It is
complete and working, but it has never spoken to your server. This document is
the contract: what to move, what to build, and the order that gets something
real working soonest.

---

## 1. What you are receiving

```
dashboard/
  index.html                  open it; no build step, no dependencies
  assets/css/                 tokens, components, shell, tabs, studio
  assets/js/core/             DOM helper, store, history, icons, UI primitives
  assets/js/data/
    registry.js               ★ THE CONTRACT — shared with the mobile app
    presets.js                section blocks, screen templates, themes
    db.js                     the seeded fixture adapter (throw this away)
    db.api.js                 ★ the HTTP adapter (implement against this)
  assets/js/render/
    renderer.js               ★ document → DOM, shared with the mobile app
  assets/js/studio/           canvas, layers, inspector, theme editor, publish
  assets/js/tabs/             one module per tab
```

Three files marked ★ are the integration surface. Everything else is UI that
does not care where data comes from.

---

## 2. Moving the files

The dashboard currently lives on the branch
`claude/admin-dashboard-design-ptn7z5` of
`github.com/mohsenbagheri5191-design/Canada-M`, in the `dashboard/` directory.
That repository is the Amazon Market Research extension — it is **not** the app
this dashboard is for. The move is across repositories.

Pick whichever is least friction:

**a. Copy the directory.** It is self-contained and has no imports outside
itself. `cp -r dashboard/ ../your-app/apps/dashboard/` is a valid migration.
You lose the commit history, which for a directory that has never been reviewed
in your repo does not matter much.

**b. Add a remote and cherry-pick.** Keeps history and authorship:

```sh
cd your-app
git remote add canada-m https://github.com/mohsenbagheri5191-design/Canada-M.git
git fetch canada-m claude/admin-dashboard-design-ptn7z5
git cherry-pick <the two commits on that branch>
```

**c. Subtree, if you want to keep pulling updates.**

```sh
git subtree add --prefix=apps/dashboard \
  https://github.com/mohsenbagheri5191-design/Canada-M.git \
  claude/admin-dashboard-design-ptn7z5 --squash
```

If your app is Next.js, `dashboard/` drops under `public/` and is served
statically, or the JS modules move into your app's route tree — see §6.

---

## 3. The one rule that keeps this working

**The dashboard and the app must import the same `registry.js` and the same
`renderer.js`.** Not copies. One module, imported twice.

The registry declares, for every component, its props, how the inspector edits
each one, whether it accepts children, how it resizes, and how it renders. The
renderer walks a layout document and produces DOM from it. If the editor and
the app each keep their own copy, they drift, and every drift bug in this class
of system comes from exactly that.

Publish them as an internal package — `@app/ui-registry` — and depend on it
from both sides. Until that exists, a shared directory and a path alias is
enough; a duplicated file is not.

`renderer.js` is written to be lifted verbatim. It has no imports outside
`core/dom.js` (a 200-line helper) and `data/registry.js`.

### What the registry needs from you

The components in `registry.js` are authored, not derived — there was no app in
the repository to extract them from. They are a working set for a field-service
app (Stack, Grid, Card, Header, List, StatTile, Button, Input, Map, Timeline,
TabBar and so on), and the studio genuinely edits them.

Your real app has its own components. Reconciling is the first substantial
piece of work:

1. For each component your app already has, add a registry entry: `props` with
   defaults, `fields` describing how each prop is edited, `acceptsChildren`,
   `resizable`, and `render` pointing at the existing component.
2. Delete any authored component your app has no counterpart for, or build the
   counterpart.
3. Anything the app can render but the registry does not declare is invisible
   to the editor; anything the registry declares but the app cannot render will
   be caught by publish validation as an unknown type.

---

## 4. The endpoints to build

`db.api.js` is a complete, commented implementation of the client side. Every
method maps to one endpoint. Build these and the dashboard works:

| Method | Endpoint | Notes |
|---|---|---|
| `hydrate()` | `GET /api/v1/bootstrap` | One snapshot of everything the caller may see. Enforce row-level security here. |
| `orgs.*` | `GET/POST/PATCH /organizations`, `PUT /organizations/:id/settings` | `settings.secrets` is write-only — never return it. |
| `users.*` | `GET/POST/PATCH/DELETE /users`, `POST /users/bulk`, `POST /users/:id/invite` | No self-signup. Invite link single-use, 72h. |
| `designs.*` | `GET/POST/PATCH /designs`, `POST /designs/:id/versions`, `PATCH /versions/:id` | `PATCH /versions/:id` is the autosave; reject with 409 if published. |
| | `POST /versions/:id/publish`, `/rollback` | Publish is atomic: validate, snapshot, thumbnail, flip, bust cache, audit. |
| `assignments.*` | `GET/POST/PATCH/DELETE /assignments` | |
| | `GET /paths/users/:id` | Returns `{ version, rule, trace }`. See §5. |
| | `POST /assignments/preview` | Returns `{ changed, unchanged }` for the resolution preview. |
| | `GET /assignments/conflicts` | Rules that could both apply. |
| `paths.*` | `GET /paths/flow` | Aggregate transitions in SQL, not the browser. |
| `entities.*` | `GET/POST/PATCH /entities/:key/records`, `POST /entities/records/bulk` | |
| | `GET/POST/PATCH/DELETE /collections` | A field-type change on a populated collection returns a migration preview. |
| | `GET /designs/data-sources` | Sample rows must respect RLS. |
| `features.*` | `GET/POST/PATCH /features`, `POST /features/:id/publish`, `PUT /features/:id/orgs/:orgId` | Re-check dependants server-side. |
| `rules.*` | `GET/POST/PATCH/DELETE /rules`, `POST /rules/:id/test` | `test` is a true round trip — dry run, commit nothing. |
| `metrics()` | `GET /metrics` | |

Plus the one the **app** calls, which is the whole point of the system:

| | `GET /api/v1/layout/resolve` | Returns `{ designVersionId, schemaVersion, screens, theme, features, settings, etag }`. Strong ETag, stale-while-revalidate 60s. |

The brief's §3 and §6 (`dashboard/BRIEF.md`) hold the full SQL schema and API
contract. `db.api.js` holds the exact request and response shapes the client
expects. Where they disagree, `db.api.js` is what the code actually does.

---

## 5. Two things that must live on the server, not the client

**The resolution rule.** It decides what every app user sees:

1. Active user-scope assignment, highest priority
2. Active organisation-scope assignment, highest priority
3. The organisation's default published design
4. The global fallback design
5. The app's built-in static layout

The mock implements this in `db.js` → `assignments.resolve()`; treat that as the
reference. It must move to the server and be called by both the runtime
(`/layout/resolve`) and the dashboard (`/paths/users/:id`). If the two compute
it separately they will disagree, and the Paths tab will confidently explain an
outcome that is not happening — which is worse than not having the tab.

The dashboard wants the `trace` back as well: the ordered list of steps it
evaluated, each `{ step, detail, hit, rule }`. The runtime does not need it;
return it from the dashboard endpoint only.

**Permissions.** Roles are modelled in the data (`super_admin`, `org_admin`,
`designer`, `viewer`, `app_user`) but nothing in the dashboard enforces them.
There is no login. Client-side checks hide buttons; they are not a boundary.
Every endpoint re-checks, and tenant tables get row-level security policies —
`records`, `collections`, `feature_assignments`, `org_settings`, `rules`.

---

## 6. Changes to the mobile app

Small and surgical, in this order:

1. Add `<LayoutRenderer />` — a thin wrapper around the shared `renderer.js`.
2. Add a layout provider that fetches `/layout/resolve` on boot, caches to
   IndexedDB, and serves the cached copy instantly next launch while
   revalidating behind it.
3. Wrap each screen in an error boundary: a crash falls back to the last known
   good layout, then to the static build-time layout.
4. Add preview mode: `?preview=<token>` renders the draft instead of the
   assigned version and disables telemetry.
5. Emit `path_events` on route change and tracked actions, batched.
6. Apply theme tokens as CSS custom properties on the root element.

The renderer is already defensive — unknown type renders nothing and logs once,
a throwing component is caught and replaced, an unresolved binding falls back,
and depth (20) and node (500) budgets are enforced during the walk. A bad
design cannot brick the app. Keep that property; it is load-bearing.

### The preview canvas

The brief specified running the real app in a sandboxed iframe over
`postMessage`. This dashboard renders the shared registry in-page instead,
because there was no app here to iframe. Same renderer, same output, different
plumbing.

Once the app exists, switching is worth doing — it is the difference between
previewing the components and previewing the app. The change is contained to
`studio/canvas.js`: replace the in-page `renderScreen` call with an iframe
pointed at `/t/:slug/:screen?preview=<token>`, and replace the direct DOM
queries in `nodeAt`/`boxOf` with a typed `postMessage` protocol (`hover`,
`select`, `rects`, `patch`) with origin checks on both ends. The overlay,
handles, guides and drop logic all work off rectangles and need no change.

---

## 7. Suggested order

Each step leaves something demonstrable.

1. **Reconcile the registry** with your real components. Nothing else can be
   trusted until the editor and the app agree on what exists.
2. **`GET /bootstrap` + `GET /metrics`.** Swap `db.js` for `db.api.js`, call
   `await db.hydrate()` before `boot()` in `main.js`. The whole dashboard now
   reads live data.
3. **Auth.** Put a session in front of it and make `setAccessToken` real.
4. **Writes, one family at a time** — designs first, since that is the tab
   people will use. `db.api.js` already does optimistic update with rollback;
   you are implementing the endpoints, not the client.
5. **`/layout/resolve` and the app renderer.** This is the milestone where a
   design change reaches a real user without a deploy. Prove it by editing a
   JSON row in the database and watching the screen change.
6. **The resolution rule server-side**, with the trace endpoint for Paths.
7. **Preview iframe**, replacing in-page rendering.
8. **Rules execution** — a worker, a scheduler, retries with backoff,
   auto-disable after five consecutive failures. The UI and dry-run are done;
   nothing executes.

---

## 8. What is deliberately not built

State these so nobody assumes they exist:

- No backend, no auth, no login.
- Rules do not execute; the run log is UI over seeded data.
- Thumbnails are live miniature renders, not stored screenshots. There is no
  `thumbnail_url` being written on publish.
- Multi-select has wrap, duplicate and delete, but not align or distribute.
- Out of scope by design: A/B testing between versions, staged rollouts,
  real-time multiplayer editing, code export, localisation management, a mobile
  version of the dashboard, a plugin API, a public API.

---

## 9. Handoff prompt

If you are passing this to another agent, this is enough to start:

> A desktop admin and design dashboard has been built and is at `<path>` in
> this repository. It is a complete, working front end with no backend: every
> read and write goes through `assets/js/data/db.js`, a seeded fixture adapter.
>
> `assets/js/data/db.api.js` is a drop-in HTTP replacement with an identical
> surface, fully commented, marking every endpoint it expects. Read
> `INTEGRATION.md` first, then `db.api.js`, then `BRIEF.md` §3 and §6 for the
> SQL schema and full API contract.
>
> Your first task is §7 step 1: reconcile `assets/js/data/registry.js` against
> this app's real components, so the editor and the runtime share one
> definition of what a component is. Then implement `GET /api/v1/bootstrap`,
> switch the import in every file from `db.js` to `db.api.js`, and add
> `await db.hydrate()` before `boot()` in `main.js`.
>
> Two rules that are load-bearing: the dashboard and the app import the *same*
> registry and renderer modules, never copies; and the assignment resolution
> rule lives on the server and is called by both, never reimplemented per
> caller.
