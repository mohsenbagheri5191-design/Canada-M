-- Amazon Market Research Pro - core schema
--
-- Four tables back the whole product:
--   profiles      one row per invited account, mirrors auth.users
--   usage_events  one row per billable Edge Function call (quota + admin usage view)
--   app_settings  single-row config, including the global kill switch
--   audit_log     append-only record of every admin action
--
-- Every table gets RLS in 20260909000200_rls_policies.sql. Nothing here
-- grants access on its own.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  email                 text        not null,
  full_name             text,
  role                  text        not null default 'user',
  status                text        not null default 'active',
  created_by            uuid        references auth.users (id) on delete set null,
  notes                 text,
  access_expires_at     timestamptz,
  monthly_request_quota integer     not null default 1000,
  last_active_at        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint profiles_role_check   check (role   in ('admin', 'user')),
  constraint profiles_status_check check (status in ('active', 'disabled', 'expired')),
  constraint profiles_quota_check  check (monthly_request_quota >= 0)
);

comment on table  public.profiles is
  'One row per invited account. No public signup: rows are created only by the admin-users Edge Function using the service role key.';
comment on column public.profiles.status is
  'active = may call the API. disabled = admin revoked access. expired = past access_expires_at.';
comment on column public.profiles.access_expires_at is
  'Optional hard cutoff. Null means no expiry. Enforced at request time, not by a scheduled job.';
comment on column public.profiles.monthly_request_quota is
  'Billable research calls allowed per calendar month (UTC). 0 blocks the account entirely.';

create index if not exists profiles_role_idx        on public.profiles (role);
create index if not exists profiles_status_idx      on public.profiles (status);
create index if not exists profiles_last_active_idx on public.profiles (last_active_at desc nulls last);
create unique index if not exists profiles_email_key on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- usage_events
-- ---------------------------------------------------------------------------

create table if not exists public.usage_events (
  id              bigint generated always as identity primary key,
  user_id         uuid        not null references auth.users (id) on delete cascade,
  endpoint        text        not null,
  reference       text,
  item_count      integer     not null default 0,
  response_status integer     not null,
  duration_ms     integer     not null default 0,
  billable        boolean     not null default true,
  created_at      timestamptz not null default now()
);

comment on table  public.usage_events is
  'Append-only call log. Doubles as the quota counter, so it is written even for rejected calls (billable=false).';
comment on column public.usage_events.reference is
  'ASIN, keyword, or operation reference the call was about. Truncated to 200 chars by the Edge Function.';
comment on column public.usage_events.billable is
  'Only billable rows count against monthly_request_quota. Failed auth and rejected calls are logged but not billed.';

-- The quota check runs on every single research call, so it gets a dedicated
-- composite index matching its exact predicate (user + billable + month).
create index if not exists usage_events_quota_idx
  on public.usage_events (user_id, created_at desc)
  where billable;

create index if not exists usage_events_created_idx  on public.usage_events (created_at desc);
create index if not exists usage_events_endpoint_idx on public.usage_events (endpoint, created_at desc);
create index if not exists usage_events_reference_idx
  on public.usage_events (reference)
  where reference is not null;

-- ---------------------------------------------------------------------------
-- app_settings
-- ---------------------------------------------------------------------------

-- Single-row table. The `id boolean primary key default true check (id)`
-- trick makes a second row impossible: the only value that satisfies the
-- check is true, and true is already taken by the primary key.
create table if not exists public.app_settings (
  id                    boolean     primary key default true,
  kill_switch           boolean     not null default false,
  kill_switch_message   text        not null default 'Amazon Market Research Pro is temporarily down for maintenance. Please try again shortly.',
  default_monthly_quota integer     not null default 1000,
  updated_at            timestamptz not null default now(),
  updated_by            uuid        references auth.users (id) on delete set null,

  constraint app_settings_singleton    check (id),
  constraint app_settings_quota_check  check (default_monthly_quota >= 0)
);

comment on table public.app_settings is
  'Single-row config. kill_switch=true blocks every caller including admins, checked on every request.';

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
  id             bigint generated always as identity primary key,
  actor_id       uuid        references auth.users (id) on delete set null,
  actor_email    text,
  action         text        not null,
  target_user_id uuid,
  target_email   text,
  details        jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table  public.audit_log is
  'Append-only admin action record. actor_email and target_email are denormalised so entries survive account deletion.';
comment on column public.audit_log.action is
  'user.created, user.updated, user.disabled, user.enabled, user.deleted, user.password_reset, settings.kill_switch, settings.updated';

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_actor_idx   on public.audit_log (actor_id, created_at desc);
create index if not exists audit_log_action_idx  on public.audit_log (action, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists app_settings_touch_updated_at on public.app_settings;
create trigger app_settings_touch_updated_at
  before update on public.app_settings
  for each row execute function public.touch_updated_at();
