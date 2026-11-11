-- podium_hiring_offers_v1 — Hiring module C3 (offer letters): rule sets, templates, signatories, offers,
-- and the RPCs that write them; plus the three C1 writes that were still two-step (band re-request,
-- chain change, JD add), now one transaction each.
-- Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c3-offers.md · depends on 0006 + 0007.
-- AUTHORIZATION STAYS IN THE WORKER (as 0007): the functions trust their caller (service_role only).
-- No salary figure is ever written into application_events by these functions (ids, ref, revision, status).

-- ── Codes: OFR-<yyyy>-NNN per calendar year ──────────────────────────────────
create or replace function podium.next_hiring_seq(p_name text)
returns bigint language plpgsql security definer set search_path to 'store', 'public' as $$
declare v_next bigint;
begin
  if not (p_name in ('podium_opening', 'podium_candidate') or p_name ~ '^podium_offer_[0-9]{4}$') then
    raise exception 'next_hiring_seq: unknown sequence %', p_name;
  end if;
  insert into store.sequences(name, current_val) values (p_name, 0) on conflict (name) do nothing;
  update store.sequences set current_val = current_val + 1 where name = p_name returning current_val into v_next;
  return v_next;
end $$;
revoke all on function podium.next_hiring_seq(text) from public, anon, authenticated;
grant execute on function podium.next_hiring_seq(text) to service_role;

-- ── Statutory rule sets (data, effective-dated; read-only from the app — new ones ship as migrations) ──
create table podium.offer_rule_sets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  effective_from date not null,
  effective_to date,
  rules jsonb not null,
  notes text,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

-- rules keys (src/offer-calc.js): basic_pct_of_fixed, hra_pct_of_basic, travel_div, telephone_div,
-- min_basic_pct_of_fixed, pf {rate, wage_ceiling_monthly}, esi {wage_ceiling_monthly, employer_rate,
-- employee_rate}, pt {<state code>: {type 'flat'|'slab', monthly, annual, threshold_monthly?, february?}}.
-- test/offer-calc.test.mjs reads the two JSON blocks below straight out of this file.
insert into podium.offer_rule_sets (code, effective_from, effective_to, rules, notes) values
('IN-2025', '2000-01-01', '2026-09-16', $rules$
{"basic_pct_of_fixed": 0.5, "hra_pct_of_basic": 0.5, "travel_div": 15, "telephone_div": 60,
 "min_basic_pct_of_fixed": 0.5,
 "pf": {"rate": 0.12, "wage_ceiling_monthly": 15000},
 "esi": {"wage_ceiling_monthly": 21000, "employer_rate": 0.0325, "employee_rate": 0.0075},
 "pt": {"KA": {"type": "flat", "monthly": 200, "annual": 2400}}}
$rules$::jsonb, 'Pre-17-Sep-2026 rules: EPF ceiling 15,000/month; Karnataka PT flat 200/month. The mailbox letters reproduce under this set.'),
('IN-2026-09', '2026-09-17', null, $rules$
{"basic_pct_of_fixed": 0.5, "hra_pct_of_basic": 0.5, "travel_div": 15, "telephone_div": 60,
 "min_basic_pct_of_fixed": 0.5,
 "pf": {"rate": 0.12, "wage_ceiling_monthly": 25000},
 "esi": {"wage_ceiling_monthly": 21000, "employer_rate": 0.0325, "employee_rate": 0.0075},
 "pt": {"KA": {"type": "slab", "threshold_monthly": 25000, "monthly": 200, "february": 300, "annual": 2500}}}
$rules$::jsonb, 'From 17 Sep 2026: EPF ceiling 25,000/month; Karnataka PT nil below 25,000/month, else 200/month and 300 in February (2,500/yr).');

-- ── Templates (versioned; offers pin the version they used) ──────────────────
create table podium.offer_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null check (template_key in ('employment', 'internship')),
  version int not null check (version >= 1),
  title text not null,
  body text not null check (length(btrim(body)) > 0),
  entity_name text,
  entity_address text[] not null default '{}',
  footer_note text,
  notes text,
  is_current boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (template_key, version)
);
create unique index offer_templates_one_current on podium.offer_templates(template_key) where is_current;

-- Employment v1 = today's letter, wording kept (incl. the confidentiality / non-compete paragraph —
-- spec legal note stands; Afshaan's call), with sections for variable, department, probation, bonuses.
insert into podium.offer_templates (template_key, version, title, body, entity_name, entity_address, footer_note, notes, is_current)
values ('employment', 1, 'Offer of Employment', $tpl$Dated: {{issue_date}}

Dear {{candidate_name}},

This is with reference to the discussions you have had with us. We are pleased to extend an offer to join {{entity_name}} (Legend of Toys).

As discussed, your fixed salary will be INR {{fixed_annual}} per annum (before all customary payroll deductions), payable monthly in accordance with the company’s payroll practices.{{#has_variable}} In addition, you will be given {{variable_phrase}} of up to INR {{variable_annual}} per annum paid {{variable_frequency}}.{{/has_variable}}
{{#has_joining_bonus}}
You will also receive a one-time joining bonus of INR {{joining_bonus}}, as per the terms of your employment agreement.
{{/has_joining_bonus}}{{#has_retention_bonus}}
You will also be eligible for a one-time retention bonus of INR {{retention_bonus}}, as per the terms of your employment agreement.
{{/has_retention_bonus}}
Your start date would be on or before {{start_date}} and you are designated as {{designation}}{{#has_department}} in {{department}} department{{/has_department}}. The location of work will be {{location}}.

Further, your employment will be contingent upon you entering into confidentiality, non-compete and similar obligations and restrictions with respect to proprietary information of the company, that are standard within the industry. All other terms and conditions of your employment will be as per the employment agreement executed between you and the company.
{{#has_probation}}
Please note that your employment agreement includes a {{probation_months}}-month probationary period.
{{/has_probation}}
Should you have any questions, please feel free to call me. Please confirm by sending a signed copy of this letter over email. We look forward to your becoming a part of this team.

Let's build together!$tpl$,
  'Fraternitas Ventures Private Limited',
  array['No 938, 3rd Cross, 1st Block, HRBR Layout,', 'Kalyanagar, Bangalore - 560043'],
  'Medical insurance premium will be over and above your CTC.',
  'Wording from the letters in use as of Nov 2026.', true),
('internship', 1, 'Internship Offer', $tpl$Dated: {{issue_date}}

Dear {{candidate_name}},

This is with reference to the discussions you have had with us. We are pleased to offer you an internship with {{entity_name}} (Legend of Toys).

As discussed, you will be paid a stipend of INR {{stipend_monthly}} per month for {{internship_months}} months from your start date, payable monthly in accordance with the company’s payroll practices.

Your internship would start on or before {{start_date}} and you are designated as Intern — {{designation}}{{#has_department}} in {{department}} department{{/has_department}}. The location of work will be {{location}}.

Further, your internship will be contingent upon you entering into confidentiality and similar obligations and restrictions with respect to proprietary information of the company, that are standard within the industry.

On successful completion of the internship, you will receive a certificate of internship.

Should you have any questions, please feel free to call me. Please confirm by sending a signed copy of this letter over email. We look forward to having you with us.

Let's build together!$tpl$,
  'Fraternitas Ventures Private Limited',
  array['No 938, 3rd Cross, 1st Block, HRBR Layout,', 'Kalyanagar, Bangalore - 560043'],
  null,
  'draft wording — review before first use', true);

-- ── Authorised signatories ───────────────────────────────────────────────────
create table podium.offer_signatories (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references podium.employees(id),
  display_name text not null check (length(btrim(display_name)) > 0),
  phone text,
  title text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index offer_signatories_employee on podium.offer_signatories(employee_id) where employee_id is not null;

-- Seeded by name from the directory; phone = employees.phone as recorded (never invented — a missing
-- phone stays null and the letterhead simply omits it). A name not found is skipped.
insert into podium.offer_signatories (employee_id, display_name, phone, title)
select e.id, e.full_name, nullif(btrim(e.phone), ''), e.job_title
  from podium.employees e
 where e.full_name in ('Mahesh Jain', 'Piyush Gupta', 'Afshaan Siddiqui') and e.status <> 'exited';

-- ── Offers: one row per revision ─────────────────────────────────────────────
-- Sent evidence and the signed copy are candidate documents; the sent evidence gets its own
-- salary-tier type (it is the letter as sent). Widen the CHECK in the same migration.
alter table podium.candidate_documents drop constraint if exists candidate_documents_doc_type_check;
alter table podium.candidate_documents add constraint candidate_documents_doc_type_check check (doc_type in (
  'cv', 'payslip', 'signed_offer', 'offer_evidence', 'id_proof', 'pan', 'address_proof', 'education',
  'experience_letter', 'relieving_letter', 'bank', 'photo', 'other'));

create table podium.offers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references podium.applications(id),
  opening_id uuid not null references podium.openings(id),
  candidate_id uuid not null references podium.candidates(id),
  offer_ref text not null,
  revision int not null check (revision >= 1),
  template_id uuid not null references podium.offer_templates(id),
  rule_set_id uuid not null references podium.offer_rule_sets(id),
  budget_id uuid references podium.opening_budgets(id),
  mode text not null check (mode in ('salary', 'stipend')),
  fixed_annual numeric(12,0) check (fixed_annual is null or fixed_annual > 0),
  variable_annual numeric(12,0) not null default 0 check (variable_annual >= 0),
  variable_label text not null default 'variable pay',
  variable_frequency text not null default 'half-yearly',
  joining_bonus numeric(12,0) not null default 0 check (joining_bonus >= 0),
  retention_bonus numeric(12,0) not null default 0 check (retention_bonus >= 0),
  stipend_monthly numeric(12,0) check (stipend_monthly is null or stipend_monthly > 0),
  internship_months int check (internship_months is null or internship_months between 1 and 24),
  total_ctc numeric(12,0) not null check (total_ctc >= 0),
  pf_opt_out boolean not null default false,
  pf_opt_out_reason text,
  designation text not null check (length(btrim(designation)) > 0),
  department_name text,
  location text,
  start_date date not null,
  probation_months int check (probation_months is null or probation_months between 0 and 12),
  signatory_id uuid references podium.offer_signatories(id),
  issue_date date,
  valid_until date,
  inputs jsonb not null,
  annexure jsonb not null,
  band_check text check (band_check in ('in_band', 'below_band', 'above_band', 'extras')),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved',
    'approval_rejected', 'ready', 'sent', 'accepted', 'declined', 'expired', 'withdrawn', 'superseded')),
  approver_employee_id uuid references podium.employees(id),
  requested_by_employee_id uuid references podium.employees(id),
  decided_by_employee_id uuid references podium.employees(id),
  decided_at timestamptz,
  decision_note text,
  pdf_path text unique,
  pdf_sha256 text,
  rendered_at timestamptz,
  sent_at timestamptz,
  sent_by uuid,
  sent_to text,
  sent_cc text[],
  sent_evidence_doc_id uuid references podium.candidate_documents(id),
  accepted_at date,
  acceptance_doc_id uuid references podium.candidate_documents(id),
  declined_at timestamptz,
  outcome_note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offer_ref, revision),
  -- No self-approval (as opening_budgets).
  check (decided_by_employee_id is null or requested_by_employee_id is null or decided_by_employee_id <> requested_by_employee_id),
  check (not pf_opt_out or (pf_opt_out_reason is not null and length(btrim(pf_opt_out_reason)) > 0)),
  check (mode <> 'salary' or fixed_annual is not null),
  check (mode <> 'stipend' or (stipend_monthly is not null and internship_months is not null)),
  -- The issued file is the record: anything past 'ready' carries its stored PDF + hash.
  check (status not in ('ready', 'sent', 'accepted') or (pdf_path is not null and pdf_sha256 is not null))
);
create index offers_application_idx on podium.offers(application_id, revision);
create index offers_opening_idx on podium.offers(opening_id, status);
create index offers_approver_idx on podium.offers(approver_employee_id) where status = 'pending_approval';
-- One accepted revision per application; one open (pre-ready) revision per application.
create unique index offers_one_accepted on podium.offers(application_id) where status = 'accepted';
create unique index offers_one_open_draft on podium.offers(application_id)
  where status in ('draft', 'pending_approval', 'approved', 'approval_rejected');
create trigger offers_touch before update on podium.offers for each row execute function podium.touch_updated_at();

-- ── RLS: on, no policies; service_role only ──────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['offer_rule_sets', 'offer_templates', 'offer_signatories', 'offers'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── Offer: create a revision ─────────────────────────────────────────────────
-- p = { offer: {application_id, opening_id, candidate_id, template_id, rule_set_id, budget_id, mode, fixed_annual,
--       variable_annual, variable_label, variable_frequency, joining_bonus, retention_bonus, stipend_monthly,
--       internship_months, total_ctc, pf_opt_out, pf_opt_out_reason, designation, department_name, location,
--       start_date, probation_months, signatory_id, inputs, annexure, band_check},
--       year ('2026'), actor_user_id, actor_employee_id }
-- Revision 1 mints OFR-<year>-NNN; later revisions reuse the application's ref. The application row is
-- locked so two creates can't take the same revision number. The one-open-draft index raises 23505.
create or replace function podium.hiring_create_offer(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_in        podium.offers;
  v_o         podium.offers;
  v_ref       text;
  v_rev       int;
  v_n         bigint;
  v_year      text := coalesce(nullif(p->>'year', ''), to_char(now() at time zone 'Asia/Kolkata', 'YYYY'));
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  v_in := jsonb_populate_record(null::podium.offers, p->'offer');
  perform 1 from podium.applications where id = v_in.application_id for update;
  if not found then raise exception 'application_not_found'; end if;

  select offer_ref, max(revision) into v_ref, v_rev
    from podium.offers where application_id = v_in.application_id
   group by offer_ref order by max(revision) desc limit 1;
  if v_ref is null then
    if v_year !~ '^[0-9]{4}$' then raise exception 'bad_year'; end if;
    v_n := podium.next_hiring_seq('podium_offer_' || v_year);
    v_ref := 'OFR-' || v_year || '-' || lpad(v_n::text, greatest(3, length(v_n::text)), '0');
    v_rev := 1;
  else
    v_rev := v_rev + 1;
  end if;

  insert into podium.offers (application_id, opening_id, candidate_id, offer_ref, revision, template_id, rule_set_id,
    budget_id, mode, fixed_annual, variable_annual, variable_label, variable_frequency, joining_bonus, retention_bonus,
    stipend_monthly, internship_months, total_ctc, pf_opt_out, pf_opt_out_reason, designation, department_name,
    location, start_date, probation_months, signatory_id, inputs, annexure, band_check, status, created_by)
  values (v_in.application_id, v_in.opening_id, v_in.candidate_id, v_ref, v_rev, v_in.template_id, v_in.rule_set_id,
    v_in.budget_id, v_in.mode, v_in.fixed_annual, coalesce(v_in.variable_annual, 0),
    coalesce(v_in.variable_label, 'variable pay'), coalesce(v_in.variable_frequency, 'half-yearly'),
    coalesce(v_in.joining_bonus, 0), coalesce(v_in.retention_bonus, 0), v_in.stipend_monthly, v_in.internship_months,
    v_in.total_ctc, coalesce(v_in.pf_opt_out, false), v_in.pf_opt_out_reason, v_in.designation, v_in.department_name,
    v_in.location, v_in.start_date, v_in.probation_months, v_in.signatory_id, v_in.inputs, v_in.annexure,
    v_in.band_check, 'draft', v_actor)
  returning * into v_o;

  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, to_status, detail)
  values (v_o.candidate_id, v_o.opening_id, v_o.application_id, v_actor, v_actor_emp, 'offer_created', 'draft',
    jsonb_build_object('offer_id', v_o.id, 'offer_ref', v_o.offer_ref, 'revision', v_o.revision));

  return jsonb_build_object('offer', to_jsonb(v_o));
end $$;

-- ── Offer: one status step ───────────────────────────────────────────────────
-- p = { offer_id, expected_status (text or array), to_status, set: {column: value…} (only the columns
--       listed below are applied), evidence_doc: null | {storage_path, file_name, mime_type, file_size, title},
--       acceptance_doc: null | {…same}, app_status: null | 'offer' | 'accepted', event_type,
--       event_note (free text → detail.note, stripped on read off the salary chain), actor_user_id, actor_employee_id }
-- raise 'stale' when the offer is not in expected_status. Side effects (§0.8 + spec):
--   to 'sent'     → supersede the application's other ready/sent revisions (supersedes only when sent);
--   to 'accepted' → supersede the application's previously accepted revision (an amendment);
--   app_status    → application interviewing→offer, or offer→accepted (never backwards), + status event.
create or replace function podium.hiring_offer_transition(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_o         podium.offers;
  v_s         podium.offers;
  v_app       podium.applications;
  v_expected  text[];
  v_to        text := p->>'to_status';
  v_from      text;
  v_doc_id    uuid;
  v_sup       uuid[] := '{}';
  v_app_to    text := nullif(p->>'app_status', '');
  v_app_from  text;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  v_expected := case when jsonb_typeof(p->'expected_status') = 'array'
    then array(select jsonb_array_elements_text(p->'expected_status')) else array[p->>'expected_status'] end;
  select * into v_o from podium.offers
   where id = (p->>'offer_id')::uuid and status = any(v_expected) for update;
  if not found then raise exception 'stale'; end if;
  v_from := v_o.status;

  -- Overlay the allowed columns from p.set onto the current row.
  v_s := jsonb_populate_record(v_o, coalesce(p->'set', '{}'::jsonb));

  if jsonb_typeof(p->'evidence_doc') = 'object' then
    insert into podium.candidate_documents (candidate_id, application_id, doc_type, title, storage_path, file_name,
      mime_type, file_size, uploaded_by)
    values (v_o.candidate_id, v_o.application_id, 'offer_evidence', p->'evidence_doc'->>'title',
      p->'evidence_doc'->>'storage_path', p->'evidence_doc'->>'file_name', p->'evidence_doc'->>'mime_type',
      (p->'evidence_doc'->>'file_size')::bigint, v_actor)
    returning id into v_doc_id;
    v_s.sent_evidence_doc_id := v_doc_id;
  end if;
  if jsonb_typeof(p->'acceptance_doc') = 'object' then
    insert into podium.candidate_documents (candidate_id, application_id, doc_type, title, storage_path, file_name,
      mime_type, file_size, uploaded_by)
    values (v_o.candidate_id, v_o.application_id, 'signed_offer', p->'acceptance_doc'->>'title',
      p->'acceptance_doc'->>'storage_path', p->'acceptance_doc'->>'file_name', p->'acceptance_doc'->>'mime_type',
      (p->'acceptance_doc'->>'file_size')::bigint, v_actor)
    returning id into v_doc_id;
    v_s.acceptance_doc_id := v_doc_id;
  end if;

  if v_to = 'sent' then
    with s as (
      update podium.offers set status = 'superseded'
       where application_id = v_o.application_id and id <> v_o.id and status in ('ready', 'sent')
      returning id)
    select coalesce(array_agg(id), '{}') into v_sup from s;
  elsif v_to = 'accepted' then
    with s as (
      update podium.offers set status = 'superseded'
       where application_id = v_o.application_id and id <> v_o.id and status = 'accepted'
      returning id)
    select coalesce(array_agg(id), '{}') into v_sup from s;
  end if;

  update podium.offers set
    status = v_to,
    band_check = v_s.band_check, budget_id = v_s.budget_id,
    approver_employee_id = v_s.approver_employee_id, requested_by_employee_id = v_s.requested_by_employee_id,
    decided_by_employee_id = v_s.decided_by_employee_id, decided_at = v_s.decided_at, decision_note = v_s.decision_note,
    issue_date = v_s.issue_date, valid_until = v_s.valid_until,
    pdf_path = v_s.pdf_path, pdf_sha256 = v_s.pdf_sha256, rendered_at = v_s.rendered_at,
    sent_at = v_s.sent_at, sent_by = v_s.sent_by, sent_to = v_s.sent_to, sent_cc = v_s.sent_cc,
    sent_evidence_doc_id = v_s.sent_evidence_doc_id,
    accepted_at = v_s.accepted_at, acceptance_doc_id = v_s.acceptance_doc_id,
    declined_at = v_s.declined_at, outcome_note = v_s.outcome_note
  where id = v_o.id
  returning * into v_o;

  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, from_status, to_status, detail)
  values (v_o.candidate_id, v_o.opening_id, v_o.application_id, v_actor, v_actor_emp,
    coalesce(nullif(p->>'event_type', ''), 'offer_' || v_to), v_from, v_to,
    jsonb_strip_nulls(jsonb_build_object('offer_id', v_o.id, 'offer_ref', v_o.offer_ref, 'revision', v_o.revision,
      'note', nullif(btrim(coalesce(p->>'event_note', '')), ''))));
  if array_length(v_sup, 1) > 0 then
    insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
      event_type, to_status, detail)
    select v_o.candidate_id, v_o.opening_id, v_o.application_id, v_actor, v_actor_emp, 'offer_superseded', 'superseded',
           jsonb_build_object('offer_id', o.id, 'offer_ref', o.offer_ref, 'revision', o.revision, 'by_revision', v_o.revision)
      from podium.offers o where o.id = any(v_sup);
  end if;

  if v_app_to is not null then
    select * into v_app from podium.applications where id = v_o.application_id for update;
    v_app_from := v_app.status;
    if (v_app_to = 'offer' and v_app_from = 'interviewing')
       or (v_app_to = 'accepted' and v_app_from = 'offer') then
      update podium.applications set status = v_app_to where id = v_app.id;
      insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
        event_type, from_status, to_status, detail)
      values (v_o.candidate_id, v_o.opening_id, v_o.application_id, v_actor, v_actor_emp, 'status_changed',
        v_app_from, v_app_to, jsonb_build_object('offer_ref', v_o.offer_ref, 'revision', v_o.revision));
    else
      v_app_to := null;
    end if;
  end if;

  return jsonb_build_object('offer', to_jsonb(v_o), 'superseded', to_jsonb(v_sup),
    'application_status', coalesce(v_app_to, v_app_from));
end $$;

-- ── Offer: lazy expiry — every 'sent' revision of these applications whose valid_until < p.today ──
-- p = { application_ids: [uuid…], today: 'YYYY-MM-DD' (IST), actor_user_id, actor_employee_id }
create or replace function podium.hiring_expire_offers(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_ids       uuid[];
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  with e as (
    update podium.offers set status = 'expired'
     where application_id in (select jsonb_array_elements_text(p->'application_ids')::uuid)
       and status = 'sent' and valid_until < (p->>'today')::date
    returning id, candidate_id, opening_id, application_id, offer_ref, revision),
  ev as (
    insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
      event_type, from_status, to_status, detail)
    select candidate_id, opening_id, application_id, v_actor, v_actor_emp, 'offer_expired', 'sent', 'expired',
           jsonb_build_object('offer_id', id, 'offer_ref', offer_ref, 'revision', revision)
      from e
    returning 1)
  select coalesce(array_agg(id), '{}') into v_ids from e;
  return jsonb_build_object('expired', to_jsonb(v_ids));
end $$;

-- ── Template: new version + flip is_current ──────────────────────────────────
-- p = { template_key, title, body, entity_name, entity_address[], footer_note, notes, actor_user_id, actor_employee_id }
create or replace function podium.hiring_template_new_version(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_t     podium.offer_templates;
  v_key   text := p->>'template_key';
  v_ver   int;
  v_actor uuid := nullif(p->>'actor_user_id', '')::uuid;
begin
  perform pg_advisory_xact_lock(hashtext('podium.offer_templates:' || coalesce(v_key, '')));
  select coalesce(max(version), 0) + 1 into v_ver from podium.offer_templates where template_key = v_key;
  update podium.offer_templates set is_current = false where template_key = v_key and is_current;
  insert into podium.offer_templates (template_key, version, title, body, entity_name, entity_address, footer_note,
    notes, is_current, created_by)
  values (v_key, v_ver, p->>'title', p->>'body', p->>'entity_name',
    coalesce(array(select jsonb_array_elements_text(p->'entity_address')), '{}'), p->>'footer_note', p->>'notes',
    true, v_actor)
  returning * into v_t;
  insert into podium.application_events (actor_user_id, actor_employee_id, event_type, detail)
  values (v_actor, nullif(p->>'actor_employee_id', '')::uuid, 'template_version',
    jsonb_build_object('template_key', v_key, 'version', v_ver, 'template_id', v_t.id));
  return jsonb_build_object('template', to_jsonb(v_t));
end $$;

-- ── C1 atomics ───────────────────────────────────────────────────────────────
-- Band change: cancel any pending + insert the new pending version + band_requested event.
-- p = { opening_id, band: {band_min, band_max}, approver_employee_id, note, actor_user_id, actor_employee_id }
create or replace function podium.hiring_request_band_change(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_op        uuid := (p->>'opening_id')::uuid;
  v_b         podium.opening_budgets;
  v_replaced  boolean;
  v_note      text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  perform 1 from podium.openings where id = v_op for update;
  if not found then raise exception 'opening_not_found'; end if;
  update podium.opening_budgets set status = 'cancelled', decided_at = now(), decision_note = 'replaced by a newer request'
   where opening_id = v_op and status = 'pending';
  v_replaced := found;
  insert into podium.opening_budgets (opening_id, version, band_min, band_max, status, requested_by,
    requested_by_employee_id, approver_employee_id)
  values (v_op, (select coalesce(max(version), 0) + 1 from podium.opening_budgets where opening_id = v_op),
    (p->'band'->>'band_min')::numeric, (p->'band'->>'band_max')::numeric, 'pending', v_actor, v_actor_emp,
    (p->>'approver_employee_id')::uuid)
  returning * into v_b;
  -- The request note is free text that may quote numbers → detail.note (stripped on read off the salary chain).
  insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_op, v_actor, v_actor_emp, 'band_requested',
    jsonb_strip_nulls(jsonb_build_object('version', v_b.version, 'approver_employee_id', v_b.approver_employee_id,
      'replaced_pending', v_replaced, 'note', v_note)));
  return jsonb_build_object('budget', to_jsonb(v_b), 'replaced_pending', v_replaced);
end $$;

-- Chain (and field) change: patch the opening + cancel the pending band and re-request it (same numbers)
-- to the new approver, requested by the actor + events.
-- p = { opening_id, patch: {job_role_id, designation, department_id, location_city, location_state, employment_type,
--       headcount, target_join_date, notes, reporting_manager_employee_id, hiring_owner_employee_id} (keys present
--       are applied), pending_budget_id (null = no re-request), approver_employee_id, events: [{event_type, detail}],
--       actor_user_id, actor_employee_id }
-- raise 'stale' when pending_budget_id is given but is no longer pending.
create or replace function podium.hiring_change_chain(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_op        uuid := (p->>'opening_id')::uuid;
  v_o         podium.openings;
  v_n         podium.openings;
  v_old       podium.opening_budgets;
  v_new       podium.opening_budgets;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  select * into v_o from podium.openings where id = v_op for update;
  if not found then raise exception 'opening_not_found'; end if;
  v_n := jsonb_populate_record(v_o, coalesce(p->'patch', '{}'::jsonb));
  update podium.openings set
    job_role_id = v_n.job_role_id, designation = v_n.designation, department_id = v_n.department_id,
    location_city = v_n.location_city, location_state = v_n.location_state, employment_type = v_n.employment_type,
    headcount = v_n.headcount, target_join_date = v_n.target_join_date, notes = v_n.notes,
    reporting_manager_employee_id = v_n.reporting_manager_employee_id,
    hiring_owner_employee_id = v_n.hiring_owner_employee_id
  where id = v_op
  returning * into v_o;

  insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, detail)
  select v_op, v_actor, v_actor_emp, e->>'event_type', e->'detail'
    from jsonb_array_elements(coalesce(p->'events', '[]'::jsonb)) e;

  if nullif(p->>'pending_budget_id', '') is not null then
    update podium.opening_budgets set status = 'cancelled', decided_at = now(), decision_note = 'chain changed — re-requested'
     where id = (p->>'pending_budget_id')::uuid and opening_id = v_op and status = 'pending'
    returning * into v_old;
    if not found then raise exception 'stale'; end if;
    insert into podium.opening_budgets (opening_id, version, band_min, band_max, status, requested_by,
      requested_by_employee_id, approver_employee_id)
    values (v_op, (select coalesce(max(version), 0) + 1 from podium.opening_budgets where opening_id = v_op),
      v_old.band_min, v_old.band_max, 'pending', v_actor, v_actor_emp, (p->>'approver_employee_id')::uuid)
    returning * into v_new;
    insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, detail)
    values (v_op, v_actor, v_actor_emp, 'band_rerequested',
      jsonb_build_object('reason', 'chain_changed', 'approver_employee_id', v_new.approver_employee_id, 'version', v_new.version));
  end if;

  return jsonb_build_object('opening', to_jsonb(v_o), 'rerequested_budget_id', v_new.id);
end $$;

-- JD: insert the next version + make it current + open a draft opening + events.
-- p = { opening_id, jd: {source, jd_text, storage_path, file_name, mime_type, file_size}, actor_user_id, actor_employee_id }
create or replace function podium.hiring_add_jd(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_op        uuid := (p->>'opening_id')::uuid;
  v_o         podium.openings;
  v_from      text;
  v_jd        podium.opening_jds;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  select * into v_o from podium.openings where id = v_op for update;
  if not found then raise exception 'opening_not_found'; end if;
  v_from := v_o.status;
  insert into podium.opening_jds (opening_id, version, source, jd_text, storage_path, file_name, mime_type, file_size, created_by)
  values (v_op, (select coalesce(max(version), 0) + 1 from podium.opening_jds where opening_id = v_op),
    p->'jd'->>'source', p->'jd'->>'jd_text', p->'jd'->>'storage_path', p->'jd'->>'file_name', p->'jd'->>'mime_type',
    (p->'jd'->>'file_size')::bigint, v_actor)
  returning * into v_jd;
  -- First JD on a draft opens it; never reopens on_hold / filled / cancelled.
  update podium.openings set current_jd_id = v_jd.id, status = case when status = 'draft' then 'open' else status end
   where id = v_op returning * into v_o;
  insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_op, v_actor, v_actor_emp, 'jd_added', jsonb_build_object('version', v_jd.version, 'source', v_jd.source));
  if v_from = 'draft' then
    insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, from_status, to_status, reason)
    values (v_op, v_actor, v_actor_emp, 'opening_status', 'draft', 'open', 'JD added');
  end if;
  return jsonb_build_object('jd', to_jsonb(v_jd), 'opening', to_jsonb(v_o));
end $$;

-- ── Grants: service_role only ────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['hiring_create_offer', 'hiring_offer_transition', 'hiring_expire_offers',
    'hiring_template_new_version', 'hiring_request_band_change', 'hiring_change_chain', 'hiring_add_jd'] loop
    execute format('revoke all on function podium.%I(jsonb) from public, anon, authenticated', f);
    execute format('grant execute on function podium.%I(jsonb) to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
