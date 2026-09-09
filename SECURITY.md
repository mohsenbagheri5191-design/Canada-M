# Security

What this architecture protects, what it does not, and what remains exposed to
a determined user. The last section is the important one: an honest list of
residual risk is more useful than a list of controls.

---

## Verified against the live deployment

Every claim below was tested against the deployed project, not reasoned about.
26 of 26 checks pass. Re-run them yourself with:

```bash
./scripts/verify-bundle.sh                              # 16 static checks
./scripts/acceptance-test.sh you@example.com 'password' # 26 live checks
```

| | Result |
|---|---|
| No `Authorization` header | `401 missing_token` |
| Invalid JWT | `401 invalid_token` |
| Origin not on the allowlist | `403 origin_not_allowed`, no CORS headers |
| No `Origin` header at all | `403 origin_not_allowed` |
| Non-admin calls `admin-users` | `403 not_admin` |
| Non-admin calls `admin-usage` | `403 not_admin` |
| Quota of 2: requests 1 and 2 | `200` |
| Quota of 2: request 3 | `403 quota_exceeded` |
| Disable, then reuse the **same** token | `403 account_disabled` |
| Re-enable, same token | `200` |
| `access_expires_at` in the past | `403 account_expired` |
| Kill switch on, normal user | `503 kill_switch` |
| Kill switch on, **admin** | `503 kill_switch` |
| Kill switch on, `admin-users` | `200` (not a one-way door) |
| Kill switch off | `200` |
| Deleted account, same token | `401 invalid_token` |
| Refresh token exchange | `200`, new access token works |
| Revoked refresh token | `400 refresh_token_not_found` |
| Access token after sign-out | `401 invalid_token` |
| Unknown `op` / empty `items` | `400 bad_request` |
| `anon` reads any of the four tables | denied |
| Signed-in user reads `profiles` | own row only (1 of 2) |
| Signed-in user writes anything | denied |
| Admin writes a profile directly | denied |
| Audit log after 9 admin actions | all 9 recorded and attributed |
| Bundle grep for coefficients and keys | 16/16 clean |

The disable test is the important one. It reuses the *same access token* the
user already held — no sign-out, no expiry, no refresh — and the request is
refused, because the server re-reads the profile row on every call.

**Numerical parity.** The scoring port was checked against the original V29
client over 20,000 randomised listings covering 16 output fields each: 320,000
comparisons, zero mismatches. The deployed function was then spot-checked
against the same local implementation and agreed exactly (rank 1200, price
24.99, 340 reviews, family 3 → 36 units, $899.64, Low confidence).

**One note on refresh tokens.** Supabase tolerates replaying a just-spent
refresh token for about 10 seconds, returning the same new session. That is
deliberate: two browser tabs refreshing at the same moment must not sign the
user out. A genuinely revoked token fails with `400 refresh_token_not_found`,
and the client treats any non-200 as unrecoverable — it clears the session and
shows the login form rather than retrying, so there is no loop either way.

---

## What is protected

### The scoring model

Everything of value lives in `supabase/functions/research/scoring.ts`, which
runs on Supabase's infrastructure and is never served to a client:

- Both V19 demand models and all eleven fitted coefficients
- The confidence-band multipliers (×0.68/×1.45 badge, ×0.40/×2.10 no-badge)
- The rank-to-units calibration table
- The Research Opportunity Score
- Every bucket boundary for the price, unit and rank bands
- All eight competitive advisory thresholds
- Brand aggregation, review-weighted rating, and the HHI formula

The extension sends observable page facts — rank, price, review count, badge
units, variation count — and renders the numbers that come back. It cannot
reproduce them, because the mapping from one to the other exists only on the
server.

Verified by `./scripts/verify-bundle.sh`, which greps the shipped bundle for
each coefficient by value, the band multipliers, `Math.exp`/`Math.log1p`, the
calibration pairs, every advisory constant and the HHI formula. It runs in
about a second; run it before every release.

### The service role key

Exists in exactly one place: the Edge Function environment, injected by
Supabase at runtime. It is not in any client file, any committed file, or the
admin console. `.gitignore` covers `.env`, `*.pem` and `*.p12`.

If it leaks, rotate it immediately at **Dashboard → Project Settings → API →
service_role → Reset**. Nothing else needs changing; the functions read it from
the environment.

### Table access

RLS is enabled on all four tables. Verified directly against the live database
by adopting each role and running the exact queries PostgREST would:

| Caller | profiles | usage_events | app_settings | audit_log |
|---|---|---|---|---|
| `anon` (the key in the extension) | denied | denied | denied | denied |
| signed-in user | own row only | own rows only | 0 rows | 0 rows |
| signed-in admin | all | all | 1 row | all |

Write attempts by a signed-in user — self-promote to admin, raise own quota,
delete usage rows to reset the quota, forge a usage row, flip the kill switch —
all return `permission denied`. So does a direct profile `UPDATE` by an admin.

There is no `INSERT`, `UPDATE` or `DELETE` policy on any table for `anon` or
`authenticated`. Not a restrictive policy — no policy at all, plus the
underlying grants revoked. Every write in the product goes through an Edge
Function using the service role.

`audit_log` is append-only by construction: not even an admin can rewrite it
through the API.

### Access control

Every request re-reads the caller's profile from the database. Nothing is
trusted from inside the JWT except the identity it proves.

That is what makes disabling immediate: a user disabled at 10:00:00 fails at
10:00:01, without waiting up to an hour for their access token to expire. The
same applies to demoting an admin, changing a quota, or an expiry passing.

| Situation | Status | Code |
|---|---|---|
| No `Authorization` header | 401 | `missing_token` |
| Invalid or expired JWT | 401 | `invalid_token` |
| Authenticated but never invited | 403 | `no_profile` |
| Admin disabled the account | 403 | `account_disabled` |
| Past `access_expires_at` | 403 | `account_expired` |
| Monthly quota spent | 403 | `quota_exceeded` |
| Non-admin calling `admin-*` | 403 | `not_admin` |
| Origin not on the allowlist | 403 | `origin_not_allowed` |
| Kill switch on | 503 | `kill_switch` |

The kill switch returns 503 rather than 403 deliberately. It is a maintenance
state affecting everyone, not a judgement about this caller, and 503 is what a
client should back off from. The brief specified 401 and 403 for the auth and
quota cases; it did not specify a code for the kill switch.

### Invite-only

No sign-up endpoint exists in the extension or the admin console. Accounts are
created by `admin-users`, which verifies the caller is an active admin first.

There is no self-serve password reset, so there is no reset flow to abuse. An
admin sets passwords directly and hands them over out of band.

An `auth.users` row on its own grants nothing. Access requires a `profiles` row
that an administrator explicitly created.

### Token handling

- Access token in `chrome.storage.session` — memory only, gone when the browser
  closes, never written to disk
- Refresh token in `chrome.storage.local` — survives restarts, rotated by
  Supabase on every use
- Both confined to the service worker. `storage.session` is explicitly pinned
  to `TRUSTED_CONTEXTS`, so content scripts cannot reach it
- Page scripts message the service worker and receive results, never
  credentials
- On a 401: refresh once, retry once, then a clean sign-out. A revoked refresh
  token clears the session rather than retrying, so there is no refresh loop
- The admin console keeps its token in `sessionStorage` and holds no refresh
  token at all. An admin session dies with the tab, deliberately

### CORS

Strict allowlist, no wildcard. A disallowed origin gets no
`Access-Control-Allow-Origin` header *and* a 403 — the first stops a browser
exposing the body, the second stops a non-browser client getting a useful
answer.

An empty allowlist blocks everything. A missing configuration should fail
loudly during setup rather than quietly become "allow all".

---

## What is still visible to a determined user

Anyone who installs the extension can open `chrome://extensions`, enable
developer mode, and read every line of the bundle. That is unavoidable and
always will be. Here is exactly what they get.

### The API surface

They can see the project URL, the anon key, the endpoint names, the request
shapes and the field names. They can call `research` themselves with `curl` and
a valid token.

**Why this is acceptable:** they need a working account to get anything back,
and that account is one you created, is rate-limited, and can be switched off
in one click. Calling the API directly is exactly what the extension does; it
gets them no capability they did not already have.

### The scraping layer

`lib/amazon.js` and `offscreen.js` show how pages are fetched and which CSS
selectors read which fields.

**Why this is acceptable:** it is a commodity. Anyone can rewrite it in an
afternoon by reading a product page in dev tools. It was deliberately left
client-side, because requests carrying the user's own cookies from their own IP
look like browsing, whereas the same requests from a datacenter IP earn a robot
check within a page or two.

### Outputs, at their own cost

A user with a valid account can call `research` repeatedly and record the
inputs and outputs. With enough pairs, the two log-linear models are
recoverable by regression: five or six well-chosen points per model would get
close, and a few hundred would nail it.

**This is the real residual risk, and there is no way to eliminate it.** Any
system that returns a number derived from inputs leaks information about the
derivation. What the architecture does is make it cost something:

- Every call is attributed to a named account and logged with its ASIN or
  keyword, so a scripted sweep looks nothing like normal research in the usage
  view
- Monthly quotas cap how many probes anyone can run
- One click disables the account
- The kill switch stops everyone at once

Watch for it in **Admin → Usage**: an account whose call count is far above the
others, or whose requests cluster on a narrow band of ranks and prices, is
probing rather than researching.

### Their own data

Users see the results of their own searches. That is the product.

### What they cannot get

The coefficients, the band multipliers, the calibration table, the advisory
thresholds, the HHI formula, the service role key, any other user's data, any
other user's usage, or the ability to change their own quota, status or role.

---

## Known accepted findings

`supabase db lint` reports two warnings. Both are understood and accepted.

**`is_admin()` is callable by `authenticated` over RPC.** It has to be: the
function is referenced inside the RLS policies on all four tables, and policy
expressions are evaluated with the querying role's privileges. Revoking
`EXECUTE` from `authenticated` would break every one of those policies.

It leaks nothing. It takes no arguments and answers only "is the caller holding
this JWT an admin?", which the caller already knows. It is revoked from `anon`,
which has no such policy to evaluate.

**Leaked-password protection is off by default.** Turn it on: **Dashboard →
Authentication → Policies**. See SETUP.md step 2.

A third finding was fixed rather than accepted: `month_usage(uuid)` was
callable by any signed-in user, and since it takes an arbitrary user id, that
let anyone read anyone else's monthly call count. Migration
`20260909000500_tighten_function_grants.sql` revokes it from `anon` and
`authenticated`; only `service_role` can call it now.

---

## Deployment notes

**`--no-verify-jwt` on the Edge Functions is not a weakening.** It turns off
the *gateway's* JWT check, which runs before your code and returns a bare 401
with no CORS headers — a browser shows that as an opaque CORS failure, and the
client cannot distinguish "signed out" from "disabled" from "over quota". Each
function does its own full verification through the Auth API, then checks
profile, status, expiry, quota and role. Verifying in the function gives both
correct error codes and correct CORS headers.

**Turn off public sign-ups** (SETUP.md step 1). Without it, anyone with the
anon key can create an `auth.users` row. They cannot use the product — no
profile means `403 no_profile` — but there is no reason to let strangers fill
the auth table.

**The admin console has no access control of its own.** It is three static
files. Anyone who can load them sees a login form, and a non-admin who signs in
is refused by the API with `403 not_admin`, so the data is safe. But do not
host it on a public URL without putting your own gate in front of it: HTTP
basic auth, an IP allowlist, or a private network. Running it locally, as
SETUP.md suggests, sidesteps this entirely.

**The pinned extension ID.** `extension/manifest.json` carries a `key` field:
the *public* half of an RSA keypair. Chrome derives the extension ID from it,
which is why the ID is `mmekjhdfdgcbnphlbpbmkfjiibcfocpk` on every machine and
survives reloads, and why the CORS allowlist could be configured before the
extension had ever been loaded.

Committing a public key is fine. The matching private key was generated
outside the repository and is not needed for anything here: loading unpacked
derives the ID from the public key alone, and publishing to the Chrome Web
Store makes Google manage signing. You would only need a private key to
distribute a self-signed `.crx` yourself.

If the `key` field is ever removed or changed, the ID changes with it and the
allowlist needs updating (admin console → Settings → CORS allowlist).
`.gitignore` covers `*.pem` and `*.p12` so private key material cannot be
committed by accident.

---

## If something goes wrong

**Service role key leaked.** Rotate it: Dashboard → Project Settings → API →
service_role → Reset. Then check `audit_log` and `usage_events` for anything
you did not do.

**An account is being abused.** Admin → Users → Disable. Effective on their
next request. Then read `audit_log` for what that account changed, if it was an
admin.

**You need everyone out, now.** Admin → Settings → kill switch. Everyone is
blocked immediately with your maintenance message. The console keeps working so
you can turn it back off.

**A user says the extension stopped working.** In order: is the kill switch on;
is their account disabled or expired; have they spent their quota (Admin →
Users shows all three); did the extension ID change (Settings → CORS
allowlist).
