-- podium_candidate_sources_v1 — C5: Add candidate CV-first, two more sources, the CV batch carries a referrer.
-- Plan: docs/superpowers/plans/2026-11-13-podium-c5-add-candidate-cv-first.md (D1, D3) · depends on 0006 (applications),
-- 0013 (cv_imports). No data change: live 2026-11-13 every application is source 'other', so the wider CHECK binds cleanly.
-- The referral rule (a referral names an employee OR an outside referrer in source_detail) is the worker's
-- (src/hiring.js referralError), not a CHECK — older rows predate it and the mcp gateway sends 'other'.

-- ── applications.source: + direct_email, job_portal (worker APP_SOURCES + app SOURCES learn them too) ──
alter table podium.applications drop constraint if exists applications_source_check;
alter table podium.applications add constraint applications_source_check check (source in (
  'referral', 'linkedin', 'naukri', 'job_portal', 'direct_email', 'campus', 'walk_in', 'agency', 'careers_page', 'other'));

-- ── cv_imports: a referral batch names the referring employee; cvImportAccept copies it onto each application ──
alter table podium.cv_imports add column if not exists referrer_employee_id uuid references podium.employees(id);

notify pgrst, 'reload schema';
