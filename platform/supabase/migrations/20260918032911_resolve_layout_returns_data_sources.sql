-- The resolver now also answers "what may this user's app read?".
--
-- The allowlist has to come back with the layout rather than be fetched
-- separately, for the same reason the trace does: the app must not be able to
-- assemble a different answer than the one the dashboard would explain. It is
-- derived from entity_configs, gated by the tenant's enabled features and by
-- the user's role, so a screen bound to `notes` simply has no source to read
-- when the notes feature is off.

create or replace function private.data_sources_for(p_user_id uuid, p_enabled text[])
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',       e.table_name,
           'name',     e.display_name,
           'table',    e.table_name,
           'title',    e.title_field,
           'columns',  e.field_config -> 'columns',
           'fields',   e.field_config -> 'fields',
           'writable', case
                         when (select u.role from public.app_users u where u.id = p_user_id)
                              = any (array(select jsonb_array_elements_text(e.permissions -> 'write')))
                         then e.permissions -> 'writableColumns'
                         else '[]'::jsonb
                       end
         ) order by e.display_name), '[]'::jsonb)
    from public.entity_configs e
   where (e.feature_key is null or e.feature_key = any (p_enabled))
     and (select u.role from public.app_users u where u.id = p_user_id)
         = any (array(select jsonb_array_elements_text(e.permissions -> 'read')));
$$;

revoke execute on function private.data_sources_for(uuid, text[]) from public, anon, authenticated;

-- Fold it into the layout payload. Everything else about resolve_layout is
-- unchanged; this adds one key.
create or replace function private.resolve_layout(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
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
begin
  select * into v_user from public.app_users where id = p_user_id and deleted_at is null;

  if not found then
    return jsonb_build_object(
      'designVersionId', null, 'screens', '[]'::jsonb, 'dataSources', '[]'::jsonb,
      'trace', jsonb_build_array(jsonb_build_object('step','User not found','detail',p_user_id::text,'hit',false)));
  end if;

  -- Features first: they gate both screens and data sources.
  select coalesce(array_agg(f.key), '{}') into v_enabled
    from public.feature_assignments fa
    join public.features f on f.id = fa.feature_id
   where fa.organization_id = v_user.organization_id and fa.enabled and f.status = 'published';

  -- Step 1 ----------------------------------------------------------------
  select * into v_rule from public.design_assignments
   where scope = 'user' and user_id = p_user_id and enabled
     and (starts_at is null or starts_at <= v_now) and (ends_at is null or ends_at >= v_now)
   order by priority desc, created_at desc limit 1;

  v_trace := v_trace || jsonb_build_object('step','User-scope assignment',
    'detail', coalesce('priority ' || v_rule.priority::text, 'none'), 'hit', v_rule.id is not null, 'rule', to_jsonb(v_rule));

  -- Step 2 ----------------------------------------------------------------
  if v_rule.id is null then
    select * into v_rule from public.design_assignments
     where scope = 'organization' and organization_id = v_user.organization_id and enabled
       and (starts_at is null or starts_at <= v_now) and (ends_at is null or ends_at >= v_now)
     order by priority desc, created_at desc limit 1;

    v_trace := v_trace || jsonb_build_object('step','Organisation-scope assignment',
      'detail', coalesce('priority ' || v_rule.priority::text, 'none'), 'hit', v_rule.id is not null, 'rule', to_jsonb(v_rule));
  end if;

  if v_rule.id is not null then
    select * into v_version from public.design_versions where id = v_rule.design_version_id;
  end if;

  -- Step 3 ----------------------------------------------------------------
  if v_version.id is null then
    select v.* into v_version from public.design_versions v join public.designs d on d.id = v.design_id
     where d.organization_id = v_user.organization_id and d.deleted_at is null and v.status = 'published'
     order by v.published_at desc nulls last limit 1;
    v_trace := v_trace || jsonb_build_object('step','Organisation default published design',
      'detail', coalesce(v_version.id::text,'none'), 'hit', v_version.id is not null);
  end if;

  -- Step 4 ----------------------------------------------------------------
  if v_version.id is null then
    select v.* into v_version from public.design_versions v join public.designs d on d.id = v.design_id
     where d.organization_id is null and d.deleted_at is null and v.status = 'published'
     order by v.published_at desc nulls last limit 1;
    v_trace := v_trace || jsonb_build_object('step','Global fallback design',
      'detail', coalesce(v_version.id::text,'none'), 'hit', v_version.id is not null);
  end if;

  -- Step 5 ----------------------------------------------------------------
  -- The built-in layout still needs its data sources: it is a real app, not a
  -- placeholder, and it renders the same task and note components.
  if v_version.id is null then
    return jsonb_build_object(
      'designVersionId', null,
      'screens', '[]'::jsonb,
      'features', to_jsonb(v_enabled),
      'dataSources', private.data_sources_for(p_user_id, v_enabled),
      'organization', jsonb_build_object('id', v_user.organization_id),
      'trace', v_trace || jsonb_build_object('step','App built-in static layout','detail','shipped with the build','hit',true));
  end if;

  select * into v_design from public.designs where id = v_version.design_id;

  select coalesce(array_agg(s), '{}') into v_dead
    from public.features f
    cross join lateral jsonb_array_elements_text(coalesce(f.manifest -> 'screens', '[]'::jsonb)) as s
   where f.status = 'published' and not (f.key = any (v_enabled));

  for v_screen in select * from jsonb_array_elements(coalesce(v_version.document -> 'screens', '[]'::jsonb))
  loop
    if not ((v_screen ->> 'id') = any (v_dead)) then
      v_screens := v_screens || v_screen;
    end if;
  end loop;

  select coalesce(settings, '{}'::jsonb) into v_settings
    from public.org_settings where organization_id = v_user.organization_id;

  return jsonb_build_object(
    'designVersionId', v_version.id,
    'designName',      v_design.name,
    'versionNumber',   v_version.version_number,
    'schemaVersion',   v_version.schema_version,
    'screens',         v_screens,
    'theme',           v_version.theme,
    'features',        to_jsonb(v_enabled),
    'dataSources',     private.data_sources_for(p_user_id, v_enabled),
    'settings',        coalesce(v_settings, '{}'::jsonb),
    'strippedScreens', to_jsonb(v_dead),
    'organization',    jsonb_build_object('id', v_user.organization_id),
    'trace',           v_trace
  );
end;
$function$;

revoke execute on function private.resolve_layout(uuid) from public, anon, authenticated;
