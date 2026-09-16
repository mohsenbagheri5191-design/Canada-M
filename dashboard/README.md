# Admin & Design Dashboard

A desktop-only control surface for a server-driven mobile app: build the app's
screens visually, decide who sees which version, manage the records the app
serves, and switch features on per client.

```
open dashboard/index.html
```

That is the whole setup. No build step, no bundler, no dependency to install —
native ES modules and modern CSS served as static assets, matching how the rest
of this repository ships. Any static server works:

```sh
cd dashboard && python3 -m http.server 8777    # then open localhost:8777
```

Minimum width is 1280px; below 1100px the page says so rather than degrading.

---

## What this is, and what it is not

This is a **complete, working front end** for the dashboard described in
`admin-dashboard-build-prompt.md`. Every tab is implemented and interactive:
the Design Studio genuinely edits a layout document, validation genuinely
blocks a bad publish, the assignment resolver genuinely runs the rule chain.

It is backed by a **seeded local data layer**, not a live API. Every read and
write goes through `assets/js/data/db.js`, whose exported surface is shaped
exactly like the API contract in the brief. Pointing it at a real backend is a
change to that one file:

```js
// today
users: { list: (q) => clone(state.users.filter(...)) }

// against the API
users: { list: (q) => fetch(`/api/v1/users?${new URLSearchParams(q)}`).then(r => r.json()) }
```

Nothing else imports `state`, and no tab constructs a URL.

---

## Two findings worth stating up front

**1. This repository is not the app the brief describes.** `Canada-M` is
*Amazon Market Research Pro* — a Chrome MV3 extension, Supabase Edge Functions
and a three-file static admin console. The `canada-services-html-export` package
describes *CanadaServices*, a separate Next.js multi-tenant app that is not in
this repository. So the brief's Phase 0 — "extract the component registry from
the real app" — had nothing here to extract from. The registry in
`data/registry.js` is therefore authored rather than derived, and is the thing
to reconcile with the real app's components when the two meet.

**2. The stack deviates from the brief deliberately.** The brief suggests React
19 + Vite + Tailwind v4 + shadcn. This repository's stated architecture is
*"no build step, no framework, no bundler: static assets."* Adding a toolchain
would have been the larger change, so the dashboard honours the existing
convention. The consequence is that all the interface work is hand-built, which
is visible in `core/` — a 200-line DOM helper, an observable store, a history
stack, and an icon set drawn on one grid.

---

## Architecture

```
┌─────────────────┐   saves JSON    ┌──────────────┐   serves JSON   ┌───────────────┐
│  Design Studio  │ ──────────────► │   Database   │ ──────────────► │  Mobile app   │
│   (this app)    │                 │  + Layout    │                 │  + Renderer   │
└─────────────────┘                 │     API      │                 └───────────────┘
        │                           └──────────────┘                          │
        └───────────── same component registry ───────────────────────────────┘
```

The single most important rule: **the editor and the app renderer read from one
registry**. `data/registry.js` declares, for every component, its props, how the
inspector edits each one, whether it takes children, how it resizes, and how it
renders. `render/renderer.js` is the walker that turns a document into DOM — it
is written to be lifted into the mobile app unchanged. The studio uses it for
the canvas; the library, the palette and the publish panel use it for
thumbnails. There is no second implementation to drift from.

### Layout document

One design version is one JSON document holding every screen:

```jsonc
{
  "schemaVersion": 1,
  "screens": [{
    "id": "scr_home", "name": "Home", "route": "/home", "isEntry": true,
    "root": {
      "id": "n_1", "type": "Stack",
      "props": { "direction": "vertical", "gap": 16 },
      "children": [
        { "id": "n_2", "type": "Header",
          "props": { "title": { "$bind": "user.firstName", "fallback": "Welcome" } } },
        { "id": "n_3", "type": "Button",
          "props": { "label": "Start" },
          "actions": { "onPress": [{ "type": "navigate", "to": "/jobs" }] },
          "visibleIf": { "all": [{ "left": "$user.role", "op": "!=", "right": "guest" }] } }
      ]
    }
  }]
}
```

### The renderer never throws

A bad design must not brick the app, so `renderNode` is defensive by
construction: an unknown `type` renders nothing and logs once, a render
function that throws is caught and replaced with a marker, a binding that
cannot resolve falls back, and depth (20) and node (500) budgets are enforced
during the walk. Node ids are stable and never renumbered on edit, so analytics
and version diffs survive restructuring.

### Conditions are data, not code

`visibleIf` and rule conditions are structured objects evaluated by a
comparison-only interpreter — dot paths, comparisons, and `all`/`any`/`not`.
There are no function calls, no prototype access, and nothing from the database
is ever passed to `eval` or `Function`. The condition builder UI and the
evaluator read the same shape, so they cannot disagree.

---

## Layout

```
dashboard/
  index.html
  assets/css/
    tokens.css       every colour, size, duration; dark + light, two densities
    base.css         reset, typography, focus, scrollbars, shared animations
    components.css   buttons, inputs, tables, menus, modals, drawers, toasts…
    shell.css        rail, top bar, command palette
    tabs.css         per-tab layout only; no component restyling
    studio.css       canvas, device frame, selection, guides, inspector
  assets/js/
    main.js          entry point
    core/
      dom.js         el(), mount(), drag(), anchorTo(), focus trap
      store.js       observable store, 100-step history, persistence
      icons.js       ~140 glyphs drawn on one 24px grid
      ui.js          toasts, menus, modals, drawers, form controls, charts
      util.js        formatting, fuzzy match, OKLCH-ish ramps, WCAG contrast
      shell.js       rail, routing, command palette, shortcuts
    data/
      registry.js    THE CONTRACT — components, props, fields, render
      presets.js     section blocks, screen templates, style + theme presets
      db.js          the data adapter; swap this for fetch calls
    render/
      renderer.js    document → DOM, plus tree traversal helpers
    studio/
      canvas.js      hover, select, drag, resize, snap, marquee, miniatures
      layers.js      tree, reorder, reparent, rename, lock, hide, solo
      inspector.js   Insert · Layers · Style · Data · Screen
      theme-editor.js token editing with a live gallery and contrast grading
      publish.js     validation, publish panel, version history
    tabs/            one module per tab; each exports mount(host, ctx)
```

Each tab module exports `mount(host, ctx)` and may return a teardown function.
The shell lazily imports it, and owns nothing inside it.

---

## The eight tabs

| Tab | What it does |
|---|---|
| **Overview** | KPIs, adoption, health, activity feed, quick actions |
| **Design Studio** | The visual builder — canvas, layers, inspector, theme, publish |
| **Design Library** | Every design, with version history and a structural compare |
| **Assignments** | Matrix, rules, conflict detection, resolution preview |
| **Paths** | Per-user resolution trace, route map, journey, impersonation preview |
| **App Data** | Records over native tables and dashboard collections |
| **Features** | Toggle matrix with dependency and impact checks, per-org settings |
| **Rules** | Trigger → conditions → actions, with dry-run tests and a run log |

### Design Studio

- **Canvas.** Device frames (iPhone, Pixel, Android compact, iPad, custom),
  rotate, zoom 25–200%, fit-to-screen. Hover outlines with a name badge, click
  to select, marquee and shift to multi-select. Eight resize handles with a live
  pixel and percentage readout, Shift to preserve ratio, clamped to the
  registry's min and max. Drag to move shows an insertion line and highlights
  the receiving parent; invalid drops are visibly rejected. Alt reveals spacing
  measurements to the parent. Right-click for duplicate, wrap, copy style, save
  as a block.
- **Insert.** Three modes. *Sections* are ~30 composed presets across nine
  groups, each shown as a real miniature render rather than an illustration,
  with anything you saved from the canvas pinned above them. *Elements* is every
  component in the registry. *Screens* is eight full templates. All draggable
  onto the canvas or click-to-insert.
- **Style.** Generated from the registry, so adding a prop to a component makes
  it editable with no change to the inspector. Preset chips for elevation,
  corners, density, type scale and emphasis; a visual box-model control with a
  link toggle; per-corner radius; hug/fill/fixed sizing; drag-to-scrub numbers;
  contrast-checked colour fields; an icon picker over the whole set.
- **Responsive overrides and states.** A node's props are layered: registry
  defaults → base → `responsive[md|lg]` → `states[hover|pressed|disabled|…]`,
  merged by `layeredProps` in the renderer. Switching breakpoint re-renders the
  canvas to match, so what you change is what you see; a bar states which layer
  edits are landing in, each overridden value carries a dot, and clicking the
  dot drops back to inherited. Empty layers are pruned so they never appear as
  diff noise.
- **Data.** Bind any bindable prop to a registered source, picked from a live
  sample tree — click a field to bind it. Format and fallback. Below that, the
  action editor (ten action types, chainable) and a guided condition builder.
- **Theme.** Six presets, a ramp generator, every token editable, a live
  component gallery, and a WCAG AA report that blocks publish on a failure.
- **History.** 100 steps, coalesced so a slider drag is one undo. Autosave two
  seconds after a change.

### Publishing

```
Draft ──validate──► Preview ──publish──► Live ──rollback──► Previous live
  ▲                                        │
  └──────────── fork to new draft ─────────┘
```

Drafts are mutable; published versions are immutable, and opening one puts the
studio in read-only mode with a *Fork a draft* action. Publish is blocked on
unknown component types, empty bindings, duplicate or missing routes, a missing
or duplicated entry screen, dead navigation links, node and depth caps, and
text tokens failing AA. Warnings (missing fallbacks, empty containers) do not
block. The panel shows before/after thumbnails and states honestly how many
users the publish moves — and, when the answer is none, how many are on an
earlier version of the same design.

---

## Interaction quality

- `⌘K` command palette covering navigation, designs, organisations and every
  tab's own commands; tabs register contextual entries while mounted.
- `?` opens the shortcut sheet. Number keys jump between tabs. `C` starts a
  create chord (`C D` new design, `C U` new user, `C A` assignment, `C R` rule).
- Optimistic updates with undo in the toast for every destructive action.
- Skeletons, never spinners. Empty states carry one clear action.
- Full keyboard navigation, visible focus rings, `prefers-reduced-motion`.
- Dark and light are both real; comfortable and compact densities are one
  attribute flip on `<html>`.

---

## Conventions

- **Tokens first.** No hex value appears outside `tokens.css`. One accent
  colour, used only for primary action, active state and selection.
- **Motion is 120–180ms**, `cubic-bezier(0.2, 0, 0, 1)`, transform and opacity
  only, no bounce.
- **4px grid**, 32px rows, 28px controls, 6/10/999px radii, 13px body, tabular
  numerals everywhere numbers are compared.
- **Depth comes from hairline borders and one soft shadow**, never stacked
  drop shadows.

## Deliberately out of scope

A/B testing between versions, staged rollouts, real-time multiplayer editing,
code export, localisation management, a mobile version of the dashboard, a
plugin API, a visual workflow builder with branching, and a public API. The
schema carries room for each without breaking published documents.

## State

Preferences, the open design and saved blocks live in `localStorage` under
`cs.dashboard.v1`. The seeded dataset lives there too — *Reset demo data* in
the avatar menu restores it.
