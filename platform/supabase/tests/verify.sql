-- Verification suite for the CanadaServices platform database.
--
--   psql "$DATABASE_URL" -f platform/supabase/tests/verify.sql
--
-- Every check either prints PASS or aborts the transaction. It is wrapped in a
-- single transaction and rolled back at the end, so it is safe to run against
-- any environment including production: it writes nothing that survives.
--
-- These are the claims the rest of the system rests on. If any of them stops
-- being true, the multi-tenant guarantee is gone and no amount of correct
-- application code puts it back.

\set ON_ERROR_STOP on
begin;

-- ===========================================================================
-- 1. The tenant boundary
--
-- The brief's Phase 1 acceptance criterion: RLS blocks a cross-organisation
-- read in a written test. This is that test.
-- ===========================================================================

do $$
declare
  v_a uuid;           -- a user in org A
  v_b uuid;           -- a user in org B
  v_org_a uuid;
  v_leaked integer;
begin
  select u.id, u.organization_id into v_a, v_org_a
    from public.app_users u
   where u.role <> 'super_admin' and u.deleted_at is null
   order by u.created_at
   limit 1;

  select u.id into v_b
    from public.app_users u
   where u.organization_id is distinct from v_org_a
     and u.role <> 'super_admin' and u.deleted_at is null
   limit 1;

  if v_a is null or v_b is null then
    raise notice 'SKIP tenant boundary: need two users in different organisations';
    return;
  end if;

  -- Become user B and try to read org A.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);

  select
      (select count(*) from public.organizations      where id = v_org_a)
    + (select count(*) from public.designs            where organization_id = v_org_a)
    + (select count(*) from public.app_users          where organization_id = v_org_a)
    + (select count(*) from public.org_settings       where organization_id = v_org_a)
    + (select count(*) from public.design_assignments where organization_id = v_org_a)
    + (select count(*) from public.records            where organization_id = v_org_a)
    + (select count(*) from public.projects           where organization_id = v_org_a)
    + (select count(*) from public.tasks              where organization_id = v_org_a)
    + (select count(*) from public.notes              where organization_id = v_org_a)
    + (select count(*) from public.jobs               where organization_id = v_org_a)
    into v_leaked;

  perform set_config('role', 'postgres', true);

  if v_leaked <> 0 then
    raise exception 'FAIL tenant boundary: % rows of another organisation were visible', v_leaked;
  end if;

  raise notice 'PASS tenant boundary: no cross-organisation rows visible';
end $$;

-- ===========================================================================
-- 2. RLS is actually on
--
-- A table added later and forgotten is the realistic failure mode, so this
-- asserts the invariant across the whole schema rather than a fixed list.
-- ===========================================================================

do $$
declare
  v_open text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_open
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not c.relrowsecurity;

  if v_open is not null then
    raise exception 'FAIL rls coverage: these public tables have RLS disabled: %', v_open;
  end if;

  raise notice 'PASS rls coverage: every public table has RLS enabled';
end $$;

-- A table with RLS on and no policy denies everything, which is a safe default
-- but almost always an oversight worth surfacing.
do $$
declare
  v_silent text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_silent
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if v_silent is not null then
    raise notice 'WARN: RLS on but no policy (denies everything): %', v_silent;
  else
    raise notice 'PASS policy coverage: every RLS table has at least one policy';
  end if;
end $$;

-- ===========================================================================
-- 3. Only functions we chose are reachable before sign-in
--
-- This is the hole the Supabase linter caught on the first pass: Postgres
-- grants EXECUTE to PUBLIC by default, so revoking from `anon` alone leaves the
-- function callable at /rest/v1/rpc/<name> with nothing but the anon key.
--
-- Building preview links found the mirror image of that. Supabase's default
-- privileges grant EXECUTE to the `anon` and `authenticated` roles *by name*,
-- so revoking from PUBLIC alone is equally useless. A function is only closed
-- when both revokes have run.
--
-- The rule used to be "none". It is now an allowlist, because exactly one
-- function is meant to be anon-callable and a blanket rule would have to be
-- deleted to accommodate it — at which point it stops protecting anything.
-- Anything not named here fails until somebody decides it belongs.
-- ===========================================================================

do $$
declare
  -- Deliberately reachable without a session:
  --   resolve_preview — a design review link is sent to people with no
  --   account. It returns one design version and nothing else, and only to a
  --   caller holding a live, unguessable, expiring token.
  v_allowed text[] := array['resolve_preview'];
  v_exposed text;
begin
  select string_agg(p.proname, ', ' order by p.proname)
    into v_exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not (p.proname = any (v_allowed));

  if v_exposed is not null then
    raise exception
      'FAIL anon exposure: SECURITY DEFINER functions callable by anon: %', v_exposed;
  end if;

  raise notice 'PASS anon exposure: only the reviewed allowlist is reachable by anon';
end $$;

-- A preview token is a bearer credential, so the table holding them must not be
-- readable by anon at the grant level — not merely blocked by a policy, which
-- is one `for all to public` away from being undone.
do $$
begin
  if to_regclass('public.preview_tokens') is null then
    raise notice 'SKIP preview tokens: table not present';
    return;
  end if;

  if has_table_privilege('anon', 'public.preview_tokens', 'select') then
    raise exception 'FAIL preview tokens: anon holds SELECT on the token table';
  end if;

  if has_function_privilege('anon', 'public.issue_preview_token(uuid,integer,text)', 'execute') then
    raise exception 'FAIL preview tokens: anon can mint preview links';
  end if;

  if has_function_privilege('anon', 'public.revoke_preview_token(text)', 'execute') then
    raise exception 'FAIL preview tokens: anon can revoke preview links';
  end if;

  -- Unbounded lifetime is the failure mode that turns a share link into a
  -- permanent backdoor, so the constraint that prevents it is asserted too.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.preview_tokens'::regclass
       and conname = 'preview_tokens_expiry_bounded'
  ) then
    raise exception 'FAIL preview tokens: nothing bounds how long a token lives';
  end if;

  raise notice 'PASS preview tokens: anon may resolve one, and may not mint, revoke or list them';
end $$;

-- A preview must answer the same way for absent, expired and revoked tokens
-- rather than confirming that a token once existed, and must never return a
-- tenant's records along with the layout.
do $$
declare
  v jsonb;
begin
  if to_regclass('public.preview_tokens') is null then
    raise notice 'SKIP preview resolution: table not present';
    return;
  end if;

  v := public.resolve_preview('definitely-not-a-real-token');
  if coalesce(v ->> 'error', '') <> 'invalid' then
    raise exception 'FAIL preview resolution: an unknown token did not answer "invalid" (got %)', v;
  end if;

  if v ? 'screens' or v ? 'theme' or v ? 'designName' then
    raise exception 'FAIL preview resolution: a rejected token leaked design fields';
  end if;

  raise notice 'PASS preview resolution: a rejected token reveals nothing';
end $$;

-- The arbitrary-user resolver must not be in the exposed schema at all.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'resolve_layout'
  ) then
    raise exception
      'FAIL resolver exposure: resolve_layout(uuid) is in the public schema and therefore an RPC endpoint';
  end if;

  raise notice 'PASS resolver exposure: resolve_layout lives in the private schema';
end $$;

-- ===========================================================================
-- 4. A published version is immutable
--
-- Rollback is a status flip rather than a restore only because nothing ever
-- edits a published document. This proves the database enforces it, not just
-- the API.
-- ===========================================================================

do $$
declare
  v_id uuid;
begin
  select id into v_id from public.design_versions where status = 'published' limit 1;

  if v_id is null then
    raise notice 'SKIP immutability: no published version to test against';
    return;
  end if;

  begin
    update public.design_versions
       set document = '{"schemaVersion":1,"screens":[]}'::jsonb
     where id = v_id;
    raise exception 'FAIL immutability: a published version was edited in place';
  exception
    when check_violation then
      raise notice 'PASS immutability: the database refused to edit a published version';
  end;
end $$;

-- One live version per design, enforced by index rather than by convention.
do $$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes from (
    select design_id from public.design_versions
     where status = 'published'
     group by design_id having count(*) > 1
  ) d;

  if v_dupes > 0 then
    raise exception 'FAIL single live version: % design(s) have more than one published version', v_dupes;
  end if;

  raise notice 'PASS single live version: at most one published version per design';
end $$;

-- ===========================================================================
-- 5. The resolution rule
--
-- Both that it resolves, and that it strips screens belonging to features the
-- tenant does not have enabled. A disabled feature leaving a reachable screen
-- behind is the bug this whole mechanism exists to prevent.
-- ===========================================================================

do $$
declare
  v_user uuid;
  v_out  jsonb;
  v_dead text[];
  v_served text[];
  v_overlap text[];
begin
  select u.id into v_user
    from public.app_users u
    join public.design_assignments a
      on a.organization_id = u.organization_id and a.scope = 'organization' and a.enabled
   where u.role = 'app_user' and u.deleted_at is null
   limit 1;

  if v_user is null then
    raise notice 'SKIP resolution: no app_user with an organisation assignment';
    return;
  end if;

  v_out := private.resolve_layout(v_user);

  if v_out ->> 'designVersionId' is null then
    raise exception 'FAIL resolution: an assigned user fell through to the static fallback';
  end if;

  if jsonb_array_length(coalesce(v_out -> 'trace', '[]'::jsonb)) = 0 then
    raise exception 'FAIL resolution: no trace returned, so Paths cannot explain the outcome';
  end if;

  select coalesce(array_agg(x), '{}') into v_dead
    from jsonb_array_elements_text(coalesce(v_out -> 'strippedScreens', '[]'::jsonb)) x;

  select coalesce(array_agg(s ->> 'id'), '{}') into v_served
    from jsonb_array_elements(coalesce(v_out -> 'screens', '[]'::jsonb)) s;

  select coalesce(array_agg(d), '{}') into v_overlap
    from unnest(v_dead) d where d = any (v_served);

  if array_length(v_overlap, 1) > 0 then
    raise exception
      'FAIL feature stripping: screens %s were served despite belonging to a disabled feature',
      v_overlap;
  end if;

  raise notice 'PASS resolution: resolved to %, trace has % steps, % screen(s) stripped',
    v_out ->> 'designName',
    jsonb_array_length(v_out -> 'trace'),
    coalesce(array_length(v_dead, 1), 0);
end $$;

-- An app_user must not be able to resolve somebody else.
do $$
declare
  v_a uuid;
  v_b uuid;
  v_org_a uuid;
begin
  select id, organization_id into v_a, v_org_a
    from public.app_users where role <> 'super_admin' and deleted_at is null
    order by created_at limit 1;

  select id into v_b
    from public.app_users
   where organization_id is distinct from v_org_a
     and role <> 'super_admin' and deleted_at is null
   limit 1;

  if v_a is null or v_b is null then
    raise notice 'SKIP resolver authorisation: need two users in different organisations';
    return;
  end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);

  begin
    perform public.resolve_layout_as_admin(v_a);
    perform set_config('role', 'postgres', true);
    raise exception 'FAIL resolver authorisation: a non-admin resolved another tenant''s user';
  exception
    when insufficient_privilege then
      perform set_config('role', 'postgres', true);
      raise notice 'PASS resolver authorisation: cross-tenant resolve refused';
  end;
end $$;

-- ===========================================================================
-- 6. Domain invariants worth asserting
-- ===========================================================================

do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad from public.tasks
   where (status = 'done' and completed_at is null)
      or (status <> 'done' and completed_at is not null);

  if v_bad > 0 then
    raise exception 'FAIL task completion: % task(s) disagree with their completed_at', v_bad;
  end if;

  select count(*) into v_bad from public.app_users
   where role <> 'super_admin' and organization_id is null and deleted_at is null;

  if v_bad > 0 then
    raise exception 'FAIL user tenancy: % non-super-admin user(s) belong to no organisation', v_bad;
  end if;

  raise notice 'PASS domain invariants';
end $$;

-- ===========================================================================
-- 7. Authentication provisioning
--
-- `raw_user_meta_data` is whatever the signup request sent. The first version
-- of the provisioning trigger read role and organisation from it, so a
-- self-signup could have asked for super_admin. These assert that it cannot.
-- ===========================================================================

do $$
declare
  v_id uuid := gen_random_uuid();
  v_role text;
  v_org  uuid;
  v_refused boolean := false;
begin
  if to_regclass('auth.users') is null then
    raise notice 'SKIP auth provisioning: auth schema not reachable';
    return;
  end if;

  -- A. An uninvited signup that claims authority in user_metadata.
  begin
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-attacker@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb,
            '{"app_role":"super_admin","org_slug":"northstar"}'::jsonb, now(), now());
  exception when others then
    v_refused := true;
  end;

  if not v_refused then
    select role, organization_id into v_role, v_org from public.app_users where id = v_id;
    if v_role = 'super_admin' then
      raise exception 'FAIL auth provisioning: user_metadata granted super_admin';
    end if;
    if v_org is not null then
      raise exception 'FAIL auth provisioning: user_metadata placed a self-signup into a tenant';
    end if;
  end if;

  -- B. An invitation, written by the service role into app_metadata, is honoured.
  v_id := gen_random_uuid();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'verify-invited@example.invalid', crypt('x', gen_salt('bf')), null,
          '{"app_role":"designer","org_slug":"northstar","must_change_password":true}'::jsonb,
          '{}'::jsonb, now(), now());

  select role into v_role from public.app_users where id = v_id;
  if v_role is distinct from 'designer' then
    raise exception 'FAIL auth provisioning: an invitation did not produce its role (got %)', v_role;
  end if;

  -- C. A user cannot promote themselves.
  if not exists (select 1 from pg_trigger where tgname = 'guard_app_user_authority') then
    raise exception 'FAIL auth provisioning: nothing stops a user rewriting their own role';
  end if;

  raise notice 'PASS auth provisioning: authority comes from app_metadata only';
end $$;

-- ===========================================================================
-- 8. The rules engine
--
-- The engine is only trustworthy if a failing rule stops on its own and a
-- self-triggering one terminates. Both are asserted rather than described.
-- ===========================================================================

do $$
declare
  v_org uuid := (select id from public.organizations order by created_at limit 1);
  v_task uuid;
  v_rule uuid := gen_random_uuid();
  v_runs integer;
  v_enabled boolean;
begin
  if to_regclass('public.rule_events') is null then
    raise notice 'SKIP rules engine: not installed';
    return;
  end if;

  -- The cron job that drives it must exist, or nothing runs in production.
  if not exists (select 1 from cron.job where jobname = 'rules-tick') then
    raise exception 'FAIL rules engine: no scheduled tick, so nothing would ever run';
  end if;

  insert into public.tasks (organization_id, title, status, priority)
  values (v_org, 'verify: rules target', 'todo', 'normal')
  returning id into v_task;

  -- A rule whose only action cannot work: five runs must disable it.
  insert into public.rules (id, organization_id, name, trigger, conditions, actions, enabled)
  values (v_rule, v_org, 'verify: always fails',
          '{"type":"task.updated","field":"status"}'::jsonb, '{}'::jsonb,
          '[{"type":"set_field","params":{"field":"no_such_column","value":"x"}}]'::jsonb, true);

  for i in 1..6 loop
    update public.tasks set status = case when i % 2 = 1 then 'blocked' else 'todo' end where id = v_task;
    perform private.drain_rule_events(100);
  end loop;

  select enabled into v_enabled from public.rules where id = v_rule;
  if v_enabled then
    raise exception 'FAIL rules engine: a rule that always fails was never disabled';
  end if;

  select count(*) into v_runs from public.rule_runs where rule_id = v_rule and status = 'failed';
  if v_runs <> 5 then
    raise exception 'FAIL rules engine: expected exactly 5 failures before disabling, got %', v_runs;
  end if;

  -- Nothing may be left running: an event stuck in `running` is an event no
  -- worker will ever pick up again.
  if exists (select 1 from public.rule_events where status = 'running') then
    raise exception 'FAIL rules engine: an event was left in the running state';
  end if;

  raise notice 'PASS rules engine: a failing rule disables itself after 5 runs';
end $$;

-- A rule that triggers itself must terminate.
do $$
declare
  v_org uuid := (select id from public.organizations order by created_at limit 1);
  v_task uuid;
  v_dead integer;
begin
  if to_regclass('public.rule_events') is null then return; end if;

  insert into public.tasks (organization_id, title, status, priority)
  values (v_org, 'verify: cascade target', 'todo', 'normal') returning id into v_task;

  insert into public.rules (organization_id, name, trigger, conditions, actions, enabled)
  values
   (v_org, 'verify: ping', '{"type":"task.updated","field":"status"}'::jsonb,
    format('{"all":[{"left":"$record.id","op":"==","right":"%s"},{"left":"$record.status","op":"==","right":"todo"}]}', v_task)::jsonb,
    '[{"type":"set_field","params":{"field":"status","value":"review"}}]'::jsonb, true),
   (v_org, 'verify: pong', '{"type":"task.updated","field":"status"}'::jsonb,
    format('{"all":[{"left":"$record.id","op":"==","right":"%s"},{"left":"$record.status","op":"==","right":"review"}]}', v_task)::jsonb,
    '[{"type":"set_field","params":{"field":"status","value":"todo"}}]'::jsonb, true);

  update public.tasks set status = 'todo' where id = v_task;
  for i in 1..15 loop perform private.drain_rule_events(200); end loop;

  if exists (select 1 from public.rule_events where status = 'pending') then
    raise exception 'FAIL rules engine: a self-triggering pair never settled';
  end if;

  select count(*) into v_dead from public.rule_events where status = 'dead';
  if v_dead = 0 then
    raise exception 'FAIL rules engine: the cascade guard never fired';
  end if;

  raise notice 'PASS rules engine: a self-triggering cascade is bounded and dead-lettered';
end $$;

rollback;

\echo ''
\echo 'verify.sql complete — read the NOTICE lines above. Any FAIL aborts the run.'
