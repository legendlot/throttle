-- F9 R7b (migration 0031) — the slack_reminders settings default (test mode, Afshaan by work email, the five
-- slots; never overwrites a value already set) and docket.slack_reminder_log: claim-before-send (the first
-- insert … on conflict do nothing wins, a second gets nothing back), the status / error_code CHECKs, FK on delete
-- cascade, RLS + grants. One DO block that always rolls back (ends by raising RESULT …). Before 0031 is applied it
-- runs the migration inside the block (execute $mig$ … $mig$, generated verbatim from
-- migrations/0031_slack_reminders.sql); after, it only checks. Run via execute_sql.
-- EXPECT: 1:test,afshaan,catchup_prep=18:00/dow5 chase=09:30/working owner_daily=09:00/working review_pack=18:00/dow4
--   review_tomorrow=17:00/dow4,live  2:1,0,1,sent/true,status_checked,code_checked,fk,sent/unmapped  3:c,true,false,false,true
do $slackrem$
declare
  v jsonb; A uuid; E1 uuid; n int; out text := '';
begin
  if to_regclass('docket.slack_reminder_log') is null then
    execute $mig$
-- 0031_slack_reminders.sql — F9 R7b (docket_slack_reminders_v1): Slack reminders (spec §9.2).
-- The docketops cron (wrangler.toml: "0,30 * * * *") wakes every half-hour; WHEN each reminder goes is here,
-- in docket.settings.slack_reminders (IST times), never in the cron expression:
--   mode               'off' sends nothing · 'test' DMs only test_employee_ids (each gets exactly their live
--                      message) · 'live' sends to the real recipients. Anything else reads as 'off'.
--   slots.<name>       { time: 'HH:MM' IST, days: 'working' } or { time, dow: 1–7 (ISO, Mon = 1) }. Every slot
--                      fires on working days only (working_days minus holidays); a missing or malformed value
--                      disables that slot.
-- Starts in 'test' mode with Afshaan as the only test recipient (looked up by work email, not hard-coded).
-- Idempotent: an existing value (a founder's choice) is never overwritten.
--
-- docket.slack_reminder_log: one row per (slot, IST run date, employee), CLAIMED before the DM is sent
-- (insert … on conflict do nothing) — a retry or a double cron fire finds the row and sends nothing. The claim
-- is written 'failed' / error_code 'in_flight' and set to 'sent' (or 'failed' + Slack's error code) after
-- the send, so a run that dies mid-send stays visible as failed, never re-sent. RLS on, no policies,
-- service_role only (the docket convention).


insert into docket.settings (key, value)
select 'slack_reminders', jsonb_build_object(
  'mode', 'test',
  'test_employee_ids', coalesce((select jsonb_agg(e.id) from podium.employees e
                                  where lower(e.work_email) = 'afshaan@legendoftoys.com' and e.status = 'active'), '[]'::jsonb),
  'slots', jsonb_build_object(
    'owner_daily',     jsonb_build_object('time', '09:00', 'days', 'working'),
    'chase',           jsonb_build_object('time', '09:30', 'days', 'working'),
    'review_tomorrow', jsonb_build_object('time', '17:00', 'dow', 4),
    'review_pack',     jsonb_build_object('time', '18:00', 'dow', 4),
    'catchup_prep',    jsonb_build_object('time', '18:00', 'dow', 5)))
on conflict (key) do nothing;

create table if not exists docket.slack_reminder_log (
  slot text not null,
  run_date date not null,                -- the IST date of the run
  employee_id uuid not null references podium.employees(id) on delete cascade,
  status text not null check (status in ('sent', 'skipped_empty', 'failed', 'unmapped')),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,60}$'),
  sent_at timestamptz not null default now(),
  unique (slot, run_date, employee_id)
);
alter table docket.slack_reminder_log enable row level security;
revoke all on docket.slack_reminder_log from public, anon, authenticated;
grant all on docket.slack_reminder_log to service_role;


notify pgrst, 'reload schema';
$mig$;
  end if;
  -- 1. the settings default: test mode, Afshaan (by work email) the only test person, the five slots
  select value into v from docket.settings where key = 'slack_reminders';
  select id into A from podium.employees where lower(work_email) = 'afshaan@legendoftoys.com' and status = 'active';
  out := '1:' || coalesce(v->>'mode', 'NULL')
    || ',' || (case when v->'test_employee_ids' = jsonb_build_array(A) then 'afshaan' else 'TEST_IDS:' || coalesce(v->>'test_employee_ids', 'NULL') end)
    || ',' || (select string_agg(k || '=' || (v->'slots'->k->>'time') || '/' || coalesce(v->'slots'->k->>'days', 'dow' || (v->'slots'->k->>'dow')), ' ' order by k)
               from jsonb_object_keys(v->'slots') k);
  -- the default never overwrites a value already set (the migration's insert, run again)
  update docket.settings set value = jsonb_set(value, '{mode}', '"live"') where key = 'slack_reminders';
  insert into docket.settings (key, value) select 'slack_reminders', '{"mode":"test"}'::jsonb on conflict (key) do nothing;
  out := out || ',' || (select value->>'mode' from docket.settings where key = 'slack_reminders');

  -- 2. the log: claim-before-send — the first insert wins, a second (a retry / a double fire) gets nothing back
  select id into E1 from podium.employees where status = 'active' order by id limit 1;
  with c as (insert into docket.slack_reminder_log (slot, run_date, employee_id, status, error_code)
             values ('owner_daily', '2026-11-13', E1, 'failed', 'in_flight') on conflict do nothing returning 1) select count(*) into n from c;
  out := out || '  2:' || n;
  with c as (insert into docket.slack_reminder_log (slot, run_date, employee_id, status, error_code)
             values ('owner_daily', '2026-11-13', E1, 'failed', 'in_flight') on conflict do nothing returning 1) select count(*) into n from c;
  out := out || ',' || n;
  with c as (insert into docket.slack_reminder_log (slot, run_date, employee_id, status)
             values ('owner_daily', '2026-11-14', E1, 'skipped_empty') on conflict do nothing returning 1) select count(*) into n from c;
  out := out || ',' || n;   -- another day is its own row
  update docket.slack_reminder_log set status = 'sent', error_code = null where slot = 'owner_daily' and run_date = '2026-11-13' and employee_id = E1;
  out := out || ',' || (select status || '/' || (sent_at is not null)::text from docket.slack_reminder_log where slot = 'owner_daily' and run_date = '2026-11-13' and employee_id = E1);
  begin insert into docket.slack_reminder_log (slot, run_date, employee_id, status) values ('chase', '2026-11-13', E1, 'claimed'); out := out || ',STATUS_OPEN';
  exception when check_violation then out := out || ',status_checked'; end;
  begin insert into docket.slack_reminder_log (slot, run_date, employee_id, status, error_code) values ('chase', '2026-11-13', E1, 'failed', 'Raw: relation x'); out := out || ',CODE_OPEN';
  exception when check_violation then out := out || ',code_checked'; end;
  begin insert into docket.slack_reminder_log (slot, run_date, employee_id, status) values ('chase', '2026-11-13', gen_random_uuid(), 'unmapped'); out := out || ',NO_FK';
  exception when foreign_key_violation then out := out || ',fk'; end;
  insert into docket.slack_reminder_log (slot, run_date, employee_id, status) values ('chase', '2026-11-13', E1, 'unmapped');
  out := out || ',' || (select string_agg(status, '/' order by status) from docket.slack_reminder_log where employee_id = E1 and run_date = '2026-11-13');

  -- 3. FK cascade, RLS on, no anon / authenticated grant, service_role all
  out := out || '  3:' || (select string_agg(confdeltype::text, '') from pg_constraint where conrelid = 'docket.slack_reminder_log'::regclass and contype = 'f')
    || ',' || (select relrowsecurity::text from pg_class where oid = 'docket.slack_reminder_log'::regclass)
    || ',' || has_table_privilege('anon', 'docket.slack_reminder_log', 'select')::text
    || ',' || has_table_privilege('authenticated', 'docket.slack_reminder_log', 'insert')::text
    || ',' || has_table_privilege('service_role', 'docket.slack_reminder_log', 'insert')::text;

  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $slackrem$;
