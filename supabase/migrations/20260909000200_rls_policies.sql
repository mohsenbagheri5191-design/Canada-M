-- Amazon Market Research Pro - helpers and Row Level Security
--
-- Posture: RLS is on for every table and the default is deny. Regular clients
-- get read-only access to their own profile and their own usage rows, and
-- nothing else. Every write in the product goes through an Edge Function
-- holding the service role key, which bypasses RLS entirely.
--
-- That means the policies below are a backstop, not the primary access
-- control. If the anon key leaks (and it will: it ships in the extension),
-- these policies are what stands between an attacker and the data.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER matters here. is_admin() reads public.profiles, and it is
-- itself used inside public.profiles' own policies. Without DEFINER the inner
-- select would re-trigger the policy and recurse infinitely. Running as the
-- table owner bypasses RLS on that inner read and breaks the cycle.
--
-- `set search_path = ''` plus fully qualified names stops a caller from
-- shadowing `profiles` with a temp table and tricking the function into
-- reading attacker-controlled rows.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id     = (select auth.uid())
       and p.role   = 'admin'
       and p.status = 'active'
       and (p.access_expires_at is null or p.access_expires_at > now())
  );
$$;

comment on function public.is_admin() is
  'True when the calling JWT belongs to an active, unexpired admin. SECURITY DEFINER to avoid RLS recursion on profiles.';

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, service_role;

-- Resolves the status a profile should be treated as *right now*, folding in
-- expiry. A row can sit at 'active' with a past access_expires_at; this is
-- what makes it read as 'expired' without a scheduled job touching the row.
create or replace function public.effective_status(
  p_status     text,
  p_expires_at timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'disabled'                              then 'disabled'
    when p_expires_at is not null and p_expires_at <= now() then 'expired'
    else p_status
  end;
$$;

comment on function public.effective_status(text, timestamptz) is
  'Folds access_expires_at into status so expiry needs no cron job. disabled always wins over expired.';

grant execute on function public.effective_status(text, timestamptz) to authenticated, service_role;

-- Billable research calls used in the current UTC calendar month.
create or replace function public.month_usage(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(count(*), 0)::integer
    from public.usage_events u
   where u.user_id  = p_user_id
     and u.billable
     and u.created_at >= date_trunc('month', now() at time zone 'utc');
$$;

comment on function public.month_usage(uuid) is
  'Billable calls this UTC calendar month. Quota windows reset at 00:00 UTC on the 1st.';

revoke all on function public.month_usage(uuid) from public;
grant execute on function public.month_usage(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.profiles     enable row level security;
alter table public.usage_events enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_log    enable row level security;

-- Note: FORCE ROW LEVEL SECURITY is deliberately NOT set. The table owner must
-- keep bypassing RLS for is_admin()'s SECURITY DEFINER read to work.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

drop policy if exists profiles_select_self  on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_no_insert    on public.profiles;
drop policy if exists profiles_no_update    on public.profiles;
drop policy if exists profiles_no_delete    on public.profiles;

-- A signed-in user may read exactly their own row. Not other users', not a
-- list, not a count.
create policy profiles_select_self
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

-- Admins may read every row: this powers the admin dashboard user list.
create policy profiles_select_admin
  on public.profiles
  for select
  to authenticated
  using (public.is_admin());

-- No insert, update or delete policy exists for authenticated or anon. That is
-- intentional and load-bearing: a user cannot promote themselves to admin,
-- raise their own quota, or re-enable a disabled account, because there is no
-- write path at all outside the service role.

-- ---------------------------------------------------------------------------
-- usage_events
-- ---------------------------------------------------------------------------

drop policy if exists usage_events_select_self  on public.usage_events;
drop policy if exists usage_events_select_admin on public.usage_events;

create policy usage_events_select_self
  on public.usage_events
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy usage_events_select_admin
  on public.usage_events
  for select
  to authenticated
  using (public.is_admin());

-- No insert policy. Only the Edge Functions log usage, via the service role.
-- If users could insert here they could forge their own quota consumption
-- (or, worse, delete rows to reset it).

-- ---------------------------------------------------------------------------
-- app_settings
-- ---------------------------------------------------------------------------

drop policy if exists app_settings_select_admin on public.app_settings;

-- Admins only. Regular users never read this table directly: the kill switch
-- reaches them as a 503 from the Edge Function, which is enough for the UI.
create policy app_settings_select_admin
  on public.app_settings
  for select
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------

drop policy if exists audit_log_select_admin on public.audit_log;

create policy audit_log_select_admin
  on public.audit_log
  for select
  to authenticated
  using (public.is_admin());

-- Append-only by construction: no insert/update/delete policy, so not even an
-- admin can rewrite history through the API. Only the service role writes here.

-- ---------------------------------------------------------------------------
-- Table grants
-- ---------------------------------------------------------------------------

-- Strip everything the `anon` role inherited by default, then hand back only
-- select on the tables that have a policy. Without a JWT, auth.uid() is null,
-- every policy predicate is false, and anon reads return zero rows.
revoke all on public.profiles     from anon, authenticated;
revoke all on public.usage_events from anon, authenticated;
revoke all on public.app_settings from anon, authenticated;
revoke all on public.audit_log    from anon, authenticated;

grant select on public.profiles     to authenticated;
grant select on public.usage_events to authenticated;
grant select on public.app_settings to authenticated;
grant select on public.audit_log    to authenticated;
