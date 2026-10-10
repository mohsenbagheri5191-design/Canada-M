-- Close the SECURITY DEFINER exposure the linter found.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and PUBLIC includes
-- anon. Revoking from anon and authenticated individually, as the earlier
-- migration did, leaves that inherited PUBLIC grant in place — so
-- resolve_layout(uuid) was reachable at /rest/v1/rpc/resolve_layout by anyone
-- holding the anon key, for any user id they cared to guess. That is a real
-- cross-tenant read, not a style warning.
--
-- Two fixes:
--   * the dangerous function moves to a schema PostgREST does not expose, so
--     it cannot be called over RPC at all regardless of grants;
--   * everything else is revoked from PUBLIC and granted back only to the role
--     that genuinely needs it.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Move the arbitrary-user resolver out of reach.
-- ---------------------------------------------------------------------------

alter function public.resolve_layout(uuid) set schema private;

-- ---------------------------------------------------------------------------
-- The wrappers stay in public because the app and dashboard call them, but
-- they now dispatch to the private one.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_my_layout()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.resolve_layout(auth.uid())
$$;

create or replace function public.resolve_layout_as_admin(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org
    from public.app_users where id = p_user_id;

  if not public.is_super_admin()
     and not (public.can_admin() and v_org = public.current_org()) then
    raise exception 'not authorised to resolve this user' using errcode = '42501';
  end if;

  return private.resolve_layout(p_user_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke the inherited PUBLIC grant, then grant deliberately.
--
-- The five helpers stay callable by authenticated because RLS policy
-- expressions are evaluated as the querying role and reference them. They leak
-- nothing: each one reports a fact about the caller's own row.
-- ---------------------------------------------------------------------------

revoke execute on function public.current_app_role()             from public, anon;
revoke execute on function public.current_org()                  from public, anon;
revoke execute on function public.is_super_admin()               from public, anon;
revoke execute on function public.can_admin()                    from public, anon;
revoke execute on function public.can_design()                   from public, anon;
revoke execute on function public.resolve_my_layout()            from public, anon;
revoke execute on function public.resolve_layout_as_admin(uuid)  from public, anon;
revoke execute on function private.resolve_layout(uuid)          from public, anon, authenticated;
revoke execute on function public.touch_updated_at()             from public, anon, authenticated;
revoke execute on function public.guard_published_version()      from public, anon, authenticated;

grant execute on function public.current_app_role()            to authenticated;
grant execute on function public.current_org()                 to authenticated;
grant execute on function public.is_super_admin()              to authenticated;
grant execute on function public.can_admin()                   to authenticated;
grant execute on function public.can_design()                  to authenticated;
grant execute on function public.resolve_my_layout()           to authenticated;
grant execute on function public.resolve_layout_as_admin(uuid) to authenticated;

-- Anything added to private later is closed by default rather than open.
alter default privileges in schema private revoke execute on functions from public;
