# Migrations

Supabase's own migration history is authoritative. This file lists what is
applied and why, because the reasoning is the part that does not survive in a
schema dump.

To vendor the SQL itself:

```sh
supabase link --project-ref sxsbeavdmfuznigslfnp
supabase db pull            # writes supabase/migrations/*.sql
```

| # | Migration | What it does |
|---|---|---|
| 1 | `core_tenancy_and_users` | `organizations`, `app_users`, `org_settings`, `audit_log` |
| 2 | `designs_versions_assignments` | `designs`, `design_versions`, `routes`, `design_assignments`, `path_events` |
| 3 | `app_data_features_rules` | `features`, `collections`, `records`, `entity_configs`, `rules`, `rule_runs` |
| 4 | `domain_projects_tasks_notes` | `projects`, `tasks`, `notes`, `customers`, `jobs` |
| 5 | `row_level_security` | RLS on every table, role helpers, per-tenant policies |
| 6 | `resolve_layout` | the resolution rule and its two callable wrappers |
| 7 | `lock_down_function_execute` | closes the default `PUBLIC` grant on every definer function |
| 8 | `preview_tokens` | share links for an unpublished version, and the anon resolver behind them |
| 9 | `lock_down_preview_grants` | closes the *named* `anon` grants Supabase adds on top of `PUBLIC` |
| 10 | `entity_configs_seed_and_data_sources` | describes `tasks`, `notes`, `projects` as the allowlist a layout may query |
| 11 | `resolve_layout_returns_data_sources` | the resolver returns that allowlist with the layout |
| 12 | `entity_configs_match_check_constraints` | corrects enum options that did not match the tables' own CHECKs |
| 13 | `auth_user_provisioning` | first attempt at linking `auth.users` to `app_users` |
| 14 | `app_users_id_cascades_on_update` | every FK to `app_users.id` cascades on update |
| 15 | `auth_provisioning_trusts_app_metadata_only` | role and tenant read from `app_metadata`, never `user_metadata` |
| 16 | `signups_are_invite_only` | an uninvited signup is refused with a sentence, not a constraint violation |
| 17 | `enable_job_extensions` | `pg_cron`, `pg_net` |
| 18 | `rule_event_queue` | `rule_events`, and the table triggers that fill it |
| 19 | `rule_engine_evaluate_and_execute` | condition evaluation matching the renderer's operators |
| 20 | `rule_engine_actions_and_worker` | the action executor and the queue drain |
| 21 | `rule_scheduler` | scheduled rules, housekeeping, and the every-minute cron |
| 22 | `fix_audit_entity_id_type_and_action_log` | `audit_log.entity_id` is uuid, not text |
| 23 | `rule_runs_status_vocabulary` | `success`, not `succeeded` |
| 24 | `rule_engine_per_rule_state_and_cascade_guard` | per-rule failure state, and a depth cap on rule-triggered cascades |

---

## The findings worth carrying forward

**Revoking a grant takes two statements, not one.** Postgres grants `EXECUTE`
on a new function to `PUBLIC`, so `revoke ... from anon` alone does nothing
(migration 7). Supabase *also* grants to the `anon` and `authenticated` roles by
name, so `revoke ... from public` alone does nothing either (migration 9). A
function is closed only when both have run. `verify.sql` asserts it.

**`raw_user_meta_data` is attacker-controlled.** It is whatever the signup
request put in `options.data`. The first provisioning trigger read the new
user's role and organisation from it, so a self-signup could have asked for
`super_admin` and been given it. Authority is now read only from
`raw_app_meta_data`, which only the service role can write (migration 15).

**An invited row cannot predate its auth account.** `app_users.id` references
`auth.users(id)`, so the "create the app_users row, then let them accept" design
is impossible here. Invitations create the auth user first, through the
`invite-user` Edge Function, and the trigger builds the app row from its
`app_metadata`.

**A rule's own writes re-enter the queue.** That is useful — a rule should be
able to cause another — but two rules that undo each other would loop forever.
Events carry a depth, writes made while draining inherit depth + 1, and past 3
the event is dead-lettered with the reason (migration 24).

**Two places naming the same thing will disagree.** `rule_runs.status` allows
`success`; the worker wrote `succeeded`. Every successful run raised, the
exception handler quarantined the event, and the engine looked like it was
silently skipping rules (migration 23). The queue's poison handling is the only
reason nothing was lost.
