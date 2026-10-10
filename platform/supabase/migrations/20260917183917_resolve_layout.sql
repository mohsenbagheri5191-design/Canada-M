-- The resolution rule.
--
-- One implementation, here, called by both the runtime (which wants the
-- layout) and the dashboard's Paths tab (which wants the trace explaining it).
-- If these were computed separately they would drift, and the dashboard would
-- confidently explain an outcome that is not happening.
--
-- Order, first hit wins:
--   1. active user-scope assignment, highest priority
--   2. active organisation-scope assignment, highest priority
--   3. the organisation's default published design
--   4. the global fallback published design
--   5. the app's built-in static layout (returns null)

create or replace function public.resolve_layout(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user     public.app_users;
  v_version  public.design_versions;
  v_design   public.designs;
  v_rule     public.design_assignments;
  v_trace    jsonb := '[]'::jsonb;
  v_enabled  text[];
  v_dead     text[] := '{}';
  v_screens  jsonb  := '[]'::jsonb;
  v_settings jsonb  := '{}'::jsonb;
  v_screen   jsonb;
  v_now      timestamptz := now();

  procedure_note text;
begin
  select * into v_user
    from public.app_users
   where id = p_user_id and deleted_at is null;

  if not found then
    return jsonb_build_object(
      'designVersionId', null,
      'screens', '[]'::jsonb,
      'trace', jsonb_build_array(
        jsonb_build_object('step', 'User not found', 'detail', p_user_id::text, 'hit', false))
    );
  end if;

  -- Step 1 --------------------------------------------------------------
  select * into v_rule
    from public.design_assignments
   where scope = 'user'
     and user_id = p_user_id
     and enabled
     and (starts_at is null or starts_at <= v_now)
     and (ends_at   is null or ends_at   >= v_now)
   order by priority desc, created_at desc
   limit 1;

  v_trace := v_trace || jsonb_build_object(
    'step',   'User-scope assignment',
    'detail', coalesce('priority ' || v_rule.priority::text, 'none'),
    'hit',    v_rule.id is not null,
    'rule',   to_jsonb(v_rule));

  -- Step 2 --------------------------------------------------------------
  if v_rule.id is null then
    select * into v_rule
      from public.design_assignments
     where scope = 'organization'
       and organization_id = v_user.organization_id
       and enabled
       and (starts_at is null or starts_at <= v_now)
       and (ends_at   is null or ends_at   >= v_now)
     order by priority desc, created_at desc
     limit 1;

    v_trace := v_trace || jsonb_build_object(
      'step',   'Organisation-scope assignment',
      'detail', coalesce('priority ' || v_rule.priority::text, 'none'),
      'hit',    v_rule.id is not null,
      'rule',   to_jsonb(v_rule));
  end if;

  if v_rule.id is not null then
    select * into v_version from public.design_versions where id = v_rule.design_version_id;
  end if;

  -- Step 3 --------------------------------------------------------------
  if v_version.id is null then
    select v.* into v_version
      from public.design_versions v
      join public.designs d on d.id = v.design_id
     where d.organization_id = v_user.organization_id
       and d.deleted_at is null
       and v.status = 'published'
     order by v.published_at desc nulls last
     limit 1;

    v_trace := v_trace || jsonb_build_object(
      'step',   'Organisation default published design',
      'detail', coalesce(v_version.id::text, 'none'),
      'hit',    v_version.id is not null);
  end if;

  -- Step 4 --------------------------------------------------------------
  if v_version.id is null then
    select v.* into v_version
      from public.design_versions v
      join public.designs d on d.id = v.design_id
     where d.organization_id is null
       and d.deleted_at is null
       and v.status = 'published'
     order by v.published_at desc nulls last
     limit 1;

    v_trace := v_trace || jsonb_build_object(
      'step',   'Global fallback design',
      'detail', coalesce(v_version.id::text, 'none'),
      'hit',    v_version.id is not null);
  end if;

  -- Step 5 --------------------------------------------------------------
  if v_version.id is null then
    return jsonb_build_object(
      'designVersionId', null,
      'screens', '[]'::jsonb,
      'trace', v_trace || jsonb_build_object(
        'step', 'App built-in static layout', 'detail', 'shipped with the build', 'hit', true));
  end if;

  select * into v_design from public.designs where id = v_version.design_id;

  -- Features enabled for this tenant ------------------------------------
  select coalesce(array_agg(f.key), '{}')
    into v_enabled
    from public.feature_assignments fa
    join public.features f on f.id = fa.feature_id
   where fa.organization_id = v_user.organization_id
     and fa.enabled
     and f.status = 'published';

  -- Screens owned by a feature this tenant does NOT have on. Stripping them
  -- before the app ever sees them is what stops a disabled feature leaving a
  -- reachable screen or a dead nav entry behind.
  select coalesce(array_agg(s), '{}')
    into v_dead
    from public.features f
    cross join lateral jsonb_array_elements_text(coalesce(f.manifest -> 'screens', '[]'::jsonb)) as s
   where f.status = 'published'
     and not (f.key = any (v_enabled));

  for v_screen in select * from jsonb_array_elements(coalesce(v_version.document -> 'screens', '[]'::jsonb))
  loop
    if not ((v_screen ->> 'id') = any (v_dead)) then
      v_screens := v_screens || v_screen;
    end if;
  end loop;

  select coalesce(settings, '{}'::jsonb) into v_settings
    from public.org_settings
   where organization_id = v_user.organization_id;

  return jsonb_build_object(
    'designVersionId', v_version.id,
    'designName',      v_design.name,
    'versionNumber',   v_version.version_number,
    'schemaVersion',   v_version.schema_version,
    'screens',         v_screens,
    'theme',           v_version.theme,
    'features',        to_jsonb(v_enabled),
    'settings',        coalesce(v_settings, '{}'::jsonb),
    'strippedScreens', to_jsonb(v_dead),
    'organization',    jsonb_build_object('id', v_user.organization_id),
    'trace',           v_trace
  );
end;
$$;

comment on function public.resolve_layout(uuid) is
  'The single resolution rule. Returns the layout plus the trace that explains it. Called by /layout/resolve and by the dashboard Paths tab.';

-- What the app itself calls: no argument, cannot be pointed at another user.
create or replace function public.resolve_my_layout()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.resolve_layout(auth.uid())
$$;

revoke execute on function public.resolve_layout(uuid)  from anon, authenticated;
revoke execute on function public.resolve_my_layout()   from anon;
grant   execute on function public.resolve_my_layout()   to authenticated;

-- The dashboard may resolve any user it is allowed to see, so the trace can be
-- shown on the Paths tab. Wrapped rather than granting resolve_layout directly,
-- because that function is SECURITY DEFINER and would otherwise let any signed
-- in user resolve anybody.
create or replace function public.resolve_layout_as_admin(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org
    from public.app_users where id = p_user_id;

  if not public.is_super_admin()
     and not (public.can_admin() and v_org = public.current_org()) then
    raise exception 'not authorised to resolve this user' using errcode = '42501';
  end if;

  return public.resolve_layout(p_user_id);
end;
$$;

revoke execute on function public.resolve_layout_as_admin(uuid) from anon;
grant   execute on function public.resolve_layout_as_admin(uuid) to authenticated;
