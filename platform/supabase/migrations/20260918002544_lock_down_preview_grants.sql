-- `revoke ... from public` is not enough on Supabase.
--
-- The earlier finding in this project was that Postgres grants EXECUTE to
-- PUBLIC, so revoking from anon alone does nothing. This is the mirror image:
-- Supabase's default privileges grant EXECUTE and table rights to the `anon`
-- and `authenticated` roles *explicitly*, so revoking from PUBLIC alone leaves
-- those named grants in place. Both revokes are needed, every time.
--
-- Neither was exploitable — the functions check the caller themselves and the
-- table is behind RLS with no policy for anon — but a grant nobody intended is
-- one refactor away from being the only thing that was holding.

revoke execute on function public.issue_preview_token(uuid, integer, text) from public, anon;
revoke execute on function public.revoke_preview_token(text) from public, anon;

grant execute on function public.issue_preview_token(uuid, integer, text) to authenticated;
grant execute on function public.revoke_preview_token(text) to authenticated;

-- resolve_preview keeps its anon grant on purpose: a review link is meant to
-- open without an account, and the token is the credential.

-- The token column is the credential, so anon has no business reading the
-- table at any grant level, RLS or not.
revoke all on table public.preview_tokens from anon;
grant select, insert, update, delete on table public.preview_tokens to authenticated;
