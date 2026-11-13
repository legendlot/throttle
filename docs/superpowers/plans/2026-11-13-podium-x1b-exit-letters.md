# Podium X1b — relieving + experience letter generator — plan

> Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` §X1 (~line 576: "relieving / experience
> letters are a manual line (HR uploads) — the generator is **X1b**"). Afshaan 2026-11-13: "Go ahead then, take your
> recommendations". No cron, `wrangler.toml` untouched. Migration `0022_exit_letters.sql` (`podium_exit_letters_v1`).
> ⚠️ The letter WORDING below is a draft for Afshaan's approval; HR can change it at any time (new template version).

## Facts the design rests on

- The exit checklist line `relieving_letters` ("Relieving + experience letters issued", owner HR, required, no N/A,
  `migrations/0010_exits.sql:43`) is ticked by hand today, optionally with `document_id` → `podium.documents`.
- Offer letters already render deterministically with pdf-lib (`src/offer-render.js`: plain-text templates with
  `{{field}}` / `{{#field}}…{{/field}}`, letterhead = entity name + address lines, signatory block, SHA-256 of the
  stored bytes is the record). Offer PDFs already issued are stored files; their bytes must not change for the same
  inputs (the offer-render tests pin this).
- Letterhead: the only payroll entity is **Fraternitas Ventures Private Limited** (current `offer_templates`
  employment v2 carries its name + address). `employees.legal_entity` is NULL for all 83 rows — do not key on it.
- `podium.documents.doc_type` CHECK lacks `relieving_letter` / `experience_letter` (must widen, and every worker/app
  list of employee doc types must learn them — the enum-drift rule). Bucket `podium-documents` (`DOC_BUCKET`).
- Signatories: `podium.offer_signatories` (3 active, `title` NULL on all).

## Decisions

- **K1 Templates.** New table `podium.exit_letter_templates` (same shape as `offer_templates`: id, template_key
  `relieving|experience`, version, title, body, entity_name, entity_address text[], footer_note, notes, is_current,
  created_by, created_at; one current per key). Seeded v1 of each with the draft wording below and the Fraternitas
  letterhead copied from the current employment offer template. Fields: `employee_name, employee_code,
  designation, department, has_department, date_joined, last_working_day, issue_date, entity_name, signatory_name,
  signatory_title, has_signatory_title, letter_ref`. Unknown field / unclosed section = render error (refused).
  HR edits on `/admin/exit-checklist` → "Letter templates": view current, save a new version (validated), history.
- **K2 Rendering.** `src/exit-letters.js` (pure): `EXIT_LETTER_FIELDS`, `exitLetterView({exit, employee, department,
  template, signatory, issueDate, ref})`, validation. PDF via a shared letter layout factored out of offer-render.js
  **without changing any offer PDF byte** (add a test that pins an offer PDF's SHA-256 before the refactor and still
  matches after). Deterministic: same inputs → same bytes; dates = the issue date.
- **K3 Issue.** POST `issueExitLetter {exit_id, kind, signatory_id}` — isHr only. Refused: `exit_not_found`,
  `exit_cancelled`, `before_lwd` (today IST < LWD), `no_joining_date` (experience only), `no_designation`,
  `bad_signatory`, `template_error`. Writes the PDF to `podium-documents` under the employee's documents path,
  a `podium.documents` row (doc_type `relieving_letter` / `experience_letter`, title "Relieving letter — REL-2026-001"),
  and a `podium.exit_letters` row (id, exit_id, employee_id, kind, revision (1, 2… per exit+kind), letter_ref
  (`REL-YYYY-NNN` / `EXP-YYYY-NNN`, sequence per kind per year), template_id, signatory_id, issue_date, sha256,
  document_id, issued_by, issued_by_employee_id, issued_at). Re-issuing = a new revision (never overwrite). One RPC
  for the two inserts + ref allocation (advisory lock or sequence table) so a ref is never reused or skipped by a
  race; storage upload before the RPC, removed if the RPC fails.
- **K4 Line link.** Issuing does NOT tick the checklist line (HR still ticks Done). The line shows the issued
  letters (ref, revision, date, Download) and, once both kinds exist, the tick defaults its document to the latest
  relieving letter. Works on open AND closed exits (letters are often re-requested after close).
- **K5 Preview.** GET `previewExitLetter {exit_id, kind, signatory_id?}` (isHr) → the rendered paragraphs + the
  refusal it would hit, for a modal before Issue. Download = the existing employee-document signed URL path.
- **K6 Visibility.** Letters are employee documents: HR sees them; the person sees their own (existing docTier
  rules — set the tier for the two new types to "self + HR", same as offer_letter). Never emailed by Podium in X1b.
- **K7 Manual.** Exits chapter: "Relieving and experience letters" (generate, re-issue, edit the wording).

## Draft wording (v1 — Afshaan to approve; HR can edit)

**Relieving letter** — title `RELIEVING LETTER`
> Date: {{issue_date}} · Ref: {{letter_ref}}
>
> Dear {{employee_name}},
>
> This is to confirm that you have been relieved of your duties with {{entity_name}} with effect from the close of
> business on {{last_working_day}}. At the time of leaving you were working as {{designation}}{{#has_department}}
> in the {{department}} team{{/has_department}} (Employee Code {{employee_code}}).
>
> We thank you for your contribution and wish you the very best.

**Experience letter** — title `TO WHOM IT MAY CONCERN`
> Date: {{issue_date}} · Ref: {{letter_ref}}
>
> This is to certify that {{employee_name}} (Employee Code {{employee_code}}) was employed with {{entity_name}} from
> {{date_joined}} to {{last_working_day}}. At the time of leaving, the designation held was
> {{designation}}{{#has_department}} in the {{department}} team{{/has_department}}.
>
> We wish {{employee_name}} success in all future endeavours.

Both close with "For {{entity_name}}", the signatory name and (if set) title. No claim about dues or F&F (F&F is not
computed in Podium, L7).

## Build

1. `migrations/0022_exit_letters.sql`: `exit_letter_templates` (+ seed v1 ×2), `exit_letters`, ref allocation +
   `exit_letter_issue` RPC, `documents.doc_type` CHECK widened (+ the two types), RLS on, service_role only, grants.
2. `src/exit-letters.js` + `src/offer-render.js` shared layout + tests (`test/exit-letters.test.mjs`, offer PDF hash
   pin).
3. `src/index.js`: `previewExitLetter`, `issueExitLetter`, `getExitLetterTemplates`, `saveExitLetterTemplate`,
   exit payload gains `letters`; every employee-doc-type list learns the two types.
4. App: exit page letters panel (preview modal, signatory pick, Issue, list + Download) on the relieving line;
   `/admin/exit-checklist` Letter templates section; doc type labels.
5. Tests, build, hostile review + Codex, apply migration, deploy, smoke on a synthetic exit, manual chapter.
