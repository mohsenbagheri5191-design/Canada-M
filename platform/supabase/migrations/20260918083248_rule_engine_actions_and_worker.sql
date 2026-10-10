-- Executing actions, and the worker that drains the queue.
--
-- Actions split into two honest halves.
--
-- Database-local actions run here, for real: set_field, update_record,
-- create_record, toggle_feature, notify_admin. Each is bounded to the tenant
-- the event belongs to, and each names its target by a column the rule author
-- chose — checked against the table's real columns, never interpolated into
-- SQL as a fragment.
--
-- Outward actions — send_email, send_push — need a provider this project does
-- not have. They are recorded as `skipped` with the reason, because a run log
-- that says "sent" when nothing was sent is worse than no run log. call_webhook
-- is outward but genuinely doable, so it goes out through pg_net.

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

    -- Set one field on the record that triggered the rule.
    when 'set_field' then
      v_field := v_params ->> 'field';
      v_value := private.rule_interpolate(v_params ->> 'value', p_scope);
      v_table := p_scope #>> '{event,entity_table}';
      v_id    := p_scope #>> '{record,id}';

      if v_field is null or v_table is null or v_id is null then
        return jsonb_build_object('status', 'skipped', 'reason', 'set_field needs a field and a record');
      end if;

      -- The column must exist on that table. This is the check that keeps a
      -- rule document from naming something it should not touch.
      if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = v_table and column_name = v_field
      ) then
        return jsonb_build_object('status', 'failed', 'reason', format('no column %I on %I', v_field, v_table));
      end if;

      -- format() with %I quotes the identifiers; the value is a parameter.
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

    -- An in-app notice. The audit log is where the dashboard already looks, so
    -- a rule's notification lands beside everything else that happened.
    when 'notify_admin' then
      insert into public.audit_log (actor_id, actor_email, organization_id, action, entity_type, entity_id, phrase)
      values (null, 'rules@system', p_org, 'rule.notify', 'Rule', p_scope #>> '{rule,id}',
              private.rule_interpolate(coalesce(v_params ->> 'message', 'A rule fired'), p_scope));
      return jsonb_build_object('status', 'ok');

    when 'call_webhook' then
      v_url := private.rule_interpolate(v_params ->> 'url', p_scope);
      -- Outward requests go to https only, and never to a private address: a
      -- rule document must not become a way to probe the network behind us.
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
      -- Deliberately not faked. No provider is configured, and a run log that
      -- claims delivery nobody can find is worse than one that says why not.
      return jsonb_build_object('status', 'skipped',
                                'reason', format('%s needs a delivery provider, which is not configured', v_type));

    else
      return jsonb_build_object('status', 'failed', 'reason', format('unknown action type %L', v_type));
  end case;
exception when others then
  return jsonb_build_object('status', 'failed', 'reason', sqlerrm);
end;
$$;

-- ---------------------------------------------------------------------------
-- The worker
-- ---------------------------------------------------------------------------

create or replace function private.drain_rule_events(p_limit integer default 50)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  ev       public.rule_events;
  r        public.rules;
  v_scope  jsonb;
  v_started timestamptz;
  v_results jsonb;
  v_result  jsonb;
  a         jsonb;
  v_failed  boolean;
  v_matched integer := 0;
  v_events  integer := 0;
  v_table   text;
begin
  for ev in
    select * from public.rule_events
     where status = 'pending' and available_at <= now()
     order by id
     limit greatest(1, least(p_limit, 500))
     for update skip locked
  loop
    update public.rule_events set status = 'running', attempts = attempts + 1 where id = ev.id;
    v_events := v_events + 1;
    v_failed := false;

    v_table := case ev.entity when 'record' then 'records' else ev.entity || 's' end;

    for r in
      select * from public.rules
       where enabled
         and (organization_id = ev.organization_id or organization_id is null)
         and trigger ->> 'type' = ev.event
    loop
      v_scope := jsonb_build_object(
        'record',   ev.payload -> 'record',
        'previous', ev.payload -> 'previous',
        'event',    jsonb_build_object('type', ev.event, 'entity', ev.entity, 'entity_table', v_table, 'id', ev.entity_id),
        'rule',     jsonb_build_object('id', r.id, 'name', r.name),
        'org',      jsonb_build_object('id', ev.organization_id)
      );

      -- A record.updated rule may name a field; if it does, the field has to
      -- have actually changed. Otherwise every save fires every rule.
      if ev.event like '%.updated'
         and (r.trigger ? 'field')
         and nullif(r.trigger ->> 'field', '') is not null
         and (ev.payload #> array['record', r.trigger ->> 'field'])
             is not distinct from (ev.payload #> array['previous', r.trigger ->> 'field'])
      then
        continue;
      end if;

      if not private.rule_conditions_pass(r.conditions, v_scope) then
        insert into public.rule_runs (rule_id, status, input, output, duration_ms)
        values (r.id, 'skipped', v_scope, jsonb_build_object('reason', 'conditions did not match'), 0);
        continue;
      end if;

      v_started := clock_timestamp();
      v_results := '[]'::jsonb;

      for a in select * from jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) loop
        v_result := private.rule_run_action(a, v_scope, ev.organization_id);
        v_results := v_results || jsonb_build_object('action', a ->> 'type') || v_result;
        if v_result ->> 'status' = 'failed' then v_failed := true; end if;
      end loop;

      insert into public.rule_runs (rule_id, status, input, output, error, duration_ms)
      values (r.id,
              case when v_failed then 'failed' else 'succeeded' end,
              v_scope,
              jsonb_build_object('actions', v_results),
              case when v_failed then 'one or more actions failed' end,
              greatest(0, (extract(epoch from clock_timestamp() - v_started) * 1000)::integer));

      -- Auto-disable after five consecutive failures. A rule that fails every
      -- time is not going to start working, and left enabled it fills the log
      -- and keeps calling whatever it is failing against.
      if v_failed then
        update public.rules
           set consecutive_fails = consecutive_fails + 1,
               enabled = (consecutive_fails + 1) < 5,
               disabled_reason = case when (consecutive_fails + 1) >= 5
                                      then 'Disabled automatically after 5 consecutive failures' end,
               updated_at = now()
         where id = r.id;
      elsif r.consecutive_fails > 0 then
        update public.rules set consecutive_fails = 0, disabled_reason = null, updated_at = now() where id = r.id;
      end if;

      v_matched := v_matched + 1;
    end loop;

    update public.rule_events
       set status = 'done', processed_at = now()
     where id = ev.id;
  end loop;

  return jsonb_build_object('events', v_events, 'rules_run', v_matched, 'at', now());
exception when others then
  -- One poisonous event must not stop the queue forever. Back it off, and give
  -- up on it after five attempts rather than retrying it for all time.
  if ev.id is not null then
    update public.rule_events
       set status = case when attempts >= 5 then 'dead' else 'pending' end,
           available_at = now() + (interval '1 minute' * power(2, least(attempts, 5))),
           last_error = sqlerrm
     where id = ev.id;
  end if;
  return jsonb_build_object('events', v_events, 'rules_run', v_matched, 'error', sqlerrm);
end;
$$;

revoke execute on function private.rule_run_action(jsonb, jsonb, uuid) from public, anon, authenticated;
revoke execute on function private.drain_rule_events(integer) from public, anon, authenticated;
