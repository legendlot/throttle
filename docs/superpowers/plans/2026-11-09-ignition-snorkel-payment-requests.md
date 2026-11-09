# Ignition → Snorkel payment requests (Reann #2) — plan

> S443, 2026-11-09. Source: `#bugs` `1793690997.941679` item 2. Status: **DRAFT, awaiting Afshaan's answers (§Open questions).**
> Builds on #1 (`2026-11-05-ignition-deal-contract-send.md`), which collects bank details + the invoice.

## Goal

A deal owner raises a creator payment from the Ignition deal. It lands in Snorkel as a normal payment
request (numbering, threshold approval, finance execution unchanged). The deal shows the request's live
status; when finance pays, date, amount, UTR and TDS come back to the deal and it shows Paid. Reject
or hold shows on the deal and flags the owner. No bank details are typed by hand anywhere.

## What exists today (measured 2026-11-09)

| Side | Fact |
|---|---|
| Ignition | `engagements.payment_amount` (192 deals > 0), `payment_terms` ∈ null 484 · advance 129 · on_release 47 · n_a 30 · on_draft 26. Owner = `poc_user_id`. |
| Ignition | `ignition.payments` = hand log (`kind` advance/final/other, `amount`, `paid_on`, `proof_path`), 39 rows, **no UTR column**. Feeds "₹X paid of ₹Y" (`getEngagement` `paid_total`). |
| Ignition | `influencer_bank_details`, `deal_contracts`, `deal_invoices` (bucket `ignition-creator-invoices/<engagement_id>/`) — **0 rows**, #1 is unpublished. Bank columns were named to match `payment_payees` + `payment_payee_banks`. |
| Ignition | Bindings: CSOPS, COMMSOPS only. No snorkelops binding. No owner notifications of any kind. |
| Snorkel | `createPaymentRequest` (`snorkelops-worker/src/index.js:5307`) needs payee, purpose, `category_key`, amount; **invoice not required**. Threshold → `approved` or `pending_approval`. |
| Snorkel | Statuses: submitted, pending_approval, approved, held, paid, rejected, cancelled. `markPaymentPaid` writes `payment_ref` (UTR), `paid_at`, `paid_amount`, TDS fields. |
| Snorkel | Split against one invoice already works (290 requests / 201 invoice numbers; duplicate check warns, never blocks). |
| Snorkel | Category `influencer` exists (no PO). 12 hand-made influencer payees, 13 requests, ₹1,12,501 (paid/cancelled). |
| Snorkel | **No source/origin column** on `payment_requests`; no cross-worker caller; notifications are in-app only (`store.payment_notifications`). |

## Design

1. **One path in: ignitionops → snorkelops over a service binding** (`[[services]] SNORKELOPS`; Cloudflare 1042 rules out a plain fetch). snorkelops gets one internal-token action, `ignitionRaisePayment`, that reuses `createPaymentRequest`'s insert/threshold/numbering code — Ignition never writes `store.payment_requests` directly. Token minted (`tools/lot-token --mint`), never asked.
2. **Traceability columns** (one migration): `payment_requests.source_system text`, `source_ref text` (Ignition request id), unique on (`source_system`,`source_ref`) = idempotent retries. `payment_payees.linked_influencer_id uuid unique`.
3. **Payee find-or-create**: by `linked_influencer_id`; else match the 12 hand-made influencer payees on PAN, then name (match → link, never duplicate); else create (`payee_type='influencer'`, `synced_from='ignition'`). Bank row copied from `influencer_bank_details` into `payment_payee_banks`; the full number never returns to Ignition (keeps #1's masking).
4. **Ignition side table `ignition.deal_payment_requests`**: engagement_id, kind (advance / balance / full), amount, invoice_id, state (`waiting_for_invoice` → `sent` → mirrors Snorkel), snorkel request id + `request_no`, held_reason, rejection_note, paid_at, paid_amount, utr, tds_amount, last_synced_at, raised_by.
5. **Waiting for invoice is Ignition-side**: the row is created in `waiting_for_invoice` and only sent to Snorkel once the creator's invoice is uploaded (it is copied in as a `payment_request_documents` row, `doc_kind='invoice'`). Finance never sees an invoice-less creator request.
6. **Split payment**: advance raised against the full-fee invoice (`invoice_total` = fee, `amount_to_pay` = advance); the balance is a second request on the same `invoice_no`, raised at Live. Sum of requests ≤ `payment_amount` enforced in Ignition.
7. **Status back, real time**: snorkelops pushes on every transition of a request with `source_system='ignition'` (approve, hold, release, reject, paid, cancel) via an `IGNITIONOPS` binding; a 15-minute reconcile cron in ignitionops is the safety net for missed pushes. On `paid`, a row is written to `ignition.payments` (gains `utr`, `tds_amount`, `snorkel_request_id`) so "₹X paid of ₹Y" keeps one source.
8. **Permissions**: raise = `ignition_manage` (Lead/Manager/Admin, i.e. the influencer team after S443). Approval and payment stay entirely in Snorkel's roles.

## Slices (each: build → `/hostile-review` → commit → deploy → smoke)

| # | Slice | Repo | Size |
|---|---|---|---|
| S1 | Migration: source columns + unique, `linked_influencer_id`, `ignition.deal_payment_requests`, `ignition.payments` + utr/tds/snorkel id; enum-drift check | db | quick |
| S2 | snorkelops `ignitionRaisePayment` (payee find-or-create, bank copy, invoice doc copy, idempotent) + push hook on transitions; tests | 05_Throttle | half-day |
| S3 | ignitionops: SNORKELOPS binding, `raiseDealPayment` / `getDealPayments` / `cancelDealPayment`, push receiver, reconcile cron, paid → `ignition.payments` | 05_Throttle | half-day |
| S4 | Ignition deal page: Payments card (states, Raise advance / Raise balance, held/rejected reason, Paid with date · amount · UTR · TDS) | 05_Throttle | half-day |
| S5 | Owner flag on held/rejected (channel per Q4) | 05_Throttle | quick |
| S6 | Manual chapter (Ignition + Snorkel), Codex pass (money path), end-to-end proof on a temporary deal with a ₹1 request Afshaan approves | — | quick |

## Open questions (Afshaan)

1. **Hand log after cutover**: keep `addPayment` (manual UPI log) for history only and hide "Add payment" on new deals, or keep both?
2. **Balance at Live**: button the owner presses, or auto-raise the balance request when the deal moves to Live (if an invoice is on file)?
3. **Creators without #1 bank details** (everything until Reann publishes): allow raising only when a matching Snorkel payee with a bank already exists, or block until the contract flow has collected details?
4. **Owner flag channel** on held/rejected: Slack DM to the owner, a `#bugs`-style channel post, or in-app only?
5. **Who may raise**: `ignition_manage` (Jashwanth, Himani, Nandeswari, Ansh + admins), or admins only?
