-- F9 R7a (migration 0030) — docket.slack_identities: the shape (PK person, unique Slack id, its format, FK on
-- delete cascade, the upsert the worker does), RLS + grants, and that every `source` the Slack path writes takes
-- 'slack' (task_history's CHECK, plan_item_history's docket.source default, task_set_deadline's gate; proposals and
-- comments carry no source). One DO block that always rolls back (ends by raising RESULT …). Before 0030 is
-- applied it runs the migration inside the block (execute $mig$ … $mig$, generated verbatim from
-- migrations/0030_slack_identities.sql); after, it only checks. Run via execute_sql.
-- EXPECT: 1:1,stamped,dup_slack,dup_emp,fk,bad_id,UZZTEST09  2:c,true,false,false,true
--   3:task_history,checked,plan_item_history=slack,set_deadline,0
do $slackid$
declare
  E1 uuid; E2 uuid; v_task uuid; v_item uuid; v_src text; out text := '';
begin
  if to_regclass('docket.slack_identities') is null then
    execute $mig$
-- 0030_slack_identities.sql — F9 R7a (docket_slack_identities_v1): Slack user → Docket person (spec §9.1).
-- One row per mapped person, written by docketops the first time a Slack user acts (users.info → profile.email
-- → podium.employees.work_email (active) → auth_user_id) and read first on every later action. A Slack action is
-- accepted only from a mapped user; an unmapped one is refused with plain words and nothing else happens.
-- Stale rows are harmless: every action re-derives the person's Docket rights from auth_user_id at call time
-- (authForUser — an inactive login is refused even with a cached row).
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
$mig$;
  end if;
  -- two active people with no Slack row yet (so nothing live is touched, even inside the rolled-back block)
  select id into E1 from podium.employees e where status = 'active' and not exists (select 1 from docket.slack_identities s where s.employee_id = e.id) order by id limit 1;
  select id into E2 from podium.employees e where status = 'active' and not exists (select 1 from docket.slack_identities s where s.employee_id = e.id) order by id offset 1 limit 1;
  if E2 is null then raise exception 'RESULT fixture: need two active people without a Slack row'; end if;
  -- ── 1. shape: PK employee, unique Slack id, FK → podium.employees on delete cascade, RLS on, service_role only ──
  insert into docket.slack_identities (employee_id, slack_user_id, auth_user_id) values (E1, 'UZZTEST01', gen_random_uuid());
  out := out || '1:' || (select count(*) from docket.slack_identities where employee_id = E1)
    || ',' || (select case when resolved_at is not null then 'stamped' else 'NOSTAMP' end from docket.slack_identities where employee_id = E1);
  begin insert into docket.slack_identities (employee_id, slack_user_id) values (E2, 'UZZTEST01'); out := out || ',DUPOK';
  exception when unique_violation then out := out || ',dup_slack'; end;
  begin insert into docket.slack_identities (employee_id, slack_user_id) values (E1, 'UZZTEST02'); out := out || ',DUPOK';
  exception when unique_violation then out := out || ',dup_emp'; end;
  begin insert into docket.slack_identities (employee_id, slack_user_id) values (gen_random_uuid(), 'UZZTEST03'); out := out || ',FKOK';
  exception when foreign_key_violation then out := out || ',fk'; end;
  begin insert into docket.slack_identities (employee_id, slack_user_id) values (E2, 'not a slack id'); out := out || ',CHKOK';
  exception when check_violation then out := out || ',bad_id'; end;
  -- re-resolving the same person upserts (the worker's merge-duplicates on employee_id)
  insert into docket.slack_identities (employee_id, slack_user_id) values (E1, 'UZZTEST09')
    on conflict (employee_id) do update set slack_user_id = excluded.slack_user_id, resolved_at = now();
  out := out || ',' || (select slack_user_id from docket.slack_identities where employee_id = E1);
  out := out || '  2:' || (select confdeltype::text from pg_constraint where conrelid = 'docket.slack_identities'::regclass and contype = 'f')
    || ',' || (select relrowsecurity from pg_class where oid = 'docket.slack_identities'::regclass)
    || ',' || has_table_privilege('anon', 'docket.slack_identities', 'select')
    || ',' || has_table_privilege('authenticated', 'docket.slack_identities', 'insert')
    || ',' || has_table_privilege('service_role', 'docket.slack_identities', 'insert');

  -- ── 3. every source the Slack path writes takes 'slack' ──
  v_task := (select id from docket.tasks order by created_at limit 1);
  if v_task is null then raise exception 'RESULT fixture: no task to hang a history row on'; end if;
  begin
    insert into docket.task_history (task_id, actor_user_id, event_type, source) values (v_task, gen_random_uuid(), 'zz_slack_probe', 'slack');
    out := out || '  3:task_history';
  exception when check_violation then out := out || '  3:TASK_HISTORY_REFUSES_SLACK'; end;
  begin
    insert into docket.task_history (task_id, actor_user_id, event_type, source) values (v_task, gen_random_uuid(), 'zz_slack_probe', 'zz_nope');
    out := out || ',UNCHECKED';
  exception when check_violation then out := out || ',checked'; end;
  v_item := (select id from docket.plan_items order by created_at limit 1);
  if v_item is null then
    insert into docket.plan_items (kind, code, title, state) values ('theme', 'ZZSL', 'zz slack probe', 'agreed') returning id into v_item;
  end if;
  perform set_config('docket.source', 'slack', true);
  insert into docket.plan_item_history (item_id, event, note) values (v_item, 'field_changed', 'zz slack probe') returning source into v_src;
  perform set_config('docket.source', '', true);
  out := out || ',plan_item_history=' || v_src
    || ',' || (case when pg_get_functiondef('docket.task_set_deadline'::regproc) ~ 'p_source, ''app''\) not in \(''app'', ''connector'', ''slack''' then 'set_deadline' else 'SET_DEADLINE_REFUSES_SLACK' end)
    || ',' || (select count(*) from information_schema.columns where table_schema = 'docket' and table_name in ('plan_proposals', 'task_comments') and column_name = 'source');

  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $slackid$;
