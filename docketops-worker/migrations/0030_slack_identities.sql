-- 0030_slack_identities.sql — F9 R7a (docket_slack_identities_v1): Slack user → Docket person (spec §9.1).
-- One row per mapped person, written by docketops the first time a Slack user acts (users.info → profile.email
-- → podium.employees.work_email (active) → auth_user_id) and read first on every later action. A Slack action is
-- accepted only from a mapped user; an unmapped one is refused with plain words and nothing else happens.
-- A row is trusted for 7 days (resolved_at); after that, or whenever it is refused (the login inactive, or no
-- longer this employee, or the employee exited), the worker deletes it by slack_user_id and re-resolves from
-- Slack once — so a re-emailed or re-linked account recovers instead of locking out or staying mis-mapped.
-- Rights are always re-derived from auth_user_id at call time (authForUser). Saving clears the slack_user_id
-- first, then upserts on employee_id, so the UNIQUE never 409s.
--
-- `source` audit (R7a): every column the Slack path writes a source into already takes 'slack' —
--   docket.task_history.source           CHECK in ('app','connector','slack','system')  (0024)
--   docket.plan_item_history.source      no CHECK (default = the docket.source setting, else 'app')
--   docket.task_set_deadline(p_source)   accepts app / connector / slack / system
--   docket.plan_proposals, docket.task_comments — no source column
-- so nothing is widened here. (docket.plan_template_apply still takes only app / connector; Slack never applies
-- a template.) test/slack-identities.sql proves each 'slack' write.
--
-- Additive + idempotent. RLS on, no policies, service_role only (the docket convention). Applied by the lane
-- before the worker that reads it deploys.

create table if not exists docket.slack_identities (
  employee_id uuid primary key references podium.employees(id) on delete cascade,
  slack_user_id text not null unique check (slack_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  auth_user_id uuid,
  resolved_at timestamptz not null default now()
);
alter table docket.slack_identities enable row level security;
revoke all on docket.slack_identities from public, anon, authenticated;
grant all on docket.slack_identities to service_role;

notify pgrst, 'reload schema';
