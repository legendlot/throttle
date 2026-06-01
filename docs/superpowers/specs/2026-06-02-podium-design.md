# Podium — LOT People & Performance OS (design spec)
> Created 2026-06-02 (Session 93). Phase 1 shipped this session. See `systems/podium.md` for current truth.

## What it is
Founder-first People & Performance OS for LOT: continuous observations, 6-monthly
appraisals (1–5 + did-well / could-improve / can-do-now), employee profiles + docs,
role/JD/KPI registry, OKRs, and an interactive org chart. Team-facing for self-recorded
wins. Most-confidential data in the stack → strict tiered access enforced server-side.

## Stack (mirrors Ignition 1:1)
- Worker `podiumops` (`05_Throttle/podiumops-worker/src/index.js` → `podiumops.afshaan.workers.dev`).
- App `apps/podium` (Next static export) → `legendlot/podium` gh-pages → `podium.legendoftoys.com`.
- DB: new `podium` schema in Supabase `lot-production`. Private Storage bucket `podium-documents`.
- Auth: Supabase Google OAuth (`@legendoftoys.com`), `store.users_profile.role` → `store.roles.permissions`.

## Locked decisions (S93)
- **Appraisal — Hybrid**: overall 1–5 + 3 prompts always; optional per-KPI sub-ratings; two-sided (self + manager); calibration; share + acknowledge.
- **Increment — Banded suggestion**: configurable %-bands per rating, founder overrides; eligibility indicator; increment + one-time-bonus history.
- **Access — Strict tiered**: `podium_admin`/`podium_hr` (all), `podium_comp` (compensation + salary bands), `podium_view` (directory/org-chart/own record). Manager powers derived from the `manager_id` graph, not a flat perm. Founder `private` observations never visible to the subject. Appraisal hidden until shared.
- **Hosting / security**: GitHub Pages public repo (boundary = worker+RLS+JWT; no data in the bundle — same as Pitstop PII today). The **absolute-salary vault** (`compensation_events.old_ctc/new_ctc/components`) ships but is gated OFF via `podium.settings.comp_vault_enabled` until Phase 5 adds a Cloudflare Access SSO wall on the site + worker. v1 records increment % + bonus amounts only.

## Phasing
1. **Foundation & Profiles** — shipped S93: employees, departments, job_roles + KPIs, documents vault (private signed-URL), compensation log (vault off), interactive org chart + snapshots, directory, admin settings.
2. Performance capture — observations (visibility tiers), accomplishments/wins, 1:1s.
3. Appraisal engine — cycles, eligibility, two-sided hybrid reviews, calibration, banded increments → comp log, share + acknowledge, letters, PIP.
4. OKRs — objectives/KRs cascade, check-ins, scoring.
5. Security hardening + salary vault — Cloudflare Access on site + worker, then flip `comp_vault_enabled`.
6. Google Workspace directory sync (Admin SDK + service account, domain-wide delegation; graceful-until-creds) + analytics + polish.

## Data model (Phase 1 tables)
`settings`, `departments`, `job_roles`, `employees` (auth_user_id nullable → login-less staff; legal_entity; manager_id self-FK), `role_kpis`, `compensation_events` (append-only; CTC cols gated), `documents` (private bucket path), `org_snapshots`. RPC `podium.next_employee_seq()` (EMP-NNN via `store.sequences`). RLS on every table, service_role-only.
