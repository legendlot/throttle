# Podium C4 — bulk CV import (extraction only, OpenAI) — plan

> Afshaan 2026-11-12: OpenAI, and ONLY "pull information from the CV and populate the right fields".
> No scoring, no matching, no reassignment — those extend later on the same ledger/cap.

## Decisions

- **D1 Flow.** Pick an open opening that has a JD (the existing `intakeOpening` gate) and a source → a
  `cv_imports` batch → drop up to 100 files → each lands in staging (`cv_imports/<batch>/<ts>_<name>`) →
  each is read → HR reviews a grid → **Accept** (new candidate + application + CV document) / **Attach to
  existing** (duplicate found: application + CV on that person, their profile untouched) / **Skip**.
  Nothing reaches `candidates` until HR accepts.
- **D2 Client-driven, resumable, no queue.** The browser runs ≤3 uploads and ≤3 extractions at a time.
  State lives in `cv_import_items.status`; reopening a batch resumes whatever is still `uploaded`. A
  conditional PATCH claims an item (`uploaded`, or `extracting` stale > 5 min) so two tabs never pay twice.
  No wrangler.toml change, no cron.
- **D3 Text first.** The worker downloads the file, hashes it (sha256) and extracts text locally —
  PDF via `unpdf`, DOCX via `fflate` (word/document.xml). Only the text goes to OpenAI. Fallbacks: a PDF
  with < 200 chars of text (a scan) → sent as `input_file`; jpg/png/webp → `input_image`; legacy `.doc` →
  `needs_manual` (no AI call). Text is capped at 40k chars, with a warning when cut.
- **D4 Model call.** Responses API by raw fetch, `model = ai_settings.extract_model` (default
  `gpt-6-luna`), `reasoning.effort = low`, `store: false`, strict `json_schema`, `max_output_tokens` 8000.
  Prompt version `cv-extract-v1` is recorded on the item and the ledger.
- **D5 CV text is untrusted.** The system prompt treats it as data. The schema has no sensitive
  attributes. Validation after the call: email must be a valid address AND appear in the CV text; phone
  digits must appear; experience/notice/CTC need a verbatim evidence quote found in the text, else the
  value is dropped with a warning. File/image mode can't be verified → every value is flagged "check
  by hand".
- **D6 Cost guards.** `ai_calls` ledger (tokens, ₹, model, prompt version, item) + `ai_settings`
  (enabled, model, monthly ₹ cap default 2,000, ₹/$ 90, per-model prices). `ai_reserve()` takes an
  advisory lock, sums this IST month's spend (reserved rows at their reserve), refuses past the cap,
  and inserts a `reserved` row; the call then settles it to actual. Cache: same sha256 + model + prompt
  version already extracted → copy, no call.
- **D7 No key / AI off / cap hit / failure** → item goes `needs_manual` with the reason; HR types the
  fields. The flow works end to end without AI.
- **D8 Duplicates.** Email/phone match against existing candidates (the `findCandidateDuplicates` rule)
  and within the batch. Shown on the row; HR chooses attach or create.
- **D9 Corrections recorded.** `extracted` (validated AI output) and `final` (what HR accepted) are both
  kept on the item.
- **D10 Purge.** Batches untouched for 7 days: un-accepted items' files and rows are deleted lazily
  when the batch list loads. Accepted files have already moved to `candidates/<id>/cv/`.
- **D11 Access.** Anyone who can manage applications on the opening (same as adding one candidate).
  CTC is only written when the caller can see salary on that opening (`cleanApplication`). Settings: HR
  can read spend; super_admin edits settings.

## Build

1. Migration `0013_cv_import.sql`: `ai_settings`, `ai_calls`, `cv_imports`, `cv_import_items`,
   `ai_reserve()`, `ai_settle()`; `candidate_documents.source` gains `cv_import`.
2. `src/cvimport.js` (pure): schema, prompt, request builder, response parser, validation + quote
   check, docx XML → text, cost math. Tests in `test/cvimport.test.mjs`.
3. `src/cvtext.js`: unpdf / fflate wrappers.
4. Worker actions: `createCvImport`, `getCvImports`, `getCvImport`, `cvImportUploadUrl`,
   `cvImportFileDone`, `cvImportExtract`, `cvImportSaveItem`, `cvImportAccept`, `cvImportSkip`,
   `discardCvImport`, `getAiSettings`, `updateAiSettings`.
5. App: `/hiring/import` (batch list + new batch) and `/hiring/import/batch?id=` (drop zone + review grid),
   with a link from the hiring page.
6. Secret: `OPENAI_API_KEY` on podiumops, set by Afshaan (`npx wrangler secret put OPENAI_API_KEY`).
