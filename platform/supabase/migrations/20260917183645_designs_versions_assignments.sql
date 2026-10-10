-- Server-driven UI: designs, immutable versions, routes, assignments.

-- ---------------------------------------------------------------------------
-- designs
-- ---------------------------------------------------------------------------

create table public.designs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  name            text        not null,
  description     text        not null default '',
  thumbnail_url   text,
  status          text        not null default 'draft',
  created_by      uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint designs_status_check check (status in ('draft', 'published', 'archived'))
);

create index designs_org_idx on public.designs (organization_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- design_versions
--
-- A published version is never edited in place. Editing one forks a new draft,
-- which is what makes rollback a single status flip rather than a restore.
-- ---------------------------------------------------------------------------

create table public.design_versions (
  id             uuid primary key default gen_random_uuid(),
  design_id      uuid        not null references public.designs (id) on delete cascade,
  version_number integer     not null,
  label          text,
  schema_version integer     not null default 1,
  document       jsonb       not null,
  theme          jsonb       not null default '{}'::jsonb,
  status         text        not null default 'draft',
  published_at   timestamptz,
  published_by   uuid references public.app_users (id) on delete set null,
  created_by     uuid references public.app_users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint design_versions_status_check check
    (status in ('draft', 'published', 'archived', 'rolled_back')),
  constraint design_versions_number_check check (version_number > 0),
  unique (design_id, version_number)
);

-- At most one published version per design, enforced by the database rather
-- than by application discipline.
create unique index design_versions_one_live
  on public.design_versions (design_id)
  where status = 'published';

create index design_versions_design_idx on public.design_versions (design_id, version_number desc);

comment on column public.design_versions.document is
  'The full layout tree for every screen. Capped at 500 nodes and depth 20 per screen, checked on publish.';

-- Reject a write to a published version at the database level, so a bug in an
-- autosave path cannot silently mutate something users are being served.
create or replace function public.guard_published_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'published'
     and new.status = 'published'
     and (new.document is distinct from old.document
          or new.theme is distinct from old.theme) then
    raise exception
      'design_versions %: a published version is immutable; fork a draft instead', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger design_versions_guard_published
  before update on public.design_versions
  for each row execute function public.guard_published_version();

create trigger design_versions_touch_updated_at
  before update on public.design_versions
  for each row execute function public.touch_updated_at();

create trigger designs_touch_updated_at
  before update on public.designs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- routes
-- ---------------------------------------------------------------------------

create table public.routes (
  id                uuid primary key default gen_random_uuid(),
  design_version_id uuid    not null references public.design_versions (id) on delete cascade,
  path              text    not null,
  screen_node_id    text    not null,
  is_entry          boolean not null default false,
  requires_role     text,

  constraint routes_path_check check (path ~ '^/'),
  unique (design_version_id, path)
);

create unique index routes_one_entry
  on public.routes (design_version_id)
  where is_entry;

-- ---------------------------------------------------------------------------
-- design_assignments
-- ---------------------------------------------------------------------------

create table public.design_assignments (
  id                uuid primary key default gen_random_uuid(),
  design_version_id uuid        not null references public.design_versions (id) on delete cascade,
  scope             text        not null,
  organization_id   uuid references public.organizations (id) on delete cascade,
  user_id           uuid references public.app_users (id) on delete cascade,
  priority          integer     not null default 0,
  starts_at         timestamptz,
  ends_at           timestamptz,
  enabled           boolean     not null default true,
  created_by        uuid references public.app_users (id) on delete set null,
  created_at        timestamptz not null default now(),

  constraint design_assignments_scope_check check (scope in ('organization', 'user')),
  constraint design_assignments_target_check check
    ((scope = 'organization' and organization_id is not null and user_id is null)
  or (scope = 'user' and user_id is not null)),
  constraint design_assignments_window_check check
    (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index design_assignments_org_idx  on public.design_assignments (organization_id, priority desc) where enabled;
create index design_assignments_user_idx on public.design_assignments (user_id, priority desc) where enabled;

-- ---------------------------------------------------------------------------
-- path_events
--
-- Telemetry from the app: route views, tracked actions, renderer errors.
-- Written in batches, read as aggregates.
-- ---------------------------------------------------------------------------

create table public.path_events (
  id                bigint generated always as identity primary key,
  user_id           uuid        not null references public.app_users (id) on delete cascade,
  organization_id   uuid references public.organizations (id) on delete cascade,
  design_version_id uuid references public.design_versions (id) on delete set null,
  session_id        text,
  route_path        text        not null,
  event             text        not null,
  node_id           text,
  dwell_ms          integer,
  metadata          jsonb       not null default '{}'::jsonb,
  occurred_at       timestamptz not null default now(),

  constraint path_events_event_check check (event in ('view', 'action', 'error'))
);

create index path_events_user_idx    on public.path_events (user_id, occurred_at desc);
create index path_events_version_idx on public.path_events (design_version_id, occurred_at desc);
create index path_events_org_idx     on public.path_events (organization_id, occurred_at desc);
create index path_events_session_idx on public.path_events (session_id, occurred_at);
