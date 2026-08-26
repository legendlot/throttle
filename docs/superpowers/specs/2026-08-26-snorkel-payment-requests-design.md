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
| Approval | **Yes, above a value threshold.** Default **₹1,00,000**, editable — **by a SUPER ADMIN only** (§2a) |
| Approver | **Vinay Jaisingh** (EMP-002, Founder's Office) by default; **the approver list is editable** so Afshaan can add himself. Needs a **pending-approvals page with single AND bulk approve** |
| Category overrides | **None.** Meta invoices are always large — **the threshold holds the line**; no category approves regardless of amount (Afshaan, 2026-08-26) |
| Currency | **Editable per request. INR is the default everywhere unless changed** |
| PO gate | **Required for goods/material categories only**, driven by the category |
| Payee + bank | **New payee master**; **bank details finance-only** |
| Part-payment | Request carries **invoice total + amount-to-pay-now** |
| Payment runs | **No run/batch concept** — per-request status + a needed-by date |
| Tally | **Workflow-only in v1**; design the seam, don't wire it |
| Executor | **Mahesh Jain** only |
| Slack channel | **Retired** once this is streamlined |
| Scope | **Credit notes / debit notes are their own request type** |

## 2a. Snorkel has no super-admin tier yet — one must be added

Afshaan: *"Threshold should only be super admin editable… if Vinay is not, make him super admin."*

**Measured 2026-08-26:** Snorkel's only admin key is `snorkel_admin`, and **6 people hold it** —
adnan, afshaan, joseph, mohit, shashwat, **vinay**. So Vinay is already a Snorkel admin, but "admin"
is a wider circle than Afshaan means for a money threshold.

**Add `snorkel_super_admin`**, following the **Manifest precedent** (`manifest_super_admin`,
RULE-MANIFEST-006 — governance separated from operational admin). Seed: **Afshaan + Vinay Jaisingh**.
Only this key may edit the threshold, the category list and the approver list. `snorkel_admin` keeps
everything it does today and gains nothing.

⚠️ **Two Vinays exist — this is Vinay Jaisingh, EMP-002, `vinay@legendoftoys.com`, Founder's Office.**
NOT Vinay Ram (EMP-065, `ram@legendoftoys.com`, Offline), who holds `sales_manager` and is the
"Vinayram" referenced elsewhere in systems/snorkel.md.

## 2b. ⛔ The biggest rollout risk: 13 of 20 requesters cannot log into Snorkel

The channel is to be retired. **Measured 2026-08-26 against `store.snorkel_user_roles`:**

- **7 of the 20 observed requesters have a Snorkel role** — akshay, joseph, mahesh, piyush, priya,
  siddhant, siddhanth.
- **13 do NOT** — akshara, himani, karan, kaushik, kirti, kishan, mishica, nandeswari, naveen,
  padmajit, pruthvi, reann, sejal.

Several of the 13 are among the **heaviest** requesters (Padmajit, Himani, Reann, Pruthvi). Retiring
`#payments` before they are onboarded leaves two-thirds of the requesters with nowhere to raise a
payment — the feature would fail on day one for reasons that have nothing to do with its design.

**Therefore: granting a `payment_request` role to all ~20 requesters is a shipping prerequisite, not
a follow-up.** It also means the new role must be genuinely minimal — these people need *only*
payment requests, not procurement, sales or collections. Note `store.snorkel_user_roles` carries one
role per user, so a requester-only role must be a distinct role_key (e.g. `payment_requester`), and
anyone who already holds a Snorkel role needs `payment_request` added to **that** role's permissions
rather than being reassigned.

## 3. The standard template

One form, phone-first. This *is* the deliverable — it replaces "please make the payment".

**Always required**
- **Payee** — picker from the payee master, with inline **“+ New payee”**
- **Category** — picker; drives the PO gate (§5)
- **Purpose** — one line, required (“Acrylic sheets for Shadow tooling”)
- **Document(s)** — at least one. **Two equally-prominent buttons: "Take photo" and "Upload file"**
  (§3a). WhatsApp photos are the norm, so capture must be as good as upload, not a fallback
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

**Currency:** every amount field carries a currency selector defaulting to **INR**. The default
applies everywhere it is not explicitly changed; the chosen currency is stored on the request and
displayed with every amount, so a non-INR request can never be read as rupees.

## 3a. Invoice capture — frictionless is the requirement, and there are two traps

Afshaan: *"make it absolutely frictionless to capture invoices… there should be a camera capture
option/button also on upload."*

**Two buttons, equal weight, never a menu:**
- **Take photo** → `<input type="file" accept="image/*" capture="environment">` — opens the rear
  camera directly on Android/iOS.
- **Upload file** → `<input type="file" accept="image/*,application/pdf" multiple>` — gallery, Files,
  or desktop drag-and-drop.

⚠️ **Nothing in the entire fleet uses `capture=` today** (swept all 12 apps + `packages/`,
2026-08-26 — zero hits). This is a genuinely new control, so it needs a real device smoke, not a
desktop one: `capture` is silently ignored on desktop browsers, so it will look fine and prove
nothing.

⚠️ **TRAP 1 — the S305 fleet-wide file-picker bug. Do not reintroduce it.** Four call sites held
`e.target.files` and then set `e.target.value = ''` *before consuming it*. `input.files` returns the
**same live FileList object** on every access, so clearing `value` empties the reference already
held; consumers then hit `if (!files.length) return` and do nothing — **no error, no toast, no
console output**. It cost Garage gate-pass every attachment for two days (42.5% of passes carried
documents before the regression; **0 of 25 after**).
**The rule: lift the File objects out first — `const picked = Array.from(e.target.files || [])` —
and only then clear `value`. Never pair a functional state updater (`setFiles(prev => …)`) with an
eager clear**, because React defers the updater to the render phase and the clear always wins.

⚠️ **TRAP 2 — phone photos are large.** The `#payments` WhatsApp images run 130–370 KB, but a direct
rear-camera capture is typically **3–8 MB**. Client-side downscale (long edge ~2000px, JPEG ~0.8)
before upload, or the first request raised on a weak factory connection will hang and the requester
will go back to Slack. Keep the original aspect ratio; never crop.

**Also required for frictionlessness:** multiple documents per request (Siddhanth routinely attaches
3–5 invoices, and one Vitboj request carried 10 WhatsApp photos); a visible thumbnail + filename per
attachment with a remove control; and upload progress, because a stalled silent upload is
indistinguishable from a broken one.

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
| **`snorkel_super_admin`** | **Afshaan + Vinay Jaisingh** | **threshold, categories, approver list** (§2a) |

⚠️ `payment_admin` was folded into `snorkel_super_admin` — Afshaan's call is that the threshold is
super-admin-only, and a second near-identical key would just be a way to widen that circle by
accident. `snorkel_admin` (6 holders today) is deliberately **not** enough to move the threshold.

## 9. Screens (mobile-first — the S304 shell is real, verified in the CSS)

**Snorkel's mobile shell exists and was confirmed in code, not assumed** (`apps/snorkel/src/app/redesign.css`:
`.sn-tabbar` fixed bottom tab bar + full-nav sheet under `@media (max-width: 767px)`, S304). So the
app shell is already phone-ready and this feature inherits it — what still has to be designed for the
phone is the **form itself**: single-column, large tap targets, numeric keypads on amount fields, a
native date picker for needed-by, and no horizontal scroll.

✅ **The mobile tab is already there, and it points at the feature this replaces.** Checked in
`(auth)/layout.js`: `MOBILE_TABS` = Requests · POs · Sales · **Payments** (`/payments`) · More. And
`/payments` is the **"Payment Queue — Approved POs. Route to Finance or the requester, then mark
paid"** screen — i.e. exactly the `routePayment`/`markPaid` surface used on 2 of 373 POs (§1).

**So this feature should TAKE OVER `/payments` rather than sit beside it.** The dead PO queue becomes
one filtered view inside the new module (requests carrying a `linked_po_number`), not a second
destination. That gives requesters a phone tab on day one with no nav change, avoids two things
called "Payments", and retires the unused screen instead of leaving it to confuse people.
⚠️ Its current permission gate must be re-checked when the route is repurposed — today it is reachable
by whoever holds the PO-payment permission, which is a narrower set than the ~20 people who need to
raise requests.

1. **New Request** — the §3 form. Must be completable one-handed on a phone, including capture (§3a).
2. **My Requests** — status list, newest first; the requester's answer to "is it done?".
3. **Approvals** (`payment_approve`) — pending queue, **single and bulk approve**, each row showing
   payee, amount, category, PO, requester, needed-by, and any duplicate/split flag.
4. **Finance Queue** (`payment_execute`) — approved-and-unpaid, sorted by needed-by; mark paid with
   UTR + proof; bulk mark-paid, since Mahesh genuinely pays in batches.
5. **Payees** — list, detail, bank accounts (gated), linked vendor.
6. **Admin → Payments** — threshold, category list + `po_required`, approver add/remove.

## 10. Build order

1. Migration: 6 tables + 2 sequences + `payment-docs` private bucket + perm keys (incl.
   `snorkel_super_admin`) + category/settings seed.
2. Worker: payee CRUD (bank-gated reads), request create/list/detail, approve (single + bulk),
   mark-paid, document upload URLs.
3. Screens 1–4 (the loop that lets the channel retire), then 5–6.
4. **Onboard the 13 requesters who have no Snorkel role (§2b)** — must land before any cutover.
5. Backfill the payee master from the vendors already known + the payees seen in `#payments`.
6. Run in parallel with the channel for a short period, then retire it.

**Smoke checklist that cannot be done on desktop:** camera capture opens the rear camera on a real
Android and a real iPhone; a captured photo actually attaches (the S305 trap); a multi-MB capture
uploads over a factory-grade connection; the form is completable one-handed.

## 11. Open — needs Afshaan before or during build

1. **Confirm the `po_required` column** in the §4 category table. *(Only remaining design question.)*
2. **Notifications.** The channel is being retired, so requesters lose their ambient feed. In-app only
   matches the S314 Pitstop posture — but ⚠️ **that decision is explicitly Pitstop-scoped**, so it
   should not be assumed to generalise. Recommendation: in-app for v1 (Mahesh works a queue; the
   requester has My Requests), and decide on email/Slack once adoption is real.
3. **Onboarding the 13 requesters without Snorkel access** (§2b) — a shipping prerequisite, and a
   people task rather than a build one.

### Answered 2026-08-26 — closed, do not re-raise

- ~~Always-approve categories?~~ **No.** Meta invoices are always large; the threshold holds the line.
- ~~Priya has no login?~~ **Wrong — my error.** She has an auth user (created 2026-06-16, last
  sign-in 2026-08-14) **and** the Snorkel `finance_manager` role. What is actually null is the link
  from her Podium employee record (EMP-060) to that auth user, which affects Podium only and is
  irrelevant here because approval routes on a Snorkel permission, not the Podium manager chain.
  Logged separately as a small Podium data gap.
- ~~Foreign currency?~~ **Editable per request, INR the default everywhere** (§3).
