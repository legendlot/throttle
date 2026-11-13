# Podium C5 — Add candidate: CV first, sources, CTC + notice — plan

> Afshaan 2026-11-13: (1) "Add candidate" on an opening opens the full form; it should offer **Upload CV first,
> Enter manually second**. (2) Capture where a candidate came from: LinkedIn, referral (+ the referrer), direct
> email, Naukri / other job portals, recruitment agency, etc. (3) Capture current CTC and notice period.
> Migration `0023_candidate_sources.sql` (`podium_candidate_sources_v1`). No cron, `wrangler.toml` untouched.

## What already exists (measured 2026-11-13; do not rebuild)

- `podium.applications` already has `source` (CHECK `applications_source_check`: referral, linkedin, naukri, campus,
  walk_in, agency, careers_page, other), `referrer_employee_id`, `source_detail`, `current_ctc`, `expected_ctc`,
  `notice_period_days`. The manual Add-candidate form, the candidate page's application edit, and the CV review
  card (`components/CvImportBits.js`) already edit them. CTC is shown/accepted only for the opening's salary chain
  (`canSeeSalary` in the app, `cleanApplication(d, salaryOk)` in the worker) — keep that gate exactly.
- The CV import (C4) flow: `/hiring/import` (pick opening + source → `createCvImport`) → `/hiring/import/batch/?id=`
  (drop files → `cvImportUploadUrl` → PUT → `cvImportFileDone` → `cvImportExtract` → review → `cvImportAccept`).
  AI already extracts notice + current/expected CTC when the CV states them. Source is **per batch** and the import
  page hides `referral` because a batch can't carry a referrer.

## Changes

### D1 Sources (migration + every list)
- Add `direct_email` ("Direct email") and `job_portal` ("Other job portal") to `applications_source_check`
  (drop + re-add in 0023) and to `APP_SOURCES` in `podiumops-worker/src/hiring.js`. Relabel `agency` → "Recruitment
  agency". App `SOURCES` (`apps/podium/src/lib/hiring.js`) in this order: LinkedIn, Naukri, Other job portal,
  Referral, Direct email, Recruitment agency, Careers page, Campus, Walk-in, Other.
- Source-detail placeholder by source: referral → "Not an employee? Referrer's name"; job_portal → "Which portal
  (Indeed, Instahyre, Foundit…)"; agency → "Agency name"; direct_email → "Who received it"; else "Campaign, post, note…".
  One helper `sourceDetailHint(source)` in `lib/hiring.js`, used by every form that edits source.
- `mcpgateway-worker/src/tools/podium.js` sends `source:'other'` — unchanged and still valid; touch nothing there
  (another lane has uncommitted edits in that worker).

### D2 Referral rule (worker)
- When the resulting application's source is `referral`, it must have `referrer_employee_id` OR a non-empty
  `source_detail` (an outside referrer's name). Else 400 `referrer_required` ("Pick who referred them, or type the
  referrer's name"). Enforce in `createCandidate`, `addApplication`, `updateApplication` (check the merged final
  state, not just the patch) and `createCvImport`. Pure helper (e.g. `referralError(source, referrerId, detail)`)
  in `hiring.js` with tests.

### D3 CV import carries the referrer
- 0023: `alter table podium.cv_imports add column referrer_employee_id uuid references podium.employees(id)`.
- `createCvImport {opening_id, source, source_detail, referrer_employee_id}` stores it (only when source =
  referral, else null; uuid-validated). `cvImportAccept` passes `referrer_employee_id: c.imp.referrer_employee_id`
  in `appData` (check `cvImportCtx`'s select includes the new column). The batch read returns the referrer's name
  for the header.
- `/hiring/import` page: stop filtering out `referral`; show "Referred by" (employee Combobox, same as the opening
  form) when source = referral; the detail hint from D1.

### D4 "Add candidate" = Upload CV first
- On the opening page (`hiring/openings/detail/page.js`, `CandidatesCard`), the Add candidate button opens a
  chooser, not the form: **Upload CV** (primary) and **Enter manually** (secondary → today's form, unchanged except
  D1/D5).
- Upload CV panel: Source, Referred by (when referral), Source detail, and a "Choose CV(s)" file input (multiple,
  same ACCEPT list + `MAX_UPLOAD_BYTES` check as the batch page). Picking files → `createCvImport` for THIS opening →
  hand the File objects to the batch page through a tiny module-level handoff (`lib/cvHandoff.js`:
  `putPendingFiles(importId, files)` / `takePendingFiles(importId)`; client-side navigation keeps the module alive)
  → `router.push('/hiring/import/batch/?id=<id>')`. The batch page, once its data has loaded, takes any pending
  files for its id and runs them through **the same function its drop zone uses** (no second upload path). A hard
  reload loses the handoff harmlessly: the batch is just empty and the drop zone is there.
- Same `blocked` gate as today (no JD / not open → button disabled with the reason).

### D5 CTC + notice visibility
- Manual form row order: identity (name, email, phone) → Source / Referred by / Source detail → Notice (days) +
  (salary chain only) Current CTC + Expected CTC → employer / title / experience → location / LinkedIn → notes.
- Opening candidate list: under the source label show "Notice 30d" when known (0 → "Immediate").
- Candidate page application line: include notice the same way if not already shown.

## Build
1. `migrations/0023_candidate_sources.sql` (D1 CHECK, D3 column; grants unchanged; no data change).
2. Worker: `hiring.js` (APP_SOURCES, `referralError`), `index.js` (D2 sites, D3), tests in `test/` (new file
   `candidate-sources.test.mjs`: sources list, referralError cases incl. whitespace detail, null/'' referrer).
3. App: `lib/hiring.js`, `lib/cvHandoff.js`, opening detail page, import page, batch page, candidate detail page.
4. `npx turbo build --filter=podium`; worker tests green.
5. Lane: hostile review + Codex, apply migration, deploy worker, push, wait-deploy, smoke, manual chapter.

## Data fix after ship (lane, with Afshaan)
- CAN-0009 (OPN-004): `source_detail` says "Direct email to Vinay" → `direct_email`.
- CAN-0003…0008: "Shortlist from Vinay" — ask Afshaan where Vinay got them before changing.
