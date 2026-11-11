# Plan — Podium Hiring C3: offer letters (templates, calculator, offers, PDF, sent/accepted)

Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` §C3 + decisions 7, 8, 9 (v3.2).
Builds on C1+C2 (live: `0f7cea76`, migrations 0006 `podium_hiring_c1_c2_v1`, 0007 `podium_hiring_atomic_rpcs_v1`).
**Out of this slice:** joining hand-off via Directory sync (C3b, next), offer email + acceptance link (O1),
interviews. **In this slice also:** make the three remaining two-write C1 ops atomic.

Conventions are as in the C1+C2 plan (`2026-11-11-podium-hiring-c1-c2.md` §A): `sb()`, `hiringRpc()`,
`rpcError()`, `ok/err/errCode`, `loadOrgEdges`, `callerEmployee`, `canComp`, `logCompAccess`, self-scoped
`SELF_SERVE_GET/POST`, pure rules in `src/*.js` with `node --test`, numerics `Number()`, no per-row awaits.

## 0. Settled decisions (hard to change later)

1. **One row per revision** in `podium.offers`. `offer_ref` (`OFR-2026-001`) is per application's offer thread
   and shared by its revisions; `revision` 1,2,3… The PDF footer prints `OFR-2026-001 · r2`.
2. An offer pins **template_version_id, rule_set_id, budget_id** (the opening's approved budget at creation)
   and stores the computed **annexure jsonb** (frozen) and `inputs jsonb`. Recompute only while `draft`.
3. Rule set chosen = the one effective on the offer's **start date** (pay is earned from joining).
4. Terms freeze at **`ready`**: the PDF is rendered then, stored in the bucket and SHA-256-hashed
   (`pdf_path`, `pdf_sha256`). Any later change = a **new revision** (draft). The issued PDF is the record —
   downloads serve the stored file, never a re-render.
5. **PDF engine: `pdf-lib`** (npm, bundled by wrangler; standard Helvetica — letters already write "INR",
   no ₹ glyph needed). No Browser Rendering, **no `wrangler.toml` change**.
6. Band check is on **total CTC + every one-time cash extra** (joining / retention bonus). Above band max, or
   any extra > 0 → approval. Below band min → no approval, flagged `below_band`. No approved band on the
   opening → 409 `band_not_approved` (can't create an offer).
7. Offer approver = **snapshotted at submit**: the opening's resolved approver (same `resolveApprover` as
   bands — manager above the reporting manager; founder fallback; never the requester). Founder override
   as for bands. Approval is voided by any edit (edits only happen on a new revision anyway).
8. Application status: first **sent** revision → application `offer`; **accepted** → application
   `accepted`. A declined/expired/withdrawn offer leaves the application at `offer`; new manual transitions
   `offer → declined | withdrawn | rejected` (reason required) close it. `accepted → withdrawn` (LOT
   withdraws before joining; reason required). `→ joined` stays C3b's job.
9. Interns: own template + `employment_type='intern'` offers use **stipend mode** — monthly stipend × months,
   no PF/PT/ESI/variable by default (annexure = stipend monthly/total). Band check still applies to total.
10. Salary visibility on offers = `canSeeSalary` for the opening (chain or allow-list). `podium_hiring`
    alone sees offer status only (no figures, no PDF). Every salary-bearing offer read logs
    `comp_access_log` (one row per request).

## 1. Migration `0008_hiring_offers.sql` (name `podium_hiring_offers_v1`) — the lane applies it

Tables (RLS on, revoke anon/authenticated, grant service_role — same block as 0006):

- `podium.offer_rule_sets` — `id uuid pk, code text unique, effective_from date not null, effective_to date,
  rules jsonb not null, notes text, created_at`. Seed two (see §2): `IN-2025` (2000-01-01 → 2026-09-16) and
  `IN-2026-09` (2026-09-17 → null). Read-only from the app; new rule sets ship as migrations.
- `podium.offer_templates` — `id, template_key text ('employment'|'internship'), version int, title text,
  body text not null, entity_name text, entity_address text[] (letterhead lines), footer_note text,
  is_current bool, created_by, created_at`, `unique(template_key, version)`, partial unique
  `(template_key) where is_current`. Edit = insert version+1 and flip `is_current` (one RPC).
- `podium.offer_signatories` — `id, employee_id uuid references employees, display_name text not null,
  phone text, title text, active bool default true, created_at`. Seed by `employees.full_name` match for
  Mahesh Jain, Piyush Gupta, Afshaan Siddiqui, phone from `employees.phone` (skip any name not found —
  report it; never invent a phone).
- `podium.offers` — `id uuid pk, application_id uuid not null references applications, opening_id uuid not
  null, candidate_id uuid not null, offer_ref text not null, revision int not null, unique(offer_ref,
  revision)`, `template_id uuid not null references offer_templates, rule_set_id uuid not null, budget_id
  uuid references opening_budgets`, `mode text check in ('salary','stipend')`,
  `fixed_annual numeric(12,0), variable_annual numeric(12,0) default 0, variable_label text default
  'variable pay', variable_frequency text default 'half-yearly', joining_bonus numeric(12,0) default 0,
  retention_bonus numeric(12,0) default 0, stipend_monthly numeric(12,0), internship_months int,
  total_ctc numeric(12,0) not null, pf_opt_out bool default false, pf_opt_out_reason text`,
  `designation text not null, department_name text, location text, start_date date not null,
  probation_months int check (probation_months is null or probation_months between 0 and 12),
  signatory_id uuid references offer_signatories, issue_date date, valid_until date`,
  `inputs jsonb not null, annexure jsonb not null, band_check text check in ('in_band','below_band',
  'above_band','extras')`,
  `status text not null default 'draft' check in ('draft','pending_approval','approved',
  'approval_rejected','ready','sent','accepted','declined','expired','withdrawn','superseded')`,
  `approver_employee_id uuid, requested_by_employee_id uuid, decided_by_employee_id uuid, decided_at,
  decision_note, pdf_path text unique, pdf_sha256 text, rendered_at`,
  `sent_at, sent_by uuid, sent_to text, sent_cc text[], sent_evidence_doc_id uuid references
  candidate_documents`, `accepted_at date, acceptance_doc_id uuid references candidate_documents,
  declined_at, outcome_note text, created_by, created_at, updated_at`.
  Checks: no self-approval (as budgets); `pf_opt_out → pf_opt_out_reason not null`; mode='salary' →
  fixed_annual not null; mode='stipend' → stipend_monthly not null.
  Partial uniques: **one accepted revision per application** `(application_id) where status='accepted'`;
  one open draft/pending per application `(application_id) where status in ('draft','pending_approval',
  'approved','approval_rejected')`.
- `next_hiring_seq` → allow names `podium_offer_<yyyy>` (regex `^podium_offer_[0-9]{4}$`) in addition to
  the two existing ones (create or replace; keep grants).
- **RPCs** (SECURITY DEFINER, service_role only, no auth inside — same posture as 0007):
  `hiring_create_offer(p)` (mints offer_ref for revision 1 or reuses the thread's, next revision number,
  inserts, event); `hiring_offer_transition(p)` (expected_status guard `for update`, sets status + the
  fields for that step, application status side-effect per §0.8, supersedes the previous live revision
  when a new one is **sent** (§spec "supersedes only when sent"), events); `hiring_template_new_version(p)`;
  and the three C1 atomics: `hiring_request_band_change(p)` (cancel pending + insert pending + event),
  `hiring_change_chain(p)` (update chain + cancel pending + re-request to new approver + event),
  `hiring_add_jd(p)` (insert JD version + set current + draft→open + events). Switch the worker handlers
  `requestBandChange`, `updateOpening` (chain branch) and `addOpeningJd` to them.
- `store.podium_roles`: nothing new (offers use the opening chain).

## 2. Pure calculator — `src/offer-calc.js` (+ `test/offer-calc.test.mjs`)

`computeAnnexure({ mode, fixed_annual, variable_annual, stipend_monthly, internship_months, pf_opt_out,
work_state }, rules) → { lines[], totals, deductions, in_hand_monthly, warnings[] }`. Full precision inside;
round to the rupee only in the output (annual and monthly columns rounded independently, as the letters).

Salary mode, F = fixed_annual (the quoted "fixed salary"), all annual unless noted:
- Basic = `basic_pct_of_fixed`·F (0.5); HRA = `hra_pct_of_basic`·Basic (0.5); Travel = F / `travel_div` (15);
  Telephone = F / `telephone_div` (60).
- PF wages (monthly) = min(Basic/12, `pf.wage_ceiling_monthly`); employer PF = employee PF =
  `pf.rate`·PF wages (0.12). `pf_opt_out` → both 0 (allowed only when Basic/12 > ceiling, else 422
  `pf_opt_out_not_eligible`).
- Statutory gross wages (monthly) W = F/12 − employer PF (employer ESI handled below).
- ESI applies when W ≤ `esi.wage_ceiling_monthly` (21000): employer = `esi.employer_rate`·W' and employee =
  `esi.employee_rate`·W' where W' = (F/12 − employer PF)/(1 + employer_rate) (employer ESI sits inside CTC).
- PT by `work_state` from `rules.pt[state]`: `IN-2025` KA = flat 200/month, 2400/yr. `IN-2026-09` KA = 0 when
  W < 25000, else 200/month and 300 in February (annual 2500; monthly column shows 200, footnote "₹300 in
  February"). Unknown state → PT 0 + warning `pt_state_unknown`.
- Gross Total = F − employer PF − employee PF − PT − employer ESI − employee ESI.
- Special = Gross Total − Basic − HRA − Travel − Telephone; < 0 → 422 `special_negative`.
- Wages check: Basic ≥ `min_basic_pct_of_fixed`·F (0.5) else 422 `wage_rule`.
- Total Fixed = F; Variable = variable_annual; Total CTC = F + Variable.
- Deductions block (decision 7): employee PF, PT, employee ESI (monthly) → **estimated monthly in-hand =
  Gross Total / 12** ("before income-tax TDS").
- `lines` order exactly as today's annexure: Basic Salary, House Rent Allowance, Special Allowance, Travel
  Reimbursement, Telephone Reimbursement, Gross Total, Employer's PF Contribution, Employee's PF
  Contribution, Professional Tax, [Employer ESI, Employee ESI only when applicable], Total Fixed, Variable
  (label from the offer: "Variable"/"Incentive"), Total CTC. Footer line: "Medical insurance premium will be
  over and above your CTC."
Stipend mode: lines Stipend (monthly, × months = total); total_ctc = stipend × months; no deductions.

Also export `bandCheck(total_ctc, extras, band) → 'in_band'|'below_band'|'above_band'|'extras'` and
`componentsContract(annexure, offer) → { monthly_fixed, monthly_variable, fixed_yearly, variable_yearly,
gross_yearly, bonus_type, designation, annexure }` (C3b writes this into compensation_events; build + test it
now so the contract is fixed).

Tests: synthetic fixtures only (never real people's figures in the repo) — as built: 450000/50000, 288000,
204000 (ESI), 470000; both rule sets; PF opt-out ineligible/eligible, special_negative, stipend, rounding
(annual vs monthly columns).
The lane separately checks the three real mailbox letters reproduce under `IN-2025` (scratch, not committed).

## 3. Template rendering — `src/offer-render.js` (+ tests)

- Body = plain text with `{{field}}` and optional sections `{{#field}}…{{/field}}` (rendered when the field
  is truthy). Paragraphs split on blank lines. No HTML. Unknown `{{x}}` → render error (refuse to issue).
- Fields: candidate_name, issue_date ("29th July 2026"), entity_name, fixed_annual_words? (no — figures
  only, Indian grouping `5,40,000`), fixed_annual, variable_annual, variable_label, variable_frequency,
  has_variable, start_date, designation, department, has_department, location, probation_months,
  has_probation, signatory_name, signatory_phone, offer_ref, revision, valid_until, stipend_monthly,
  internship_months, joining_bonus, has_joining_bonus.
- `renderOfferPdf({ template, offer, annexure, signatory }) → Uint8Array` with pdf-lib: A4; page 1 =
  letterhead (entity name bold, address lines, signatory phone, right-aligned) → "Offer of Employment"
  (template title) → body paragraphs wrapped to width → "Regards," + signatory; page 2 = letterhead again +
  "Annexure I: CTC Break Up" + table (Particulars | Annual | Monthly) + footer notes + deductions/in-hand
  block. Every page footer: `OFR-2026-001 · r2 · <issue date>`. Deterministic (fixed creation/mod dates =
  issue date, no random ids) so the same inputs give the same bytes.
- Also `renderOfferText(...)` → the same content as structured JSON (paragraphs + table) for the in-app
  preview, so preview and PDF share one renderer.

Seed template bodies (in 0008): **employment v1** = today's letter, wording kept (incl. the
confidentiality/non-compete paragraph — spec legal note stands; Afshaan's call), with sections for
variable, department, probation, joining bonus. **internship v1** = drafted in the same voice: stipend INR X
per month for N months from the start date, designation "Intern — <designation>", location, confidentiality
paragraph (no non-compete), "certificate on completion", confirm by signed copy. Mark internship v1 notes
"draft wording — review before first use".

## 4. Worker actions (all self-scoped; add to SELF_SERVE_GET / SELF_SERVE_POST)

GET
- `getOfferSetup?application_id` → templates (current per key), signatories (active), the opening's
  approved band (only if canSeeSalary), resolved approver name, defaults (designation, department, location,
  start date = opening.target_join_date, mode from opening.employment_type, valid_days 7).
- `previewOffer?…` as POST `previewOffer {application_id, …terms}` (no write) → annexure + band_check +
  warnings + rendered text. canSeeSalary required.
- `getOffers?application_id` → revisions (figures only with canSeeSalary; else status/ref/revision/dates).
- `getOffer?id` → full offer + annexure + rendered text + events; logs comp_access_log.
- `getOfferPdfUrl?id` → 120s signed URL of the STORED pdf; canSeeSalary; logs comp_access_log.

POST (create/revise/send = hiring owner or reporting manager of the opening — NOT podium_hiring, NOT HR
unless on the chain; approve = snapshotted approver / founder override, never requester)
- `createOffer {application_id, template_key, …terms}` → application must be active, status `interviewing`
  or `offer` (or `accepted` → creates an **amendment** revision), opening open + JD + approved band; draft
  revision via `hiring_create_offer`. If a non-final draft exists → 409 `draft_exists` (edit it instead).
- `updateOfferDraft {id, …terms}` → only `draft`/`approval_rejected` (back to draft); recomputes.
- `submitOffer {id}` → in band → `ready` (render PDF + hash + store, then transition); above/extras →
  `pending_approval` with approver snapshot.
- `decideOffer {id, decision, note}` → approve → `approved` → immediately render → `ready`; reject →
  `approval_rejected`.
- `markOfferSent {id, sent_to, sent_cc[], sent_at?, evidence_storage_path?}` → `ready` → `sent`;
  issue_date = today if null; valid_until = issue_date + 7 (or provided); supersedes the previous live
  revision; application → `offer`. The form pre-fills CC = hr@legendoftoys.com + chain emails + Afshaan
  (decision 9) — recorded, not sent (O1 sends).
- `recordOfferAcceptance {id, accepted_at, signed_storage_path}` → `sent` → `accepted` (refuse if
  accepted_at > valid_until → 409 `offer_expired`, needs a fresh send); stores the signed copy as a
  candidate_documents `signed_offer` row; application → `accepted`; warns when accepted offers on the
  opening ≥ headcount.
- `recordOfferDecline {id, note}`, `withdrawOffer {id, reason}` (any non-final status; LOT side).
- Lazy expiry: any read/write touching a `sent` offer with `valid_until < today (IST)` flips it to `expired`
  (via the transition RPC) first.
- `createOfferDocUploadUrl {offer_id, kind:'sent_evidence'|'signed'}` → path
  `candidates/<candidate_id>/offers/<offer_ref>-r<rev>-<kind>-<ts>.pdf`.
- Templates admin (canComp OR podium_admin): `getOfferTemplates`, `saveOfferTemplate {template_key,
  title, body, entity_name, entity_address[], footer_note}` (validates merge fields by a dry render →
  new version), `saveSignatory {id?, employee_id, display_name, phone, title, active}`.

Generated PDFs live at `offers/<application_id>/<offer_ref>-r<rev>.pdf` (bucket `podium-documents`).
Extend `getCandidate` documents and visibility: `signed_offer` already salary-gated — keep.

Every write → `application_events` (offer_created, offer_submitted, offer_approved, offer_rejected,
offer_ready, offer_sent, offer_accepted, offer_declined, offer_expired, offer_withdrawn, offer_superseded,
template_version) with **no figures in detail** (ids, ref, revision, status only).

## 5. App (`apps/podium/src`)

- Candidate detail → each application row gets an **Offers** block: revisions list (ref · rN · status pill
  · total CTC if returned), "Create offer" / "Revise" (opens `/hiring/offer/new?application_id=`), link to
  each revision `/hiring/offer?id=`. New manual transitions per §0.8 in the status picker.
- `/hiring/offer/new` (and edit of a draft): template picker (employment/internship, from mode), terms form
  (fixed annual, variable annual + label + frequency, joining/retention bonus, stipend + months for intern,
  start date, probation, designation, department, location, signatory, PF opt-out + reason), **live
  annexure preview** (debounced `previewOffer`) with band badge (In band / Below band / Above band — needs
  approval / Extras — need approval) and warnings; Save draft / Submit.
- `/hiring/offer?id=`: header (ref · revision · status), letter preview (rendered text) + annexure table +
  deductions/in-hand block, actions by status and role: Submit, Approve/Reject (approver only),
  Download PDF (stored), Mark as sent (to/cc prefilled, optional evidence upload), Record acceptance
  (date + signed copy upload), Record decline, Withdraw, Revise. Timeline.
- `/admin/offer-templates` (nav under ADMIN, requires `podium_super_admin` OR the server's allow): template
  versions with body editor + merge-field cheat sheet + live preview with sample data; signatories table.
- Opening detail candidate rows show offer status.

## 6. Verification
- `npm test` (calc + render + existing hiring tests), `npx turbo build --filter=podium`.
- Lane: scratch script reproduces the three mailbox letters under IN-2025 to the rupee; hostile review +
  Codex pass on the salary/auth diff; apply 0008; commit; push; deploy; wait-deploy; live smoke (opening →
  JD → band approved by… [needs a non-requester approver — smoke with a band requested by someone else or
  verify approval paths by API refusal only] → candidate → offer in band → ready → PDF download + hash
  match → mark sent → record acceptance → application accepted); clean up smoke rows + bucket objects;
  reset sequences.
