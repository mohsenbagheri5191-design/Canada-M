# The app

The thing a user opens. It has no screens of its own — it asks the database
what to render and renders that.

```sh
python3 -m http.server 8000     # from the repository root
open http://localhost:8000/app/
```

No build step, no dependencies. Native ES modules, same as the dashboard.

---

## The one idea

The dashboard and the app read **the same component registry**. Not a copy, not
a port — the same file. `app/assets/js/shared.js` is the only place the app
reaches into `dashboard/`, and everything else imports from there.

This is not tidiness. If the app had its own renderer, a component would
eventually draw one way in the studio and another on a phone, and every design
published between the divergence and someone noticing would be wrong in a way
nobody could see. One registry, two readers, no drift.

The same argument is why `private.resolve_layout` is a single database function
that both the app and the dashboard's Paths tab call. The tab claims to explain
why a user sees what they see; if it computed that separately it would
confidently describe an outcome that is not happening.

---

## Boot order

1. **Preview.** `?preview=<token>` short-circuits everything. A review link has
   to work for somebody with no account, so it cannot wait on a session check.
2. **Session.** No session, sign-in screen, nothing else.
3. **Layout,** from cache if there is one, so the first paint never waits on the
   network.
4. **Router,** over the screens the layout actually contains.
5. **Telemetry,** last, because nothing else should depend on it.

---

## Decisions worth knowing

**The layout is served from cache first, always.**

A technician opening the app in a basement sees yesterday's layout instantly,
not a spinner that resolves into an error. A layout is not data — it is the
shape of the application — so serving a stale one is correct in a way serving
stale records would not be. Revalidation happens behind the paint, and a
revalidation that returns the same version does not re-render, because that
would throw away scroll position for nothing.

The cache key includes the user id. On a shared device, signing out and in as
somebody else must not serve the previous tenant's layout.

**A theme from the wire is always merged over a complete default.**

The resolver returns whatever is stored on the design version, and that is not
guaranteed to be complete. The seeded row carries three colours. The draft used
for preview carries `{palette, style}` and no colours at all. The renderer, meanwhile,
dereferences `theme.typography.fontFamily` and asks `theme.style` for its
surfaces — so a partial theme does not degrade, it throws, and the app renders
nothing. `runtime/theme.js` fills the gaps; present keys still win.

**There is a built-in layout, and it is load-bearing.**

`resolve_layout` ends its chain with a step called *"App built-in static
layout"* and returns `screens: []`. That step is only true if the app has one.
Without `runtime/builtin.js`, a brand-new tenant — or an organisation whose only
published design was rolled back — opens the app to a blank screen, and the
resolver's last line of defence is a comment rather than a behaviour.

**The error boundary is per screen.**

The shared renderer already refuses to throw for one bad component: with
`editable: false` an unknown type renders nothing and a component that throws is
dropped. What it cannot catch is a failure above that — a malformed screen, a
root that is not a node. Those take the whole screen down, and on a phone that
is a white page with no way back. So the boundary sits in the shell, shows what
failed, and offers the two things that recover it.

A screen that renders to *nothing* is treated the same way. It is not an error,
but it is indistinguishable from one for the person holding the phone, who will
assume it is still loading.

**Telemetry never costs the user anything.**

Events queue and flush in batches; nothing blocks a navigation. The queue is
capped and drops the oldest, because a device offline for a day must not
accumulate a megabyte of screen views and recent behaviour is the part anyone
looks at. A failed flush retries once, then drops — telemetry is not worth a
retry storm.

The flush uses `fetch(..., { keepalive: true })`, not `sendBeacon`.
`sendBeacon` cannot set an `Authorization` header and PostgREST will not read a
JWT from the query string, so a beaconed insert arrives as `anon` and is refused
by the row-level policy — after putting a bearer token in a URL, where it lands
in every log along the way.

`visibilitychange` is the flush trigger, not `beforeunload`: the latter does not
fire when a mobile OS kills a backgrounded tab, so a flush that waits for it
loses the end of most sessions.

---

## Preview links

`?preview=<token>` renders one specific design version. The token is the whole
credential, so it is 32 random bytes, expires (24 hours by default, 30 days
maximum, enforced by a check constraint), and can be revoked without being
deleted.

`public.resolve_preview` is the one `SECURITY DEFINER` function in this project
that `anon` may call, and `verify.sql` names it in an allowlist so that adding a
second one fails the test until somebody decides it belongs. It returns a layout
and nothing else — no records, no tasks, no notes, and specifically not
`org_settings.secrets`. Absent, expired and revoked tokens all answer without
revealing whether the token ever existed.

Preview is read-only, says so in a banner, keeps a coloured outline around the
frame in case the banner is dismissed, and **records no telemetry**. A
stakeholder clicking through a draft twenty times is not usage, and letting it
into `path_events` corrupts the only numbers the Paths tab reports.

### Issuing one

```sql
select public.issue_preview_token('<design_version_id>', 24, 'client review');
-- → { "token": "…", "expiresAt": "…" }
```

Then `https://<host>/app/?preview=<token>`.

---

## Routing

Routes come from the layout document, so the set of reachable screens changes on
publish with no release. Which is why the router is more careful than one over a
fixed table:

- **The current route can vanish** — a publish removes a screen, or a feature is
  switched off mid-session and the resolver strips it. The user is standing on a
  path that no longer exists. It falls back to the entry screen, replacing rather
  than pushing history, and says why instead of jumping silently.
- **`requiresRole` is a display rule, not a security boundary.** It hides a
  screen; the data behind it is protected by row-level security in the database.
  Hiding is not defending, and nothing in this directory is what stops anyone
  reading anything.

---

## Configuration

`assets/js/config.js` holds the project URL and publishable key. The publishable
key authenticates nothing on its own — every table has RLS, so what a caller can
read is decided by the JWT they present. The **service role key bypasses RLS
entirely** and must never appear here or anywhere else in this repository.

A `window.__APP_CONFIG__` set before the module loads overrides any of it, so a
self-hosted tenant can point the same build at its own project without a
rebuild.

---

## Offline writes

A write that fails is not one thing. The outbox exists because the difference
matters more than the failure:

- **The server never decided** — a dropped connection, a timeout, a 5xx. The
  change stays on screen and the write is queued, because it is going to be
  sent. Taking it away and putting it back when the signal returns would be a
  worse lie than leaving it.
- **The server decided, and said no** — 401, 403, 404, 409, 422. Rolled back
  immediately. Retrying cannot change a permission, and a queue that keeps
  trying only produces the same refusal for the rest of the session.

Entries live in IndexedDB, so a phone that loses signal in a basement and gets
closed in a van delivers its work when it next sees a network. Repeated taps on
one row collapse to a single final state rather than stacking conflicting
updates.

Every request is also bounded by `requestTimeoutMs`. A server that accepts the
connection and then never answers used to leave the promise unsettled — the
write neither succeeded nor failed, the outbox never saw it, and the user
watched a change that was going nowhere.

---

## Not built yet

- **Creating and editing.** The app completes and reopens tasks and pins notes.
  It cannot yet write a new note or edit one.
- **Password reset and forced change.** `complete_password_change()` exists in
  the database and `must_change_password` is set on every invited account, but
  the app does not yet show the change screen.
- **Search.** `notes.search` is a generated tsvector and nothing queries it.
- **Push notifications.** The rules engine records `send_push` as skipped,
  honestly, because no provider is configured.
