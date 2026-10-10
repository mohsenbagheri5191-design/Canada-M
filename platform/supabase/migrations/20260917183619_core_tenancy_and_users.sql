-- CanadaServices core tenancy
--
-- Every table below is tenant-scoped by organization_id. RLS lands in a later
-- migration; nothing here grants access on its own.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------

create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  status     text        not null default 'active',
  plan       text        not null default 'starter',
  region     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint organizations_status_check check (status in ('active', 'suspended')),
  constraint organizations_plan_check   check (plan   in ('starter', 'growth', 'scale')),
  constraint organizations_slug_check   check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$')
);

comment on table public.organizations is
  'One row per client tenant. slug appears in the runtime URL /t/<slug>.';

-- ---------------------------------------------------------------------------
-- app_users
--
-- Mirrors auth.users rather than replacing it: Supabase owns credentials, this
-- table owns tenancy and role. No public signup — rows are created by an admin
-- through a service-role function.
-- ---------------------------------------------------------------------------

create table public.app_users (
  id                   uuid primary key references auth.users (id) on delete cascade,
  organization_id      uuid references public.organizations (id) on delete restrict,
  email                text        not null,
  full_name            text,
  role                 text        not null default 'app_user',
  status               text        not null default 'invited',
  must_change_password boolean     not null default true,
  last_login_at        timestamptz,
  session_count        integer     not null default 0,
  created_by           uuid references public.app_users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,

  constraint app_users_role_check check
    (role in ('super_admin', 'org_admin', 'designer', 'viewer', 'app_user')),
  constraint app_users_status_check check
    (status in ('invited', 'active', 'suspended', 'deleted')),
  -- A super_admin is platform-level and belongs to no single tenant; everyone
  -- else must have one. Enforced here so a mis-scoped row cannot exist.
  constraint app_users_org_required check
    (role = 'super_admin' or organization_id is not null)
);

create unique index app_users_email_key  on public.app_users (lower(email));
create        index app_users_org_idx    on public.app_users (organization_id) where deleted_at is null;
create        index app_users_role_idx   on public.app_users (role);
create        index app_users_active_idx on public.app_users (last_login_at desc nulls last);

comment on column public.app_users.role is
  'super_admin = everything across orgs. org_admin = users/assignments/designs in their org. designer = edit designs, cannot publish. viewer = read-only. app_user = mobile app only, no dashboard.';

-- ---------------------------------------------------------------------------
-- org_settings
-- ---------------------------------------------------------------------------

create table public.org_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  settings        jsonb       not null default '{}'::jsonb,
  secrets         jsonb,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.app_users (id) on delete set null
);

comment on column public.org_settings.secrets is
  'Integration credentials. Write-only from the UI and never returned by any API response. Encrypt at the application boundary before insert.';

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id              bigint generated always as identity primary key,
  actor_id        uuid references public.app_users (id) on delete set null,
  actor_email     text,
  organization_id uuid references public.organizations (id) on delete set null,
  action          text        not null,
  entity_type     text        not null,
  entity_id       uuid,
  phrase          text,
  before          jsonb,
  after           jsonb,
  ip              inet,
  occurred_at     timestamptz not null default now()
);

create index audit_log_occurred_idx on public.audit_log (occurred_at desc);
create index audit_log_org_idx      on public.audit_log (organization_id, occurred_at desc);
create index audit_log_entity_idx   on public.audit_log (entity_type, entity_id);

comment on table public.audit_log is
  'Append-only. actor_email is denormalised so entries survive account deletion. Every mutating endpoint writes one row.';

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

create trigger organizations_touch_updated_at
  before update on public.organizations
  for each row execute function public.touch_updated_at();

create trigger app_users_touch_updated_at
  before update on public.app_users
  for each row execute function public.touch_updated_at();

create trigger org_settings_touch_updated_at
  before update on public.org_settings
  for each row execute function public.touch_updated_at();
