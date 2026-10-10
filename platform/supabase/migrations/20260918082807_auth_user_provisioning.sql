-- Linking auth.users to app_users.
--
-- Two tables hold a person: `auth.users` is Supabase's, holding the password
-- and the session; `app_users` is ours, holding the tenant, the role and the
-- status. Nothing kept them in step, so a person created through Supabase Auth
-- had no app_users row, `current_org()` returned null, and every RLS policy
-- refused them — an account that signs in successfully and then sees nothing,
-- which is the worst failure mode available because it looks like data loss.
--
-- The trigger closes that. It runs on insert into auth.users and either adopts
-- an existing invited row (matched on email) or creates one.
--
-- The invite path matters: an admin invites someone by creating an app_users
-- row with status 'invited' before any auth.users row exists. When that person
-- accepts, Supabase creates the auth row with a *new* uuid, and the two would
-- otherwise never meet. Adoption re-points the app_users row at the auth id so
-- the tenant and role the admin chose survive.

create or replace function private.provision_app_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_invited public.app_users;
  v_org     uuid;
begin
  -- An invited row for this email, not yet linked to a real account.
  select * into v_invited
    from public.app_users
   where lower(email) = lower(new.email)
     and deleted_at is null
   order by created_at
   limit 1;

  if found then
    if v_invited.id = new.id then
      return new; -- already linked
    end if;

    -- Re-point the invitation at the account that just accepted it. The id is
    -- the primary key, so this moves every row that referenced them too; the
    -- foreign keys are ON UPDATE CASCADE for exactly this.
    update public.app_users
       set id = new.id,
           status = 'active',
           last_login_at = now(),
           updated_at = now()
     where id = v_invited.id;

    return new;
  end if;

  -- No invitation. Take the organisation from the sign-up metadata when it
  -- names one that exists, and otherwise leave it null — a user with no
  -- organisation can sign in and sees nothing, which is correct and visible,
  -- rather than being quietly dropped into somebody else's tenant.
  select id into v_org
    from public.organizations
   where slug = nullif(new.raw_user_meta_data ->> 'org_slug', '')
     and status = 'active';

  insert into public.app_users (id, organization_id, email, full_name, role, status, must_change_password)
  values (
    new.id,
    v_org,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    'app_user',
    case when new.email_confirmed_at is null then 'invited' else 'active' end,
    false
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.provision_app_user();

-- Sign-in bookkeeping. last_sign_in_at moving is the only reliable signal that
-- a session was actually established.
create or replace function private.record_sign_in()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
    update public.app_users
       set last_login_at = new.last_sign_in_at,
           session_count = session_count + 1,
           status = case when status = 'invited' then 'active' else status end,
           updated_at = now()
     where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_signed_in on auth.users;
create trigger on_auth_user_signed_in
  after update on auth.users
  for each row execute function private.record_sign_in();

revoke execute on function private.provision_app_user() from public, anon, authenticated;
revoke execute on function private.record_sign_in() from public, anon, authenticated;

-- What the app calls once a forced password change is done. It cannot write
-- must_change_password directly: the column decides whether the app lets them
-- past the change screen, so a client that could clear it could skip it.
create or replace function public.complete_password_change()
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  update public.app_users
     set must_change_password = false, updated_at = now()
   where id = auth.uid();
  return found;
end;
$$;

revoke execute on function public.complete_password_change() from public, anon;
grant execute on function public.complete_password_change() to authenticated;
