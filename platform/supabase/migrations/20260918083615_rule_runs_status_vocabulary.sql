-- `rule_runs.status` is 'success' | 'failed' | 'skipped'. The worker wrote
-- 'succeeded', which the CHECK refused — so every successful run raised, the
-- exception handler quarantined the event, and the engine looked like it was
-- silently skipping rules. The queue's poison handling worked exactly as
-- designed, which is the only reason nothing was lost.
--
-- Two places said what a run status is. Now one does, and the schema wins.

create or replace function private.drain_rule_events(p_limit integer default 50)
returns jsonb language plpgsql volatile security definer set search_path to '' as $$
declare
  ev public.rule_events; r public.rules; v_scope jsonb; v_started timestamptz;
  v_results jsonb; v_result jsonb; a jsonb; v_failed boolean;
  v_matched integer := 0; v_events integer := 0; v_table text;
begin
  for ev in
    select * from public.rule_events
     where status = 'pending' and available_at <= now()
     order by id limit greatest(1, least(p_limit, 500)) for update skip locked
  loop
    update public.rule_events set status = 'running', attempts = attempts + 1 where id = ev.id;
    v_events := v_events + 1; v_failed := false;
    v_table := case ev.entity when 'record' then 'records' else ev.entity || 's' end;

    for r in
      select * from public.rules
       where enabled and (organization_id = ev.organization_id or organization_id is null)
         and trigger ->> 'type' = ev.event
    loop
      v_scope := jsonb_build_object(
        'record', ev.payload -> 'record', 'previous', ev.payload -> 'previous',
        'event', jsonb_build_object('type', ev.event, 'entity', ev.entity, 'entity_table', v_table, 'id', ev.entity_id),
        'rule', jsonb_build_object('id', r.id, 'name', r.name),
        'org', jsonb_build_object('id', ev.organization_id));

      -- An `.updated` rule may name a field; if it does, that field has to have
      -- actually changed, or every save fires every rule.
      if ev.event like '%.updated' and (r.trigger ? 'field')
         and nullif(r.trigger ->> 'field', '') is not null
         and (ev.payload #> array['record', r.trigger ->> 'field'])
             is not distinct from (ev.payload #> array['previous', r.trigger ->> 'field'])
      then continue; end if;

      if not private.rule_conditions_pass(r.conditions, v_scope) then
        insert into public.rule_runs (rule_id, status, input, output, duration_ms)
        values (r.id, 'skipped', v_scope, jsonb_build_object('reason', 'conditions did not match'), 0);
        continue;
      end if;

      v_started := clock_timestamp(); v_results := '[]'::jsonb;

      for a in select * from jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) loop
        v_result := private.rule_run_action(a, v_scope, ev.organization_id);
        v_results := v_results || jsonb_build_array(jsonb_build_object('action', a ->> 'type') || v_result);
        if v_result ->> 'status' = 'failed' then v_failed := true; end if;
      end loop;

      insert into public.rule_runs (rule_id, status, input, output, error, duration_ms)
      values (r.id, case when v_failed then 'failed' else 'success' end, v_scope,
              jsonb_build_object('actions', v_results),
              case when v_failed then 'one or more actions failed' end,
              greatest(0, (extract(epoch from clock_timestamp() - v_started) * 1000)::integer));

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

    update public.rule_events set status = 'done', processed_at = now() where id = ev.id;
  end loop;

  return jsonb_build_object('events', v_events, 'rules_run', v_matched, 'at', now());
exception when others then
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

-- The scheduler looked for the same wrong word.
create or replace function private.enqueue_scheduled_rules()
returns integer language plpgsql volatile security definer set search_path to '' as $$
declare r public.rules; v_every integer; v_last timestamptz; v_count integer := 0;
begin
  for r in select * from public.rules where enabled and trigger ->> 'type' = 'schedule' loop
    v_every := greatest(coalesce((r.trigger ->> 'every_minutes')::integer, 60), 1);
    select max(occurred_at) into v_last
      from public.rule_runs where rule_id = r.id and status in ('success', 'failed');
    if v_last is null or v_last <= now() - make_interval(mins => v_every) then
      insert into public.rule_events (organization_id, event, entity, entity_id, payload)
      values (r.organization_id, 'schedule', 'schedule', r.id::text,
              jsonb_build_object('record', jsonb_build_object('rule_id', r.id, 'at', now())));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke execute on function private.drain_rule_events(integer) from public, anon, authenticated;
revoke execute on function private.enqueue_scheduled_rules() from public, anon, authenticated;
