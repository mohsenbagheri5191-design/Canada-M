-- App Data, Features and Rules.
--
-- Two storage models on purpose. `collections` + `records` hold JSONB for data
-- types an admin invents in the dashboard, so a new type needs no migration.
-- `entity_configs` describes real tables that already exist, so the app's core
-- data keeps its constraints and its query plans. They are not unified:
-- generating migrations from a dashboard is how you get an unrecoverable
-- production schema.

-- ---------------------------------------------------------------------------
-- features
-- ---------------------------------------------------------------------------

create table public.features (
  id              uuid primary key default gen_random_uuid(),
  key             text        not null unique,
  name            text        not null,
  description     text        not null default '',
  icon            text,
  origin          text        not null default 'composed',
  status          text        not null default 'draft',
  manifest        jsonb       not null default '{}'::jsonb,
  depends_on      text[]      not null default '{}',
  settings_schema jsonb       not null default '{}'::jsonb,
  created_by      uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint features_origin_check check (origin in ('code', 'composed')),
  constraint features_status_check check (status in ('draft', 'published', 'deprecated')),
  constraint features_key_check    check (key ~ '^[a-z][a-z0-9_]{1,38}$')
);

comment on column public.features.origin is
  'code = declared in the repository, needs a deploy to exist. composed = assembled in the dashboard from existing screens, collections and actions.';

create table public.feature_assignments (
  id              uuid primary key default gen_random_uuid(),
  feature_id      uuid        not null references public.features (id) on delete cascade,
  organization_id uuid        not null references public.organizations (id) on delete cascade,
  enabled         boolean     not null default false,
  settings        jsonb       not null default '{}'::jsonb,
  updated_by      uuid references public.app_users (id) on delete set null,
  updated_at      timestamptz not null default now(),

  unique (feature_id, organization_id)
);

create index feature_assignments_org_idx on public.feature_assignments (organization_id) where enabled;

-- ---------------------------------------------------------------------------
-- collections + records
-- ---------------------------------------------------------------------------

create table public.collections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  feature_id      uuid references public.features (id) on delete set null,
  key             text        not null,
  name            text        not null,
  origin          text        not null default 'collection',
  title_field     text,
  field_schema    jsonb       not null default '[]'::jsonb,
  permissions     jsonb       not null default '{}'::jsonb,
  created_by      uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint collections_origin_check check (origin in ('collection', 'native')),
  constraint collections_key_check    check (key ~ '^[a-z][a-z0-9_]{1,46}$')
);

-- A global collection (organization_id null) is shared by every tenant; a
-- scoped one is unique within its tenant. Two partial indexes because a null
-- organization_id would not collide under a plain unique constraint.
create unique index collections_org_key    on public.collections (organization_id, key) where organization_id is not null;
create unique index collections_global_key on public.collections (key)                  where organization_id is null;

create table public.records (
  id              uuid primary key default gen_random_uuid(),
  collection_id   uuid        not null references public.collections (id) on delete cascade,
  organization_id uuid        not null references public.organizations (id) on delete cascade,
  data            jsonb       not null default '{}'::jsonb,
  created_by      uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index records_collection_idx on public.records (collection_id, organization_id) where deleted_at is null;
create index records_trash_idx      on public.records (deleted_at) where deleted_at is not null;
create index records_data_idx       on public.records using gin (data jsonb_path_ops);

comment on column public.records.deleted_at is
  'Soft delete. The Trash view restores within 30 days; a scheduled job purges past that.';

-- ---------------------------------------------------------------------------
-- entity_configs
-- ---------------------------------------------------------------------------

create table public.entity_configs (
  id            uuid primary key default gen_random_uuid(),
  table_name    text        not null unique,
  display_name  text        not null,
  feature_key   text,
  title_field   text,
  field_config  jsonb       not null default '{}'::jsonb,
  permissions   jsonb       not null default '{}'::jsonb,
  tenant_column text        not null default 'organization_id',
  created_at    timestamptz not null default now()
);

comment on table public.entity_configs is
  'Maps a real table to a display name, field labels, control types and validation, so App Data can manage it without the schema changing.';

-- ---------------------------------------------------------------------------
-- rules
-- ---------------------------------------------------------------------------

create table public.rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations (id) on delete cascade,
  name             text        not null,
  trigger          jsonb       not null,
  conditions       jsonb       not null default '{"all":[]}'::jsonb,
  actions          jsonb       not null default '[]'::jsonb,
  enabled          boolean     not null default false,
  disabled_reason  text,
  consecutive_fails integer    not null default 0,
  created_by       uuid references public.app_users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index rules_org_idx on public.rules (organization_id) where enabled;

comment on column public.rules.consecutive_fails is
  'Five in a row auto-disables the rule and notifies an admin. Reset on any success.';

create table public.rule_runs (
  id          bigint generated always as identity primary key,
  rule_id     uuid        not null references public.rules (id) on delete cascade,
  status      text        not null,
  input       jsonb,
  output      jsonb,
  error       text,
  duration_ms integer,
  occurred_at timestamptz not null default now(),

  constraint rule_runs_status_check check (status in ('success', 'failed', 'skipped'))
);

create index rule_runs_rule_idx on public.rule_runs (rule_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger features_touch_updated_at
  before update on public.features
  for each row execute function public.touch_updated_at();

create trigger feature_assignments_touch_updated_at
  before update on public.feature_assignments
  for each row execute function public.touch_updated_at();

create trigger collections_touch_updated_at
  before update on public.collections
  for each row execute function public.touch_updated_at();

create trigger records_touch_updated_at
  before update on public.records
  for each row execute function public.touch_updated_at();

create trigger rules_touch_updated_at
  before update on public.rules
  for each row execute function public.touch_updated_at();
