# Setup

Everything below is already done for the live project. This is the record of
how it was built and what you need if you redeploy, hand the project to
someone else, or stand up a second environment.

**Live deployment**

| | |
|---|---|
| Project ref | `ftwkxuqqnbtuegabxxnj` |
| API URL | `https://ftwkxuqqnbtuegabxxnj.supabase.co` |
| Region | `ca-central-1` |
| Extension ID | `mmekjhdfdgcbnphlbpbmkfjiibcfocpk` |
| First admin | `mohsen.bagheri5191@gmail.com` |

---

## Do these three things first

The build is complete but three settings need a human in the Supabase
dashboard, because they are auth configuration rather than schema and no API
reaches them.

### 1. Turn off public sign-ups

**Dashboard → Authentication → Sign In / Providers → Email → "Allow new users to sign up" → off.**

Without this, anyone holding the anon key (which ships in the extension, by
design) can create an `auth.users` row.

They still cannot use the product: `authenticate()` refuses any account with no
`profiles` row and returns `403 no_profile`. So this is defence in depth rather
than the gate itself. But leaving it on lets a stranger fill your auth table
with junk, and there is no reason to allow that.

### 2. Turn on leaked-password protection

**Dashboard → Authentication → Policies → "Leaked password protection" → on.**

Checks new passwords against HaveIBeenPwned. The database linter flags this as
a warning until you do. Costs nothing.

### 3. Change the bootstrap admin password

The first admin was created with a generated temporary password, handed over
separately. Sign in to the admin console, open your own row, and set a real
one. The temporary password was generated once and is not stored anywhere.

---

## Deploying from scratch

For a second environment, or if you ever need to rebuild this one.

### Prerequisites

```bash
npm install -g supabase          # or: brew install supabase/tap/supabase
supabase --version               # 2.x
```

You need a Supabase personal access token from
https://supabase.com/dashboard/account/tokens

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
```

### 1. Create the project

```bash
supabase projects create amazon-market-research-pro \
  --org-id YOUR_ORG_ID \
  --region ca-central-1 \
  --db-password "$(openssl rand -base64 32)"
```

Save that database password somewhere safe. It is shown once.

Note the project ref it returns; every command below uses it.

```bash
export PROJECT_REF=your_new_ref
```

### 2. Link and run the migrations

```bash
supabase link --project-ref "$PROJECT_REF"
supabase db push
```

That applies, in order:

| Migration | What it does |
|---|---|
| `20260909000100_core_schema.sql` | The four tables, their indexes, `updated_at` triggers |
| `20260909000200_rls_policies.sql` | `is_admin()`, `effective_status()`, `month_usage()`, RLS on every table, grant tightening |
| `20260909000300_admin_rpc.sql` | `admin_user_list()`, `admin_usage_summary()`, both service-role only |
| `20260909000400_cors_allowlist.sql` | `app_settings.allowed_origins` |
| `20260909000500_tighten_function_grants.sql` | Revokes the SECURITY DEFINER helpers from `anon` and `authenticated` |

Confirm:

```bash
supabase db lint --project-ref "$PROJECT_REF"
```

### 3. Set the CORS allowlist

The extension ID is pinned by the `key` field in `extension/manifest.json`, so
it is the same on every machine and survives reloads. You can set the allowlist
before you have ever loaded the extension.

```bash
supabase secrets set --project-ref "$PROJECT_REF" \
  ALLOWED_ORIGINS="chrome-extension://mmekjhdfdgcbnphlbpbmkfjiibcfocpk"
```

If you skip this, the functions fall back to `app_settings.allowed_origins`,
which the admin console can edit live. Either works; the secret takes
precedence when both are set.

> An empty allowlist blocks everything. That is deliberate: a missing
> configuration should fail loudly during setup rather than quietly become
> "allow all" in production.

### 4. Deploy the Edge Functions

```bash
supabase functions deploy research    --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy me          --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy admin-users --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy admin-usage --project-ref "$PROJECT_REF" --no-verify-jwt
```

**`--no-verify-jwt` is deliberate and does not mean unauthenticated.** Each
function calls `authenticate()`, which verifies the JWT through the Auth API,
loads the caller's profile, and checks status, expiry, quota and role before
doing any work.

The flag turns off the *gateway's* JWT check, which runs before your code and
returns a bare 401 with no CORS headers. The browser would surface that as an
opaque CORS failure instead of your `{"error":{"code":"..."}}` envelope, and
the extension could not tell "signed out" from "disabled" from "over quota".
Verifying in the function gives you both correct error shapes and correct CORS.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically. You
do not set them.

### 5. Create the first admin

There is no sign-up, so the first administrator is created directly in the
database. Every account after this one is created from the admin console.

Generate a password:

```bash
openssl rand -base64 24
```

Then run this in **Dashboard → SQL Editor**, replacing both placeholders:

```sql
do $$
declare
  v_id    uuid := gen_random_uuid();
  v_email text := 'you@example.com';        -- <- your email
  v_pw    text := 'PASTE_GENERATED_PASSWORD'; -- <- from openssl above
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(v_pw, extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    '', '', '', ''
  );

  -- GoTrue needs a matching identity row for email sign-in to work.
  insert into auth.identities (
    provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    v_id::text, v_id,
    jsonb_build_object('sub', v_id::text, 'email', v_email,
                       'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  );

  insert into public.profiles (id, email, full_name, role, status, monthly_request_quota)
  values (v_id, v_email, 'Owner', 'admin', 'active', 100000);
end $$;
```

### 6. Point the clients at the project

Two files, two values each:

`extension/config.js`
```js
export const SUPABASE_URL = "https://YOUR_REF.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```

`admin/config.js`
```js
window.AMR_CONFIG = {
  SUPABASE_URL: "https://YOUR_REF.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

Also update `host_permissions` in `extension/manifest.json` to your project
URL, so the service worker is allowed to reach it.

Get the values with:

```bash
supabase projects api-keys --project-ref "$PROJECT_REF"
```

### 7. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Confirm the ID reads `mmekjhdfdgcbnphlbpbmkfjiibcfocpk`

If it does not match, the `key` in `manifest.json` was changed or removed. Put
it back, or add the new ID to the allowlist (admin console → Settings → CORS
allowlist).

### 8. Serve the admin console

It is three static files with no build step. Anything that serves a directory
works:

```bash
cd admin && python3 -m http.server 5173
```

Then open http://localhost:5173

`http://localhost:5173` is already in the default allowlist. For a hosted
deployment, add that origin to the allowlist and put the console behind your
own access control — see SECURITY.md.

---

## Verify the deployment

### Bundle contains no secrets

```bash
./scripts/verify-bundle.sh
```

16 checks: all six V19 coefficients by value, the confidence-band multipliers,
`Math.exp`/`Math.log1p`, the calibration table, every advisory threshold, the
HHI formula, service-role keys, connection strings, private keys, the old
embedded dataset, and `fetch()` outside the service worker.

### The API refuses what it should

Replace `$URL` with your project URL and `$ANON` with your anon key.

```bash
URL=https://ftwkxuqqnbtuegabxxnj.supabase.co
ANON=your_anon_key
ORIGIN=chrome-extension://mmekjhdfdgcbnphlbpbmkfjiibcfocpk

# No token -> 401 missing_token
curl -s -X POST "$URL/functions/v1/me" \
  -H "apikey: $ANON" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}'

# Junk token -> 401 invalid_token
curl -s -X POST "$URL/functions/v1/me" \
  -H "apikey: $ANON" -H "Origin: $ORIGIN" -H "Authorization: Bearer not.a.real.token" \
  -H 'Content-Type: application/json' -d '{}'

# Disallowed origin -> 403 origin_not_allowed, and no CORS headers
curl -si -X POST "$URL/functions/v1/me" \
  -H "apikey: $ANON" -H "Origin: https://evil.example" \
  -H 'Content-Type: application/json' -d '{}' | head -20

# Sign in
TOKEN=$(curl -s -X POST "$URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' | jq -r .access_token)

# Profile and quota -> 200
curl -s -X POST "$URL/functions/v1/me" \
  -H "apikey: $ANON" -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq

# Score a listing -> 200, with units and revenue the client never computed
curl -s -X POST "$URL/functions/v1/research" \
  -H "apikey: $ANON" -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"op":"score","items":[{"asin":"B09WH49CDW","rank":1200,"priceNumber":24.99,"reviewCount":340,"variationCount":3}]}' | jq

# Direct table read with the anon key -> RLS returns nothing
curl -s "$URL/rest/v1/profiles?select=*" -H "apikey: $ANON" | jq
```

The last one should print `[]` or a permission error. If it prints rows, stop
and check that migration `20260909000200` applied.

### Non-admin cannot reach the admin API

Create a normal user in the console, sign in as them, and call `admin-users`.
Expect `403 not_admin`. It is refused twice over: the Edge Function checks
`role`, and `admin_user_list()` is not granted to `authenticated` at all.

---

## Day-to-day operations

**Create a user.** Admin console → Users → Create user. Generate a password,
save the account, and pass the password to them yourself. It is displayed once
and stored nowhere.

**Cut someone off.** Users → Disable. Their next request fails with `403
account_disabled`, without waiting for a token to expire, because the server
re-reads their profile on every call.

**Time-limited access.** Set an expiry date when creating or editing. Access
stops at 23:59 local on that day. No cron job is involved; expiry is evaluated
at request time.

**Maintenance mode.** Settings → kill switch. Blocks every user immediately,
including you, with the message you set. The admin console keeps working, on
purpose: if the kill switch also blocked the admin API, turning it on would be
a one-way door.

**Quotas.** Counted per UTC calendar month, resetting at 00:00 on the 1st. One
`research` call is one request, however many products it covers, so batching is
rewarded. Failed and rejected calls are logged but not billed.

**A new extension build changed the ID.** Admin console → Settings → CORS
allowlist. Takes up to 30 seconds to propagate (the functions cache it for that
long per warm instance).

---

## Redeploying after a change

```bash
# schema
supabase db push

# a single function
supabase functions deploy research --project-ref "$PROJECT_REF" --no-verify-jwt

# always, before packaging the extension
./scripts/verify-bundle.sh
```

Changing anything in `supabase/functions/_shared/` affects all four functions.
Redeploy all four.
