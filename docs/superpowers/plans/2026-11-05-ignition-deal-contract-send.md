# Ignition: send brief + contract, creator accepts, Shipping locked (Reann #1)

Slack: `#bugs` `1793690997.941679`, item 1. Afshaan approved the "I accept" link over parsing replies (2026-11-05).
Items 2 (Snorkel) and 3 (commission) build on this. Do not build them here.

## What it does

1. Someone opens a deal, clicks Send contract, checks and edits the text, clicks Send.
2. Email goes from `partners@legendoftoys.com` through Gmail with a link. Replies land in that mailbox.
3. The creator opens the link (no login), reads the contract, ticks and clicks I accept.
4. On paid or affiliate deals the same page then takes bank details and the invoice.
5. Shipping stays locked until accepted. A person can record acceptance by hand, with a reason.

Sending and the lock both stay OFF until the wording is published. Reann owns the wording and has been asked for it.

## Decisions already made (do not reopen)

- **Gmail, not Resend or Relay.** `comms.legendoftoys.com` is deliberately marketing only (integrations.md). Relay `/send` needs a template and a comms profile. This is a one-to-one contract, so it needs replies and a Sent copy in `partners@`. Gmail domain-wide delegation with `gmail.modify` already exists and that scope allows `messages.send`.
- **Send runs inside csops, via the existing bridge.** `GOOGLE_SA_JSON` lives only on csops and its value cannot be read. Ignition already calls `csopsBridge()` with `IGNITION_BRIDGE_TOKEN` over the `CSOPS` binding. Add bridge actions there. No new secrets, no `wrangler.toml` edit.
- **This replaces the S313 "inert brief" plan.** Its two prerequisites (Relay template, comms profile) no longer apply. Replace the comment block and `BriefPreviewButton`; keep the rule that Reann's words go in before anything is armed.
- **UGC is out of scope.** UGC deals keep `generateUgcBrief`, never get the lock.
- **Existing deals:** only deals in `proposed` or `planning` today come under the lock (plus every new video deal). Everything else is exempt, because it has already moved on.

## Data (one migration file, the lane applies it)

File: `ignitionops-worker/migrations/0004_deal_contracts.sql`. RLS on for every new table, no policies, `revoke all from anon, authenticated`, `grant all to service_role`. End with `notify pgrst, 'reload schema'`.

- `ignition.engagements`: add `deliverables text`; add `contract_required boolean not null default true`. Backfill: `false` where `engagement_type='ugc' or stage not in ('proposed','planning')`.
- `ignition.contract_settings`: single row (`id int primary key default 1 check (id=1)`): `subject`, `dos_and_donts`, `terms`, `published_at`, `published_by`, `updated_at`, `updated_by`. Seed an empty unpublished row.
- `ignition.deal_contracts`: `id`, `engagement_id`, `influencer_id`, `status` CHECK in `sending|sent|failed|superseded|accepted|accepted_by_hand`, `to_email`, `subject`, `body` (exact text sent), `body_sha256`, `token_hash` unique nullable, `gmail_message_id`, `error`, `sent_by`, `sent_at`, `accepted_at`, `accepted_ip`, `accepted_user_agent`, `by_hand_reason`, `by_hand_by`, `created_at`. Index on `engagement_id`.
- `ignition.influencer_bank_details`: `influencer_id` PK, `account_name`, `account_number`, `ifsc`, `bank_name`, `upi_id`, `pan`, `gstin`, `submitted_at`, `contract_id`, `editable_until`. These names match `store.payment_payees` + `payment_payee_banks` so item 2 can map them across.
- `ignition.deal_invoices`: `id`, `engagement_id`, `contract_id`, `path`, `file_name`, `mime`, `uploaded_at`.
- Private storage bucket `ignition-creator-invoices`: `file_size_limit` 10 MB, `allowed_mime_types` pdf, jpeg, png.

## Worker: new file `ignitionops-worker/src/contract.js` (pure, tested)

- `composeContract(deal, products, coupons, campaign, settings)` returns `{to, subject, body, warnings, blockers}`. Body sections: greeting, campaign name and type, what we are sending, deliverables, post date, payment terms and amount (not for barter; map `advance|on_draft|on_release|n_a` to plain words), tracking link and code if present, dos and don'ts, terms. No invented legal wording: dos, don'ts and terms come only from settings.
- `blockers` (refuse to send): wording not published, no valid email, deal not approved, terminal stage, UGC, no deliverables, no expected post date, paid deal with no amount.
- `validateBank(input)`: trims and uppercases. IFSC `^[A-Z]{4}0[A-Z0-9]{6}$`, PAN `^[A-Z]{5}[0-9]{4}[A-Z]$`, account number 6 to 18 digits and must match its confirm field, GSTIN optional 15 chars, UPI optional. Returns field-level errors.
- `maskBank(row)`: `{received, account_last4, ifsc, bank_name, submitted_at}` only. Never the full number or PAN.
- `shipLockRefusal({deal, settings, accepted, toStage})`: refuses when wording is published, `deal.contract_required`, nothing accepted, and `toStage` is one of `shipped, delivered, scheduled, posting, live`. Transitions are free, so `planning → live` must not skip the lock.
- `needsPayment(deal)`: true for `paid` and `affiliate`, false for `barter`.
- `newToken()` 32 random bytes base64url; `hashToken()` SHA-256 hex.

## Worker: `index.js`

Authenticated, `requirePerm('ignition_manage')` for writes, `ignition_view` for reads. Partners are refused: do not add these to `PARTNER_GET_ACTIONS`.

- `getContractSettings`, `saveContractSettings`, `publishContractSettings` (refuse with empty dos or terms). Settings response includes a mailbox check from the bridge probe.
- `getDealContractDraft` returns the composed draft plus blockers.
- `sendDealContract {engagement_id, to, subject, body, save_email}`: re-check blockers server-side. Refuse if a send of the same body went out in the last 60 seconds. Insert row as `sending`, call bridge, then mark `sent` and mark older live rows `superseded` only on success. On failure mark `failed` and return the error in words. Link is `https://ignition.legendoftoys.com/deal/?t=<token>`, added by the server, not part of the editable text. An accepted contract cannot be re-sent without `force_resend: true`, which clears acceptance and needs a history note.
- `markContractAcceptedByHand {engagement_id, reason}`: reason required, writes history.
- `allowBankUpdate {influencer_id, engagement_id}`: sets `editable_until` to now + 7 days, writes history (no numbers).
- `getDealInvoiceUrl`: short-lived signed read URL.
- `getEngagement` response gains `contract` (latest row without `token_hash`, plus bank mask, invoices, `settings_published`), omitted for partners.
- `advanceStage`: call `shipLockRefusal` with the other gates, before any write, with a clear message. **Read every site that writes `stage` and every route into a post-ship stage** (`createEngagement` accepts `body.stage`; check approve, gifted-no-post, imports) and reconcile the count in your report.
- Add `deliverables` to `ENGAGEMENT_FIELDS`. Set `contract_required=false` at create for UGC.
- Remove `getDealBriefPreview` and the S313 block once nothing calls them.

Public routes, in `fetch` before the JWT gate. All look up by `hashToken(t)`; unknown or superseded token returns a plain "this link is no longer valid". CORS as elsewhere.

- `GET /public/contract?t=`: deal number, subject, body, status, `needs_payment`, bank mask, invoices (names only), closed flag. No internal fields, no cost, no owner.
- `POST /public/contract/accept`: **POST only**, because mail scanners follow GET links. Idempotent. Stores time, `CF-Connecting-IP`, user agent. Writes history. Refused on terminal deals.
- `POST /public/contract/bank`: only after acceptance and only if `needs_payment`. Refused if details already exist and `editable_until` has passed, with "ask the Legend of Toys team to reopen this". This stops a forwarded link from changing where money goes.
- `POST /public/contract/invoice-url` then `POST /public/contract/invoice-done`: after acceptance only. Signed upload as `createCampaignBriefUploadUrl` does. Server-chosen path under `engagement_id/`. `invoice-done` must verify the path belongs to this engagement.

## csops: `csops-worker/src/index.js`, in the `/bridge/ignition` handler

- `partnerMailboxProbe`: `GET /users/partners@legendoftoys.com/profile`, returns ok + address or the error.
- `sendPartnerEmail {to, subject, text, html}`: sender is a hardcoded constant, never caller-supplied. Strip CR and LF from `to` and `subject` (header injection). RFC 2047 encode the subject. Multipart text + html.
- Token cache must be **per mailbox**. Do not change what `gmailAccessToken`, `gmailMailbox` or `gmailFetch` do for carecrew: Pitstop mail depends on them. Add a separate function or an optional parameter that defaults to today's behaviour.

## App: `apps/ignition`

- `src/app/deal/page.js`, outside `(auth)`: public, no login, mobile-first, readable light layout. Must work inside the root `AuthProvider` with no redirect to login: confirm by reading `@throttle/auth`. Uses `useSearchParams` in `Suspense` for static export. Steps: read, tick "I have read and agree", I accept; then bank form (account twice, inline field errors) and invoice upload; then a done state. Coming back later shows where they stopped. Plain words, no internal terms.
- `engagements/detail/components/ContractCard.js` on the deal page, hidden for partners, for video deals only: status in words with who and when; bank "received, ending 4321"; invoices; buttons Send contract or Resend, Mark accepted by hand, Allow bank details update. If wording is unpublished, say so and link to the settings page.
- Send modal: To (editable, with save-to-influencer), Subject, Body (editable), blockers listed and Send disabled while any remain, note that the accept link is added automatically.
- `DealTermsCard`: edit `deliverables`. Also add it to the new-deal form if that form has a natural place (`useDealForm`, `dealPayload`).
- `admin/contract/page.js`: edit subject, dos and don'ts, terms; Publish, with a plain warning that publishing turns on sending and the Shipping lock. Shows whether `partners@` is reachable. Add to `lib/nav.js` following how `admin/users` is gated.
- Stage move refusal shows the worker's message in `AdvanceModal`.
- Remove `BriefPreviewButton` and its use.

## Tests and checks

`ignitionops-worker/test/contract.test.mjs` for every pure function, including hostile inputs: empty, whitespace, null, lowercase IFSC, `planning → live` with no acceptance, barter, UGC, already accepted, unpublished wording.

Run the worker suite, the app suite and `npx turbo build --filter=ignition`. Zero errors.

## Not in this build

Snorkel payee creation, payment requests, commission (items 2, 3). Reminders to creators who have not accepted. Access changes (item 10).
