# Browser suites

Real Chromium, driving the repository's own `app/` and `dashboard/` files.

```sh
cd tests/e2e
npm install
npx playwright install chromium      # skip if your machine already has one
npm test
```

If your environment ships a browser and forbids downloading one, point at it:

```sh
CHROMIUM_PATH=/path/to/chrome npm test
```

## What they test

| Suite | Checks |
|---|---|
| `app.test.mjs` | sign-in, theme normalisation, built-in layout, cache-first paint with the server down, dead-route recovery, telemetry batching, all four preview-token outcomes, the error boundary |
| `data.test.mjs` | rows bound to components, the PostgREST query the client builds, six ways the allowlist refuses a document, optimistic writes and rollback, `Repeater` |
| `outbox.test.mjs` | offline writes: refused vs unreachable, surviving a reload, draining when the server returns, de-duplicating repeated taps |
| `dashboard.test.mjs` | every block and screen template renders through the shared registry; every component has a preset |
| `studio.test.mjs` | all 8 dashboard tabs load without errors; inserting a block; the typed item editor |

## How they reach "Supabase"

`stub.mjs` is a small HTTP server that does two jobs: it serves the repository
as static files, and it answers the Supabase auth and PostgREST endpoints with
payloads **captured from the live database** (`fixtures/`). It injects
`window.__APP_CONFIG__` into `app/index.html` so the app talks to it instead of
the real project.

So the suites need no network and no credentials. They test the client, not the
database — for the database, run `platform/supabase/tests/verify.sql`.

The stub's test users are `maya@northstar.ca` and `daniel@brightroof.ca` with
the password `correct-horse`. **That password exists only inside the stub**; it
is not set on the real accounts.

If the database's response shapes change, refresh `fixtures/` from the live
project, or the suites will keep passing against shapes that no longer exist.
