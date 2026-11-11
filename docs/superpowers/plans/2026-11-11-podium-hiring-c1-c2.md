# Plan — Podium Hiring C1 (openings) + C2 (candidates, applications, documents)

Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` (v3.2). DB: migration
`podium_hiring_c1_c2_v1` (file `podiumops-worker/migrations/0006_hiring_openings_candidates.sql`) is
**APPLIED**. Out of this slice: offers (C3), the joining hand-off via Directory sync (lands with C3 — needs an
accepted offer), bulk CV upload (C4), retention purge job, interviews.

## A. Worker — `podiumops-worker/src/index.js` (+ new `src/hiring.js` for pure rules)

Conventions to reuse: `sb()`, `sbStore()`, `ok()/err()`, `pickFields`, `safeSeg`, `storageFetch`,
`DOC_BUCKET`, `loadOrgEdges`, `callerEmployee`, `isHr`, `canComp`, `logCompAccess`, `intParam`, the
GET_ACTIONS / POST_ACTIONS maps and `SELF_SERVE_GET` / `SELF_SERVE_POST`. PostgREST numerics arrive as
strings → `Number()`. Never loop-await per row.

### Permission key
- `PODIUM_PERM_KEYS` += `'podium_hiring'`; `normalizePodiumPerms` forces `podium_view` when it is on.
- `getMe`: add `hiring: { access: bool }` = `podium_hiring` OR caller has ≥1 direct report (active) OR is
  hiring owner / reporting manager / approver on any opening. Also add display flag
  `permissions.podium_hiring_access` (same value) for the nav, like `podium_super_admin`.

### Pure rules (`src/hiring.js`, unit-tested in `test/hiring.test.mjs`)
- `ACTIVE_APP_STATUSES = new,screening,interviewing,offer,accepted,on_hold`; terminal = joined,rejected,
  declined,withdrawn,no_show.
- `APP_TRANSITIONS` (manual, this slice): new→screening|rejected|withdrawn|on_hold; screening→interviewing|
  rejected|withdrawn|on_hold; interviewing→rejected|withdrawn|on_hold (→offer is C3's job, NOT manual);
  on_hold→new|screening|interviewing|rejected|withdrawn. `offer`/`accepted`/`joined`/`declined`/`no_show` are
  never set manually in this slice. `rejected`/`withdrawn` require a non-empty reason.
- `resolveApprover(edges, founders, reportingManagerId, requesterEmpId)`: a = manager_id of the reporting
  manager; if none (RM is a founder) → a founder ≠ RM; if a === requester → a founder ≠ requester; returns
  employee id or null. `founders` = active employees with `manager_id IS NULL` whose `users_profile.role =
  'super_admin'` (today EMP-001 Afshaan, EMP-002 Vinay).
- `openingRoles(auth, me, opening, budget)` → `{ hiring, owner, manager, approver, hr }` (approver = the
  CURRENT budget's `approver_employee_id`, or the pending one).
- `canSeeOpening` = hiring||owner||manager||approver||isHr. `canEditOpening` = hiring||owner.
  `canManageApps` = hiring||owner||manager. `canSeeSalary` = canComp(auth)||owner||manager||approver
  (podium_hiring alone does NOT). `canChangeChain` = hiring only.
- Doc visibility by type: `cv,education,experience_letter,photo,other` → canSeeOpening (any of the
  candidate's openings) or HR; `payslip,signed_offer` → canSeeSalary on any of the candidate's openings;
  `id_proof,pan,address_proof,bank` → `isHr` only. Enforced on list AND signed URL.
- `jdGate(opening)` → error `jd_required` ("Add the JD to this opening first") when `current_jd_id` null.

### GET actions (all in SELF_SERVE_GET; each self-scopes)
- `getOpenings?status&search` → openings visible to caller, each with role names, department,
  status, `has_jd`, `budget_status` (pending/approved/none), counts by application status, headcount; band
  only when `canSeeSalary` for that opening.
- `getOpening?id` → opening + `my_roles`, `jd` (current) + `jd_versions[]`, `budgets[]` (band fields only if
  canSeeSalary; logs one `comp_access_log` row `getOpening` when band shown), `applications[]` (candidate
  name/code, status, source, created_at; `expected_ctc`/`current_ctc` only if canSeeSalary), `events[]`
  (last 100), `approver` (resolved).
- `getJdDownloadUrl?jd_id` → 120s signed URL, canSeeOpening.
- `getCandidates?search&status&opening_id` → candidates with ≥1 application on an opening the caller can
  see (HR/hiring: all). Row: code, name, email, phone, location, current_title, latest application
  status + opening code/designation.
- `getCandidate?id` → person + `applications[]` (only openings caller can see; salary fields per opening)
  + `documents[]` (filtered by type rule) + `events[]`; logs `comp_access_log` when salary fields shown.
- `getCandidateDocumentUrl?id` → signed URL per doc rule.
- `findCandidateDuplicates?email&phone` → up to 5 matches (code, name, email, phone, applications count)
  on `email_norm`/`phone_norm`, scoped to caller visibility (HR/hiring: all; others: only those already on
  their openings, else just `{count}` so nothing leaks).

### POST actions (all in SELF_SERVE_POST; each self-scopes)
- `createOpening {job_role_id?, designation, department_id?, reporting_manager_employee_id,
  hiring_owner_employee_id?, location_city?, location_state?, employment_type?, headcount?,
  target_join_date?, notes?, band_min, band_max | band_from_role:true, jd_text? | use_role_jd:true}` —
  allowed for `podium_hiring` or anyone with ≥1 active direct report (hiring owner defaults to the caller;
  only `podium_hiring` may name someone else). Mints `OPN-NNN` via `rpc/next_hiring_seq`. Creates budget v1
  `pending` with snapshotted approver (requester = caller's employee). Optional JD v1. Status `draft` if no
  JD else `open`. Event `opening_created`.
- `updateOpening {id, …fields}` — canEditOpening; `reporting_manager_employee_id` /
  `hiring_owner_employee_id` only via canChangeChain (event `chain_changed`; cancels a pending budget and
  re-requests it to the new approver).
- `setOpeningStatus {id, status, reason?}` — canEditOpening; `open` requires JD; `filled`/`cancelled`
  refused while any ACTIVE application exists (409 `resolve_applications_first`); reopening from
  filled/cancelled needs podium_hiring.
- `addOpeningJd {opening_id, jd_text?} | {opening_id, storage_path, file_name, mime_type, file_size} |
  {opening_id, use_role_jd:true}` — canEditOpening; new version, sets `current_jd_id`; first JD on a
  `draft` opening moves it to `open`; never reopens on_hold/filled/cancelled.
- `createJdUploadUrl {opening_id, file_name}` — canEditOpening; path `openings/<id>/jd/<ts>_<name>`;
  PDF/DOCX only; ≤15 MB (client-declared, re-checked on record).
- `requestBandChange {opening_id, band_min, band_max, note?}` — canEditOpening; supersedes nothing until
  approved; cancels an existing pending request; approver re-resolved now.
- `decideBand {budget_id, decision: 'approve'|'reject', note?}` — caller's employee must equal the
  snapshotted `approver_employee_id`, OR be a founder (super_admin) — and never the requester (403
  `no_self_approval`). Approve → previous approved version `superseded`, opening.current_budget_id = this.
- `createCandidate {opening_id, full_name, email?, phone?, location?, current_employer?, current_title?,
  total_experience_years?, skills?, education?, linkedin_url?, notes?, source?, referrer_employee_id?,
  source_detail?, current_ctc?, expected_ctc?, notice_period_days?}` — canManageApps on that opening;
  **jdGate**; opening must be `open`; mints `CAN-NNNN`; creates person + application `new`; events.
  CTC fields accepted only if canSeeSalary (else ignored).
- `addApplication {candidate_id, opening_id, …application fields}` — as above, for an existing person;
  409 `already_active` on the unique index.
- `updateCandidate {id, …person fields}` — canManageApps on any of their openings, or HR.
- `updateApplication {id, source?, referrer_employee_id?, source_detail?, notice_period_days?,
  current_ctc?, expected_ctc?}` — canManageApps; CTC only with canSeeSalary.
- `setApplicationStatus {id, status, reason?}` — canManageApps; **jdGate**; APP_TRANSITIONS; sets
  `closed_at` on terminal; when the person has no other active application and none joined, sets
  `candidates.retain_until = today + 12 months` (unless talent_pool). Event with from/to + reason.
- `moveApplication {id, to_opening_id, reason}` — canManageApps on BOTH; target jdGate + open; closes the
  old one `withdrawn` (reason "moved to OPN-x"), sets `moved_to_application_id`, creates the new one
  `new`; salary fields NOT copied.
- `createCandidateDocUploadUrl {candidate_id, doc_type, file_name}` / `recordCandidateDocument
  {candidate_id, application_id?, doc_type, storage_path, file_name, mime_type, file_size, title?}` —
  caller must be allowed to SEE that doc type for this candidate; path must start
  `candidates/<candidate_id>/`; types: pdf/doc/docx/jpg/jpeg/png/webp; ≤15 MB.
- `deleteCandidateDocument {id}` — HR, or the uploader within 24h; removes the object.

### Audit
Every write emits an `application_events` row (opening_id and/or application_id + candidate_id, actor,
event_type, from/to, reason). Never put CTC/band numbers in `reason`/`detail`.

## B. App — `apps/podium/src`

- `lib/nav.js`: new group `HIRING` (icon Briefcase/UserPlus) → `Openings` `/hiring/openings` and
  `Candidates` `/hiring`, both `requires: 'podium_hiring_access'`.
- `lib/hiring.js`: status labels/colours, source labels, doc-type labels + which need HR, `formatINR`.
- `/hiring/openings` (page.js): table of openings (code, designation, dept, reporting manager, status pill,
  JD ✓/"JD needed", band status, candidates count, headcount) + "New opening" button → `/hiring/openings/new`.
- `/hiring/openings/new`: form (job role select → prefill designation/department; reporting manager +
  hiring owner comboboxes from `getEmployees`; location; type full-time/intern; headcount; target date;
  band min/max OR "use the role's band"; JD paste OR file upload OR "use the role's JD" — all optional
  except designation, reporting manager, band). Explains "Without a JD the opening stays a draft and no CVs
  can be added."
- `/hiring/openings/detail?id=`: header (code, designation, status pill + status actions), cards:
  **JD** (current version view/download, add new version: paste/upload/role JD, version history),
  **Band** (current approved band, pending request with "Approve"/"Reject" shown only to the approver
  (`my_roles.approver` and not requester), "Request change"), **Team** (owner / reporting manager /
  approver), **Candidates** (table by status; "Add candidate" disabled with the JD message when no JD;
  quick-add form incl. duplicate check via `findCandidateDuplicates` on email/phone blur), **Timeline**.
- `/hiring` (page.js): candidates list with search + status + opening filters.
- `/hiring/detail?id=`: profile card (editable), Applications (per row: opening, status select limited to
  allowed transitions with required reason for reject/withdraw, CTC fields when returned, "Move to another
  opening"), Documents (upload with doc-type select; list with download; HR-only types hidden if not
  returned), Timeline.
- Reuse `components/ui.js` atoms, `StatusBadge`, `DocumentUploader` pattern (signed upload →
  `uploadToSignedUrl` → record), `podiumopsGet/Post`, existing styling. Static export: query-string detail
  params (PATTERN-074), no dynamic routes.
- Admin roles matrix (`/admin/roles`): add the `podium_hiring` toggle ("Hiring — openings + candidates").

## C. Verification
- `cd podiumops-worker && npm test` (new `test/hiring.test.mjs` covers transitions, resolveApprover incl.
  self/founder cases, doc-visibility table, canSeeSalary).
- `npx turbo build --filter=podium` zero errors.
- Lane: hostile review → commit → push → `npx wrangler deploy` → `tools/wait-deploy.sh podium` → in-app
  browser smoke (create opening without JD → add candidate blocked → add JD → add candidate → status move →
  upload CV → band approve as approver).
