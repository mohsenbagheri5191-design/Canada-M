-- Provisioning, rewritten against two facts the first version got wrong.
--
-- 1. `app_users.id` references `auth.users(id)`, so an app_users row cannot
--    exist before the auth account. An invitation therefore creates the auth
--    user first — through an Edge Function holding the service role — and this
--    trigger builds the app_users row from it. There is no "adopt an existing
--    invited row" path: it cannot happen, and ON DELETE CASCADE means a stale
--    row cannot survive its auth user either.
--
-- 2. **`raw_user_meta_data` is attacker-controlled.** It is whatever the signup
--    request put in `options.data`, so a self-signup could have asked for
--    `role: 'super_admin'` and the first version would have granted it.
--    `raw_app_meta_data` is the opposite: only the service role can write it.
--    So role and organisation are read from app_metadata only, and
--    user_metadata may supply nothing but a display name.
--
-- A self-signup therefore lands with role 'app_user' and no organisation: they
-- can sign in and see nothing, which is correct, visible, and recoverable by an
-- admin. Silently placing them in a tenant would not be.

create or replace function private.provision_app_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_org  uuid;
  v_role text;
begin
  -- Only roles that exist, and never super_admin from metadata: that one is
  -- granted by hand, in the database, deliberately.
  v_role := coalesce(nullif(new.raw_app_meta_data ->> 'app_role', ''), 'app_user');
  if v_role not in ('app_user', 'designer', 'org_admin') then
    v_role := 'app_user';
  end if;

  select id into v_org
    from public.organizations
   where id = nullif(new.raw_app_meta_data ->> 'organization_id', '')::uuid
     and status = 'active';

  if v_org is null then
    select id into v_org
      from public.organizations
     where slug = nullif(new.raw_app_meta_data ->> 'org_slug', '')
       and status = 'active';
  end if;

  insert into public.app_users (id, organization_id, email, full_name, role, status, must_change_password)
  values (
    new.id,
    v_org,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_app_meta_data ->> 'full_name', ''),
      split_part(new.email, '@', 1)),
    v_role,
    case when new.email_confirmed_at is null then 'invited' else 'active' end,
    -- An invited account is given a password it did not choose, so it must
    -- choose one. A self-signup already chose theirs.
    coalesce((new.raw_app_meta_data ->> 'must_change_password')::boolean, false)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke execute on function private.provision_app_user() from public, anon, authenticated;

-- A person must not be able to promote themselves or move tenant by writing to
-- their own row. RLS on app_users permits self-update for profile fields, so
-- the columns that decide authority are pinned by a trigger instead.
create or replace function private.guard_app_user_authority()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- Anything running as the service role, or as a definer function that has
  -- already checked the caller, is left alone.
  if auth.uid() is null or auth.uid() <> new.id then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'a user cannot change their own role' using errcode = 'insufficient_privilege';
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'a user cannot change their own organisation' using errcode = 'insufficient_privilege';
  end if;
  if new.status is distinct from old.status then
    raise exception 'a user cannot change their own status' using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_app_user_authority on public.app_users;
create trigger guard_app_user_authority
  before update on public.app_users
  for each row execute function private.guard_app_user_authority();

revoke execute on function private.guard_app_user_authority() from public, anon, authenticated;
