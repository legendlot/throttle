-- podium_interviews_v1 — Hiring O2: interview rounds + panel feedback.
-- Plan: docs/superpowers/plans/2026-11-12-podium-o2-interviews.md (D1–D9) · depends on 0006 + 0007.
-- AUTHORIZATION STAYS IN THE WORKER (src/interviews.js + index.js): these functions trust their caller
-- (service_role only). All tables RLS-on, no policies, service_role only (RULE-RLS-001 / RULE-PODIUM-002).
-- application_events.event_type has no CHECK (0006; verified live 2026-11-12), so the new event types
-- (interview_scheduled / _rescheduled / _updated / _cancelled / _no_show / _verdict, feedback_submitted)
-- need no widening. Their detail carries ids and codes only — never feedback content.

-- ── D1: the round plan per opening ───────────────────────────────────────────
create table podium.opening_rounds (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references podium.openings(id) on delete cascade,
  seq int not null check (seq between 1 and 100),
  name text not null check (length(btrim(name)) between 1 and 80),
  default_interviewer_ids uuid[] not null default '{}' check (cardinality(default_interviewer_ids) <= 10),
  -- [{key, label}] — up to 10 criteria, each scored 1–5 (shape validated in the worker: cleanScorecard)
  scorecard jsonb not null default '[]'::jsonb
    check (jsonb_typeof(scorecard) = 'array' and jsonb_array_length(scorecard) <= 10),
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- deferred so a reorder (one UPDATE over the whole plan) never trips on a transient duplicate
  constraint opening_rounds_seq_unique unique (opening_id, seq) deferrable initially deferred
);

-- ── D2: one interview per application × round ────────────────────────────────
create table podium.interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references podium.applications(id) on delete cascade,
  opening_id uuid not null references podium.openings(id) on delete cascade,
  candidate_id uuid not null references podium.candidates(id) on delete cascade,
  round_id uuid references podium.opening_rounds(id),        -- null = free-text round (opening with no plan)
  round_name text not null check (length(btrim(round_name)) between 1 and 80),   -- snapshot
  scorecard jsonb not null default '[]'::jsonb                                    -- snapshot at scheduling
    check (jsonb_typeof(scorecard) = 'array' and jsonb_array_length(scorecard) <= 10),
  scheduled_at timestamptz not null,
  duration_min int not null default 60 check (duration_min between 10 and 480),
  mode text not null default 'in_person' check (mode in ('in_person', 'video', 'phone')),
  location text check (location is null or length(location) <= 500),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled', 'no_show')),
  jd_id uuid not null references podium.opening_jds(id),     -- the opening's current JD at scheduling
  verdict text check (verdict in ('advance', 'reject', 'hold')),
  verdict_reason text,                                        -- OUTCOME_REASON_CODES (reject), worker-validated
  verdict_note text check (verdict_note is null or length(verdict_note) <= 2000),
  verdict_by uuid,
  verdict_by_employee_id uuid references podium.employees(id),
  verdict_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 500),
  cancelled_by uuid,
  cancelled_at timestamptz,
  calendar_event_id text,                                     -- O3 (Calendar); null until then
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((verdict is null) = (verdict_at is null)),
  check (verdict is null or status = 'completed'),
  check (verdict is distinct from 'reject' or verdict_reason is not null),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index interviews_application_idx on podium.interviews(application_id, scheduled_at);
create index interviews_opening_idx on podium.interviews(opening_id);
-- One live interview per application × round. A free-text round is keyed by its name. Cancelled and no-show
-- rows free the slot (a no-show round can be scheduled again).
create unique index interviews_one_per_round on podium.interviews
  (application_id, coalesce(round_id::text, 'name:' || lower(btrim(round_name))))
  where status not in ('cancelled', 'no_show');

-- ── D3: the panel = one feedback row per interviewer ─────────────────────────
create table podium.interview_panel (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references podium.interviews(id) on delete cascade,
  employee_id uuid not null references podium.employees(id),
  due_at timestamptz not null,                                -- scheduled_at + 24h; moves on reschedule while pending
  rating smallint check (rating between 1 and 5),
  recommendation text check (recommendation in ('strong_yes', 'yes', 'no', 'strong_no')),
  scores jsonb not null default '{}'::jsonb check (jsonb_typeof(scores) = 'object'),
  notes text check (notes is null or length(notes) <= 5000),
  submitted_at timestamptz,
  reminded_at timestamptz,
  remind_count int not null default 0 check (remind_count >= 0),
  created_at timestamptz not null default now(),
  unique (interview_id, employee_id),
  check ((submitted_at is null) = (rating is null)),
  check ((submitted_at is null) = (recommendation is null))
);
create index interview_panel_employee_idx on podium.interview_panel(employee_id, submitted_at);

-- D3 backstop: feedback is submit-once, never edited. (Removing a submitted panelist is refused in
-- hiring_update_interview, which deletes only unsubmitted rows; deletes are not trapped here so the retention
-- cascade from candidates / applications is never blocked.)
create or replace function podium.refuse_feedback_edit() returns trigger language plpgsql as $$
begin
  if old.submitted_at is not null and (
       new.submitted_at is distinct from old.submitted_at or new.rating is distinct from old.rating
    or new.recommendation is distinct from old.recommendation or new.scores is distinct from old.scores
    or new.notes is distinct from old.notes or new.employee_id is distinct from old.employee_id
    or new.interview_id is distinct from old.interview_id) then
    raise exception 'feedback_locked';
  end if;
  return new;
end $$;
create trigger interview_panel_no_edit before update on podium.interview_panel
  for each row execute function podium.refuse_feedback_edit();

-- D3 backstop, race-proof: feedback lands only on a scheduled / completed interview whose time has passed. FOR SHARE
-- on the interview serialises this against hiring_update_interview (FOR UPDATE), cancel and no-show, so a reschedule
-- or close cannot slip between the worker's check and the write.
create or replace function podium.check_feedback_window() returns trigger language plpgsql as $$
declare
  v_status text;
  v_at     timestamptz;
begin
  if old.submitted_at is null and new.submitted_at is not null then
    select status, scheduled_at into v_status, v_at from podium.interviews where id = new.interview_id for share;
    if v_status is null or v_status not in ('scheduled', 'completed') then raise exception 'interview_closed'; end if;
    if v_at > now() then raise exception 'too_early'; end if;
  end if;
  return new;
end $$;
create trigger interview_panel_feedback_window before update on podium.interview_panel
  for each row execute function podium.check_feedback_window();

-- A closed application (rejected / declined / withdrawn / joined / no_show, by any path: verdict, setApplicationStatus,
-- moveApplication, offer decline, confirm joining) cancels its still-scheduled interviews, so no panelist is left
-- owing feedback on a candidate who is gone.
create or replace function podium.cancel_interviews_on_close() returns trigger language plpgsql as $$
begin
  if new.status in ('joined', 'rejected', 'declined', 'withdrawn', 'no_show')
     and old.status not in ('joined', 'rejected', 'declined', 'withdrawn', 'no_show') then
    update podium.interviews
       set status = 'cancelled', cancel_reason = 'application closed', cancelled_at = now()
     where application_id = new.id and status = 'scheduled';
  end if;
  return null;
end $$;
create trigger applications_close_interviews after update of status on podium.applications
  for each row execute function podium.cancel_interviews_on_close();

create trigger opening_rounds_touch before update on podium.opening_rounds for each row execute function podium.touch_updated_at();
create trigger interviews_touch before update on podium.interviews for each row execute function podium.touch_updated_at();

-- ── RLS: on, no policies; service_role only ──────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['opening_rounds', 'interviews', 'interview_panel'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── Schedule: interview + panel rows (+ new|screening → interviewing with its event) in ONE transaction ──
-- p = { interview: {application_id, opening_id, candidate_id, round_id, round_name, scorecard, scheduled_at,
--       duration_min, mode, location, jd_id}, panel: [{employee_id, due_at}], expected_status,
--       actor_user_id, actor_employee_id }
-- raise 'stale' when the application left expected_status; 'opening_not_open' / 'jd_required' re-check the gate
-- under the row lock; the one-per-round unique index raises 23505 (PostgREST 409).
create or replace function podium.hiring_schedule_interview(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_in        podium.interviews;
  v_iv        podium.interviews;
  v_app       podium.applications;
  v_op        podium.openings;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  v_in := jsonb_populate_record(null::podium.interviews, p->'interview');
  select * into v_app from podium.applications
   where id = v_in.application_id and status = p->>'expected_status' for update;
  if not found then raise exception 'stale'; end if;
  select * into v_op from podium.openings where id = v_app.opening_id for share;
  if v_op.status <> 'open' then raise exception 'opening_not_open'; end if;
  if v_op.current_jd_id is null then raise exception 'jd_required'; end if;
  if jsonb_typeof(p->'panel') is distinct from 'array' or jsonb_array_length(p->'panel') < 1 then raise exception 'panel_required'; end if;

  insert into podium.interviews (application_id, opening_id, candidate_id, round_id, round_name, scorecard,
    scheduled_at, duration_min, mode, location, status, jd_id, created_by)
  values (v_app.id, v_app.opening_id, v_app.candidate_id, v_in.round_id, btrim(v_in.round_name),
    coalesce(v_in.scorecard, '[]'::jsonb), v_in.scheduled_at, coalesce(v_in.duration_min, 60),
    coalesce(v_in.mode, 'in_person'), v_in.location, 'scheduled', v_op.current_jd_id, v_actor)
  returning * into v_iv;

  insert into podium.interview_panel (interview_id, employee_id, due_at)
  select v_iv.id, (x->>'employee_id')::uuid, (x->>'due_at')::timestamptz
    from jsonb_array_elements(p->'panel') x;

  if v_app.status in ('new', 'screening') then
    update podium.applications set status = 'interviewing' where id = v_app.id;
    insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
      event_type, from_status, to_status, detail)
    values (v_app.candidate_id, v_app.opening_id, v_app.id, v_actor, v_actor_emp, 'status_changed',
      v_app.status, 'interviewing', jsonb_build_object('interview_id', v_iv.id));
  end if;

  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, detail)
  values (v_app.candidate_id, v_app.opening_id, v_app.id, v_actor, v_actor_emp, 'interview_scheduled',
    jsonb_strip_nulls(jsonb_build_object('interview_id', v_iv.id, 'round_id', v_iv.round_id)));

  return jsonb_build_object('interview', to_jsonb(v_iv),
    'application_status', case when v_app.status in ('new', 'screening') then 'interviewing' else v_app.status end);
end $$;

-- ── Edit a scheduled interview: logistics + panel add/remove (+ pending due_at on reschedule), ONE transaction ──
-- p = { interview_id, expected_updated_at, patch: {scheduled_at?, duration_min?, mode?, location?},
--       add: [{employee_id, due_at}], remove: [employee_id], new_due_at (set when rescheduled),
--       actor_user_id, actor_employee_id }
-- raise 'stale' (no longer scheduled / changed since read), 'panel_submitted' (removing a submitted panelist),
-- 'panel_required' (the edit would leave no panel), 'application_not_schedulable' / 'opening_not_open' / 'jd_required'
-- (the D2 gate, re-checked under the lock), 'reschedule_after_feedback' (a time change once any feedback is in).
create or replace function podium.hiring_update_interview(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_old       podium.interviews;
  v_iv        podium.interviews;
  v_app       podium.applications;
  v_op        podium.openings;
  v_pt        jsonb := coalesce(p->'patch', '{}'::jsonb);
  v_removed   int;
  v_want      int := coalesce(jsonb_array_length(p->'remove'), 0);
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
  v_resched   boolean;
begin
  select * into v_old from podium.interviews
   where id = (p->>'interview_id')::uuid and status = 'scheduled'
     and updated_at = (p->>'expected_updated_at')::timestamptz
   for update;
  if not found then raise exception 'stale'; end if;
  -- D2 gate re-checked under lock: the application is still schedulable and the opening still open.
  select * into v_app from podium.applications where id = v_old.application_id for share;
  if v_app.status not in ('new', 'screening', 'interviewing') then raise exception 'application_not_schedulable'; end if;
  select * into v_op from podium.openings where id = v_old.opening_id for share;
  if v_op.status <> 'open' then raise exception 'opening_not_open'; end if;
  if v_op.current_jd_id is null then raise exception 'jd_required'; end if;
  -- Feedback already given is anchored to the time it was given for: moving the time is refused (cancel + reschedule).
  if v_pt ? 'scheduled_at' and (v_pt->>'scheduled_at')::timestamptz is distinct from v_old.scheduled_at
     and exists (select 1 from podium.interview_panel where interview_id = v_old.id and submitted_at is not null) then
    raise exception 'reschedule_after_feedback';
  end if;

  update podium.interviews set
    scheduled_at = case when v_pt ? 'scheduled_at' then (v_pt->>'scheduled_at')::timestamptz else scheduled_at end,
    duration_min = case when v_pt ? 'duration_min' then (v_pt->>'duration_min')::int else duration_min end,
    mode         = case when v_pt ? 'mode' then v_pt->>'mode' else mode end,
    location     = case when v_pt ? 'location' then nullif(v_pt->>'location', '') else location end
  where id = v_old.id
  returning * into v_iv;
  v_resched := v_iv.scheduled_at is distinct from v_old.scheduled_at;

  if v_want > 0 then
    delete from podium.interview_panel
     where interview_id = v_old.id and submitted_at is null
       and employee_id in (select (x #>> '{}')::uuid from jsonb_array_elements(p->'remove') x);
    get diagnostics v_removed = row_count;
    if v_removed <> v_want then raise exception 'panel_submitted'; end if;
  end if;

  if jsonb_typeof(p->'add') = 'array' and jsonb_array_length(p->'add') > 0 then
    insert into podium.interview_panel (interview_id, employee_id, due_at)
    select v_old.id, (x->>'employee_id')::uuid, (x->>'due_at')::timestamptz from jsonb_array_elements(p->'add') x
    on conflict (interview_id, employee_id) do nothing;
  end if;

  if v_resched and p->>'new_due_at' is not null then
    update podium.interview_panel set due_at = (p->>'new_due_at')::timestamptz
     where interview_id = v_old.id and submitted_at is null;
  end if;

  if not exists (select 1 from podium.interview_panel where interview_id = v_old.id) then
    raise exception 'panel_required';
  end if;

  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, detail)
  values (v_iv.candidate_id, v_iv.opening_id, v_iv.application_id, v_actor, v_actor_emp,
    case when v_resched then 'interview_rescheduled' else 'interview_updated' end,
    jsonb_build_object('interview_id', v_iv.id));

  return jsonb_build_object('interview', to_jsonb(v_iv), 'rescheduled', v_resched);
end $$;

-- ── D6 verdict: verdict + completed (+ reject → rejected / hold → on_hold with its event), ONE transaction ──
-- p = { interview_id, verdict, reason, note, to_status (null for advance), expected_status, actor_user_id,
--       actor_employee_id }
-- The worker has already checked the transition table and that no live offer exists; the offer check is repeated
-- here under the application row lock. raise 'stale' when the interview is no longer verdict-able or the application
-- left expected_status; 'close_offers_first' when a live offer revision exists.
create or replace function podium.hiring_interview_verdict(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_iv        podium.interviews;
  v_app       podium.applications;
  v_to        text := nullif(p->>'to_status', '');
  v_reason    text := nullif(btrim(coalesce(p->>'reason', '')), '');
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  if p->>'verdict' is null or p->>'verdict' not in ('advance', 'reject', 'hold') then raise exception 'bad_verdict'; end if;
  update podium.interviews
     set verdict = p->>'verdict', verdict_reason = case when p->>'verdict' = 'reject' then v_reason else null end,
         verdict_note = nullif(btrim(coalesce(p->>'note', '')), ''),
         verdict_by = v_actor, verdict_by_employee_id = v_actor_emp, verdict_at = now(), status = 'completed'
   where id = (p->>'interview_id')::uuid and status in ('scheduled', 'completed') and verdict is null
     and scheduled_at <= now()
  returning * into v_iv;
  if not found then raise exception 'stale'; end if;

  if v_to is not null then
    select * into v_app from podium.applications
     where id = v_iv.application_id and status = p->>'expected_status' for update;
    if not found then raise exception 'stale'; end if;
    -- Re-checked under the lock (the worker checked first): a hold or reject never strands a live offer revision.
    -- The list = OFFER_LIVE_STATUSES in src/hiring.js.
    if exists (select 1 from podium.offers where application_id = v_app.id
                and status in ('draft', 'pending_approval', 'approved', 'approval_rejected', 'ready', 'sent', 'accepted')) then
      raise exception 'close_offers_first';
    end if;
    update podium.applications
       set status = v_to,
           outcome_reason = case when v_to = 'rejected' then v_reason else outcome_reason end,
           closed_at = case when v_to = 'rejected' then now() else closed_at end
     where id = v_iv.application_id and status = p->>'expected_status'
    returning * into v_app;
    if not found then raise exception 'stale'; end if;
    insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
      event_type, from_status, to_status, reason, detail)
    values (v_iv.candidate_id, v_iv.opening_id, v_iv.application_id, v_actor, v_actor_emp, 'status_changed',
      p->>'expected_status', v_to, case when v_to = 'rejected' then v_reason else null end,
      jsonb_build_object('interview_id', v_iv.id));
  end if;

  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, reason, detail)
  values (v_iv.candidate_id, v_iv.opening_id, v_iv.application_id, v_actor, v_actor_emp, 'interview_verdict',
    case when p->>'verdict' = 'reject' then v_reason else null end,
    jsonb_build_object('interview_id', v_iv.id, 'verdict', v_iv.verdict));

  return jsonb_build_object('interview', to_jsonb(v_iv), 'application_status', coalesce(v_to, p->>'expected_status'));
end $$;

-- ── D1 reorder: the whole plan in one statement (the seq unique is deferred) ──
-- p = { opening_id, ids: [round ids in the new order] } — must be exactly the opening's rounds.
create or replace function podium.hiring_reorder_rounds(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_n    int;
  v_have int;
begin
  if jsonb_typeof(p->'ids') is distinct from 'array' then raise exception 'bad_order'; end if;
  v_n := jsonb_array_length(p->'ids');
  select count(*) into v_have from podium.opening_rounds where opening_id = (p->>'opening_id')::uuid;
  if v_n <> v_have or (select count(distinct x) from jsonb_array_elements_text(p->'ids') x) <> v_n
     or exists (select 1 from jsonb_array_elements_text(p->'ids') x
                 where not exists (select 1 from podium.opening_rounds r
                                    where r.id = x::uuid and r.opening_id = (p->>'opening_id')::uuid)) then
    raise exception 'bad_order';
  end if;
  update podium.opening_rounds r set seq = o.n
    from jsonb_array_elements_text(p->'ids') with ordinality as o(id, n)
   where r.id = o.id::uuid and r.opening_id = (p->>'opening_id')::uuid and r.seq <> o.n;
  return jsonb_build_object('ok', true, 'count', v_n);
end $$;

-- ── Grants: service_role only (Supabase's default privileges also grant anon/authenticated — revoke those too) ──
do $$
declare f text;
begin
  foreach f in array array['hiring_schedule_interview(jsonb)', 'hiring_update_interview(jsonb)',
                           'hiring_interview_verdict(jsonb)', 'hiring_reorder_rounds(jsonb)'] loop
    execute format('revoke all on function podium.%s from public, anon, authenticated', f);
    execute format('grant execute on function podium.%s to service_role', f);
  end loop;
end $$;
revoke all on function podium.refuse_feedback_edit() from public, anon, authenticated;
revoke all on function podium.check_feedback_window() from public, anon, authenticated;
revoke all on function podium.cancel_interviews_on_close() from public, anon, authenticated;

notify pgrst, 'reload schema';
