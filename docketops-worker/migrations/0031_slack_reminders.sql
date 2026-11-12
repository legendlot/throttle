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
