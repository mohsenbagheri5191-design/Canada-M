# Platform

The backend for the admin dashboard and the app it drives. Live on Supabase.

| | |
|---|---|
| Project | `canada-services` |
| Ref | `sxsbeavdmfuznigslfnp` |
| Region | `ca-central-1` (Montreal) |
| URL | `https://sxsbeavdmfuznigslfnp.supabase.co` |
| Publishable key | `sb_publishable_BALtodXYHyXJ41amq26zhA_17o7gMTI` |

The publishable key is safe in client code and in this file — it authenticates
nothing on its own. Every table has row-level security, so what a caller can
read is decided by the JWT they present, not by holding this key. The **service
role key** is the opposite: it bypasses RLS entirely, so it belongs in an Edge
Function secret and must never appear in a repository or in client code.

This is a separate project from `amazon-market-research-pro`, which is a live
product on the same account. Nothing here touches it.

---

## What is live

Seven migrations, applied and verified:

| Migration | What it adds |
|---|---|
| `core_tenancy_and_users` | `organizations`, `app_users`, `org_settings`, `audit_log` |
| `designs_versions_assignments` | `designs`, `design_versions`, `routes`, `design_assignments`, `path_events` |
| `app_data_features_rules` | `features`, `feature_assignments`, `collections`, `records`, `entity_configs`, `rules`, `rule_runs` |
| `domain_projects_tasks_notes` | `projects`, `tasks`, `notes`, `customers`, `jobs` |
| `row_level_security` | RLS on all 21 tables, role helpers, per-tenant policies |
| `resolve_layout` | the resolution rule and its two callable wrappers |
| `lock_down_function_execute` | closes the default `PUBLIC` grant on every `SECURITY DEFINER` function |
| `preview_tokens` | share links for an unpublished design version, and the anon-callable resolver behind them |
| `lock_down_preview_grants` | closes the named `anon` grants Supabase adds on top of the `PUBLIC` one |

Supabase's migration history is the authoritative copy. To vendor them here:

```sh
supabase link --project-ref sxsbeavdmfuznigslfnp
supabase db pull            # writes supabase/migrations/*.sql
```

---

## The three decisions worth knowing

**1. The resolution rule is one function, in the database.**

`private.resolve_layout(user_id)` implements the whole order — user-scope
assignment by priority, then organisation-scope, then the organisation's default
published design, then the global fallback, then the app's built-in layout — and
returns both the layout *and* the trace that explains it.

Two wrappers call it, and nothing else can:

- `public.resolve_my_layout()` — what the app calls. Takes no argument, so it
  can only ever resolve the caller.
- `public.resolve_layout_as_admin(user_id)` — what the dashboard's Paths tab
  calls. Checks the caller is an admin over that user's organisation first.

`resolve_layout` itself lives in the `private` schema, which PostgREST does not
expose, so it is not an RPC endpoint at any grant level.

This matters because the dashboard's Paths tab claims to explain why a user sees
what they see. If the dashboard computed that separately from the runtime, the
two would drift and the tab would confidently describe an outcome that is not
happening. One function, two callers, no drift.

**2. A published version is immutable, enforced by a trigger.**

Rollback is a single status flip rather than a restore-from-backup only because
nothing ever edits a published document. A trigger raises on any attempt, so a
bug in an autosave path cannot quietly mutate what users are being served. A
partial unique index also guarantees at most one published version per design.

**3. Two storage models for app data, deliberately not unified.**

`collections` + `records` hold JSONB for data types an admin invents in the
dashboard — a new type needs no migration. `entity_configs` describes real
tables that already exist, so the app's core data (`projects`, `tasks`, `notes`,
`jobs`) keeps its constraints, foreign keys and query plans.

Generating migrations from a dashboard is how you end up with a production
schema nobody can recover, which is why these stay separate.

---

## Verifying it

```sh
psql "$DATABASE_URL" -f platform/supabase/tests/verify.sql
```

Wrapped in a transaction and rolled back, so it is safe against any environment.
It asserts the claims the system rests on:

- no cross-organisation row is visible to a user from another tenant
- every `public` table has RLS enabled, and every RLS table has a policy
- no `SECURITY DEFINER` function is callable by `anon`
- `resolve_layout` is not in the exposed schema
- a published version cannot be edited, and only one is live per design
- resolution returns a trace, and never serves a screen belonging to a feature
  the tenant has switched off
- a non-admin cannot resolve another tenant's user

### Results from the last run

All passing. Worth recording two of them:

```
resolve_layout(maya@northstar.ca)
  screens served : scr_home, scr_notes
  stripped       : ["scr_timesheets"]     ← feature off for this tenant
  features on    : ["notes"]
  trace          : User-scope assignment=false | Organisation-scope assignment=true
```

```
BrightRoof user, no assignment
  designVersionId : null
  final trace step: "App built-in static layout"
```

The second is the fallback chain running to the end without erroring, which is
the behaviour that stops a missing assignment becoming a blank app.

### A second finding, from building preview links

The first finding was that `revoke execute ... from anon` does nothing on its
own, because Postgres grants `EXECUTE` to `PUBLIC` and `PUBLIC` includes `anon`.

Preview links turned up the mirror image. Supabase's default privileges *also*
grant `EXECUTE` and table rights to the `anon` and `authenticated` roles **by
name**, so `revoke ... from public` on its own is equally useless — the named
grant survives it. `issue_preview_token` came out of its migration executable by
`anon` despite the revoke.

Neither was exploitable: the function checks its caller itself and refused with
`42501`, and the token table is behind RLS with no policy matching `anon`. But a
grant nobody intended is one refactor away from being the only thing that was
holding. `lock_down_preview_grants` revokes from both, and `verify.sql` now
asserts it.

The rule, stated once: **a function is only closed when it has been revoked from
`PUBLIC` *and* from `anon`.** Either alone is a no-op.

That test also changed shape. It used to assert that *no* `SECURITY DEFINER`
function is anon-callable. `resolve_preview` is deliberately anon-callable — a
review link is sent to people with no account — so the rule is now an allowlist
naming it. A blanket rule that has to be deleted the first time a legitimate
exception appears stops protecting anything.

### One finding from building it

The first pass at locking down functions used `revoke execute ... from anon`.
The Supabase linter caught that this does nothing on its own: Postgres grants
`EXECUTE` on a new function to `PUBLIC`, and `PUBLIC` includes `anon`, so
`resolve_layout(uuid)` was reachable at `/rest/v1/rpc/resolve_layout` by anyone
holding the publishable key, for any user id they cared to guess. That is a
cross-tenant read, not a style warning.

`lock_down_function_execute` revokes from `PUBLIC` explicitly and moves the
resolver into `private`. `verify.sql` now asserts the invariant so it cannot
regress.

---

## Seed data

Two tenants exist for testing: **Northstar Projects** (`northstar`) and
**BrightRoof Studio** (`brightroof`), with one `app_user` each, two features
(`notes` on for Northstar, `timesheets` off for both) and one published design
with three screens. The passwords on those auth users are placeholders and
cannot be signed in with.

---

## Not built yet

- **A REST API.** The app talks to PostgREST directly, which is enough for it.
  `dashboard/db.api.js` still expects a `/api/v1` that does not exist, so the
  dashboard runs on seeded data.
- **Password reset.** `complete_password_change()` exists and every invited
  account is flagged; no screen calls it yet.
- **Email and push delivery.** The rules engine records both as skipped with
  the reason rather than claiming a delivery nobody can find.
- **A second Edge Function.** Only `invite-user` is deployed.
