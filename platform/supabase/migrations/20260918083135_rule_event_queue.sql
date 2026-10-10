-- The event queue.
--
-- Rules fire on things that happen. Firing them inside the statement that
-- caused the event would mean a slow webhook holds a user's save open, and a
-- failing rule rolls back the write that triggered it — the tail wagging the
-- dog. So the trigger does one cheap insert and returns, and a worker drains
-- the queue out of band.
--
-- The queue is also what makes "at least once" honest. A row is claimed with
-- FOR UPDATE SKIP LOCKED, so two workers never take the same event, and an
-- event that dies mid-flight is still there to retry rather than lost.

create table if not exists public.rule_events (
  id              bigserial primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  event           text not null,
  entity          text not null,
  entity_id       text,
  payload         jsonb not null default '{}'::jsonb,
  actor_id        uuid references public.app_users(id) on update cascade on delete set null,
  status          text not null default 'pending',
  attempts        integer not null default 0,
  last_error      text,
  available_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  processed_at    timestamptz,

  constraint rule_events_status_check check (status in ('pending', 'running', 'done', 'failed', 'dead'))
);

comment on table public.rule_events is
  'Work queue for the rules engine. Written by table triggers, drained by private.drain_rule_events().';

create index if not exists rule_events_claimable_idx
  on public.rule_events (available_at, id) where status = 'pending';
create index if not exists rule_events_org_idx on public.rule_events (organization_id, created_at desc);

alter table public.rule_events enable row level security;

-- Admins may watch their own tenant's queue. Nobody writes it from a client:
-- events come from triggers, which run as the table owner.
drop policy if exists rule_events_read on public.rule_events;
create policy rule_events_read on public.rule_events
  for select to authenticated
  using (public.is_super_admin() or (public.can_admin() and organization_id = public.current_org()));

revoke all on table public.rule_events from anon;
grant select on table public.rule_events to authenticated;
grant usage, select on sequence public.rule_events_id_seq to authenticated;

-- ---------------------------------------------------------------------------
-- Enqueueing
-- ---------------------------------------------------------------------------

create or replace function private.enqueue_rule_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_row    jsonb;
  v_old    jsonb;
  v_event  text;
  v_org    uuid;
  v_entity text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
    v_event := v_entity || '.deleted';
  else
    v_row := to_jsonb(new);
    v_old := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
    v_event := v_entity || case when tg_op = 'INSERT' then '.created' else '.updated' end;
  end if;

  v_org := nullif(v_row ->> 'organization_id', '')::uuid;

  -- No rules for this tenant and event means no reason to queue anything. This
  -- is the difference between a queue that stays empty on a busy system and one
  -- that fills with work nobody asked for.
  if not exists (
    select 1 from public.rules r
     where r.enabled
       and (r.organization_id = v_org or r.organization_id is null)
       and r.trigger ->> 'type' = v_event
  ) then
    return coalesce(new, old);
  end if;

  insert into public.rule_events (organization_id, event, entity, entity_id, payload, actor_id)
  values (
    v_org,
    v_event,
    v_entity,
    v_row ->> 'id',
    jsonb_strip_nulls(jsonb_build_object('record', v_row, 'previous', v_old)),
    auth.uid()
  );

  return coalesce(new, old);
end;
$$;

revoke execute on function private.enqueue_rule_event() from public, anon, authenticated;

-- Wire the tables a rule can currently fire on. `records` is the JSONB store the
-- dashboard invents types in; the rest are the real domain tables.
do $$
declare t text;
begin
  foreach t in array array['records', 'tasks', 'notes', 'projects', 'jobs', 'customers'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists rule_events_%1$s on public.%1$s', t);
    execute format(
      'create trigger rule_events_%1$s after insert or update or delete on public.%1$s
         for each row execute function private.enqueue_rule_event(%2$L)',
      t, case when t = 'records' then 'record' else rtrim(t, 's') end);
  end loop;
end $$;
