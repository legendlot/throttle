-- podium_offer_link_v1 — Hiring O1: the offer email + the candidate's acceptance link.
-- Plan: docs/superpowers/plans/2026-11-12-podium-o1-offer-link.md · depends on 0006 + 0008 + 0011.
-- AUTHORIZATION STAYS IN THE WORKER: the public routes prove the link (token hash) and the functions below
-- re-check it under the offer lock. service_role only. Raises podium_<code>.
-- No salary figure and no bank number is ever written into application_events by these functions.

-- ── Every mail Podium sends about an offer (D8 send intent → Gmail → reconcile) ──
create table podium.offer_emails (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references podium.offers(id),
  application_id uuid not null references podium.applications(id),
  -- offer / confirmation go to the candidate (To only, never CC); offer_copy / confirmation_copy are the link-free
  -- copies for the people on CC; alert = an internal note. (src/offerlink.js MAIL_KINDS)
  kind text not null check (kind in ('offer', 'offer_copy', 'confirmation', 'confirmation_copy', 'alert')),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'unknown')),
  sender_email text not null,
  to_email text not null,
  cc_emails text[] not null default '{}',
  -- On an 'offer' row: who gets its link-free copy (→ offers.sent_cc). A copy row points at its parent.
  copy_to text[] not null default '{}',
  parent_email_id uuid references podium.offer_emails(id),
  subject text not null,
  message_id_header text not null unique,
  gmail_message_id text,
  gmail_thread_id text,
  -- SHA-256 hex of the link token; the token itself is never stored. Only an 'offer' mail carries a link.
  token_hash text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  link_revoked_at timestamptz,
  -- Reconcile (D8.3 / review I): unknown → failed only after two misses ≥ 2 minutes apart.
  reconcile_misses int not null default 0 check (reconcile_misses >= 0),
  last_reconciled_at timestamptz,
  error text check (error is null or length(error) <= 1000),
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  check (kind = 'offer' or token_hash is null),
  check (kind <> 'offer' or token_hash is not null),
  check (kind in ('offer', 'confirmation', 'alert') or parent_email_id is not null)
);
-- Atomic send claim: one unresolved offer mail per offer (a double click, or a send while the last one is
-- still being checked, inserts once — the loser gets 23505 → send_pending).
create unique index offer_emails_one_pending on podium.offer_emails(offer_id)
  where kind = 'offer' and status in ('sending', 'unknown');
-- One confirmation per offer (a conflict = skip, never a second Gmail call); a failed one may be retried.
create unique index offer_emails_one_confirmation on podium.offer_emails(offer_id)
  where kind = 'confirmation' and status in ('sending', 'unknown', 'sent');
-- One copy per parent mail.
create unique index offer_emails_one_copy on podium.offer_emails(parent_email_id)
  where kind in ('offer_copy', 'confirmation_copy') and status in ('sending', 'unknown', 'sent');
create index offer_emails_application_idx on podium.offer_emails(application_id, created_at desc);
create index offer_emails_offer_idx on podium.offer_emails(offer_id, created_at desc);

-- ── The acceptance evidence (append-only) ──
create table podium.offer_acceptances (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null unique references podium.offers(id),
  revision int not null check (revision >= 1),
  pdf_sha256 text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  typed_name text not null check (length(btrim(typed_name)) between 1 and 200),
  confirmed_join_date date not null,
  accepted_at timestamptz not null,
  ip text check (ip is null or length(ip) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  signed_doc_id uuid references podium.candidate_documents(id),
  created_at timestamptz not null default now()
);
create or replace function podium.refuse_acceptance_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'offer_acceptances is append-only';
end $$;
create trigger offer_acceptances_no_change before update or delete on podium.offer_acceptances
  for each row execute function podium.refuse_acceptance_mutation();

-- ── What the candidate said through the link (decline / question) + a blocked acceptance ──
create table podium.offer_responses (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references podium.offers(id),
  application_id uuid not null references podium.applications(id),
  kind text not null check (kind in ('decline', 'question', 'accept_blocked')),
  reason text check (reason is null or reason in ('compensation', 'role', 'location', 'another_offer', 'personal', 'other')),
  text text check (text is null or length(text) <= 2000),
  proposed_join_date date,
  ip text check (ip is null or length(ip) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  created_at timestamptz not null default now(),
  seen_by uuid,
  seen_at timestamptz,
  check (kind <> 'decline' or reason is not null),
  check (kind <> 'question' or length(btrim(coalesce(text, ''))) > 0),
  check ((seen_at is null) = (seen_by is null))
);
create index offer_responses_offer_idx on podium.offer_responses(offer_id, created_at);
-- One blocked acceptance per offer: the alert goes only with the insert that won.
create unique index offer_responses_one_blocked on podium.offer_responses(offer_id) where kind = 'accept_blocked';
create index offer_responses_open_idx on podium.offer_responses(created_at desc) where seen_at is null;

-- ── The candidate's bank details (D3): employee_private's column names + CHECKs; masked everywhere ──
-- First submit = insert-or-ignore; a change only inside an HR "allow update" window (editable_until), used up by it.
create table podium.candidate_bank_details (
  candidate_id uuid primary key references podium.candidates(id) on delete cascade,
  bank_account_number text not null check (bank_account_number ~ '^[0-9]{9,18}$'),
  bank_ifsc text not null check (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_account_name text not null check (length(btrim(bank_account_name)) between 1 and 120),
  bank_name text check (bank_name is null or length(bank_name) <= 120),
  submitted_at timestamptz not null default now(),
  offer_id uuid references podium.offers(id),
  editable_until timestamptz,
  reopen_by uuid,
  updated_at timestamptz not null default now()
);
create trigger candidate_bank_details_touch before update on podium.candidate_bank_details
  for each row execute function podium.touch_updated_at();

-- ── Upload reservations (review E): a signed upload URL is minted only against a reserved slot ──
-- ≤ 30 per offer (offer_link_reserve_upload counts under the offer lock); upload-done completes it once.
create table podium.offer_link_uploads (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references podium.offers(id),
  candidate_id uuid not null references podium.candidates(id) on delete cascade,
  storage_path text not null unique check (storage_path like 'candidates/%/link/%' and position('..' in storage_path) = 0),
  doc_type text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index offer_link_uploads_offer_idx on podium.offer_link_uploads(offer_id);

-- The private bucket caps an object at 15 MB (the signed upload URL cannot) — only if nobody set a limit yet.
update storage.buckets set file_size_limit = 15728640 where id = 'podium-documents' and file_size_limit is null;

-- ── Candidate documents: HR verification + where the file came from ──
alter table podium.candidate_documents
  add column verified_by uuid,
  add column verified_at timestamptz,
  add column source text not null default 'staff' check (source in ('staff', 'candidate_link'));
alter table podium.candidate_documents
  add constraint candidate_documents_verified_pair check ((verified_at is null) = (verified_by is null));

-- ── RLS: on, no policies; service_role only ──────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['offer_emails', 'offer_acceptances', 'offer_responses', 'candidate_bank_details', 'offer_link_uploads'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── D6: is this token the live link of this offer? (twin of src/offerlink.js isLinkLive) ──
create or replace function podium.offer_link_live(p_offer uuid, p_token_hash text)
returns boolean language sql stable security definer set search_path to 'podium', 'public' as $$
  select exists (
    select 1 from podium.offer_emails e
     where e.offer_id = p_offer and e.token_hash = p_token_hash and e.kind = 'offer'
       and e.link_revoked_at is null and e.status in ('sending', 'sent', 'unknown')
       and not exists (select 1 from podium.offer_emails n
                        where n.offer_id = e.offer_id and n.kind = 'offer' and n.id <> e.id
                          and n.status in ('sending', 'sent', 'unknown') and n.created_at > e.created_at))
$$;

-- ── Accept through the link ──────────────────────────────────────────────────
-- p = { offer_id, token_hash, typed_name, confirmed_join_date, accepted_at, ip, user_agent, pdf_sha256,
--       signed_doc: {storage_path, file_name, mime_type, file_size, title}, today: 'YYYY-MM-DD' (IST) }
-- Lock order offer → application → opening (as hiring_confirm_joining). Checks: sent → validity → live link →
-- opening open + headcount (D5) → transition
-- sent → accepted (+ the signed_offer document, application → accepted) → the evidence row.
-- Raises podium_<code>: offer_not_found · offer_not_open · offer_expired · link_dead · join_date_mismatch ·
-- pdf_changed · opening_closed · headcount_full; the transition's own 'stale' / 'not_latest' pass through.
create or replace function podium.offer_link_accept(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_o       podium.offers;
  v_op      podium.openings;
  v_taken   int;
  v_res     jsonb;
  v_acc     uuid;
  v_today   date := coalesce(nullif(p->>'today', '')::date, (now() at time zone 'Asia/Kolkata')::date);
begin
  select * into v_o from podium.offers where id = (p->>'offer_id')::uuid for update;
  if not found then raise exception 'podium_offer_not_found'; end if;
  perform 1 from podium.applications where id = v_o.application_id for update;
  if v_o.status <> 'sent' then raise exception 'podium_offer_not_open'; end if;
  if v_o.valid_until is not null and v_o.valid_until < v_today then raise exception 'podium_offer_expired'; end if;
  if not podium.offer_link_live(v_o.id, p->>'token_hash') then raise exception 'podium_link_dead'; end if;
  if (p->>'confirmed_join_date')::date is distinct from v_o.start_date then raise exception 'podium_join_date_mismatch'; end if;
  if v_o.pdf_sha256 is distinct from p->>'pdf_sha256' then raise exception 'podium_pdf_changed'; end if;

  -- D5: the seat check is atomic — two acceptances on the last seat serialise on the opening row. A closed
  -- (filled / on hold / cancelled) opening is a blocked acceptance too.
  select * into v_op from podium.openings where id = v_o.opening_id for update;
  if v_op.status <> 'open' then raise exception 'podium_opening_closed'; end if;
  select count(*) into v_taken from podium.offers
   where opening_id = v_o.opening_id and status = 'accepted' and application_id <> v_o.application_id;
  if v_taken >= v_op.headcount then raise exception 'podium_headcount_full'; end if;

  v_res := podium.hiring_offer_transition(jsonb_build_object(
    'offer_id', v_o.id, 'expected_status', 'sent', 'to_status', 'accepted',
    'set', jsonb_build_object('accepted_at', v_today),
    'acceptance_doc', p->'signed_doc', 'app_status', 'accepted', 'event_type', 'offer_accepted_link',
    'expected_terms_hash', v_o.terms_hash, 'actor_user_id', null, 'actor_employee_id', null));

  -- After the transition, so the evidence row can point at the signed_offer document it created.
  insert into podium.offer_acceptances (offer_id, revision, pdf_sha256, typed_name, confirmed_join_date, accepted_at,
    ip, user_agent, token_hash, signed_doc_id)
  values (v_o.id, v_o.revision, v_o.pdf_sha256, btrim(p->>'typed_name'), v_o.start_date,
    coalesce(nullif(p->>'accepted_at', '')::timestamptz, now()), left(nullif(p->>'ip', ''), 100),
    left(nullif(p->>'user_agent', ''), 500), p->>'token_hash', nullif(v_res->'offer'->>'acceptance_doc_id', '')::uuid)
  returning id into v_acc;
  update podium.candidate_documents set source = 'candidate_link'
   where id = nullif(v_res->'offer'->>'acceptance_doc_id', '')::uuid;

  return v_res || jsonb_build_object('acceptance_id', v_acc);
end $$;

-- ── Decline / question through the link ──────────────────────────────────────
-- p = { offer_id, token_hash, kind: 'decline'|'question', reason, text, proposed_join_date, ip, user_agent, today }
-- decline → the response + sent → declined (one transaction). question → the response only (state unchanged),
-- at most 10 per offer per IST day.
-- Raises podium_<code>: offer_not_found · offer_not_open · offer_expired · link_dead · bad_kind · bad_reason ·
-- text_required · text_too_long · question_cap.
create or replace function podium.offer_link_respond(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_o       podium.offers;
  v_kind    text := p->>'kind';
  v_reason  text := nullif(p->>'reason', '');
  v_text    text := nullif(btrim(coalesce(p->>'text', '')), '');
  v_today   date := coalesce(nullif(p->>'today', '')::date, (now() at time zone 'Asia/Kolkata')::date);
  v_n       int;
  v_id      uuid;
  v_res     jsonb := '{}'::jsonb;
begin
  select * into v_o from podium.offers where id = (p->>'offer_id')::uuid for update;
  if not found then raise exception 'podium_offer_not_found'; end if;
  if v_o.status <> 'sent' then raise exception 'podium_offer_not_open'; end if;
  if v_o.valid_until is not null and v_o.valid_until < v_today then raise exception 'podium_offer_expired'; end if;
  if not podium.offer_link_live(v_o.id, p->>'token_hash') then raise exception 'podium_link_dead'; end if;
  if v_kind is null or v_kind not in ('decline', 'question') then raise exception 'podium_bad_kind'; end if;
  if v_text is not null and length(v_text) > 2000 then raise exception 'podium_text_too_long'; end if;

  if v_kind = 'decline' then
    if v_reason is null or v_reason not in ('compensation', 'role', 'location', 'another_offer', 'personal', 'other') then
      raise exception 'podium_bad_reason';
    end if;
  else
    if v_text is null then raise exception 'podium_text_required'; end if;
    select count(*) into v_n from podium.offer_responses
     where offer_id = v_o.id and kind = 'question' and (created_at at time zone 'Asia/Kolkata')::date = v_today;
    if v_n >= 10 then raise exception 'podium_question_cap'; end if;
  end if;

  insert into podium.offer_responses (offer_id, application_id, kind, reason, text, proposed_join_date, ip, user_agent)
  values (v_o.id, v_o.application_id, v_kind, case when v_kind = 'decline' then v_reason end, v_text,
    case when v_kind = 'question' then nullif(p->>'proposed_join_date', '')::date end,
    left(nullif(p->>'ip', ''), 100), left(nullif(p->>'user_agent', ''), 500))
  returning id into v_id;

  if v_kind = 'decline' then
    -- The free text can quote a figure → outcome_note + detail.note (stripped on read off the salary chain).
    v_res := podium.hiring_offer_transition(jsonb_build_object(
      'offer_id', v_o.id, 'expected_status', 'sent', 'to_status', 'declined',
      'set', jsonb_build_object('declined_at', now(), 'outcome_note', v_reason || coalesce(': ' || v_text, '')),
      'event_type', 'offer_declined_link', 'event_note', v_text, 'actor_user_id', null, 'actor_employee_id', null));
  else
    insert into podium.application_events (candidate_id, opening_id, application_id, event_type, detail)
    values (v_o.candidate_id, v_o.opening_id, v_o.application_id, 'offer_question_link',
      jsonb_build_object('offer_id', v_o.id, 'offer_ref', v_o.offer_ref, 'revision', v_o.revision, 'response_id', v_id));
  end if;

  return v_res || jsonb_build_object('response_id', v_id, 'kind', v_kind);
end $$;

-- ── Reserve an upload slot (review E) ─────────────────────────────────────────
-- p = { offer_id, candidate_id, storage_path, doc_type }. The worker has already proved the link and the documents
-- step; this only makes the cap atomic. Raises podium_<code>: offer_not_found · upload_cap.
create or replace function podium.offer_link_reserve_upload(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_o   podium.offers;
  v_n   int;
  v_id  uuid;
begin
  select * into v_o from podium.offers where id = (p->>'offer_id')::uuid for update;
  if not found or v_o.candidate_id is distinct from (p->>'candidate_id')::uuid then raise exception 'podium_offer_not_found'; end if;
  select count(*) into v_n from podium.offer_link_uploads where offer_id = v_o.id;
  if v_n >= 30 then raise exception 'podium_upload_cap'; end if;
  insert into podium.offer_link_uploads (offer_id, candidate_id, storage_path, doc_type)
  values (v_o.id, v_o.candidate_id, p->>'storage_path', p->>'doc_type')
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'reserved', v_n + 1);
end $$;

-- ── Grants: service_role only ────────────────────────────────────────────────
revoke all on function podium.offer_link_live(uuid, text) from public, anon, authenticated;
grant execute on function podium.offer_link_live(uuid, text) to service_role;
do $$
declare f text;
begin
  foreach f in array array['offer_link_accept', 'offer_link_respond', 'offer_link_reserve_upload'] loop
    execute format('revoke all on function podium.%I(jsonb) from public, anon, authenticated', f);
    execute format('grant execute on function podium.%I(jsonb) to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
