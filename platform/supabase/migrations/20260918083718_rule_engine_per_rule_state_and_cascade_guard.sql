-- Two faults the first working run exposed.
--
-- 1. `v_failed` was reset once per event, not per rule. One failing rule marked
--    every rule processed after it in the same event as failed too — which
--    auto-disabled a perfectly good rule after five events, for someone else's
--    failure. The test caught it because a rule whose only action was *skipped*
--    came back disabled.
--
-- 2. A rule's actions write to the same tables the triggers watch, so a rule's
--    own write enqueues another event. That is correct and useful — a rule
--    should be able to cause another — but nothing bounded it. A rule that sets
--    the field it fires on would enqueue itself forever, at one row per tick,
--    until the table filled.
--
--    Events now carry a depth. A write made while draining inherits the current
--    depth plus one, and past the cap the event is recorded as dead with the
--    reason rather than queued. The cap is deliberately small: a chain longer
--    than this is a mistake in the rules, not a workload.

alter table public.rule_events add column if not exists depth integer not null default 0;

create or replace function private.enqueue_rule_event()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  v_row jsonb; v_old jsonb; v_event text; v_org uuid;
  v_entity text := tg_argv[0];
  v_depth integer := coalesce(nullif(current_setting('app.rule_depth', true), '')::integer, 0);
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old); v_event := v_entity || '.deleted';
  else
    v_row := to_jsonb(new);
    v_old := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
    v_event := v_entity || case when tg_op = 'INSERT' then '.created' else '.updated' end;
  end if;

  v_org := nullif(v_row ->> 'organization_id', '')::uuid;

  if not exists (
    select 1 from public.rules r
     where r.enabled and (r.organization_id = v_org or r.organization_id is null)
       and r.trigger ->> 'type' = v_event
  ) then
    return coalesce(new, old);
  end if;

  if v_depth >= 3 then
    insert into public.rule_events (organization_id, event, entity, entity_id, payload, status, depth, last_error, processed_at)
    values (v_org, v_event, v_entity, v_row ->> 'id', '{}'::jsonb, 'dead', v_depth,
            'cascade depth limit reached; a rule is probably triggering itself', now());
    return coalesce(new, old);
  end if;

  insert into public.rule_events (organization_id, event, entity, entity_id, payload, actor_id, depth)
  values (v_org, v_event, v_entity, v_row ->> 'id',
          jsonb_strip_nulls(jsonb_build_object('record', v_row, 'previous', v_old)),
          auth.uid(), v_depth);

  return coalesce(new, old);
end;
$$;

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
    v_events := v_events + 1;
    v_table := case ev.entity when 'record' then 'records' else ev.entity || 's' end;

    -- Anything these actions write is one level deeper than the event that
    -- caused it, so the enqueue trigger can see the chain it is part of.
    perform set_config('app.rule_depth', (ev.depth + 1)::text, true);

    for r in
      select * from public.rules
       where enabled and (organization_id = ev.organization_id or organization_id is null)
         and trigger ->> 'type' = ev.event
       order by created_at, id
    loop
      -- Per rule, not per event: one rule's failure is not another's.
      v_failed := false;

      v_scope := jsonb_build_object(
        'record', ev.payload -> 'record', 'previous', ev.payload -> 'previous',
        'event', jsonb_build_object('type', ev.event, 'entity', ev.entity, 'entity_table', v_table, 'id', ev.entity_id),
        'rule', jsonb_build_object('id', r.id, 'name', r.name),
        'org', jsonb_build_object('id', ev.organization_id));

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

    perform set_config('app.rule_depth', '0', true);
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

revoke execute on function private.enqueue_rule_event() from public, anon, authenticated;
revoke execute on function private.drain_rule_events(integer) from public, anon, authenticated;
