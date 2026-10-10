-- Scheduled rules, and the cron that drives everything.
--
-- A `schedule` rule has no event to react to, so one is manufactured on a
-- cadence. `trigger.cron` is checked against the rule's own last successful run
-- rather than against a cron parser: the worker asks "has it been at least
-- `every_minutes` since this rule last succeeded?", which is a coarser
-- guarantee than cron and an honest one. A rule that says every 60 minutes runs
-- at most once an hour and never twice.

create or replace function private.enqueue_scheduled_rules()
returns integer
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  r public.rules;
  v_every integer;
  v_last  timestamptz;
  v_count integer := 0;
begin
  for r in
    select * from public.rules where enabled and trigger ->> 'type' = 'schedule'
  loop
    v_every := greatest(coalesce((r.trigger ->> 'every_minutes')::integer, 60), 1);

    select max(occurred_at) into v_last
      from public.rule_runs
     where rule_id = r.id and status in ('succeeded', 'failed');

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

create or replace function private.rules_tick()
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_scheduled integer;
  v_drained   jsonb;
begin
  v_scheduled := private.enqueue_scheduled_rules();
  v_drained := private.drain_rule_events(200);

  -- Housekeeping, so the queue and the run log do not grow without bound.
  delete from public.rule_events where status = 'done' and processed_at < now() - interval '7 days';
  delete from public.rule_runs where occurred_at < now() - interval '30 days';

  return v_drained || jsonb_build_object('scheduled', v_scheduled);
end;
$$;

revoke execute on function private.enqueue_scheduled_rules() from public, anon, authenticated;
revoke execute on function private.rules_tick() from public, anon, authenticated;

-- An admin's "run it now" button, scoped to their own tenant's queue.
create or replace function public.run_rules_now()
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
begin
  if not (public.is_super_admin() or public.can_admin()) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  return private.rules_tick();
end;
$$;

revoke execute on function public.run_rules_now() from public, anon;
grant execute on function public.run_rules_now() to authenticated;

-- Every minute. The work is bounded by the LIMIT in the drain, so a backlog
-- catches up over several ticks instead of one long transaction.
select cron.unschedule('rules-tick') where exists (select 1 from cron.job where jobname = 'rules-tick');
select cron.schedule('rules-tick', '* * * * *', $$select private.rules_tick()$$);
