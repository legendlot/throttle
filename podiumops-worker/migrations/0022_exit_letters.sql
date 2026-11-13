-- podium_exit_letters_v1 — X1b: relieving + experience letter generator.
-- Plan: docs/superpowers/plans/2026-11-13-podium-x1b-exit-letters.md (K1–K7) · depends on 0010 (exits), 0008 (offer
-- templates + signatories). AUTHORIZATION STAYS IN THE WORKER (as 0007-0010): every function trusts its caller
-- (service_role only). Rendering is the worker's (src/exit-letters.js); the PDF is uploaded BEFORE exit_letter_issue
-- and removed by the worker if this call fails.
-- Live values checked 2026-11-13: documents.doc_type CHECK = resume|offer_letter|employment_agreement|nda|education_cert|
-- id_proof|bank_details|address_proof|appraisal_letter|increment_letter|other; offer_templates employment v2 (current)
-- carries the Fraternitas letterhead (employees.legal_entity is NULL on every row — never keyed on).

-- ── documents.doc_type: + the two letters (worker RESTRICTED_DOC_TYPES + app DOC_TYPES learn them too) ──
alter table podium.documents drop constraint if exists documents_doc_type_check;
alter table podium.documents add constraint documents_doc_type_check check (doc_type in (
  'resume', 'offer_letter', 'employment_agreement', 'nda', 'education_cert', 'id_proof', 'bank_details', 'address_proof',
  'appraisal_letter', 'increment_letter', 'relieving_letter', 'experience_letter', 'other'));

-- ── Templates (versioned, same shape as offer_templates; a letter pins the version it used) ──
create table podium.exit_letter_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null check (template_key in ('relieving', 'experience')),
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
create unique index exit_letter_templates_one_current on podium.exit_letter_templates(template_key) where is_current;

-- v1 of each: the draft wording (plan § Draft wording — for Afshaan's approval; HR edits = a new version). The
-- letterhead is copied from the current employment offer template (Fraternitas — the only payroll entity).
-- One paragraph per line: a single newline is a line break in the renderer, so a sentence never wraps in the source.
insert into podium.exit_letter_templates (template_key, version, title, body, entity_name, entity_address, notes, is_current)
select v.template_key, 1, v.title, v.body, t.entity_name, coalesce(t.entity_address, '{}'),
       'draft wording — review before first use', true
  from (values
    ('relieving', 'RELIEVING LETTER', $tpl$Date: {{issue_date}} · Ref: {{letter_ref}}

Dear {{employee_name}},

This is to confirm that you have been relieved of your duties with {{entity_name}} with effect from the close of business on {{last_working_day}}. At the time of leaving you were working as {{designation}}{{#has_department}} in the {{department}} team{{/has_department}} (Employee Code {{employee_code}}).

We thank you for your contribution and wish you the very best.$tpl$),
    ('experience', 'TO WHOM IT MAY CONCERN', $tpl$Date: {{issue_date}} · Ref: {{letter_ref}}

This is to certify that {{employee_name}} (Employee Code {{employee_code}}) was employed with {{entity_name}} from {{date_joined}} to {{last_working_day}}. At the time of leaving, the designation held was {{designation}}{{#has_department}} in the {{department}} team{{/has_department}}.

We wish {{employee_name}} success in all future endeavours.$tpl$)
  ) as v(template_key, title, body)
  left join lateral (
    select entity_name, entity_address from podium.offer_templates
     where template_key = 'employment' and is_current limit 1
  ) t on true;

-- ── Ref counters: one row per kind per year (REL-2026-001 / EXP-2026-001). Bumped only inside exit_letter_issue, so a
-- failed issue rolls the counter back with it (never skipped) and the row lock serialises concurrent issues. ──
create table podium.exit_letter_counters (
  kind text not null check (kind in ('relieving', 'experience')),
  year int not null check (year between 2000 and 2999),
  last_n int not null default 0 check (last_n >= 0),
  primary key (kind, year)
);

-- ── Issued letters (append-only). Re-issuing = a new revision of the same ref; nothing is ever overwritten. ──
create table podium.exit_letters (
  id uuid primary key default gen_random_uuid(),
  exit_id uuid not null references podium.employee_exits(id),
  employee_id uuid not null references podium.employees(id),
  kind text not null check (kind in ('relieving', 'experience')),
  revision int not null check (revision >= 1),
  letter_ref text not null check (letter_ref ~ '^(REL|EXP)-[0-9]{4}-[0-9]{3,}$'),
  template_id uuid not null references podium.exit_letter_templates(id),
  signatory_id uuid not null references podium.offer_signatories(id),
  issue_date date not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  document_id uuid not null references podium.documents(id) on delete restrict,   -- the stored file is the record
  issued_by uuid,
  issued_by_employee_id uuid references podium.employees(id),
  issued_at timestamptz not null default now(),
  unique (exit_id, kind, revision),
  unique (letter_ref, revision),
  unique (document_id)
);
create index exit_letters_exit_idx on podium.exit_letters (exit_id, kind, revision desc);
create index exit_letters_employee_idx on podium.exit_letters (employee_id, issued_at desc);

create or replace function podium.exit_letters_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'exit_letters is append-only';
end $$;
create trigger exit_letters_no_update before update or delete on podium.exit_letters
  for each row execute function podium.exit_letters_append_only();

-- An exit with issued letters can't be cancelled (the worker refuses first with the same code; this holds under the
-- row lock, so a letter issued while a cancel is in flight still wins). Raises podium_letters_issued.
create or replace function podium.exit_cancel_guard_letters() returns trigger language plpgsql as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled'
     and exists (select 1 from podium.exit_letters where exit_id = new.id) then
    raise exception 'podium_letters_issued';
  end if;
  return new;
end $$;
create trigger employee_exits_no_cancel_with_letters before update of status on podium.employee_exits
  for each row execute function podium.exit_cancel_guard_letters();

-- ── RLS: on, no policies; service_role only (as 0010) ────────────────────────
do $$
declare t text;
begin
  foreach t in array array['exit_letter_templates', 'exit_letter_counters', 'exit_letters'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── Issue: allocate the ref + revision, insert the document + the letter, in one transaction ──
-- p = { exit_id, kind, expected_ref, expected_revision, year, template_id, signatory_id, issue_date, sha256,
--       storage_path, file_name, file_size, title, actor_user_id, actor_employee_id }
-- The worker rendered the PDF with the ref + revision it EXPECTS (the ref is printed on the letter) and uploaded it;
-- under the exit lock this allocates the real ones and refuses if they differ (podium_ref_conflict → the worker
-- removes its file and retries). Revision 1 mints <REL|EXP>-<year>-NNN from the counter; later revisions reuse the
-- exit's ref for that kind (as offers reuse OFR-). "Today" for before_lwd is the DB's IST date.
-- Raises podium_<code>: bad_expected · exit_not_found · exit_cancelled · before_lwd · bad_kind · bad_storage_path · ref_conflict.
create or replace function podium.exit_letter_issue(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_x      podium.employee_exits;
  v_kind   text := p->>'kind';
  v_year   int := (p->>'year')::int;
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_rev    int;
  v_ref    text;
  v_n      int;
  v_doc    podium.documents;
  v_l      podium.exit_letters;
begin
  if v_kind is null or v_kind not in ('relieving', 'experience') then raise exception 'podium_bad_kind'; end if;
  -- The caller must say which ref + revision it printed; a missing one would compare as "anything goes".
  if nullif(p->>'expected_revision', '') is null or nullif(p->>'expected_ref', '') is null then
    raise exception 'podium_bad_expected';
  end if;
  select * into v_x from podium.employee_exits where id = (p->>'exit_id')::uuid for update;
  if not found then raise exception 'podium_exit_not_found'; end if;
  if v_x.status = 'cancelled' then raise exception 'podium_exit_cancelled'; end if;
  if v_today < v_x.lwd then raise exception 'podium_before_lwd' using detail = v_x.lwd::text; end if;
  -- The file must sit under this employee's documents path (the bucket also holds hiring files).
  if coalesce(p->>'storage_path', '') not like v_x.employee_id::text || '/exit_letters/%'
     or position('..' in p->>'storage_path') > 0 then
    raise exception 'podium_bad_storage_path';
  end if;

  select coalesce(max(revision), 0) + 1, max(letter_ref) into v_rev, v_ref
    from podium.exit_letters where exit_id = v_x.id and kind = v_kind;
  if v_rev = 1 then
    insert into podium.exit_letter_counters (kind, year, last_n) values (v_kind, v_year, 0)
      on conflict (kind, year) do nothing;
    update podium.exit_letter_counters set last_n = last_n + 1
     where kind = v_kind and year = v_year
    returning last_n into v_n;
    v_ref := case v_kind when 'relieving' then 'REL' else 'EXP' end || '-' || v_year::text || '-'
             || lpad(v_n::text, greatest(3, length(v_n::text)), '0');
  end if;
  if v_rev <> (p->>'expected_revision')::int or v_ref is distinct from (p->>'expected_ref') then
    raise exception 'podium_ref_conflict' using detail = v_ref || ' r' || v_rev::text;
  end if;

  insert into podium.documents (employee_id, doc_type, title, storage_path, file_name, mime_type, file_size, uploaded_by)
  values (v_x.employee_id, v_kind || '_letter', p->>'title', p->>'storage_path', p->>'file_name', 'application/pdf',
    nullif(p->>'file_size', '')::bigint, nullif(p->>'actor_user_id', '')::uuid)
  returning * into v_doc;

  insert into podium.exit_letters (exit_id, employee_id, kind, revision, letter_ref, template_id, signatory_id, issue_date,
    sha256, document_id, issued_by, issued_by_employee_id)
  values (v_x.id, v_x.employee_id, v_kind, v_rev, v_ref, (p->>'template_id')::uuid, (p->>'signatory_id')::uuid,
    (p->>'issue_date')::date, p->>'sha256', v_doc.id, nullif(p->>'actor_user_id', '')::uuid,
    nullif(p->>'actor_employee_id', '')::uuid)
  returning * into v_l;

  return jsonb_build_object('letter', to_jsonb(v_l), 'document', to_jsonb(v_doc));
end $$;

-- ── Template: new version + flip is_current (as hiring_template_new_version) ──
-- p = { template_key, title, body, entity_name, entity_address[], footer_note, notes, actor_user_id }
create or replace function podium.exit_letter_template_new_version(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_t   podium.exit_letter_templates;
  v_key text := p->>'template_key';
  v_ver int;
begin
  perform pg_advisory_xact_lock(hashtext('podium.exit_letter_templates:' || coalesce(v_key, '')));
  select coalesce(max(version), 0) + 1 into v_ver from podium.exit_letter_templates where template_key = v_key;
  update podium.exit_letter_templates set is_current = false where template_key = v_key and is_current;
  insert into podium.exit_letter_templates (template_key, version, title, body, entity_name, entity_address, footer_note,
    notes, is_current, created_by)
  values (v_key, v_ver, p->>'title', p->>'body', p->>'entity_name',
    coalesce(array(select jsonb_array_elements_text(p->'entity_address')), '{}'), p->>'footer_note', p->>'notes',
    true, nullif(p->>'actor_user_id', '')::uuid)
  returning * into v_t;
  return jsonb_build_object('template', to_jsonb(v_t));
end $$;

-- ── Grants: service_role only ────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['exit_letter_issue', 'exit_letter_template_new_version'] loop
    execute format('revoke all on function podium.%I(jsonb) from public, anon, authenticated', f);
    execute format('grant execute on function podium.%I(jsonb) to service_role', f);
  end loop;
end $$;
revoke all on function podium.exit_letters_append_only() from public, anon, authenticated;
revoke all on function podium.exit_cancel_guard_letters() from public, anon, authenticated;

notify pgrst, 'reload schema';
