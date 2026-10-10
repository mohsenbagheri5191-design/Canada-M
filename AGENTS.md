# Agent notes: Canada-M Workspace

This branch (`claude/admin-dashboard-design-ptn7z5`) holds the Canada-M Workspace: a design
dashboard (`dashboard/`), the server-driven app it controls (`app/`), and their Supabase backend
(`platform/`). **Read [HANDOFF.md](HANDOFF.md) first**: links, access, architecture, status and
next steps.

## Hard rules

- Two products share this repository. Work only in `site/`, `dashboard/`, `app/`, `platform/`,
  `tests/e2e/`, `scripts/build-site.sh`, `.github/workflows/pages.yml`, `netlify.toml` and the
  handoff files. `README.md`, `SECURITY.md`, `SETUP.md`, `.env.example`, `extension/`, `admin/`,
  `supabase/` and the other scripts belong to Amazon Market Research Pro.
- The repository is public. Never commit passwords, tokens, keys or connection strings.
- The Supabase service role key lives only inside Edge Functions.
- The Supabase project for this work is `sxsbeavdmfuznigslfnp`. Never touch
  `amazon-market-research-pro`.
- `org_settings.secrets` is write-only: never read it into a response, a log or a file.
- One component registry and one resolver (`private.resolve_layout`). Do not fork either.
- A database change is a new file in `platform/supabase/migrations/`, applied to the live project
  under the same name. Revoke `EXECUTE` on new functions from both `public` and `anon`.
- Do not merge into, or open pull requests against, the default branch: it is the other product.

## Check your work

```sh
cd tests/e2e && npm install && npm test                            # no network or credentials
psql "<connection string>" -f platform/supabase/tests/verify.sql   # after database changes
```

A push to this branch deploys to https://mohsenbagheri5191-design.github.io/Canada-M/ through the
Pages workflow; check it at https://github.com/mohsenbagheri5191-design/Canada-M/actions.
