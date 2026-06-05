-- Docket — Scratchpad. Applied to lot-production as migration `docket_scratchpad_v1` (2026-06-05).
-- Per-person private notes (RULE-DOCKET-005): free text + inline checkboxes + inline math.
-- Scoped by user_id in every docketops handler (no admin/break-glass path); RLS-on/service_role.
create table docket.scratch_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text,
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index docket_scratch_notes_user_idx on docket.scratch_notes(user_id, updated_at desc nulls last);
alter table docket.scratch_notes enable row level security;
grant all on docket.scratch_notes to service_role;
