-- Amazon Market Research Pro - admin reporting RPCs
--
-- Aggregation that would be slow or chatty over PostgREST, expressed once in
-- SQL. Both functions are SECURITY DEFINER (they deliberately read across all
-- users) and are therefore granted to service_role only.
--
-- That grant is the whole security model here: `authenticated` cannot execute
-- them at all, so a non-admin holding a valid JWT gets a permission error even
-- before the Edge Function's own is_admin() check would reject them. Two
-- independent gates, either of which is sufficient.

-- ---------------------------------------------------------------------------
-- admin_user_list
-- ---------------------------------------------------------------------------

create or replace function public.admin_user_list()
returns table (
  id                    uuid,
  email                 text,
  full_name             text,
  role                  text,
  status                text,
  effective_status      text,
  notes                 text,
  access_expires_at     timestamptz,
  monthly_request_quota integer,
  last_active_at        timestamptz,
  created_at            timestamptz,
  created_by            uuid,
  month_usage           integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.email,
    p.full_name,
    p.role,
    p.status,
    public.effective_status(p.status, p.access_expires_at),
    p.notes,
    p.access_expires_at,
    p.monthly_request_quota,
    p.last_active_at,
    p.created_at,
    p.created_by,
    coalesce(u.calls, 0)::integer
  from public.profiles p
  left join (
    select user_id, count(*) as calls
      from public.usage_events
     where billable
       and created_at >= date_trunc('month', now() at time zone 'utc')
     group by user_id
  ) u on u.user_id = p.id
  order by p.created_at desc;
$$;

comment on function public.admin_user_list() is
  'Every profile plus its billable call count for the current UTC month. service_role only.';

revoke all on function public.admin_user_list() from public, anon, authenticated;
grant execute on function public.admin_user_list() to service_role;

-- ---------------------------------------------------------------------------
-- admin_usage_summary
-- ---------------------------------------------------------------------------

-- Returns the whole admin usage view as one jsonb document: headline totals,
-- per-user breakdown, a daily series, endpoint mix and the most requested
-- ASINs. One round trip instead of five.
create or replace function public.admin_usage_summary(p_days integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select
      greatest(1, least(coalesce(p_days, 30), 365)) as days,
      now() - (greatest(1, least(coalesce(p_days, 30), 365)) || ' days')::interval as since
  ),
  scoped as (
    select u.*
      from public.usage_events u, bounds b
     where u.created_at >= b.since
  ),
  totals as (
    select
      count(*)                                            as total_calls,
      count(*) filter (where billable)                    as billable_calls,
      count(*) filter (where response_status >= 400)      as failed_calls,
      count(distinct user_id)                             as active_users,
      coalesce(round(avg(duration_ms))::integer, 0)       as avg_duration_ms,
      coalesce(sum(item_count), 0)::bigint                as total_items
    from scoped
  ),
  per_user as (
    select coalesce(jsonb_agg(x order by x.calls desc), '[]'::jsonb) as data
    from (
      select
        s.user_id                                  as "userId",
        coalesce(p.email, 'deleted account')       as email,
        coalesce(p.full_name, '')                  as "fullName",
        count(*)::integer                          as calls,
        count(*) filter (where s.billable)::integer as billable,
        max(s.created_at)                          as "lastCall"
      from scoped s
      left join public.profiles p on p.id = s.user_id
      group by s.user_id, p.email, p.full_name
    ) x
  ),
  per_day as (
    select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) as data
    from (
      select
        (date_trunc('day', s.created_at at time zone 'utc'))::date as day,
        count(*)::integer                                          as calls
      from scoped s
      group by 1
    ) x
  ),
  per_endpoint as (
    select coalesce(jsonb_agg(x order by x.calls desc), '[]'::jsonb) as data
    from (
      select s.endpoint, count(*)::integer as calls
      from scoped s
      group by s.endpoint
    ) x
  ),
  top_refs as (
    select coalesce(jsonb_agg(x order by x.calls desc), '[]'::jsonb) as data
    from (
      select s.reference, count(*)::integer as calls
      from scoped s
      where s.reference is not null and s.reference <> ''
      group by s.reference
      order by count(*) desc
      limit 20
    ) x
  )
  select jsonb_build_object(
    'windowDays',   (select days from bounds),
    'totals',       (select to_jsonb(t) from totals t),
    'perUser',      (select data from per_user),
    'perDay',       (select data from per_day),
    'perEndpoint',  (select data from per_endpoint),
    'topReferences',(select data from top_refs)
  );
$$;

comment on function public.admin_usage_summary(integer) is
  'Whole admin usage dashboard as one jsonb document. Window clamped to 1-365 days. service_role only.';

revoke all on function public.admin_usage_summary(integer) from public, anon, authenticated;
grant execute on function public.admin_usage_summary(integer) to service_role;
