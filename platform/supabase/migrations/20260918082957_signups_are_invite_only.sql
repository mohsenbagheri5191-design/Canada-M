-- `app_users_org_required` says a non-super-admin must belong to an
-- organisation, and nothing in a self-signup can supply one that this system
-- would trust. So an uninvited signup cannot become a usable account, and the
-- only question is how it fails.
--
-- Left alone it failed as a CHECK violation, which reaches the caller as an
-- opaque 500 naming a constraint. This makes it explicit: the product is
-- invite-only, and the refusal says so. `viewer` is added to the accepted
-- roles because the table already allows it.

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
  -- Role and organisation come from app_metadata, which only the service role
  -- can write. user_metadata is the signup payload — attacker-controlled — and
  -- may supply nothing but a display name.
  v_role := coalesce(nullif(new.raw_app_meta_data ->> 'app_role', ''), 'app_user');
  if v_role not in ('app_user', 'designer', 'org_admin', 'viewer') then
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

  if v_org is null then
    raise exception 'Accounts here are created by invitation. Ask an administrator to invite %.', new.email
      using errcode = 'insufficient_privilege',
            hint = 'An invitation supplies the organisation; a self-signup cannot.';
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
    coalesce((new.raw_app_meta_data ->> 'must_change_password')::boolean, false)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke execute on function private.provision_app_user() from public, anon, authenticated;
