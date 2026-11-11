-- podium_hiring_atomic_rpcs_v1 — the hiring writes that touch more than one row, each as ONE transaction.
-- Called by podiumops-worker via POST /rest/v1/rpc/<name> with body { "p": { ... } } (Content-Profile podium).
-- AUTHORIZATION STAYS IN THE WORKER: these functions trust their caller (service_role only) and do no
-- permission checks of their own. Codes are minted inside the transaction via podium.next_hiring_seq, so a
-- failed write rolls the counter back too (no gaps from half-written rows).
-- Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c1-c2.md · depends on 0006 (podium_hiring_c1_c2_v1).

-- ── Opening + budget v1 (+ JD v1) + opening_created event ────────────────────
-- p = { opening: {job_role_id, designation, department_id, reporting_manager_employee_id, hiring_owner_employee_id,
--                 location_city, location_state, employment_type, headcount, target_join_date, notes},
--       band: {band_min, band_max}, jd: null | {source: 'text'|'job_role', jd_text},
--       approver_employee_id, actor_user_id, actor_employee_id, event_detail }
-- Status is 'open' only when the JD row is inserted in this same call; otherwise 'draft' (the JD gate).
create or replace function podium.hiring_create_opening(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_in        podium.openings;
  v_o         podium.openings;
  v_budget_id uuid;
  v_jd_id     uuid := null;
  v_n         bigint;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  v_in := jsonb_populate_record(null::podium.openings, p->'opening');
  v_n := podium.next_hiring_seq('podium_opening');
  insert into podium.openings (opening_code, job_role_id, designation, department_id, reporting_manager_employee_id,
    hiring_owner_employee_id, location_city, location_state, employment_type, headcount, target_join_date, notes,
    status, created_by)
  values ('OPN-' || lpad(v_n::text, greatest(3, length(v_n::text)), '0'), v_in.job_role_id, v_in.designation,
    v_in.department_id, v_in.reporting_manager_employee_id, v_in.hiring_owner_employee_id,
    coalesce(v_in.location_city, 'Bangalore'), coalesce(v_in.location_state, 'Karnataka'),
    coalesce(v_in.employment_type, 'full_time'), coalesce(v_in.headcount, 1), v_in.target_join_date, v_in.notes,
    'draft', v_actor)
  returning * into v_o;

  insert into podium.opening_budgets (opening_id, version, band_min, band_max, status, requested_by,
    requested_by_employee_id, approver_employee_id)
  values (v_o.id, 1, (p->'band'->>'band_min')::numeric, (p->'band'->>'band_max')::numeric, 'pending', v_actor,
    v_actor_emp, (p->>'approver_employee_id')::uuid)
  returning id into v_budget_id;

  if jsonb_typeof(p->'jd') = 'object' then
    insert into podium.opening_jds (opening_id, version, source, jd_text, created_by)
    values (v_o.id, 1, p->'jd'->>'source', p->'jd'->>'jd_text', v_actor)
    returning id into v_jd_id;
    update podium.openings set current_jd_id = v_jd_id, status = 'open' where id = v_o.id returning * into v_o;
  end if;

  insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, to_status, detail)
  values (v_o.id, v_actor, v_actor_emp, 'opening_created', v_o.status, p->'event_detail');

  return jsonb_build_object('opening', to_jsonb(v_o), 'budget_id', v_budget_id, 'jd_id', v_jd_id);
end $$;

-- ── Candidate (person) + application 'new' + candidate_created / application_created events ──
-- p = { opening_id, candidate: {full_name, email, phone, location, current_employer, current_title,
--       total_experience_years, skills[], education, linkedin_url, notes},
--       application: {source, referrer_employee_id, source_detail, notice_period_days, current_ctc?, expected_ctc?},
--       actor_user_id, actor_employee_id }
-- The worker drops current_ctc / expected_ctc from `application` unless the caller may see salary.
create or replace function podium.hiring_create_candidate(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_ci        podium.candidates;
  v_c         podium.candidates;
  v_ai        podium.applications;
  v_a         podium.applications;
  v_n         bigint;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  v_ci := jsonb_populate_record(null::podium.candidates, p->'candidate');
  v_ai := jsonb_populate_record(null::podium.applications, p->'application');
  v_n := podium.next_hiring_seq('podium_candidate');
  insert into podium.candidates (candidate_code, full_name, email, phone, location, current_employer, current_title,
    total_experience_years, skills, education, linkedin_url, notes, created_by)
  values ('CAN-' || lpad(v_n::text, greatest(4, length(v_n::text)), '0'), v_ci.full_name, v_ci.email, v_ci.phone,
    v_ci.location, v_ci.current_employer, v_ci.current_title, v_ci.total_experience_years,
    coalesce(v_ci.skills, '{}'), v_ci.education, v_ci.linkedin_url, v_ci.notes, v_actor)
  returning * into v_c;

  insert into podium.applications (candidate_id, opening_id, source, referrer_employee_id, source_detail,
    current_ctc, expected_ctc, notice_period_days, status, created_by)
  values (v_c.id, (p->>'opening_id')::uuid, coalesce(v_ai.source, 'other'), v_ai.referrer_employee_id,
    v_ai.source_detail, v_ai.current_ctc, v_ai.expected_ctc, v_ai.notice_period_days, 'new', v_actor)
  returning * into v_a;

  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, to_status, detail)
  values (v_c.id, null, null, v_actor, v_actor_emp, 'candidate_created', null, null),
         (v_c.id, v_a.opening_id, v_a.id, v_actor, v_actor_emp, 'application_created', 'new',
          jsonb_build_object('source', v_a.source));

  return jsonb_build_object('candidate', to_jsonb(v_c), 'application', to_jsonb(v_a));
end $$;

-- ── Move: new application on the target opening + close the old one 'withdrawn' + two events ──
-- p = { application_id, expected_status, to_opening_id, outcome_reason ('moved to OPN-x'), from_opening_code,
--       note (free text → detail.note), actor_user_id, actor_employee_id }
-- raise 'stale' when the application is no longer in expected_status; the one-active-per-opening unique
-- index raises 23505 (PostgREST 409) when the person is already active on the target.
-- Salary fields are NOT copied.
create or replace function podium.hiring_move_application(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_old       podium.applications;
  v_new       podium.applications;
  v_note      text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  select * into v_old from podium.applications
   where id = (p->>'application_id')::uuid and status = p->>'expected_status'
   for update;
  if not found then raise exception 'stale'; end if;

  insert into podium.applications (candidate_id, opening_id, status, created_by, source, referrer_employee_id,
    source_detail, notice_period_days)
  values (v_old.candidate_id, (p->>'to_opening_id')::uuid, 'new', v_actor, v_old.source, v_old.referrer_employee_id,
    v_old.source_detail, v_old.notice_period_days)
  returning * into v_new;

  update podium.applications
     set status = 'withdrawn', outcome_reason = p->>'outcome_reason', moved_to_application_id = v_new.id,
         closed_at = now()
   where id = v_old.id;

  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, from_status, to_status, reason, detail)
  values (v_old.candidate_id, v_old.opening_id, v_old.id, v_actor, v_actor_emp, 'application_moved',
          v_old.status, 'withdrawn', p->>'outcome_reason',
          jsonb_strip_nulls(jsonb_build_object('to_application_id', v_new.id, 'note', v_note))),
         (v_old.candidate_id, v_new.opening_id, v_new.id, v_actor, v_actor_emp, 'application_created',
          null, 'new', null,
          jsonb_strip_nulls(jsonb_build_object('moved_from_opening', p->>'from_opening_code', 'note', v_note)));

  return jsonb_build_object('from_application_id', v_old.id, 'to_application_id', v_new.id);
end $$;

-- ── Decide a pending band: approve/reject + supersede the previous approved + repoint the opening + event ──
-- p = { budget_id, decision: 'approve'|'reject', note, actor_user_id, actor_employee_id, event_detail }
-- raise 'not_pending' when the row is no longer pending. The 0006 check constraint still refuses self-approval.
create or replace function podium.hiring_decide_band(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_b         podium.opening_budgets;
  v_decision  text := p->>'decision';
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  if v_decision is null or v_decision not in ('approve', 'reject') then raise exception 'bad_decision'; end if;
  update podium.opening_budgets
     set status = case when v_decision = 'approve' then 'approved' else 'rejected' end,
         decided_by = v_actor, decided_by_employee_id = v_actor_emp, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p->>'note', '')), '')
   where id = (p->>'budget_id')::uuid and status = 'pending'
  returning * into v_b;
  if not found then raise exception 'not_pending'; end if;

  if v_decision = 'approve' then
    update podium.opening_budgets set status = 'superseded'
     where opening_id = v_b.opening_id and status = 'approved' and id <> v_b.id;
    update podium.openings set current_budget_id = v_b.id where id = v_b.opening_id;
  end if;

  insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_b.opening_id, v_actor, v_actor_emp,
          case when v_decision = 'approve' then 'band_approved' else 'band_rejected' end, p->'event_detail');

  return jsonb_build_object('budget', to_jsonb(v_b));
end $$;

-- ── Grants: service_role only (Supabase's default privileges also grant anon/authenticated — revoke those too) ──
revoke all on function podium.hiring_create_opening(jsonb)   from public, anon, authenticated;
revoke all on function podium.hiring_create_candidate(jsonb) from public, anon, authenticated;
revoke all on function podium.hiring_move_application(jsonb) from public, anon, authenticated;
revoke all on function podium.hiring_decide_band(jsonb)      from public, anon, authenticated;
grant execute on function podium.hiring_create_opening(jsonb)   to service_role;
grant execute on function podium.hiring_create_candidate(jsonb) to service_role;
grant execute on function podium.hiring_move_application(jsonb) to service_role;
grant execute on function podium.hiring_decide_band(jsonb)      to service_role;

-- 0006 revoked only PUBLIC on the code minter; close anon/authenticated too.
revoke all on function podium.next_hiring_seq(text) from anon, authenticated;

notify pgrst, 'reload schema';
