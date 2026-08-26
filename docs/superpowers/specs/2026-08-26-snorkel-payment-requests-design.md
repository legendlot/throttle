# Snorkel — Payment Requests (replacing the #payments Slack channel)

> Written S314 snorkel lane, 2026-08-26. Design only — **nothing built yet.**
> Goal (Afshaan): anyone can open Snorkel **on their phone** and raise the same payment request they
> currently post in `#payments`, and **the channel is retired once this is streamlined.**

---

## 1. What the current process actually is (studied, not assumed)

Read ~145 messages in `#payments` (C090SUNAN4A) spanning 2026-08-01 → 08-26, plus threads.

**At least 20 distinct requesters** — Siddhanth, Padmajit, Himani, Reann, Pruthvi, Piyush, Kirti,
Akshara, Joseph, Kishan, Akshay, Mishica, Sejal, Priya, Kaushik, Nandu, Naveen, Karan, Siddhant —
all funnelling to **one executor, Mahesh Jain**.

The message text is near-constant ("please make the payment"). **The payload is the attachment** — a
PDF invoice or a WhatsApp photo of one. Everything else is inconsistent:

| Field | Frequency | Example as written today |
|---|---|---|
| Invoice file | almost always | `Invoice_Muscle&Masala_LOT.pdf`, `WhatsApp Image ….jpeg` |
| Amount | sometimes | "Total Amount To Be Paid = 1,20,978 Rs" |
| Payee bank details | only when unknown | 6 lines pasted as free text |
| Purpose | sometimes | "for acrylic sheets", "BDC Event table fee" |
| Urgency / due date | often, informal | "on priority", "by 3pm today", "on Thursday", "due 31st August" |
| PO reference | rarely | `PO 295 - Champion Electronics.pdf` |

**Spend is much wider than procurement:** material supply (Vitboj ₹3,81,773 · JDM ₹1,15,652 ·
Annapoorna ₹2,89,100 · Siddhi Vinayak ₹1,14,400 · Champion ₹1,53,400) · ad platforms (Meta ₹21L, Meta
credit line ₹12,27,750, Amazon DSP, Flipkart Vendor Central, Pinterest) · influencers · event
sponsorship (Beantown, BDC) · SaaS (LimeChat, Shopflo, Uniware, Veeno) · professional retainers
(POSH) · outsourcing (Chan Quality) · freight (Delhivery, air) · utilities (tea ₹42,739, water ₹4,725).

### The four failure modes, each with its evidence

1. **Payee identity is ambiguous.** Padmajit's thread (`1787291311.933149`): *"pls share bank details
   of shivam"* → *"who is shivam?"* → *"this is Lalji"* → the company is SHIVAM ENTERPRISES. Four
   round-trips for one payment.
2. **The PO gate is real but undiscoverable.** Piyush: *"Payments are still going through without PO,
   why?"* Mahesh: *"Will make sure now the payments are made with PO's."* Then Padmajit, asked for a
   PO, answered **"How do i get one?"**; Siddhanth issued one retroactively while saying he would stop
   (`1787208375.467839`).
3. **No status visibility → false escalation with operational cost.** Delhivery placed LOT under
   financial embargo and held all shipments; Padmajit escalated to Mohit — **the payment had already
   been made on 7 August** (`1786358219.502279`). Nobody could see that.
4. **Chasing is the norm.** "Is it done?" · "What's the update on payments?" · "you have missed Vitboj
   Poly coating payment" · "the vendor is pestering me" · "vendor is daily calling me". Completion is
   signalled by Mahesh posting 5–10 UTR screenshots at ~01:30 with a few @-mentions, so requests are
   acknowledged **in batches** and individual ones fall through.

⚠️ **A fifth risk nothing today can detect: duplicate payment.** `invoice  100.pdf` appears twice —
Kishan 2026-08-08 (Roxie box labels) and Siddhanth 2026-08-20 (Anagaha Enterprise). Same filename,
different requesters, 12 days apart. Whether or not it is the same invoice, the process cannot tell.

### Why the existing Snorkel mechanism was not adopted

`store.purchase_orders` already carries `payment_status`, `payment_requested_by/_at`, `paid_by/_at`,
`payment_routed_to`, `payment_note`, with worker actions `routePayment` + `markPaid`.
**It has been used on 2 of 373 POs** (1 paid, 1 requested).

That is diagnostic. It only works on an **Approved PO**, and it records **no amount, no UTR and no
attachment** — so it structurally cannot represent most of `#payments`. Building v1 as an extension
of that surface would inherit the same non-adoption. It is superseded by §3, and the PO columns stay
as the PO-side mirror (§6).

## 2. Decisions taken (Afshaan, 2026-08-26 — do not re-open)

| Question | Answer |
|---|---|
| Approval | **Yes, above a value threshold.** Default **₹1,00,000**, **editable in a Snorkel admin panel** |
| Approver | **Vinay Jaisingh** (EMP-002, Founder's Office) by default; **the approver list is editable** so Afshaan can add himself. Needs a **pending-approvals page with single AND bulk approve** |
| PO gate | **Required for goods/material categories only**, driven by the category |
| Payee + bank | **New payee master**; **bank details finance-only** |
| Part-payment | Request carries **invoice total + amount-to-pay-now** |
| Payment runs | **No run/batch concept** — per-request status + a needed-by date |
| Tally | **Workflow-only in v1**; design the seam, don't wire it |
| Executor | **Mahesh Jain** only |
| Slack channel | **Retired** once this is streamlined |
| Scope | **Credit notes / debit notes are their own request type** |

## 3. The standard template

One form, phone-first. This *is* the deliverable — it replaces "please make the payment".

**Always required**
- **Payee** — picker from the payee master, with inline **“+ New payee”**
- **Category** — picker; drives the PO gate (§5)
- **Purpose** — one line, required (“Acrylic sheets for Shadow tooling”)
- **Document(s)** — at least one; camera capture or file. WhatsApp photos are the norm, so the
  capture path must be as good as the upload path
- **Invoice number** + **invoice date**
- **Invoice total (₹)**
- **Amount to pay now (₹)** — defaults to the invoice total; a lower value is a part-payment
- **Needed-by date** — required, replacing "today"/"ASAP"/"on priority"

**Conditionally required**
- **PO number** — mandatory iff the chosen category is `po_required` (§5)

**Optional**
- Urgency flag + a reason (only meaningful with a reason; otherwise everything is urgent)
- Notes; people to keep informed

**Captured automatically, never typed**
- Requester + timestamp · computed approval route · **the threshold in force at submit** · payee's
  default bank account · running balance already requested against this invoice

**Request types:** `payment` · `credit_note` · `debit_note`. CN/DN carry the same shape minus
*amount to pay now* (they offset rather than disburse) and never enter the paid state.

## 4. Data model

All in `store` (Snorkel's schema), RLS on, service_role-only, per RULE-RLS-001.

**`store.payment_payees`** — `payee_code` (`PAY-NNNN`, seq `payee`), `name`, `payee_type`
(vendor · influencer · ad_platform · service_provider · logistics · utility · event · govt · other),
`linked_vendor_code` → `store.vendors` (nullable — a payee that *is* a procurement vendor),
`gstin`, `pan`, `email`, `phone`, `is_active`, audit cols.
⚠️ Deliberately **not** an extension of `store.vendors`: influencers, ad platforms, landlords and
event organisers are not procurement vendors, and forcing them in would pollute every vendor picker
in the PO flow. `linked_vendor_code` keeps the join where it is genuinely the same entity.

**`store.payment_payee_banks`** — `payee_id`, `account_name`, `account_number`, `ifsc`, `bank_name`,
`branch`, `upi_id`, `is_default` (partial-unique one per payee), `is_active`, audit cols.
A separate table so the permission gate is a table-level decision, and because a payee legitimately
has more than one account.

**`store.payment_requests`** — `request_no` (`PAY-NNNN`, seq `pay_request`), `request_type`,
`category_key`, `payee_id`, `purpose`, `invoice_no`, `invoice_date`, `invoice_total`,
`amount_to_pay`, `currency` (default INR), `needed_by`, `is_urgent`, `urgency_reason`,
`linked_po_number`, `status`, `threshold_at_submit`, `auto_approved`,
requester/approver/rejecter/payer audit sets, `payee_bank_id` (which account it went to),
`payment_ref` (UTR), `payment_mode`, `paid_amount`, `payment_note`.

**`store.payment_request_documents`** — `request_id`, `doc_kind`
(invoice · proforma · quote · **payment_proof** · other), `file_path` in a **private** bucket
`payment-docs`, `file_name`, `mime`, `size_bytes`, uploader, timestamp.
Finance's UTR screenshot lands here as `payment_proof` — that is what kills failure mode 3.

**`store.payment_categories`** (admin-editable) — `category_key`, `label`, `po_required`,
`is_active`, `sort_order`.

**`store.payment_settings`** (singleton) — `approval_threshold_inr` (default `100000`), audit cols.

**Proposed seed categories — ⏳ confirm/edit the `po_required` column:**

| Category | PO required | Seen as |
|---|---|---|
| `material_supply` | **yes** | Vitboj, JDM, Annapoorna, Siddhi Vinayak, Champion |
| `packaging` | **yes** | boxes, Roxie labels, batch stickers, WhatAbout |
| `outsourcing_jobwork` | **yes** | Chan Quality Solution, painted tops |
| `capex_equipment` | **yes** | soldering machines, acrylic sheets |
| `ad_spend` | no | Meta, Amazon DSP, Flipkart VC, Pinterest |
| `influencer` | no | Reann/Himani influencer invoices |
| `saas_subscription` | no | LimeChat, Shopflo, Uniware, Veeno |
| `logistics_freight` | no | Delhivery, air shipments |
| `events_sponsorship` | no | Beantown, BDC table fee |
| `professional_services` | no | POSH retainer, legal |
| `utilities_facility` | no | tea ₹42,739, water ₹4,725 |
| `other` | no | — |

## 5. Rules the build must hold

1. **Approval routes on the amount, and the threshold is STAMPED at submit.**
   `amount_to_pay >= threshold` → `pending_approval`; otherwise `approved` with
   `auto_approved = true`.
   ⚠️ **Write `threshold_at_submit` onto the row.** The threshold is admin-editable, and without the
   stamp, raising it later silently reinterprets every historic request as "never needed approval" —
   an audit trail that changes retroactively is not an audit trail.
   ⚠️ **`auto_approved` is a distinct boolean, not a fake approver.** Never stamp Vinay as approver on
   something he never saw.
2. **Approvers are a permission, not a hardcoded name.** Perm key `payment_approve`, granted through
   the existing `store.snorkel_roles` / `snorkel_user_roles` layer and surfaced in the Payments admin
   tab as a plain add/remove list. Seed: Vinay Jaisingh. That satisfies "editable so I can add me
   later" without new machinery.
3. **The PO gate is category-driven.** `po_required` → `linked_po_number` mandatory, must resolve to a
   real `store.purchase_orders` row, and should warn when the PO's value is already consumed. This
   closes Piyush's complaint **by construction** rather than by reminder — and the form must show
   *how* to raise a PO, because "How do i get one?" was the actual blocker.
4. **Bank details are write-on-create, read-gated.** A requester adding a new payee **may enter** bank
   details (they already have them — that is what they paste into Slack today), but only
   `payment_bank_view` holders may **read them back**; everyone else sees the account masked to the
   last 4. This is the asymmetry the current process lacks, and it mirrors the Podium PAN precedent
   (`stripPan`). ⚠️ Bank details must never be returned by the general payee read used to populate
   the picker — gate at the query, not in the UI.
5. **Duplicate-invoice guard.** On submit, warn (do not block) when the same `payee_id` +
   `invoice_no` already has a non-rejected request, showing the prior one. Evidence: `invoice 100.pdf`
   above. Blocking is wrong — genuine re-bills and part-payments share an invoice number.
6. **Part-payment is derived, never re-keyed.** `Σ amount_to_pay` of non-rejected requests for a
   (payee, invoice_no) gives the balance; the form shows "₹67,850 already requested against this
   invoice" when raising the balance. Closes "please make the balance payment".
7. **Threshold-splitting is visible.** If the running total for a (payee, invoice_no) crosses the
   threshold while individual requests do not, flag it on the approvals page. Do not auto-block.
8. **Status is the product.** Every requester sees `submitted → pending approval → approved → paid`
   with the UTR and proof attached. Failure mode 3 (Delhivery) is closed only if this is visible
   *without asking anyone*.

## 6. Relationship to existing objects

- **`purchase_orders` payment columns** are superseded as the *request* surface. Keep them as the
  PO-side mirror: when a request with a `linked_po_number` is paid, stamp `payment_status='paid'`,
  `paid_at`, `paid_by` on the PO so procurement's own screens stay truthful. **Do not build a second
  request flow there.**
- **`po_requests`** is the pre-PO *procurement* requisition — a different thing (asking to buy, not
  asking to pay). No overlap; do not merge.
- **Odo / P&L** — out of scope for v1. A payment request is not a cost recognition event.

## 7. Tally seam (designed, not wired)

Per the decision, v1 is workflow-only. But the paid record must carry everything a Tally **Payment**
voucher needs, so wiring later is additive: payee (→ ledger), date, amount, bank account, UTR as the
voucher narration/reference, and a `tally_voucher_no` column following exactly the pattern shipped
today in `snorkel_tally_voucher_identity_v1` — Tally identifies a voucher for ALTER by
`DATE + VOUCHERNUMBER + VCHTYPE`, so a push without a stored identity duplicates.
See `2026-08-26-snorkel-tally-connect-design.md`.

## 8. Permissions (new keys, Snorkel's own layer)

| Key | Who | Grants |
|---|---|---|
| `payment_request` | everyone who posts in #payments today (~20 people) | raise + see own requests |
| `payment_approve` | Vinay Jaisingh (+ Afshaan later) | approvals page, single + bulk approve |
| `payment_execute` | Mahesh Jain | mark paid, record UTR, upload proof |
| `payment_bank_view` | finance | read unmasked bank details |
| `payment_payee_manage` | finance + requesters (create only) | create/edit payees |
| `payment_admin` | Afshaan | threshold, categories, approver list |

## 9. Screens (mobile-first — Snorkel already has the S304 shell)

1. **New Request** — the §3 form. Must be completable one-handed on a phone with a camera photo.
2. **My Requests** — status list, newest first; the requester's answer to "is it done?".
3. **Approvals** (`payment_approve`) — pending queue, **single and bulk approve**, each row showing
   payee, amount, category, PO, requester, needed-by, and any duplicate/split flag.
4. **Finance Queue** (`payment_execute`) — approved-and-unpaid, sorted by needed-by; mark paid with
   UTR + proof; bulk mark-paid, since Mahesh genuinely pays in batches.
5. **Payees** — list, detail, bank accounts (gated), linked vendor.
6. **Admin → Payments** — threshold, category list + `po_required`, approver add/remove.

## 10. Build order

1. Migration: 6 tables + 2 sequences + `payment-docs` private bucket + perm keys + category/settings seed.
2. Worker: payee CRUD (bank-gated reads), request create/list/detail, approve (single + bulk), mark-paid, document upload URLs.
3. Screens 1–4 (the loop that lets the channel retire), then 5–6.
4. Backfill the payee master from the vendors already known + the payees seen in `#payments`.
5. Run in parallel with the channel for a short period, then retire it.

## 11. Open — needs Afshaan before or during build

1. **Confirm the `po_required` column** in the §4 category table.
2. **Notifications.** The channel is being retired, so requesters lose their ambient feed. In-app only
   matches the S314 Pitstop posture — but ⚠️ **that decision is explicitly Pitstop-scoped**, so it
   should not be assumed to generalise. Recommendation: in-app for v1 (Mahesh works a queue; the
   requester has My Requests), and decide on email/Slack once adoption is real.
3. **Should approval be required regardless of amount for any category?** (e.g. ad spend, where a
   single Meta invoice was ₹21L but a credit-line top-up may be routine.)
4. **Priya Bhadulkar has no login** (`auth_user_id` is null). If she ever needs the finance queue, an
   account must be created first.
5. **Foreign-currency payments** — air freight and some vendors may not be INR. v1 assumes INR;
   confirm before that assumption is baked into the amount fields.
