-- podium_cv_import_v1 — Hiring C4: bulk CV import, extraction only (OpenAI), review-and-confirm.
-- Plan: docs/superpowers/plans/2026-11-12-podium-c4-cv-import.md · depends on 0006 (hiring) + 0012.
-- AUTHORIZATION STAYS IN THE WORKER. service_role only. Nothing here writes to candidates —
-- HR's Accept goes through the existing hiring_create_candidate path.

-- ── AI settings: one row. Model per feature, monthly ₹ cap, prices (USD per 1M tokens) ──
create table podium.ai_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  provider text not null default 'openai' check (provider in ('openai')),
  extract_model text not null default 'gpt-6-luna',
  monthly_cap_inr numeric not null default 2000 check (monthly_cap_inr >= 0),
  usd_inr numeric not null default 90 check (usd_inr > 0),
  -- {"<model>": {"in": $, "cached": $, "out": $}} per 1M tokens (developers.openai.com/api/docs/pricing, 2026-11-12)
  prices jsonb not null default '{"gpt-6-luna": {"in": 0.10, "cached": 0.01, "out": 0.50},
                                  "gpt-6.1-terra": {"in": 1.00, "cached": 0.05, "out": 5.00},
                                  "gpt-6.1-sol": {"in": 2.00, "cached": 0.10, "out": 10.00}}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into podium.ai_settings default values;

-- ── Every AI call: reserved before the call, settled after (D6) ──
create table podium.ai_calls (
  id uuid primary key default gen_random_uuid(),
  feature text not null check (feature in ('cv_extract')),
  provider text not null,
  model text not null,
  prompt_version text not null,
  ref_id uuid,
  status text not null default 'reserved' check (status in ('reserved', 'ok', 'failed')),
  reserved_inr numeric not null check (reserved_inr >= 0),
  cost_inr numeric check (cost_inr is null or cost_inr >= 0),
  input_tokens int, cached_tokens int, output_tokens int, reasoning_tokens int,
  error text,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ai_calls_created_at on podium.ai_calls (created_at);

-- ── A batch: one opening, one source ──
create table podium.cv_imports (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references podium.openings(id),
  source text not null,
  source_detail text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  -- last activity; the lazy 7-day purge keys on it (D10)
  updated_at timestamptz not null default now()
);
create index cv_imports_opening on podium.cv_imports (opening_id);

-- ── One uploaded file ──
create table podium.cv_import_items (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references podium.cv_imports(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  file_size bigint not null check (file_size > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'extracting', 'extracted', 'needs_manual', 'accepting', 'accepted', 'skipped')),
  extract_mode text check (extract_mode in ('text', 'file', 'image', 'cache', 'manual')),
  model text,
  prompt_version text,
  ai_call_id uuid references podium.ai_calls(id),
  extracted jsonb,                       -- validated AI output (D9)
  warnings text[] not null default '{}',
  final jsonb,                           -- what HR accepted (D9)
  candidate_id uuid references podium.candidates(id),
  application_id uuid references podium.applications(id),
  document_id uuid references podium.candidate_documents(id),
  attempts int not null default 0 check (attempts >= 0),
  last_error text,
  extracting_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cv_import_items_import on podium.cv_import_items (import_id);
create index cv_import_items_sha on podium.cv_import_items (sha256) where sha256 is not null;

-- ── Candidate documents: a CV that came in through an import ──
alter table podium.candidate_documents drop constraint candidate_documents_source_check;
alter table podium.candidate_documents
  add constraint candidate_documents_source_check check (source in ('staff', 'candidate_link', 'cv_import'));

-- ── RLS: on, no policies; service_role only ──
do $$
declare t text;
begin
  foreach t in array array['ai_settings', 'ai_calls', 'cv_imports', 'cv_import_items'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── D6: reserve spend under one lock. This IST month = settled cost + open reservations. ──
-- p: {feature, model, prompt_version, ref_id, estimate_inr, actor_user_id}
create or replace function podium.ai_reserve(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  s podium.ai_settings;
  est numeric := coalesce((p->>'estimate_inr')::numeric, 0);
  month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  spent numeric;
  rid uuid;
begin
  if est < 0 then raise exception 'podium_bad_estimate'; end if;
  perform pg_advisory_xact_lock(hashtext('podium_ai_spend'));
  select * into s from podium.ai_settings where id = 1;
  if not found or not s.enabled then raise exception 'podium_ai_disabled'; end if;
  select coalesce(sum(case when status = 'reserved' then reserved_inr else coalesce(cost_inr, reserved_inr) end), 0)
    into spent from podium.ai_calls where created_at >= month_start;
  if spent + est > s.monthly_cap_inr then
    raise exception 'podium_ai_cap' using detail = json_build_object('spent', round(spent, 2), 'cap', s.monthly_cap_inr)::text;
  end if;
  insert into podium.ai_calls (feature, provider, model, prompt_version, ref_id, reserved_inr, actor_user_id)
  values (p->>'feature', s.provider, p->>'model', p->>'prompt_version', nullif(p->>'ref_id', '')::uuid, est,
          nullif(p->>'actor_user_id', '')::uuid)
  returning id into rid;
  return jsonb_build_object('id', rid, 'spent_inr', round(spent, 2), 'cap_inr', s.monthly_cap_inr);
end $$;

-- This IST month's spend + cap, for the page header.
create or replace function podium.ai_month_spend()
returns jsonb language sql stable security definer set search_path to 'podium', 'public' as $$
  select jsonb_build_object(
    'spent_inr', round(coalesce(sum(case when c.status = 'reserved' then c.reserved_inr else coalesce(c.cost_inr, c.reserved_inr) end), 0), 2),
    'calls', count(c.id),
    'cap_inr', (select monthly_cap_inr from podium.ai_settings where id = 1),
    'enabled', (select enabled from podium.ai_settings where id = 1))
  from podium.ai_calls c
  where c.created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
$$;

do $$
declare f text;
begin
  foreach f in array array['ai_reserve(jsonb)', 'ai_month_spend()'] loop
    execute format('revoke all on function podium.%s from public, anon, authenticated', f);
    execute format('grant execute on function podium.%s to service_role', f);
  end loop;
end $$;
