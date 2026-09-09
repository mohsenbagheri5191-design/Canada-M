-- Amazon Market Research Pro - tighten SECURITY DEFINER function grants
--
-- Supabase's default privileges grant EXECUTE on every new function to anon,
-- authenticated and service_role explicitly. A plain `revoke ... from public`
-- does not remove an explicit role grant, so both helpers stayed callable over
-- PostgREST at /rest/v1/rpc/<name>. The database linter flagged both.
--
-- month_usage(uuid) was the one that actually mattered: it takes an arbitrary
-- user id, so any signed-in user could read any other user's call count for
-- the month. Only the Edge Functions (service_role) ever need it.

revoke all on function public.month_usage(uuid) from public, anon, authenticated;
grant execute on function public.month_usage(uuid) to service_role;

-- is_admin() is different: it is referenced inside the RLS policies on
-- profiles, usage_events, app_settings and audit_log, and policy expressions
-- are evaluated with the querying role's privileges. Revoking EXECUTE from
-- `authenticated` would break every one of those policies, so the grant stays.
--
-- Leaving it callable over RPC is not a leak. It takes no arguments and
-- answers only "is the caller holding this JWT an admin?", which the caller
-- already knows. anon has no such policy to evaluate, so it loses the grant.
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- effective_status() is IMMUTABLE, takes its inputs as arguments and reads
-- nothing, so it leaks nothing regardless of caller.
revoke all on function public.effective_status(text, timestamptz) from public, anon;
grant execute on function public.effective_status(text, timestamptz) to authenticated, service_role;
