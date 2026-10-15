# BUILD PROMPT: Multi-Tenant Admin & Design Dashboard

> Paste this whole document to your coding agent as the project brief.
> It is written to be executed in phases. Do not let the agent skip Phase 0.

---

## 0. ROLE AND MISSION

You are a senior full-stack engineer and product designer. You are building a
desktop-only admin dashboard that controls an existing mobile web app.

The dashboard does three jobs:

1. **Design Studio.** A visual builder that lets a non-developer restructure,
   restyle and rewire the mobile app: move sections, resize them, swap
   components, change theme, icons, typography, spacing, and bind components to
   real data and actions. Output is saved as a versioned layout document, not
   as code.
2. **Admin Panel.** Create, edit, delete and manage users and client
   organizations, and control which users see which design version.
3. **App Control.** Manage the app's real content and records, compose and
   toggle features per client organization, and configure per-client settings.

The dashboard has seven tabs. The first five are the core request. The last two
carry app control, which is too much surface to bury inside Overview.

| Tab | Purpose |
|---|---|
| Overview | Admin home: health, activity, quick actions |
| Design Studio | Build and edit an app design |
| Design Library | Browse, compare, duplicate, archive every design ever built |
| Assignments | Bind a design version to an organization or user |
| Paths | See each user's route, assigned design, and real journey through screens |
| App Data | Create, edit and delete the actual records the app serves |
| Features | Compose features, toggle them per client, configure settings and rules |

**Non-negotiables**

- The existing mobile app is never rebuilt. It gains a renderer and keeps
  working.
- No design change ever requires a redeploy of the mobile app.
- A bad design must never brick the app. Fallbacks are mandatory.
- Desktop-first dashboard, minimum 1280px, optimized for 1440px and 1920px.
- Visual quality bar: the calibre of Linear, Figma and Vercel. Dense,
  restrained, fast. No stock admin-template look. No purple gradient hero.
  Simple on the surface, deep underneath.

---

## 1. PHASE 0: AUDIT BEFORE YOU WRITE ANY CODE

Do not assume the stack. Inspect the existing repository and database, then
produce a written report and wait for my approval.

Report must cover:

1. **Stack.** Framework, language, build tool, hosting, package manager.
2. **Auth.** Provider, session model, token format, where users are stored,
   whether self-signup exists today.
3. **Database.** Engine, schema, existing user and tenant tables, whether
   row-level security is available and in use.
4. **Screen inventory.** Every screen and route in the app today, with its file
   path.
5. **Component inventory.** Every reusable UI component, its props, and whether
   props are typed. This becomes the seed of the component registry.
6. **Theme.** How colour, typography and spacing are currently defined
   (CSS variables, Tailwind config, styled-components theme, hard-coded).
7. **Data sources.** Every API endpoint or query a screen currently consumes.
8. **Risk list.** Anything in the current code that blocks server-driven
   rendering, for example components with side effects at import time,
   hard-coded navigation, or logic embedded in JSX.

Then propose:

- Which screens become server-driven in v1 and which stay static.
- A migration order, safest screen first.

**Stop here. Wait for approval before Phase 1.**

---

## 2. ARCHITECTURE: SERVER-DRIVEN UI

All designs live on the server. A user is linked to a design. The app fetches
its layout at runtime and renders it. This is the correct pattern for what we
need and it is what the rest of this document assumes.

```
┌─────────────────┐   saves JSON    ┌──────────────┐   serves JSON   ┌───────────────┐
│  Design Studio  │ ──────────────► │   Database   │ ──────────────► │  Mobile app   │
│   (dashboard)   │                 │  + Layout    │                 │  + Renderer   │
└─────────────────┘                 │     API      │                 └───────────────┘
        │                           └──────────────┘                          │
        │                                   ▲                                 │
        └───────────── same component registry ───────────────────────────────┘
```

**The single most important rule:** the dashboard editor and the mobile app
renderer read from **one shared component registry**. Publish it as an internal
package, for example `@app/ui-registry`. The editor never invents a component
the app cannot render, and the app never renders a component the editor cannot
configure. Every drift bug in this kind of system comes from breaking this rule.

### Why not generate code and redeploy

Code generation means every design change is a build and a deploy, per-user
variants become impossible without feature flags, and rollback takes minutes
instead of one second. Keep a **code export as a later, one-way escape hatch**
only, not as the delivery mechanism.

### Recommended libraries (verify current versions at build time)

- **Dashboard:** React 19 + TypeScript + Vite, or Next.js App Router if SSR is
  wanted. Tailwind CSS v4. shadcn/ui as the primitive layer only, restyled to
  our own tokens so it does not look like default shadcn.
- **Drag and drop:** `@dnd-kit/core` plus `@dnd-kit/sortable`. It is the
  current React standard, roughly 6KB core, with real keyboard accessibility.
  `react-beautiful-dnd` is deprecated. Consider
  `@atlaskit/pragmatic-drag-and-drop` only if profiling shows dnd-kit is too
  slow on very large trees.
- **Editor foundation:** evaluate **Puck** (MIT, React-first, drag-and-drop
  visual editor that outputs JSON and renders from JSON). It matches this
  architecture almost exactly and can save months. If Puck's data model cannot
  express our bindings and multi-tenancy, build the canvas on dnd-kit instead
  and keep the same JSON shape. Report your recommendation with reasoning
  before committing.
- **State:** Zustand for editor state, TanStack Query for server state.
- **Validation:** Zod schemas shared between dashboard, API and renderer.
- **Undo/redo:** an immutable command stack over the layout tree, using Immer
  patches. Target 100 steps.
- **Tables:** TanStack Table with virtualization for user and path lists.
- **Charts:** Recharts, restyled, no default palettes.

---

## 3. DATA MODEL

Postgres shown. Adapt names to the existing schema found in Phase 0. Do not
duplicate a users table that already exists; extend it.

```sql
-- Tenancy ------------------------------------------------------------------
create table organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  status        text not null default 'active',   -- active | suspended
  created_at    timestamptz not null default now()
);

-- Users --------------------------------------------------------------------
create table app_users (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid references organizations(id) on delete restrict,
  email                 text not null unique,
  full_name             text,
  role                  text not null default 'app_user',
    -- super_admin | org_admin | designer | viewer | app_user
  status                text not null default 'invited',
    -- invited | active | suspended | deleted
  password_hash         text,
  must_change_password  boolean not null default true,
  last_login_at         timestamptz,
  created_by            uuid references app_users(id),
  created_at            timestamptz not null default now()
);

-- Designs ------------------------------------------------------------------
create table designs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  name            text not null,
  description     text,
  thumbnail_url   text,
  status          text not null default 'draft', -- draft | published | archived
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Immutable snapshots. A published version is never edited in place.
create table design_versions (
  id              uuid primary key default gen_random_uuid(),
  design_id       uuid not null references designs(id) on delete cascade,
  version_number  integer not null,
  label           text,                    -- "v3 - bigger CTA"
  schema_version  integer not null default 1,
  document        jsonb not null,          -- the full layout tree, see §4
  theme           jsonb not null,          -- design tokens
  status          text not null default 'draft', -- draft | published | rolled_back
  published_at    timestamptz,
  published_by    uuid references app_users(id),
  created_at      timestamptz not null default now(),
  unique (design_id, version_number)
);

-- Routes (the "path" of a screen) -----------------------------------------
create table routes (
  id                 uuid primary key default gen_random_uuid(),
  design_version_id  uuid not null references design_versions(id) on delete cascade,
  path               text not null,        -- "/home", "/profile/:id"
  screen_node_id     text not null,        -- node id inside document
  is_entry           boolean not null default false,
  requires_role      text,
  unique (design_version_id, path)
);

-- Assignments: who sees what ----------------------------------------------
create table design_assignments (
  id                 uuid primary key default gen_random_uuid(),
  design_version_id  uuid not null references design_versions(id),
  scope              text not null,        -- organization | user
  organization_id    uuid references organizations(id),
  user_id            uuid references app_users(id),
  priority           integer not null default 0,  -- higher wins
  starts_at          timestamptz,
  ends_at            timestamptz,
  created_by         uuid references app_users(id),
  created_at         timestamptz not null default now(),
  check ((scope = 'organization' and organization_id is not null)
      or (scope = 'user' and user_id is not null))
);

-- Journey tracking ---------------------------------------------------------
create table path_events (
  id                 bigserial primary key,
  user_id            uuid not null references app_users(id),
  design_version_id  uuid references design_versions(id),
  route_path         text not null,
  event              text not null,        -- view | action | error
  node_id            text,
  metadata           jsonb,
  occurred_at        timestamptz not null default now()
);
create index on path_events (user_id, occurred_at desc);
create index on path_events (design_version_id, occurred_at desc);

-- Audit --------------------------------------------------------------------
create table audit_log (
  id           bigserial primary key,
  actor_id     uuid references app_users(id),
  action       text not null,     -- design.publish, user.delete, assignment.create
  entity_type  text not null,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  ip           inet,
  occurred_at  timestamptz not null default now()
);

-- Features -----------------------------------------------------------------
create table features (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,             -- "rewards", "messaging"
  name            text not null,
  description     text,
  icon            text,
  origin          text not null default 'composed', -- code | composed
  status          text not null default 'draft',    -- draft | published | deprecated
  manifest        jsonb not null,                   -- see §15
  depends_on      text[] not null default '{}',     -- other feature keys
  settings_schema jsonb,                            -- per-org configurable options
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now()
);

create table feature_assignments (
  id              uuid primary key default gen_random_uuid(),
  feature_id      uuid not null references features(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  enabled         boolean not null default false,
  settings        jsonb not null default '{}',
  updated_by      uuid references app_users(id),
  updated_at      timestamptz not null default now(),
  unique (feature_id, organization_id)
);

-- Collections created from the dashboard -----------------------------------
create table collections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  feature_id      uuid references features(id) on delete set null,
  key             text not null,
  name            text not null,
  field_schema    jsonb not null,   -- ordered field definitions
  permissions     jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  unique (organization_id, key)
);

create table records (
  id              uuid primary key default gen_random_uuid(),
  collection_id   uuid not null references collections(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  data            jsonb not null,
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index on records (collection_id, organization_id) where deleted_at is null;
create index on records using gin (data jsonb_path_ops);

-- Adapters for data that already lives in real tables ----------------------
create table entity_configs (
  id            uuid primary key default gen_random_uuid(),
  table_name    text not null unique,
  display_name  text not null,
  field_config  jsonb not null,   -- labels, control types, visibility, validation
  permissions   jsonb not null default '{}',
  tenant_column text              -- column used to scope rows by organization
);

-- Per-organization app settings --------------------------------------------
create table org_settings (
  organization_id uuid primary key references organizations(id) on delete cascade,
  settings        jsonb not null default '{}',
  secrets         jsonb,          -- encrypted at rest, never returned to a client
  updated_at      timestamptz not null default now()
);

-- Rules --------------------------------------------------------------------
create table rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  name            text not null,
  trigger         jsonb not null,               -- { type, collectionKey?, event? }
  conditions      jsonb not null default '[]',
  actions         jsonb not null,               -- ordered list
  enabled         boolean not null default false,
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now()
);

create table rule_runs (
  id           bigserial primary key,
  rule_id      uuid not null references rules(id) on delete cascade,
  status       text not null,   -- success | failed | skipped
  input        jsonb,
  output       jsonb,
  error        text,
  duration_ms  integer,
  occurred_at  timestamptz not null default now()
);
```

**Resolution rule.** When the app asks "what layout do I render for user X",
resolve in this order and return the first hit:

1. Active user-scope assignment, highest priority.
2. Active organization-scope assignment, highest priority.
3. The organization's default published design.
4. The global fallback design.
5. The app's built-in static layout.

The same endpoint also returns the user's **enabled feature keys** and their
organization's **settings**. Layout, features and settings resolve together in
one round trip, so the app never renders a screen belonging to a feature the
client has switched off. If a layout references a disabled feature's screen,
that screen is stripped from the response and any nav entry pointing at it is
removed. Never leave a dead link in the app.

Enable row-level security on every tenant table so an org admin can never read
another org's rows. `records`, `collections`, `feature_assignments`,
`org_settings` and `rules` are all tenant-scoped and all need policies.

---

## 4. LAYOUT DOCUMENT SCHEMA

One design version is one JSON document containing all screens.

```jsonc
{
  "schemaVersion": 1,
  "designId": "uuid",
  "versionNumber": 3,
  "screens": [
    {
      "id": "scr_home",
      "name": "Home",
      "route": "/home",
      "isEntry": true,
      "root": {
        "id": "n_1",
        "type": "Stack",
        "props": {
          "direction": "vertical",
          "gap": 16,
          "padding": { "top": 24, "right": 16, "bottom": 24, "left": 16 },
          "background": "{{theme.colors.surface}}"
        },
        "children": [
          {
            "id": "n_2",
            "type": "Header",
            "props": {
              "title": { "$bind": "user.firstName", "fallback": "Welcome" },
              "showAvatar": true
            }
          },
          {
            "id": "n_3",
            "type": "Button",
            "props": {
              "label": "Start",
              "variant": "primary",
              "size": { "width": "fill", "height": 48 }
            },
            "actions": {
              "onPress": { "type": "navigate", "to": "/explore" }
            },
            "visibleIf": { "$expr": "user.role != 'guest'" }
          }
        ]
      }
    }
  ]
}
```

### Rules the renderer enforces

- Every node has a stable `id`. Never renumber ids on edit, or analytics and
  A/B history break.
- `type` must exist in the registry. Unknown type renders nothing and logs a
  warning. It must never throw.
- `schemaVersion` mismatch means fall back to the last known good layout.
- Depth cap of 20. Node cap of 500 per screen. Reject on publish, not at
  runtime.

### Component registry

The shared contract. One file, consumed by both sides.

```ts
export const registry = {
  Button: {
    label: "Button",
    category: "Actions",
    icon: "mouse-pointer-click",
    props: z.object({
      label: z.string().default("Button"),
      variant: z.enum(["primary", "secondary", "ghost", "danger"]).default("primary"),
      size: sizeSchema,
      icon: z.string().optional(),
      disabled: z.boolean().default(false),
    }),
    // How the inspector renders each prop
    fields: {
      label:   { control: "text", bindable: true },
      variant: { control: "segmented" },
      size:    { control: "size" },
      icon:    { control: "icon-picker" },
    },
    acceptsChildren: false,
    resizable: { width: true, height: true, minHeight: 32, maxHeight: 96 },
    render: ButtonComponent,
  },
  // Stack, Grid, Card, Text, Image, List, Input, Tabs, Modal, Map, Spacer, Divider...
} satisfies Registry;
```

Seed the registry from the Phase 0 component inventory. Every existing app
component gets an entry so the editor shows real app elements, not generic
placeholder blocks.

---

## 5. BINDINGS, ACTIONS AND LOGIC

This is the "data and logic binding" layer. Keep it declarative and sandboxed.
Never evaluate arbitrary JavaScript from the database.

**Bindings.** Any prop can be a literal or a binding object:

```json
{ "$bind": "order.total", "format": "currency", "fallback": "0.00" }
```

Available scopes: `user`, `org`, `route.params`, `query.<sourceId>`, `state`,
`theme`.

**Data sources.** Registered server-side, never free-form URLs from the
document. A source declares id, endpoint, method, parameter schema, cache TTL
and required role. The editor shows a picker of registered sources with a live
sample response so the user can click a field to bind it.

**Conditions.** `visibleIf` / `disabledIf` take a restricted expression
evaluated by a safe interpreter supporting only comparison, logical operators
and dot paths. No function calls, no property access on prototypes.

**Actions.** A closed set of action types:

```
navigate | goBack | openModal | closeModal | callSource |
submitForm | setState | copyToClipboard | openUrl | signOut
```

Actions may be chained as an array and may include an `onSuccess` /
`onError` branch. Anything outside this set requires a code change to the app,
which is the correct boundary.

---

## 6. API CONTRACT

```
# Runtime (consumed by the mobile app)
GET  /api/v1/layout/resolve
       -> { designVersionId, schemaVersion, screens, theme, etag }
       Auth: app user token. Runs the §3 resolution rule.
       Caching: strong ETag, stale-while-revalidate 60s.
POST /api/v1/telemetry/path        # batched path_events

# Designs
GET    /api/v1/designs                        ?org=&status=&q=
POST   /api/v1/designs
GET    /api/v1/designs/:id
GET    /api/v1/designs/:id/versions
POST   /api/v1/designs/:id/versions           # new draft, optionally forked
PATCH  /api/v1/versions/:vid                  # autosave draft document
POST   /api/v1/versions/:vid/validate         # returns errors + warnings
POST   /api/v1/versions/:vid/publish
POST   /api/v1/versions/:vid/rollback
GET    /api/v1/versions/:vid/preview-token    # short-lived token for preview
GET    /api/v1/versions/:a/diff/:b            # structural diff for compare view

# Admin
GET/POST/PATCH/DELETE  /api/v1/users
POST   /api/v1/users/:id/invite
POST   /api/v1/users/:id/reset-password
GET/POST/PATCH         /api/v1/organizations
GET/POST/DELETE        /api/v1/assignments
GET    /api/v1/paths/users/:id                # resolved route map + journey
GET    /api/v1/paths/matrix                   # who uses which design
GET    /api/v1/audit

# App data
GET    /api/v1/entities                       # every manageable entity + config
GET    /api/v1/entities/:key/schema
GET    /api/v1/entities/:key/records          ?q=&filter=&sort=&cursor=
POST   /api/v1/entities/:key/records
PATCH  /api/v1/entities/:key/records/:rid
DELETE /api/v1/entities/:key/records/:rid     # soft delete
POST   /api/v1/entities/:key/records/bulk     # bulk edit or delete
POST   /api/v1/entities/:key/import           # CSV, returns a dry-run preview
GET    /api/v1/entities/:key/export
GET/POST/PATCH/DELETE  /api/v1/collections    # dashboard-defined collections

# Features and settings
GET/POST/PATCH         /api/v1/features
POST   /api/v1/features/:id/publish
GET    /api/v1/features/matrix                # feature x organization grid
PUT    /api/v1/features/:id/orgs/:orgId       # toggle + per-org settings
GET/PUT                /api/v1/organizations/:id/settings

# Rules
GET/POST/PATCH/DELETE  /api/v1/rules
POST   /api/v1/rules/:id/test                 # dry run against sample input
GET    /api/v1/rules/:id/runs                 # run log
```

Every mutating endpoint writes to `audit_log`. Every list endpoint is
cursor-paginated and filterable. Rate-limit auth endpoints.

---

## 7. CHANGES TO THE EXISTING MOBILE APP

Keep this small and surgical.

1. Add `<LayoutRenderer />`, a recursive component that walks the document and
   maps `type` to the registry's `render`.
2. Add a layout provider that fetches `/layout/resolve` on boot, caches the
   result in localStorage or IndexedDB, and serves the cached copy instantly on
   next launch while revalidating in the background.
3. Wrap the renderer in an error boundary per screen. A crash falls back to the
   last known good layout, then to the static build-time layout.
4. Add a preview mode: when the app loads with `?preview=<token>`, it renders
   the draft version instead of the assigned one and disables telemetry. This
   is what the Design Studio iframe uses.
5. Emit `path_events` on route change and on tracked actions, batched.
6. Theme is applied by writing design tokens to CSS custom properties on the
   root element, so every component restyles without prop drilling.

---

## 8. DASHBOARD DESIGN LANGUAGE

Build a real design system before building screens. Tokens first.

**Surfaces.** Dark by default with a proper light mode. Near-black base
(`#0A0A0B`), raised panels one step lighter (`#141416`), hairline borders at
about 8 percent white. Depth comes from borders and one soft shadow, never from
heavy drop shadows.

**Accent.** Exactly one accent colour, used only for primary action, active
state and selection. Everything else is greyscale. Semantic colours for
success, warning, danger only where they carry meaning.

**Type.** Inter or Geist. Sizes 11, 12, 13, 14, 16, 20, 28. Body is 13px.
Tabular numerals for every table column. Never centre body text.

**Space.** 4px base grid. Panel padding 16. Section gap 24.

**Radius.** 6px controls, 10px panels, 999px pills. Consistent, never mixed.

**Motion.** 120 to 180ms, `cubic-bezier(0.2, 0, 0, 1)`. Animate transform and
opacity only. No bounce. Respect `prefers-reduced-motion`.

**Density.** This is a professional tool. 32px row height, 28px controls.
Ship a comfortable and a compact density toggle.

**Required interaction quality**

- Command palette on `Cmd/Ctrl+K` covering every action in the product.
- Keyboard shortcuts on everything meaningful, discoverable via `?`.
- Optimistic updates with rollback on failure.
- Skeleton loaders, never spinners, for anything over 200ms.
- Empty states with one clear action, not a shrug illustration.
- Toasts that stack, auto-dismiss, and offer undo where the action is undoable.
- Full keyboard navigation and visible focus rings. WCAG 2.1 AA contrast.

**Shell.** Slim left icon rail with the five tabs, a global org switcher and
search in the top bar, avatar menu bottom-left. The rail collapses to icons
only. Breadcrumbs inside each tab.

---

## 9. TAB 1: OVERVIEW

The admin home. Scannable in five seconds.

- KPI strip: total users, active users in the last 7 days, organizations,
  published designs, drafts awaiting publish, errors in the last 24 hours.
- Activity feed from `audit_log` with actor avatar, plain-language sentence and
  relative time. Click through to the entity.
- Health panel: layout API p95 latency, cache hit rate, renderer error rate,
  most recent failed publish.
- Quick actions: new user, new design, new assignment.
- Adoption chart: unique users per design version over the last 30 days.

---

## 10. TAB 2: DESIGN STUDIO

The core of the product. Three-region layout.

```
┌────────────────────────────────────────────────────────────────────────┐
│ toolbar: design name · version pill · device · zoom · undo/redo · save │
├──────────────────────────────────────────────┬─────────────────────────┤
│                                              │  RIGHT PANEL (tabbed)   │
│              LIVE MOBILE PREVIEW             │                         │
│         real app in an iframe, in a          │  Insert · Layers ·      │
│         device frame, fully interactive      │  Style · Data · Screen  │
│                                              │                         │
│      [ 390×844 ]  [ 430×932 ]  [ custom ]    │  (contextual to the     │
│                                              │   selected node)        │
└──────────────────────────────────────────────┴─────────────────────────┘
```

### Left: live preview canvas

- The **real app** in a sandboxed iframe running preview mode, not a mock. This
  is the difference between a toy and a tool.
- Device frames: iPhone 15/16 sizes, a small Android size, a tablet size, plus
  custom width and height. Rotate. Zoom 25 to 200 percent, fit-to-screen,
  `Cmd+0` to reset.
- Hovering a node outlines it and shows a name badge. Clicking selects it and
  syncs the right panel and the layer tree.
- Selected node shows resize handles on all eight points. Drag to resize with
  live pixel and percentage readout. Hold Shift to preserve ratio. Respect the
  registry's min and max constraints.
- Drag a node to move it. Show a clear insertion line, highlight the drop
  parent, and auto-scroll near edges. Invalid drops are visibly rejected, never
  silently dropped.
- Alignment and distribution guides with snapping to siblings, parent edges and
  the 4px grid. Hold Alt to see spacing measurements to neighbours, Figma-style.
- Multi-select with Shift and marquee. Group, ungroup, align, distribute.
- Right-click context menu: duplicate, delete, wrap in container, copy style,
  paste style, save as reusable block, move to screen.
- Communication between dashboard and iframe is `postMessage` only, with a
  typed message protocol and origin checks.

### Right: tabbed inspector

**Insert.** Searchable component palette grouped by category, showing the real
app components from the registry with thumbnails. Also holds saved reusable
blocks and full screen templates. Drag from here onto the canvas.

**Layers.** The node tree. Drag to reorder and reparent. Rename, lock, hide,
solo. Keyboard navigable. Search filters the tree.

**Style.** Contextual to the selection, driven by the registry `fields` map:

- Layout: direction, align, justify, gap, wrap, grid columns.
- Size: width and height as fixed, fill, hug, or percentage, with min and max.
- Spacing: padding and margin with a visual box control and linked-sides toggle.
- Position: static, absolute, sticky, with offsets and z-index.
- Appearance: background, border, radius per corner, shadow, opacity, blur.
- Typography: family, size, weight, line height, letter spacing, align,
  transform, truncation.
- Icons: searchable icon picker over one icon set (Lucide or Phosphor), with
  size and colour.
- Every value can be a raw value or a **token**. Show a token badge when bound.
  Editing the token updates everywhere it is used.
- **Responsive overrides** per breakpoint. Show clearly which breakpoint you are
  editing and which values are inherited versus overridden.
- **States**: default, hover, pressed, disabled, and any custom states the
  component declares.

**Data.** Bind props to sources. Pick a registered source, see a live sample
response tree, click a field to bind it. Show a format dropdown and a fallback
field. Below that, the actions editor: pick a trigger, pick an action type,
fill its typed parameters, chain more actions. Below that, conditional
visibility with a guided condition builder, not a raw text box.

**Screen.** Route path, entry-screen flag, required role, page title, meta,
scroll behaviour, safe-area handling, background, and the screen's transition.

### Theme editor

A dedicated modal or side sheet, reachable from the toolbar. Edit the whole
token set: colour ramps with contrast checking, typography scale, spacing
scale, radius scale, shadow scale, icon set, and named semantic aliases. Show a
live component gallery that updates as you edit so the effect of a token change
is visible immediately. Support importing a palette and generating ramps.

### Editing behaviour

- Autosave the draft every 2 seconds after a change, debounced. Show a subtle
  "Saved" state with the timestamp. Never a blocking save dialog.
- Undo and redo, 100 steps, `Cmd+Z` and `Cmd+Shift+Z`, working across every
  panel including style changes.
- Version pill in the toolbar opens version history with a visual diff and a
  restore button.
- `Publish` opens a confirmation panel showing validation results, a
  before-and-after thumbnail, the assignment impact ("this will change the app
  for 412 users across 3 organizations"), and an optional version label.
- Validation blocks publish on: unknown component types, unresolved required
  bindings, missing route on an entry screen, duplicate routes, node or depth
  cap exceeded, contrast failures on text tokens.

---

## 11. TAB 3: DESIGN LIBRARY

Every design ever built, browsable.

- Grid and list toggle. Cards show a real rendered thumbnail (generate on
  publish with a headless browser screenshot of the entry screen), name,
  organization, status pill, version number, last edited by and when, and the
  count of users currently assigned.
- Filters: organization, status, created by, date range, assigned or unassigned.
  Sort by recent, name, adoption.
- Search across design name, description and version labels.
- Row actions: open in studio, duplicate, duplicate to another organization,
  rename, archive, delete (soft, with confirm-by-typing-the-name for published
  designs that have assignments).
- **Compare view.** Select two versions and see them side by side: rendered
  previews on top, structural diff below, listing added, removed, moved and
  restyled nodes. This is what makes review real rather than decorative.
- Version timeline per design showing publishes, rollbacks and who did them.

---

## 12. TAB 4: ASSIGNMENTS

Bind designs to audiences. This tab must make the current state unmistakable.

- **Matrix view.** Organizations down the rows, designs across the columns,
  cell shows the assigned version. Click a cell to change it. Users with a
  personal override show a small badge on their org row.
- **Assignment list.** Every rule with scope, target, design version, priority,
  active window and who created it. Inline enable and disable.
- **Create flow.** Choose scope (organization or user), choose target with a
  searchable picker, choose design and version, set priority, optionally set a
  start and end date. Before saving, show a **resolution preview**: "After this
  change, 412 users will see v7, 12 users keep their personal override." List
  those users.
- **Conflict detection.** If two rules could both apply, show which wins and
  why, and offer to fix the priority.
- Bulk assign from a filtered user selection.
- One-click rollback of an assignment to its previous value, with the audit
  entry linked.

---

## 13. TAB 5: PATHS

Per-user visibility into route, assigned design, and real journey.

**User list** with columns: name, email, organization, role, status, resolved
design version, entry route, last seen, session count. Filter and sort on
everything. Click a row to open the detail panel.

**User detail panel**, three sections:

1. **Resolved path.** The exact route the user lands on, which assignment rule
   produced their design version, and the full rule chain that was evaluated,
   shown as a trace. This answers "why is this user seeing this" in one glance.
2. **Route map.** Every route available to that user in their assigned design,
   as a node graph: screen name, path, required role, reachable or blocked, and
   the navigation edges between screens. Highlight orphan screens with no
   inbound route and dead-end screens with no outbound action.
3. **Journey.** Their actual session history from `path_events`, as a timeline:
   screens visited in order, time on each, actions fired, errors hit. Aggregate
   view above it shows the most common paths through the app as a Sankey-style
   flow, with drop-off percentage at each step.

Add an **Impersonate preview** action: open the app in preview mode exactly as
that user would see it, read-only, watermarked, and audit-logged.

Export any view to CSV.

---

## 14. TAB 6: APP DATA

Full create, edit and delete over the records the app actually serves.

### Two backends, one interface

The app's data lives in two places and the tab must present both identically:

1. **Native tables** that already exist in the app. Managed through
   `entity_configs`, which maps a real table to a display name, field labels,
   control types, validation and permissions. Nothing about the existing schema
   changes.
2. **Dashboard-created collections**, stored as `collections` plus JSONB
   `records`. This is what lets an admin invent a new data type without a
   database migration.

**Why the hybrid.** Auto-generating migrations from a dashboard is how you end
up with an unrecoverable production schema. JSONB records give the flexibility
where flexibility is needed, real tables keep the performance and constraints
where the app's core data lives. Do not unify them into one storage model.

### Field types

Text, long text, rich text, number, currency, percent, boolean, date, datetime,
select, multi-select, relation (to another collection or entity), file, image,
colour, JSON, computed (read-only, server-evaluated). Each carries required,
unique, default, min, max, pattern and help text.

### UI spec

- **Left rail:** entity and collection list, grouped by feature, searchable.
  A `New collection` action opens the schema builder.
- **Table view:** virtualized, resizable and reorderable columns, sticky header,
  column visibility menu, sort, and a filter builder supporting AND and OR
  groups. Row height follows the global density setting.
- **Saved views** per entity, shareable within the organization, with their own
  filters, sort and visible columns.
- **Inline editing** on the cell for simple types, with optimistic save and a
  clear error state on rejection. Escape reverts.
- **Detail drawer** slides in from the right for the full record: all fields,
  related records, file previews, created and updated metadata, and a per-record
  audit trail showing who changed what and when.
- **Bulk actions:** multi-select via checkbox or shift-click, then bulk edit a
  field, bulk delete, or bulk export. Always show a confirmation with the exact
  count and require typing the count for destructive bulk actions over 50 rows.
- **Import:** CSV upload with column mapping, a dry-run preview showing the rows
  that will be created, updated and rejected with reasons, and commit only after
  review. Never commit a partial import silently.
- **Soft delete** with a Trash view and 30-day restore.
- **Relations** use a searchable picker showing the related record's title
  field, not a raw UUID.

### Schema builder

For dashboard-created collections: name the collection, add fields, drag to
reorder, set type and validation per field, choose the title field, choose which
roles can read, create, update and delete. Changing a field type on a collection
with existing data shows a migration preview and blocks unsafe conversions.

Publishing a collection makes it available as a data source in the Design Studio
automatically. That link is the point of the whole system.

---

## 15. TAB 7: FEATURES

A feature is a bundle: screens, routes, a data collection, permissions, a nav
entry and settings, switched on or off per client organization.

### Be honest about the boundary

Two kinds of feature exist and the dashboard must label which is which:

- **Composed features** are assembled in the dashboard from things that already
  exist: screens built in the Design Studio, collections built in App Data,
  registered components, registered data sources and the action set. An admin
  can create these end to end with no developer. This covers most of what people
  mean by "add a new feature": a new section with its own screens, its own data,
  its own place in the nav, and its own permissions.
- **Code features** need a new capability that does not exist yet, for example a
  new component type, a payment provider, camera access or an offline sync
  engine. These are declared in the repository, registered into the `features`
  table on deploy, and then appear in this tab as toggleable like any other. The
  dashboard cannot conjure these, and the UI should say so plainly rather than
  letting someone build a feature that silently cannot work.

Make this visible: the feature builder shows a live "Buildable here" checklist,
and if a step needs something that does not exist yet, it produces a short,
copyable developer request instead of a dead end.

### Feature manifest

```jsonc
{
  "key": "rewards",
  "name": "Rewards",
  "icon": "gift",
  "version": 2,
  "screens": ["scr_rewards_home", "scr_reward_detail"],
  "routes": [
    { "path": "/rewards", "screen": "scr_rewards_home", "isEntry": false },
    { "path": "/rewards/:id", "screen": "scr_reward_detail" }
  ],
  "collections": ["rewards", "redemptions"],
  "navigation": [
    { "label": "Rewards", "icon": "gift", "route": "/rewards", "position": 3 }
  ],
  "permissions": { "view": ["app_user"], "manage": ["org_admin"] },
  "dependsOn": ["accounts"],
  "settingsSchema": {
    "pointsPerDollar": { "type": "number", "default": 1, "min": 0 },
    "expiryDays":      { "type": "number", "default": 365 },
    "showLeaderboard": { "type": "boolean", "default": false }
  }
}
```

### Feature builder

A guided flow, not a blank canvas:

1. Name, icon, description.
2. Screens: pick existing screens or create new ones, which opens the Design
   Studio in a feature context and returns here on save.
3. Data: pick existing collections or create a new one inline.
4. Navigation: where it appears, label, icon, position, and which roles see it.
5. Permissions: who can view, who can manage.
6. Settings: define the options each client can configure, with types and
   defaults. These render automatically as a form on the toggle screen.
7. Dependencies: which other features must be on.
8. Review, then save as draft and publish.

Features version and publish exactly like designs: draft, validate, publish,
rollback. Never edit a published feature in place.

### Toggle matrix

Organizations down the rows, features across the columns, a switch in each cell.

- Turning a feature on shows an impact preview: user count affected, screens
  that become reachable, collections that become writable.
- Turning a feature off checks dependants first and refuses with a clear reason
  if another enabled feature depends on it.
- Per-organization settings open in a side panel generated from
  `settingsSchema`, so adding a setting never requires new dashboard code.
- Bulk enable across a filtered set of organizations.
- Every toggle writes to `audit_log` and takes effect on the next app fetch.

### Per-client settings

Beyond feature settings, a global settings panel per organization: app display
name, logo, icon, splash, default theme, contact and support details, legal
URLs, locale and timezone, quotas and limits, notification channels, and
integration credentials. Credentials write to `org_settings.secrets`, encrypted
at rest, write-only from the UI, and never returned in any API response.

---

## 16. RULES: SIMPLE AUTOMATIONS

You were unsure about this, so here is my recommendation: **build the simple
rules engine in v1, skip the visual workflow builder.** A trigger, a condition
and a short list of actions covers most of what people actually want, costs
about a week, and does not require anyone to learn a flowchart tool. If it turns
out you need branching and loops later, the data model below already supports
adding them. Build it behind a feature flag so it can stay hidden until you want
it.

**Shape:** `when [trigger] and [conditions] then [actions in order]`.

| Triggers | Actions |
|---|---|
| record created | send email |
| record updated (optionally on a specific field) | send push notification |
| record deleted | create a record |
| user created | update a record |
| user first login | call a webhook |
| form submitted | toggle a feature for the org |
| threshold crossed (count or sum on a collection) | notify an admin in-app |
| schedule (daily, weekly, monthly at a time) | add a tag or set a field |

Conditions reuse the same restricted expression evaluator as `visibleIf` in §5.
No arbitrary code, ever.

**UI:** a plain-language builder that reads as a sentence, with dropdowns rather
than a canvas. Show a `Test rule` button that runs against a real sample record
and displays exactly what would happen without committing it.

**Safety:** per-rule execution timeout, a cap on runs per hour per organization,
loop detection so a rule cannot trigger itself, retries with exponential backoff
on webhook failure, and a run log with input, output and error visible in the
UI. A rule that fails five times in a row auto-disables and notifies the admin.

---

## 17. USERS, AUTH AND PERMISSIONS

**No self-signup for the mobile app.** Admins create accounts.

Creation flow: enter email, name, organization, role. Choose either send an
invite email with a single-use link valid 72 hours, or set a temporary password
shown once and copyable. `must_change_password` defaults true. Support bulk CSV
import with a validation preview before commit.

Management: edit profile and role, suspend and reactivate, force password
reset, revoke all sessions, soft delete with a 30-day restore window, hard
delete for compliance requests.

**Roles**

| Role | Can |
|---|---|
| super_admin | Everything, across all organizations |
| org_admin | Manage users, assignments and designs within their org |
| designer | Create and edit designs, cannot publish or manage users |
| viewer | Read-only across the dashboard |
| app_user | Mobile app only, no dashboard access |

Enforce permissions on the server, on every endpoint, via row-level security.
Client-side checks are for hiding buttons only and are never the boundary.

**Security requirements:** Argon2id password hashing, short-lived access tokens
with refresh rotation, mandatory 2FA for super_admin, session list with remote
revoke, rate limiting and lockout on repeated failures, secure and httpOnly
cookies, CSP on the dashboard, strict origin checks on the preview iframe
`postMessage` channel, and full audit logging of every admin action.

---

## 18. PUBLISHING PIPELINE

```
Draft  ──validate──►  Preview  ──publish──►  Live  ──rollback──►  Previous live
  ▲                                            │
  └────────────── fork to new draft ───────────┘
```

- Drafts are mutable. Published versions are immutable. Editing a published
  version forks a new draft.
- Publish is atomic: validate, snapshot, generate thumbnail, flip status, bust
  the layout cache, write audit entry.
- Rollback restores the previous published version as live in one action and
  takes effect on the next app fetch, within the cache TTL. Target under 60
  seconds end to end. Keep a `Force refresh all clients` action that pushes an
  invalidation signal for emergencies.
- Preview links are short-lived signed tokens, shareable for review without
  dashboard access.

---

## 19. BUILD ORDER AND ACCEPTANCE CRITERIA

Ship in this order. Each phase must pass its criteria before the next starts.

**Phase 0. Audit.** Report delivered and approved.

**Phase 1. Foundation.** Schema migrated, RLS on, auth working, dashboard shell
with five empty tabs, design tokens and core component library built.
*Passes when:* a super_admin logs in, sees the shell, and RLS blocks
cross-organization reads in a written test.

**Phase 2. Registry and renderer.** Component registry extracted from the real
app. `LayoutRenderer` added. One screen migrated to server-driven.
*Passes when:* changing a JSON row in the database changes that screen in the
app with no deploy, and a deliberately corrupted document falls back cleanly
instead of crashing.

**Phase 3. Admin panel.** Tabs Overview, Assignments and Paths. Full user and
organization CRUD, invites, assignments with resolution preview, path views.
*Passes when:* an admin creates a user, assigns a design, and the resolution
trace on the Paths tab correctly explains the outcome.

**Phase 4. Design Studio core.** Canvas with live preview, drag to move,
resize, layer tree, style inspector, autosave, undo and redo, draft to publish
to rollback.
*Passes when:* a non-developer rebuilds an existing screen from scratch in
under 15 minutes without touching code, publishes it, and rolls it back.

**Phase 5. Data and logic.** Bindings, registered sources, actions,
conditional visibility, theme editor, responsive overrides and states.
*Passes when:* a screen bound to live data renders correctly for two different
users with different data, and a navigation action works end to end.

**Phase 6. App Data.** Entity configs over native tables, the collection schema
builder, the record table with filtering and inline edit, detail drawer, bulk
actions, CSV import with dry run, soft delete and restore.
*Passes when:* an admin creates a new collection, adds records, and those
records appear as a bindable data source in the Design Studio without any code
change.

**Phase 7. Features.** Feature manifest, feature builder, publish and rollback,
the toggle matrix with dependency and impact checks, per-organization settings,
and feature-aware layout resolution.
*Passes when:* switching a feature off for one organization removes its screens
and nav entries for that organization's users only, and leaves every other
organization untouched.

**Phase 8. Rules.** Trigger, condition and action builder, test runs, run log,
retries and auto-disable.
*Passes when:* a rule fires on a real record change, the action completes, and
the run log shows the input and output. Then break the webhook deliberately and
confirm the rule retries and auto-disables.

**Phase 9. Library and polish.** Compare view, thumbnails, command palette,
shortcuts, empty states, accessibility audit, performance pass.
*Passes when:* the editor stays at 60fps dragging in a 200-node screen, the
layout API p95 is under 150ms, and an axe accessibility scan is clean at AA.

**Definition of done for every phase:** typed end to end with no `any` in
shared contracts, Zod validation at every boundary, tests on the resolution
rule and the publish pipeline, and no console errors.

---

## 20. EXPLICITLY OUT OF SCOPE FOR V1

State these so they are not silently built: A/B testing between versions,
scheduled and staged rollouts, real-time multiplayer editing, code export,
localization management, a mobile version of the dashboard itself, a plugin
API, a visual workflow builder with branching and loops, and a public API for
clients. Design the schema so each can be added later without a migration that
breaks published documents, published features or existing records.

---

## 21. HOW TO WORK WITH ME

- Deliver the Phase 0 audit first and stop.
- At the start of each later phase, show me the plan and the key interface
  decisions before writing code.
- When a decision has real trade-offs, give me two options with a
  recommendation, not a menu of five.
- Flag anything in this brief that conflicts with what you find in the actual
  codebase. This document is a specification, not a description of what exists.
