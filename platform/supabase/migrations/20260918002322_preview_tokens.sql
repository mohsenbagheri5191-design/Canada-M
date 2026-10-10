create table if not exists public.preview_tokens (
  token             text primary key,
  design_version_id uuid not null references public.design_versions(id) on delete cascade,
  organization_id   uuid references public.organizations(id) on delete cascade,
  label             text,
  created_by        uuid references public.app_users(id) on delete set null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  last_used_at      timestamptz,
  use_count         integer not null default 0,
  constraint preview_tokens_expiry_bounded check (expires_at > created_at and expires_at <= created_at + interval '30 days')
);

comment on table public.preview_tokens is
  'Share links for an unpublished design version. The token is the whole credential: unguessable, expiring, revocable.';

create index if not exists preview_tokens_version_idx on public.preview_tokens (design_version_id);
create index if not exists preview_tokens_live_idx on public.preview_tokens (expires_at) where revoked_at is null;

alter table public.preview_tokens enable row level security;

drop policy if exists preview_tokens_read on public.preview_tokens;
create policy preview_tokens_read on public.preview_tokens
  for select to authenticated
  using (public.is_super_admin() or organization_id = public.current_org());

drop policy if exists preview_tokens_write on public.preview_tokens;
create policy preview_tokens_write on public.preview_tokens
  for all to authenticated
  using (public.can_design() and (public.is_super_admin() or organization_id = public.current_org()))
  with check (public.can_design() and (public.is_super_admin() or organization_id = public.current_org()));

create or replace function public.issue_preview_token(
  p_design_version_id uuid,
  p_hours integer default 24,
  p_label text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_org   uuid;
  v_token text;
  v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 720);
begin
  select d.organization_id into v_org
    from public.design_versions v
    join public.designs d on d.id = v.design_id
   where v.id = p_design_version_id;

  if not found then
    raise exception 'design version not found' using errcode = 'no_data_found';
  end if;

  if not (public.is_super_admin() or (public.can_design() and v_org is not distinct from public.current_org())) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');

  insert into public.preview_tokens (token, design_version_id, organization_id, label, created_by, expires_at)
  values (v_token, p_design_version_id, v_org, p_label, auth.uid(), now() + make_interval(hours => v_hours));

  insert into public.audit_log (actor_id, actor_email, organization_id, action, entity_type, entity_id, phrase)
  select auth.uid(), u.email, v_org, 'preview.issue', 'DesignVersion', p_design_version_id::text,
         format('issued a %s hour preview link', v_hours)
    from public.app_users u where u.id = auth.uid();

  return jsonb_build_object('token', v_token, 'expiresAt', now() + make_interval(hours => v_hours));
end;
$$;

create or replace function public.revoke_preview_token(p_token text)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.preview_tokens where token = p_token;
  if not found then return false; end if;

  if not (public.is_super_admin() or (public.can_design() and v_org is not distinct from public.current_org())) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  update public.preview_tokens set revoked_at = now() where token = p_token and revoked_at is null;
  return found;
end;
$$;

create or replace function public.resolve_preview(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_row      public.preview_tokens;
  v_version  public.design_versions;
  v_design   public.designs;
  v_settings jsonb := '{}'::jsonb;
begin
  select * into v_row from public.preview_tokens where token = p_token;
  if not found then
    return jsonb_build_object('error', 'invalid');
  end if;
  if v_row.revoked_at is not null then
    return jsonb_build_object('error', 'revoked');
  end if;
  if v_row.expires_at <= now() then
    return jsonb_build_object('error', 'expired');
  end if;

  select * into v_version from public.design_versions where id = v_row.design_version_id;
  if not found then
    return jsonb_build_object('error', 'missing');
  end if;

  select * into v_design from public.designs where id = v_version.design_id;

  select coalesce(s.settings, '{}'::jsonb) into v_settings
    from public.org_settings s
   where s.organization_id = v_row.organization_id;

  update public.preview_tokens
     set last_used_at = now(), use_count = use_count + 1
   where token = p_token;

  return jsonb_build_object(
    'designVersionId', v_version.id,
    'designName',      v_design.name,
    'versionNumber',   v_version.version_number,
    'schemaVersion',   v_version.schema_version,
    'screens',         coalesce(v_version.document -> 'screens', '[]'::jsonb),
    'theme',           v_version.theme,
    'features',        '[]'::jsonb,
    'strippedScreens', '[]'::jsonb,
    'settings',        jsonb_build_object(
                         'appName',  v_settings ->> 'appName',
                         'locale',   v_settings ->> 'locale',
                         'timezone', v_settings ->> 'timezone'),
    'organization',    jsonb_build_object('id', v_row.organization_id),
    'preview',         true
  );
end;
$$;

revoke execute on function public.issue_preview_token(uuid, integer, text) from public;
revoke execute on function public.revoke_preview_token(text) from public;
revoke execute on function public.resolve_preview(text) from public;

grant execute on function public.issue_preview_token(uuid, integer, text) to authenticated;
grant execute on function public.revoke_preview_token(text) to authenticated;
grant execute on function public.resolve_preview(text) to anon, authenticated;
