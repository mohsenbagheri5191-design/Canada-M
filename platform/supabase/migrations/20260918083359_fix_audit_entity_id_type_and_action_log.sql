-- Two fixes found by running the engine rather than reading it.
--
-- 1. `audit_log.entity_id` is uuid. Both notify_admin and issue_preview_token
--    passed text, so notify_admin failed at runtime and the preview audit
--    insert would have failed the first time anyone issued a token — inside a
--    function whose earlier statements had already succeeded.
--
-- 2. The action log appended the action name and its result as two separate
--    array elements, so the run output read as a list of half-objects.

create or replace function private.rule_run_action(
  p_action jsonb,
  p_scope  jsonb,
  p_org    uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_type   text := p_action ->> 'type';
  v_params jsonb := coalesce(p_action -> 'params', '{}'::jsonb);
  v_field  text;
  v_value  text;
  v_table  text;
  v_id     text;
  v_url    text;
  v_n      bigint;
begin
  case v_type

    when 'set_field' then
      v_field := v_params ->> 'field';
      v_value := private.rule_interpolate(v_params ->> 'value', p_scope);
      v_table := p_scope #>> '{event,entity_table}';
      v_id    := p_scope #>> '{record,id}';

      if v_field is null or v_table is null or v_id is null then
        return jsonb_build_object('status', 'skipped', 'reason', 'set_field needs a field and a record');
      end if;

      if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = v_table and column_name = v_field
      ) then
        return jsonb_build_object('status', 'failed', 'reason', format('no column %I on %I', v_field, v_table));
      end if;

      execute format('update public.%I set %I = $1 where id = $2::uuid and organization_id = $3', v_table, v_field)
        using v_value, v_id, p_org;
      get diagnostics v_n = row_count;
      return jsonb_build_object('status', case when v_n > 0 then 'ok' else 'skipped' end,
                                'rows', v_n, 'field', v_field, 'value', v_value);

    when 'update_record' then
      v_table := coalesce(v_params ->> 'collection', p_scope #>> '{event,entity_table}');
      v_id    := coalesce(private.rule_interpolate(v_params ->> 'id', p_scope), p_scope #>> '{record,id}');
      if v_table <> 'records' then
        return jsonb_build_object('status', 'skipped', 'reason', 'update_record only writes the records store');
      end if;
      update public.records
         set data = data || coalesce(v_params -> 'data', '{}'::jsonb), updated_at = now()
       where id = v_id::uuid and organization_id = p_org;
      get diagnostics v_n = row_count;
      return jsonb_build_object('status', case when v_n > 0 then 'ok' else 'skipped' end, 'rows', v_n);

    when 'create_record' then
      insert into public.records (organization_id, collection_id, data)
      select p_org, c.id, coalesce(v_params -> 'data', '{}'::jsonb)
        from public.collections c
       where c.organization_id = p_org and c.key = v_params ->> 'collection';
      get diagnostics v_n = row_count;
      return jsonb_build_object('status', case when v_n > 0 then 'ok' else 'failed' end,
                                'reason', case when v_n = 0 then 'no such collection for this organisation' end);

    when 'toggle_feature' then
      update public.feature_assignments fa
         set enabled = coalesce((v_params ->> 'enabled')::boolean, true), updated_at = now()
        from public.features f
       where f.id = fa.feature_id
         and fa.organization_id = p_org
         and f.key = v_params ->> 'feature';
      get diagnostics v_n = row_count;
      return jsonb_build_object('status', case when v_n > 0 then 'ok' else 'failed' end,
                                'reason', case when v_n = 0 then 'no such feature for this organisation' end);

    when 'notify_admin' then
      insert into public.audit_log (actor_id, actor_email, organization_id, action, entity_type, entity_id, phrase)
      values (null, 'rules@system', p_org, 'rule.notify', 'Rule',
              nullif(p_scope #>> '{rule,id}', '')::uuid,
              private.rule_interpolate(coalesce(v_params ->> 'message', 'A rule fired'), p_scope));
      return jsonb_build_object('status', 'ok');

    when 'call_webhook' then
      v_url := private.rule_interpolate(v_params ->> 'url', p_scope);
      if v_url is null or v_url !~ '^https://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(/|$|\?)' then
        return jsonb_build_object('status', 'failed', 'reason', 'webhook url must be a public https address');
      end if;
      if v_url ~* '://(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' then
        return jsonb_build_object('status', 'failed', 'reason', 'webhook url resolves to a private address');
      end if;

      select net.http_post(
               url := v_url,
               body := jsonb_build_object('event', p_scope -> 'event', 'record', p_scope -> 'record'),
               headers := '{"content-type":"application/json"}'::jsonb,
               timeout_milliseconds := 5000)
        into v_n;
      return jsonb_build_object('status', 'ok', 'request_id', v_n);

    when 'send_email', 'send_push' then
      return jsonb_build_object('status', 'skipped',
                                'reason', format('%s needs a delivery provider, which is not configured', v_type));

    else
      return jsonb_build_object('status', 'failed', 'reason', format('unknown action type %L', v_type));
  end case;
exception when others then
  return jsonb_build_object('status', 'failed', 'reason', sqlerrm);
end;
$$;

revoke execute on function private.rule_run_action(jsonb, jsonb, uuid) from public, anon, authenticated;

-- The same uuid mistake in the preview issuer, which would have failed on the
-- very first real invitation of a reviewer.
create or replace function public.issue_preview_token(
  p_design_version_id uuid,
  p_hours integer default 24,
  p_label text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_org   uuid;
  v_token text;
  v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 720);
begin
  select d.organization_id into v_org
    from public.design_versions v
    join public.designs d on d.id = v.design_id
   where v.id = p_design_version_id;

  if not found then
    raise exception 'design version not found' using errcode = 'no_data_found';
  end if;

  if not (public.is_super_admin() or (public.can_design() and v_org is not distinct from public.current_org())) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');

  insert into public.preview_tokens (token, design_version_id, organization_id, label, created_by, expires_at)
  values (v_token, p_design_version_id, v_org, p_label, auth.uid(), now() + make_interval(hours => v_hours));

  insert into public.audit_log (actor_id, actor_email, organization_id, action, entity_type, entity_id, phrase)
  select auth.uid(), u.email, v_org, 'preview.issue', 'DesignVersion', p_design_version_id,
         format('issued a %s hour preview link', v_hours)
    from public.app_users u where u.id = auth.uid();

  return jsonb_build_object('token', v_token, 'expiresAt', now() + make_interval(hours => v_hours));
end;
$$;

revoke execute on function public.issue_preview_token(uuid, integer, text) from public, anon;
grant execute on function public.issue_preview_token(uuid, integer, text) to authenticated;
