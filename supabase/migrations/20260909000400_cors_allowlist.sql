-- Amazon Market Research Pro - database-backed CORS allowlist
--
-- The Edge Functions prefer the ALLOWED_ORIGINS secret and fall back to this
-- column when it is unset. Keeping a copy in the database means the allowlist
-- can be changed with a single UPDATE (or from the admin dashboard) when a new
-- extension build changes its ID, with no redeploy and no downtime.
--
-- This is configuration, not a credential. It is readable by admins through
-- app_settings' existing RLS policy and by nobody else.

alter table public.app_settings
  add column if not exists allowed_origins text not null default '';

comment on column public.app_settings.allowed_origins is
  'Comma-separated CORS allowlist used when the ALLOWED_ORIGINS secret is unset. Use the literal __no_origin__ entry to permit requests that send no Origin header.';
