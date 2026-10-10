-- Row-level security.
--
-- This is the tenant boundary. An org_admin must not be able to read another
-- organisation's rows even with a valid token and a hand-written query, so the
-- rule lives here rather than in application code.
--
-- The helper functions are SECURITY DEFINER so that reading app_users to learn
-- the caller's org does not re-enter app_users' own policy and recurse.

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.app_users
   where id = auth.uid() and deleted_at is null
$$;

create or replace function public.current_org()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id from public.app_users
   where id = auth.uid() and deleted_at is null
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() = 'super_admin', false)
$$;

-- Can administer within their own tenant.
create or replace function public.can_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('super_admin', 'org_admin'), false)
$$;

-- Can change designs, but publishing is checked separately in the API.
create or replace function public.can_design()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('super_admin', 'org_admin', 'designer'), false)
$$;

revoke execute on function public.current_app_role() from anon;
revoke execute on function public.current_org()      from anon;
revoke execute on function public.is_super_admin()   from anon;
revoke execute on function public.can_admin()        from anon;
revoke execute on function public.can_design()       from anon;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. A table with RLS on and no policy denies everything,
-- which is the correct default for anything added later and forgotten.
-- ---------------------------------------------------------------------------

alter table public.organizations       enable row level security;
alter table public.app_users           enable row level security;
alter table public.org_settings        enable row level security;
alter table public.audit_log           enable row level security;
alter table public.designs             enable row level security;
alter table public.design_versions     enable row level security;
alter table public.routes              enable row level security;
alter table public.design_assignments  enable row level security;
alter table public.path_events         enable row level security;
alter table public.features            enable row level security;
alter table public.feature_assignments enable row level security;
alter table public.collections         enable row level security;
alter table public.records             enable row level security;
alter table public.entity_configs      enable row level security;
alter table public.rules               enable row level security;
alter table public.rule_runs           enable row level security;
alter table public.projects            enable row level security;
alter table public.tasks               enable row level security;
alter table public.notes               enable row level security;
alter table public.customers           enable row level security;
alter table public.jobs                enable row level security;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

create policy organizations_read on public.organizations
  for select to authenticated
  using (public.is_super_admin() or id = public.current_org());

create policy organizations_write on public.organizations
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- A user sees themselves, and an admin sees their own organisation's users.
create policy app_users_read on public.app_users
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_super_admin()
    or (public.can_admin() and organization_id = public.current_org())
  );

-- Writes go through service-role functions (there is no public signup), so no
-- insert or update policy is granted to authenticated at all.
create policy app_users_self_update on public.app_users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.current_app_role() and organization_id = public.current_org());

create policy org_settings_read on public.org_settings
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy org_settings_write on public.org_settings
  for all to authenticated
  using (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()))
  with check (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()));

create policy audit_log_read on public.audit_log
  for select to authenticated
  using (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()));

-- ---------------------------------------------------------------------------
-- Designs
--
-- app_user reads designs too: the runtime needs the document it was assigned.
-- ---------------------------------------------------------------------------

create policy designs_read on public.designs
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org() or organization_id is null);

create policy designs_write on public.designs
  for all to authenticated
  using (public.can_design() and (public.is_super_admin() or organization_id = public.current_org()))
  with check (public.can_design() and (public.is_super_admin() or organization_id = public.current_org()));

create policy design_versions_read on public.design_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.designs d
       where d.id = design_id
         and (public.is_super_admin() or d.organization_id = public.current_org() or d.organization_id is null)
    )
  );

create policy design_versions_write on public.design_versions
  for all to authenticated
  using (
    public.can_design() and exists (
      select 1 from public.designs d
       where d.id = design_id
         and (public.is_super_admin() or d.organization_id = public.current_org())
    )
  )
  with check (
    public.can_design() and exists (
      select 1 from public.designs d
       where d.id = design_id
         and (public.is_super_admin() or d.organization_id = public.current_org())
    )
  );

create policy routes_read on public.routes
  for select to authenticated
  using (
    exists (
      select 1 from public.design_versions v
        join public.designs d on d.id = v.design_id
       where v.id = design_version_id
         and (public.is_super_admin() or d.organization_id = public.current_org() or d.organization_id is null)
    )
  );

create policy routes_write on public.routes
  for all to authenticated
  using (public.can_design())
  with check (public.can_design());

create policy design_assignments_read on public.design_assignments
  for select to authenticated
  using (
    public.is_super_admin()
    or organization_id = public.current_org()
    or user_id = auth.uid()
  );

create policy design_assignments_write on public.design_assignments
  for all to authenticated
  using (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()))
  with check (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()));

-- Telemetry: a user may only write their own events; admins read their org's.
create policy path_events_insert_self on public.path_events
  for insert to authenticated
  with check (user_id = auth.uid());

create policy path_events_read on public.path_events
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_super_admin()
    or (public.can_admin() and organization_id = public.current_org())
  );

-- ---------------------------------------------------------------------------
-- Features — the catalogue is platform-level, the toggles are per tenant.
-- ---------------------------------------------------------------------------

create policy features_read on public.features
  for select to authenticated using (true);

create policy features_write on public.features
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy feature_assignments_read on public.feature_assignments
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy feature_assignments_write on public.feature_assignments
  for all to authenticated
  using (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()))
  with check (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()));

-- ---------------------------------------------------------------------------
-- App data
-- ---------------------------------------------------------------------------

create policy collections_read on public.collections
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org() or organization_id is null);

create policy collections_write on public.collections
  for all to authenticated
  using (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()))
  with check (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()));

create policy records_read on public.records
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy records_write on public.records
  for all to authenticated
  using (public.is_super_admin() or organization_id = public.current_org())
  with check (public.is_super_admin() or organization_id = public.current_org());

create policy entity_configs_read on public.entity_configs
  for select to authenticated using (true);

create policy entity_configs_write on public.entity_configs
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

create policy rules_read on public.rules
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy rules_write on public.rules
  for all to authenticated
  using (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()))
  with check (public.can_admin() and (public.is_super_admin() or organization_id = public.current_org()));

create policy rule_runs_read on public.rule_runs
  for select to authenticated
  using (
    exists (
      select 1 from public.rules r
       where r.id = rule_id
         and (public.is_super_admin() or r.organization_id = public.current_org())
    )
  );

-- ---------------------------------------------------------------------------
-- Domain data — one shape for all of it, scoped by organization_id.
-- ---------------------------------------------------------------------------

create policy projects_read on public.projects
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy projects_write on public.projects
  for all to authenticated
  using (public.is_super_admin() or organization_id = public.current_org())
  with check (public.is_super_admin() or organization_id = public.current_org());

create policy tasks_read on public.tasks
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy tasks_write on public.tasks
  for all to authenticated
  using (public.is_super_admin() or organization_id = public.current_org())
  with check (public.is_super_admin() or organization_id = public.current_org());

create policy notes_read on public.notes
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy notes_write on public.notes
  for all to authenticated
  using (public.is_super_admin() or organization_id = public.current_org())
  with check (public.is_super_admin() or organization_id = public.current_org());

create policy customers_read on public.customers
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy customers_write on public.customers
  for all to authenticated
  using (public.is_super_admin() or organization_id = public.current_org())
  with check (public.is_super_admin() or organization_id = public.current_org());

create policy jobs_read on public.jobs
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

create policy jobs_write on public.jobs
  for all to authenticated
  using (public.is_super_admin() or organization_id = public.current_org())
  with check (public.is_super_admin() or organization_id = public.current_org());
