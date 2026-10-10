-- The app's own data: project management and notes, plus the field-service
-- tables from the original review package.
--
-- These are real tables, not JSONB collections, because they are the app's core
-- data and they need constraints, foreign keys and real indexes. App Data
-- manages them through entity_configs; the dashboard cannot alter their shape.

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------

create table public.projects (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations (id) on delete cascade,
  key             text        not null,
  name            text        not null,
  description     text        not null default '',
  status          text        not null default 'active',
  colour          text,
  owner_id        uuid references public.app_users (id) on delete set null,
  starts_on       date,
  due_on          date,
  archived_at     timestamptz,
  created_by      uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint projects_status_check check (status in ('planning', 'active', 'on_hold', 'done', 'cancelled')),
  constraint projects_dates_check  check (due_on is null or starts_on is null or due_on >= starts_on),
  unique (organization_id, key)
);

create index projects_org_idx   on public.projects (organization_id, status) where deleted_at is null;
create index projects_owner_idx on public.projects (owner_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- tasks
--
-- `position` is a sparse float so a drag-and-drop reorder rewrites one row
-- rather than renumbering the whole list.
-- ---------------------------------------------------------------------------

create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations (id) on delete cascade,
  project_id      uuid references public.projects (id) on delete cascade,
  parent_id       uuid references public.tasks (id) on delete cascade,
  title           text        not null,
  notes           text        not null default '',
  status          text        not null default 'todo',
  priority        text        not null default 'normal',
  assignee_id     uuid references public.app_users (id) on delete set null,
  due_at          timestamptz,
  completed_at    timestamptz,
  estimate_min    integer,
  position        double precision not null default 1000,
  labels          text[]      not null default '{}',
  created_by      uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint tasks_status_check   check (status   in ('todo', 'in_progress', 'blocked', 'review', 'done')),
  constraint tasks_priority_check check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint tasks_estimate_check check (estimate_min is null or estimate_min >= 0),
  -- A done task has a completion time and nothing else does, so "when was this
  -- finished" never needs a guess.
  constraint tasks_completed_check check
    ((status = 'done' and completed_at is not null)
  or (status <> 'done' and completed_at is null)),
  constraint tasks_not_own_parent check (parent_id is distinct from id)
);

create index tasks_project_idx  on public.tasks (project_id, status, position) where deleted_at is null;
create index tasks_assignee_idx on public.tasks (assignee_id, due_at) where deleted_at is null;
create index tasks_org_due_idx  on public.tasks (organization_id, due_at) where deleted_at is null and status <> 'done';
create index tasks_parent_idx   on public.tasks (parent_id) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------

create table public.notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations (id) on delete cascade,
  project_id      uuid references public.projects (id) on delete set null,
  task_id         uuid references public.tasks (id) on delete set null,
  title           text        not null default '',
  body            text        not null default '',
  body_format     text        not null default 'markdown',
  pinned          boolean     not null default false,
  labels          text[]      not null default '{}',
  author_id       uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint notes_format_check check (body_format in ('markdown', 'plain', 'rich'))
);

create index notes_org_idx     on public.notes (organization_id, updated_at desc) where deleted_at is null;
create index notes_project_idx on public.notes (project_id, updated_at desc) where deleted_at is null;
create index notes_pinned_idx  on public.notes (organization_id) where pinned and deleted_at is null;

-- Full-text search over title and body, maintained by the database so the app
-- never has to keep a search index in step by hand.
alter table public.notes
  add column search tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body,  '')), 'B')
  ) stored;

create index notes_search_idx on public.notes using gin (search);

-- ---------------------------------------------------------------------------
-- customers + jobs — the field-service tables from the review package
-- ---------------------------------------------------------------------------

create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations (id) on delete cascade,
  name            text        not null,
  email           text,
  phone           text,
  address         text,
  city            text,
  province        text,
  postal_code     text,
  since           date,
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index customers_org_idx on public.customers (organization_id, name) where deleted_at is null;

create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations (id) on delete cascade,
  reference        text       not null,
  customer_id     uuid references public.customers (id) on delete set null,
  project_id      uuid references public.projects (id) on delete set null,
  service         text        not null,
  status          text        not null default 'scheduled',
  priority        text        not null default 'normal',
  city            text,
  address         text,
  technician_id   uuid references public.app_users (id) on delete set null,
  scheduled_at    timestamptz,
  completed_at    timestamptz,
  value_cents     bigint,
  notes           text        not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint jobs_status_check   check (status   in ('scheduled', 'in_progress', 'blocked', 'complete', 'cancelled')),
  constraint jobs_priority_check check (priority in ('low', 'normal', 'high')),
  constraint jobs_value_check    check (value_cents is null or value_cents >= 0),
  unique (organization_id, reference)
);

create index jobs_org_idx        on public.jobs (organization_id, status, scheduled_at) where deleted_at is null;
create index jobs_technician_idx on public.jobs (technician_id, scheduled_at) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger projects_touch_updated_at  before update on public.projects  for each row execute function public.touch_updated_at();
create trigger tasks_touch_updated_at     before update on public.tasks     for each row execute function public.touch_updated_at();
create trigger notes_touch_updated_at     before update on public.notes     for each row execute function public.touch_updated_at();
create trigger customers_touch_updated_at before update on public.customers for each row execute function public.touch_updated_at();
create trigger jobs_touch_updated_at      before update on public.jobs      for each row execute function public.touch_updated_at();
