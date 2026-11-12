# Podium O1 — Offer email + acceptance link (plan, 2026-11-12)

Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` §O1. Pattern copied (not shared) from
Ignition S441: `ignitionops-worker/src/index.js` `handlePublicContract` / `contractByToken` / `sendContract`,
`csops-worker/src/partner-email.js` (MIME), `ignitionops-worker/src/contract.js` (pure rules).

## Decisions taken in the plan (record in the spec as-built)

- **D1 Mail identity.** Gmail API `users/me/messages/send` with the shared SA (`env.GOOGLE_SA_JSON`) and scope
  `https://www.googleapis.com/auth/gmail.modify`, which is already on that client's domain-wide-delegation list.
  csops already sends from `partners@` the same way. The impersonated mailbox (`sub`) is always the opening's
  **hiring owner's** `work_email`, or the reporting manager's if the owner has none. It never comes from the
  caller, and a missing mailbox is refused with `no_sender_mailbox`. `googleAccessToken` gains an optional
  `opts.sub`; nothing else changes. The write SA (`GOOGLE_ADMIN_SA_JSON`) is never used for mail.
  A super_admin GET `getOfferMailCheck` proves delegation by minting for the caller's own work_email and calling
  `users/me/profile`, read-only.
- **D2 Rate limiting.** There is no Cloudflare rate-limit binding, because that needs a `wrangler.toml` change.
  The 32-byte token makes guessing moot. Instead, each link has caps: 30 uploads, 10 questions per day and
  5 bank submits.
- **D3 Candidate bank.** New `podium.candidate_bank_details` uses the **employee_private column names**
  (`bank_account_number`, `bank_ifsc`, `bank_account_name`, plus `bank_name`) and the same CHECK regexes.
  - It is service-role only and masked everywhere.
  - The first submit is insert-or-ignore. A change needs HR's `allowCandidateBankUpdate`: one change within
    7 days, used up by that change.
  - Only `canComp` (the salary allow-list, Finance) can reveal the full number, and it is logged through
    `logCompAccess`.
  - `confirmJoining` copies it into `employee_private` only when that row has no bank yet. The copy is a
    first fill, not a change request.
- **D4 Joining date.** The candidate confirms the letter's `start_date`. A different date goes through
  "I have a question" (optional `proposed_join_date`); it never changes state.
- **D5 Headcount is atomic.** The accept RPC locks the opening row and refuses `podium_headcount_full` when the
  opening's accepted offers (other applications) already number ≥ `headcount`. When that happens:
  - the page says "Thank you — we'll be in touch shortly";
  - a `offer_responses` row of kind `accept_blocked` is written;
  - the hiring owner is emailed.
- **D6 One live link per revision.** A link (`offer_emails.token_hash`) is live when it is the newest
  `kind='offer'` email of that offer, not `link_revoked_at`, and the email status is `sending`, `sent` or
  `unknown`. Sending a new revision supersedes the old offer (the C3 transition), which kills its link because
  the offer is no longer `sent`/`accepted`. Re-sending the same revision (a wrong address, say) revokes that
  offer's older links.
- **D7 What a live link can do:**
  - `sent` and IST today ≤ `valid_until` → accept / decline / question.
  - `sent` but past `valid_until` → the expired notice.
  - `accepted` → the documents step, until `start_date + 7` days; after that, a notice.
  - Every other status → only the notice:
    - superseded → `This offer has been replaced — check your latest email`.
    - expired → `This offer has expired — contact <owner first name>`.
    - withdrawn / declined → `This offer is no longer open — contact <owner first name>`.
  - Bad or dead token → 404 `This link is no longer valid.` A notice carries no letter, no name and no terms.
- **D8 Send intent + reconcile.**
  1. Insert an `offer_emails` row with status `sending` (a unique partial index allows one `sending` per offer)
     and our own `Message-ID: <podium-offer-<row id>@legendoftoys.com>`.
  2. Call Gmail:
     - 2xx → `sent` (store `gmail_message_id`, `gmail_thread_id`).
     - A definite 4xx/5xx response → `failed` with the error.
     - A throw or timeout → `unknown`.
  3. `reconcileOfferEmails(env, offerId)` runs before any new send and on `getOffer`. For an `unknown` row, or a
     `sending` row older than 2 minutes, it searches the sender's mailbox `messages.list?q=rfc822msgid:<id>`:
     found → `sent`, not found → `failed`.
  4. `finishOfferSend` is idempotent. When a `kind='offer'` email is `sent` but the offer is still `ready`, it
     runs the C3 `ready → sent` transition, with the same set as `markOfferSent`: sent_at, sent_by, sent_to,
     sent_cc, valid_until from the send day. It is called right after a send and from reconcile, so a
     transition that failed after the mail went out heals on the next view.
- **D9 Threading.** A revision, the confirmation and the alerts reply in the application's existing Gmail thread:
  `threadId` = the newest `offer_emails.gmail_thread_id` for the application, with `In-Reply-To`/`References` =
  its `message_id_header`. Gmail requires the Subject to match for threading, so every mail of an application
  uses `Offer — <designation> — Legend of Toys` (a revision adds nothing to the subject; the body says "revised").
- **D10 CC.** Prefilled from `offerDefaultCc` (hr@ + chain + Afshaan, decision 9) and editable, exactly like
  `markOfferSent` (≤20 addresses).

## Migration `0012_offer_link.sql` (`podium_offer_link_v1`)

- `podium.offer_emails`:
  - Columns: id uuid pk, offer_id → offers, application_id → applications,
    kind text check in (`offer`, `confirmation`, `alert`), status text check in (`sending`, `sent`, `failed`,
    `unknown`), sender_email, to_email, cc_emails text[], subject, message_id_header text unique,
    gmail_message_id, gmail_thread_id, token_hash text unique (only kind `offer`), link_revoked_at,
    error text, created_by uuid, created_at, sent_at.
  - Unique partial index: `(offer_id) where status = 'sending'`.
  - Index: `(application_id, created_at desc)`.
- `podium.offer_acceptances`:
  - Columns: id, offer_id unique → offers, revision, pdf_sha256, typed_name, confirmed_join_date, accepted_at
    timestamptz, ip, user_agent, token_hash, signed_doc_id → candidate_documents.
  - Append-only: no update/delete grant beyond service_role, and a trigger refuses UPDATE/DELETE.
- `podium.offer_responses`:
  - Columns: id, offer_id, application_id, kind check in (`decline`, `question`, `accept_blocked`),
    reason check in (`compensation`, `role`, `location`, `another_offer`, `personal`, `other`) (required for
    decline), text (≤2000), proposed_join_date, ip, user_agent, created_at, seen_by uuid, seen_at.
  - Index: `(offer_id, created_at)`.
- `podium.candidate_bank_details`:
  - Columns: candidate_id pk → candidates, bank_account_number / bank_ifsc / bank_account_name with the J2
    regexes, bank_name, submitted_at, offer_id, editable_until, reopen_by uuid, updated_at.
- `candidate_documents`: add `verified_by uuid`, `verified_at timestamptz`, and `source text not null default
  'staff' check in ('staff','candidate_link')`.
- RLS on, no policies, service_role-only grants on all four new tables (copy the 0008 `do $$` block).
- **RPC `podium.offer_link_accept(p jsonb)`** (SECURITY DEFINER, `search_path` pinned, service_role execute).
  - Input: `p = {offer_id, token_hash, typed_name, confirmed_join_date, accepted_at, ip, user_agent, pdf_sha256,
    signed_doc{storage_path,file_name,mime_type,file_size,title}, today}`.
  - Lock order: offer row `for update` (status must be `sent`), then `valid_until >= today` else
    `podium_offer_expired`, then the link must be live (D6) else `podium_link_dead`, then lock the opening and
    run the headcount check (D5) else `podium_headcount_full`.
  - Then: insert `offer_acceptances`, and call `podium.hiring_offer_transition` with `to_status accepted`,
    `expected_status sent`, `app_status accepted`, `event_type offer_accepted_link`, `acceptance_doc =
    signed_doc`, `set {accepted_at: date}`, `expected_terms_hash` = the row's terms_hash, actor null. Return its
    result plus the acceptance id.
- **RPC `podium.offer_link_respond(p jsonb)`**: `p = {offer_id, token_hash, kind, reason, text,
  proposed_join_date, ip, user_agent, today}`.
  - Common checks: lock the offer (must be `sent`, link live, not expired).
  - `decline`: insert the response, then transition `sent → declined` (`set declined_at, outcome_note =
    reason+text`, `event_type offer_declined_link`).
  - `question`: refuse `podium_question_cap` at ≥10 for that offer today, then insert the response.
  - Raises `podium_<code>`.

## Worker

**New pure module `src/offerlink.js`** + `test/offerlink.test.mjs`:
- `newLinkToken()` → 43-char base64url of 32 random bytes; `hashLinkToken(t)` → sha256 hex;
  `linkTokenShapeOk(t)`.
- `normName(s)`: NFKC, lowercase, every whitespace run → nothing, so "Asha  K" equals "asha k" and "ASHAK".
  `namesMatch(typed, onOffer)` compares the two.
- `DECLINE_REASONS` (code → label).
- `linkState({offer, today, startPlus7})` → `{mode: 'respond'|'documents'|'notice', notice}` per D7.
- `buildOfferMime({from, fromName, to, cc, subject, text, html, messageId, inReplyTo, attachments:[{filename,
  mime, bytes}]}, boundary?)`: multipart/mixed wrapping multipart/alternative. Copy the header-injection rules from
  `partner-email.js` (strip CR/LF, one bare address per field, RFC 2047 subject). Attachment filenames go RFC 2231
  ASCII-safe.
- Email renderers (text + html, escaped): `renderOfferEmail({candidateFirst, designation, startDate, validUntil,
  link, revised, ownerName})`, `renderConfirmationEmail(...)`, `renderAlertEmail({kind, candidateName,
  offerRef, revision, reason, text, proposedDate, appUrl})`. The button reads **"View and respond to your
  offer"**.
- `candidateLinkDocPath(candidateId, docType, fileName, ts)` → `candidates/<cid>/link/<docType>/<ts>-<safe>`, and
  `checkCandidateLinkDocPath(path, candidateId)`.
- `LINK_DOC_TYPES`: `payslip`, `pan`, `id_proof`, `address_proof`, `relieving_letter`, `photo`, `bank`
  (cancelled cheque), `education`, `experience_letter`. Each has a label; required:
  `pan, id_proof, address_proof, photo, bank`.
- `validateCandidateBank({account_number, account_number_confirm, ifsc, account_name, bank_name})` →
  `{ok, clean}` | `{ok:false, errors}`. Account: 9–18 digits, confirmation must match. IFSC: uppercased, same
  regex as J2. Name: 1–120.
- `maskAccount(n)` → `XXXXXX1234`.
- `certificateLines({offerRef, revision, candidateName, typedName, acceptedAtIst, joinDate, ip, userAgent,
  pdfSha256, tokenHashPrefix})` → the lines of the appended page (the rendering is pdf-lib in index.js or
  offer-render.js).

**`index.js`:**
- `googleAccessToken` gains `opts.sub` (default unchanged).
- `gmailSend(env, senderEmail, raw, threadId)` and `gmailFindByMessageId(env, senderEmail, messageId)`, with a
  per-mailbox token cache inside the isolate.
- `sendOfferEmail` (POST, `{id, sent_to?, sent_cc?}`):
  - Same gates as `markOfferSent`. `ready`, or `sent` for a same-revision resend.
  - `sent_to` defaults to the candidate's email.
  - Runs reconcile first, inserts the intent (D8), attaches the issued PDF read from storage (`pdf_path`),
    sends, then `finishOfferSend`.
- `resendOfferConfirmation` (POST, `{id}`): an accepted offer whose confirmation mail is missing or failed.
- `markOfferResponseSeen` (POST, `{response_id}`): canManageOffers on its offer.
- `verifyCandidateDocument` (POST, `{id, verified}`): `requireHr`; sets or clears verified_by/at.
- `allowCandidateBankUpdate` (POST, `{candidate_id}`): `requireHr`; editable_until = now + 7 days, reopen_by.
- `revealCandidateBank` (POST, `{candidate_id}`): `canComp` only, logged through `logCompAccess`; returns the full
  number.
- `getOfferResponses` (GET): open `offer_responses` (seen_at null) on offers the caller can manage.
  Used by the dashboard card and the Hiring page.
- `getOfferMailCheck` (GET, super_admin): D1 proof.
- `getOffer` adds:
  - `emails` (never token_hash; `has_link` + `link_live` instead);
  - `responses`;
  - `acceptance` (typed name, at, ip; the full user agent only for canManageOffers);
  - `joining`: per LINK_DOC_TYPES, the uploaded docs with verified state (titles only; ID/PAN/bank/address
    entries respect the existing HR-only doc visibility rule — non-HR see a count, not the file);
  - `bank`: masked, plus `editable`.
- **Public router**: `url.pathname.startsWith('/public/offer')` is handled BEFORE the JWT gate, with try/catch →
  generic 500.
  - `GET /public/offer?t=` → the view.
    - Respond mode: `{mode, candidate_first_name, designation, department, location, start_date, valid_until,
      offer_ref, revision, owner_first_name, annexure, letter_text (renderOfferText of the frozen letter, or the
      PDF url only if that's not cheap), pdf_url (10-minute signed URL of pdf_path), decline_reasons}`.
    - Documents mode: `{docs, bank: masked, bank_editable, docs_open_until}`.
    - Notice: `{mode:'notice', notice}`.
  - `POST /public/offer/accept` `{t, typed_name, confirm_join, agree}`:
    1. Name match, else 422 `name_mismatch` ("Type your full name exactly as it appears on the offer").
    2. Generate the certificate page appended to the issued PDF (pdf-lib), stored at
       `offers/<app>/<ref>-r<rev>-accepted-<sha12>.pdf`, no upsert.
    3. Call the RPC.
    4. On success, send the confirmation (kind `confirmation`, accepted PDF attached; a failure is recorded, not
       thrown) → the documents-mode view.
    5. `podium_headcount_full` → write an `accept_blocked` response + an alert mail →
       `{mode:'notice', notice:"Thank you — we'll be in touch shortly."}`.
    6. Idempotent: an already-accepted offer returns the documents view.
  - `POST /public/offer/decline` `{t, reason, text}` and `POST /public/offer/question` `{t, text,
    proposed_join_date?}` → the RPC + an alert mail (from the sender mailbox to itself, CC the reporting manager
    + hr@) → the view.
  - `POST /public/offer/upload-url` `{t, doc_type, file_name, mime}`: documents mode only, cap 30, mime pdf, jpg
    or png → signed upload URL.
  - `POST /public/offer/upload-done` `{t, doc_type, storage_path, file_name, mime, file_size}`: path check +
    storage HEAD (`checkStoredObject`) → insert candidate_documents (source `candidate_link`, uploaded_by null,
    application_id) + an application event `document_added` (actor null) → the view.
  - `POST /public/offer/bank`: validate → insert-or-ignore → else PATCH only where editable_until > now (clears
    editable_until/reopen_by) → else 409 `Your bank details are already with us. To change them, ask the
    Legend of Toys team.` The event detail never carries numbers.
- `confirmJoining`: after the employee exists, copy candidate_bank_details → employee_private when that row's
  bank_account_number is null (upsert on employee_id, only the 3 bank columns). It never fails the joining
  (warn).
- Add the new actions to the route tables / allow-lists exactly where the C3 offer actions sit.

## App (`apps/podium`)

- `src/app/offer/layout.js`: `export const metadata = { robots: { index: false, follow: false } }`; no
  AuthProvider dependency.
- `src/app/offer/page.js`: client page. It reads `t` from the query and makes plain `fetch` calls to
  `${PD_URL}/public/offer...` (PD_URL as in `lib/podiumopsFetch.js`; export it from there), never an auth
  header. It is mobile-first, in the Podium tokens.
  - **Respond mode:** greeting, role / start date / valid until; the letter (pdf link "Open the offer letter
    (PDF)" + the annexure table); then three tabs/cards:
    - Accept: typed name, a "I will join on <date>" checkbox, a "I have read and accept this offer" checkbox,
      and the button.
    - Decline: a reason select + text.
    - Question: text + optional date.
  - **Documents mode:**
    - "Your acceptance is recorded";
    - a checklist of LINK_DOC_TYPES with upload buttons (signed upload PUT, then upload-done) and a ✓ when
      uploaded / verified;
    - a bank form, or the masked bank + "ask HR to reopen".
  - **Notice mode:** just the sentence.
- Offer detail (`(auth)/hiring/offer/page.js` + `OfferBits.js`):
  - "Send by email" (ready): a modal with To (candidate email) + editable CC prefilled from `getOffer`'s default
    cc, then `sendOfferEmail`. Keep "Mark as sent" as the fallback.
  - On sent: "Resend link (same revision)".
  - The emails list (kind, status, to, sent_at, error); `unknown`/`sending` show "checking…".
  - The responses list with "Mark seen".
  - The acceptance evidence card.
  - The joining-documents checklist with Verify / Unverify (HR).
  - The bank card: masked, "Allow update" (HR), "Reveal" (comp).
  - "Resend confirmation" when accepted and no confirmation is `sent`.
- `(auth)/dashboard/page.js`: a "Candidate responses" card from `getOfferResponses` (hidden when empty), each
  linking to its offer.

## Tests / proof

- `node --test` over the whole of `podiumops-worker/test`, green. Offerlink tests cover:
  - token shape and hash;
  - name match;
  - linkState (each D7 branch, edges: valid_until day = respond, start+7 day = documents, start+8 = notice);
  - MIME (CRLF injection refused, multi-recipient refused, attachment present and base64 wrapped, threading
    headers);
  - the bank validator;
  - the doc path checker (another candidate's path refused, `..` refused).
- `npx wrangler deploy --dry-run` clean.
- `npx turbo build --filter=podium` clean.
- Live (lane):
  - `getOfferMailCheck`.
  - A synthetic opening + candidate whose email is Afshaan's own work address (ask Afshaan before any real
    send; CC trimmed to himself):
    - send → link → accept with a wrong name (refused), then the right name → certificate PDF + confirmation
      in the same thread;
    - upload one doc (fake path refused), bank save, second bank save refused, allowCandidateBankUpdate → one
      change;
    - a second revision kills the old link.
  - Decline + question on a second synthetic offer.
  - Clean up all synthetic rows and storage objects.
