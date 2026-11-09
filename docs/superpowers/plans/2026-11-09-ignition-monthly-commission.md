# Ignition monthly affiliate commission (Reann #3) — plan

> S443, 2026-11-09. Source: `#bugs` `1793690997.941679` item 3. Status: **APPROVED 2026-11-09 — Afshaan took every recommendation (§Decisions). S1 SHIPPED (0008 live); S2 SHIPPED (worker `b299acdb`); S3 SHIPPED (app `c2c4cffb`); S4 (manual + first real verify, from 1 Dec) next.**
> Builds on #2 (`2026-11-09-ignition-snorkel-payment-requests.md`): commission is paid through the same
> Ignition → Snorkel request path, contract-collected bank details and invoice rule.

## Goal (Reann's words, condensed)

Commission % is required on affiliate deals. Each month Ignition works out commission = code net sales × %.
D2C checks it after returns and cancellations, enters the final amount and marks it Verified (name + date,
then locked). The Snorkel request uses the verified amount, not Ignition's estimate. The deal shows both
amounts and the reason for any difference.

## What exists today (measured 2026-11-09)

| Fact | Evidence |
|---|---|
| 79 affiliate-type deals (77 `affiliate`, 2 `paid_plus_affiliate`). 78 have `affiliate_pct`, **every one is 10**. | live SQL |
| The commission formula uses `engagements.commission_rate`, which is set on **0** of them, so every redemption's `commission_amount` is ₹0 and `coupon_codes.commission_accrued` sums to ₹0. `affiliate_pct` is never read by it. | `ignitionops-worker/src/index.js:3618-3636` |
| Attribution exists: `coupon_codes` (185 affiliate, 174 active, 0 stuck `pending_shopify`) + `coupon_redemptions` (per Shopify order: `order_date`, `gross_value`, `net_value` = gross − refunded, `refunded`, `commission_eligible` = inside the deal's window). Synced daily 08:40 IST + "Sync all" on Reports. | `index.js:3615-3660`, `systems/ignition.md:732` |
| Affiliate-CODE net sales: Aug ₹3,00,102 · Sep ₹5,43,675 · Oct ₹5,23,475. ⚠️ **Almost all of it is on BARTER (Oct ₹4,46,761, 28 deals) and PAID (₹73,726, 7 deals) deals — tracking codes, no commission %.** Affiliate-type deals sold **₹959 in October** (1 deal): commission today ≈ ₹96/month. It grows as the 73 not-yet-live affiliate deals (39 shipped, 22 planning, 11 delivered, 1 posting) go live. (Corrected 2026-11-09: the first draft said ≈ ₹50,000/month — it counted every affiliate code, not affiliate deals.) | live SQL |
| No per-month rollup, no verification, no D2C role anywhere. D2C lead is Mohit Jain (`reference/decisions.md` S306). Returns: refunds already net per order; RTO lives in Odo (`sync_rto_returns`), not in Ignition. | reader |
| `CodesCard.js:114` shows affiliate codes as tracking-only, deliberately without a commission figure. | |
| **Commission window** (S182): `affiliate_active_from` is set when the deal is advanced to Live; orders before it earn nothing (`couponInWindow`: no `from` = not eligible). All 6 live affiliate deals have it; the other 73 are not live yet. | `index.js:3262`, `:3537` |
| Money field: `net_value = totalPrice − totalRefunded` — Shopify `totalPriceSet` INCLUDES GST and shipping. | `index.js:3477-3488` |

## Design

1. **One rate: `affiliate_pct`.** The affiliate commission formula reads `affiliate_pct`. `commission_rate` stays for what still reads it — the UGC brief (`index.js:438`, `:1521`; `decisions.md` S313: UGC commission is a different, real thing) — the affiliate formula just stops using it. Required on every new or edited `affiliate` / `paid_plus_affiliate` deal (worker + form), as Reann asked. The one affiliate deal without it is listed for the team.
2. **`ignition.commission_statements`** — one row per (deal, month): `orders`, `net_sales`, `rate`, `estimate` (net_sales × rate), `verified_amount`, `difference_reason`, `verified_by` / `verified_by_name` / `verified_at`, `state` (estimated → verified → requested → paid; `nil` when the estimate is ₹0), `deal_payment_request_id`. Unique (engagement_id, month).
3. **Estimate is recomputed until verified.** A nightly job (after the 08:40 code sync) rebuilds the estimate for every month not yet verified, so late refunds lower it automatically. Once Verified it is frozen (a DB trigger refuses changes to a verified row, except the request link + state moving forward).
4. **D2C verifies.** New Ignition permission `ignition_commission_verify` (who holds it: Q3). A **Commission** page lists a month's statements (deal, creator, orders, net sales, estimate) with a Verify action per row: final amount + reason (reason required when it differs from the estimate). Name + date are stamped; the row locks. Bulk "verify at estimate" for rows that match.
5. **Paying it.** A verified statement becomes a `deal_payment_requests` row of new kind **`commission`** for the verified amount (the same path as #2: waits for the creator's invoice, Snorkel, status back, owner DM). Commission requests sit OUTSIDE the fee cap (`payment_amount`) and are capped at their statement's verified amount instead — one live request per statement. Who raises it: Q4.
6. **On the deal:** a Commission card — per month: orders, net sales, Ignition estimate, D2C verified amount, the reason, who verified and when, and the request's status.

## Slices (each: build → `/hostile-review` → commit → deploy → smoke)

| # | Slice | Size |
|---|---|---|
| S1 | Migration: `commission_statements`, verified-row lock trigger, `deal_payment_requests.kind` += `commission` + `statement_id` (CHECK widened in the same migration; enum-drift check on the feeder), permission `ignition_commission_verify`. | quick |
| S2 | ignitionops: formula on `affiliate_pct`; nightly statement rebuild + backfill of past months (Q2); `getCommissionStatements` / `verifyCommission` / `raiseCommissionPayment` (cap = verified amount, one live request per statement); `affiliate_pct` required on affiliate deals. Tests. | half-day |
| S3 | Ignition app: Commission page (D2C), deal-page Commission card, `affiliate_pct` required in the deal forms. | half-day |
| S4 | Manual (Ignition: commission chapter; Snorkel: commission requests) + live proof on one real month (D2C verifies a real statement; a ₹1 commission request round-trips, then deleted). | quick |

## Decisions (Afshaan, 2026-11-09 — took every recommendation)

1. **Net sales** = order value after the code's discount, minus refunds, **excluding GST** (and shipping: commission is on products). Needs a new ex-GST net per order from Shopify (`currentSubtotalPriceSet` less included tax) — S1 adds the column, S2 fills it.
2. **From November 2026.** No statement for an earlier month (DB check).
3. **Verifiers:** Mohit Jain + admins (`ignition_commission_verify`).
4. **Automatic raise:** verifying a non-zero amount creates the commission request, waiting for the creator's invoice.
5. **Pay any verified amount above ₹0.** A ₹0 verified month is closed with nothing to pay.

## Questions for Afshaan (as asked)

1. **What counts as "net sales"?** (a) Shopify order value after the code's discount, minus refunds, **excluding GST** (recommended: commission on our revenue, not on tax); (b) the same including GST; (c) gross before discount.
2. **From which month?** (a) **From November 2026 onwards** (recommended: no surprise back-pay; Aug–Oct can be added later as a one-off if you choose); (b) backfill Aug–Oct as statements to verify (corrected: affiliate deals sold ₹959 in Oct, so this is tiny).
3. **Who verifies (D2C)?** (a) **Mohit Jain + admins** (recommended, Mohit is the D2C lead); (b) name the people.
4. **Who raises the payment after verification?** (a) **Automatic**: verifying creates the request, waiting for the creator's invoice (recommended — one less step, and D2C's number goes straight to Snorkel); (b) the deal owner presses Raise.
5. **Small amounts:** (a) **Pay any verified amount above ₹0** (recommended for now — simplest; revisit if Finance gets many tiny requests); (b) carry forward until a month reaches ₹500.

Not a question, a flag: Snorkel needs a creator invoice for every request (#2's rule). Monthly commission means a monthly invoice per creator. If that turns out impractical for creators, the fallback is a LOT-generated self-billing invoice — a separate decision, not in this plan.

## S1 — as built (2026-11-09, migration `0008_commission_statements.sql`, applied as `ignition_0008_commission_statements`)

- `coupon_redemptions.net_ex_gst` (empty until S2's sync fills it).
- `ignition.commission_statements` (deal × IST month; Nov 2026 floor; UNIQUE (engagement_id, month)).
  Triggers: **month guard** — no future month, and verify only once the month is over
  (`commission_current_month()`, its own function so a rolled-back proof can move "now");
  **lock** — a verified row is frozen and undeletable, except a reopen (verified → estimated,
  verification cleared) while no request on it is live or paid.
- RPCs (service_role only): `verify_commission_statement(id, amount, reason, by, by_name)` verifies AND
  raises in one transaction (Decision 4; ₹0 raises nothing); `raise_commission_payment` (re-raise after a
  rejection/cancel); `reopen_commission_statement` (the correction path for a mistyped amount; S2 gates it
  to admins).
- `deal_payment_requests`: kind `commission` + `statement_id` (paired CHECK), one live request per
  statement; the fee sum, fee-cut trigger, per-kind exclusivity and **0007's hand-log guard** ignore
  commission. `deal_payment_refusal`'s commission branch judges against the statement (verified, amount ≤
  verified). `payments.kind` += `commission`.
- Roles: admin += `ignition_commission_verify`; new `ignition_commission_verifier` ("Commission verifier
  (D2C)", view + reports + verify). Mohit Jain moved to it from `ignition_viewer` (snapshot
  `store.safety_ignition_user_roles_mohit_2026_11_09`).
- Commission stays payable if the deal is cancelled later (sales were made) — no stage check, by design.
- Proof (live, rolled back): 22 checks — Oct + future month refused; verify in an open month refused;
  raise before verify refused; differing amount without reason refused; verify at estimate → ₹120 request
  waiting_for_invoice; verified edit / delete / reopen-while-live refused; double raise + double verify
  refused; refusal branch: = verified ok, > verified refused, other deal refused, no statement refused; fee
  committed = 0; hand log allowed next to a live commission request; cancel → reopen → re-verify ₹100 with
  reason → ₹100 request; ₹0 verify → no request; commission without a statement refused. Nothing persisted.
- Hostile review (opus): 8 findings — #1 correction path, #2 verify-before-month-end, #4 hand-log guard,
  #7b verify+raise atomic, #8 not-found guard fixed in 0008; the rest are the S2/S3 checklist below.

## S2/S3 checklist (from the S1 hostile review — must land)

- `deleteEngagement`: check `commission_statements` BEFORE any child delete — refuse if any are
  verified, delete estimated ones first (otherwise the FK fails after the children are gone).
- `addPayment` hand-log pre-check: ignore `kind='commission'` (the DB guard already does).
- Nightly rebuild: upsert only rows NOT verified (an ON CONFLICT hitting a verified row fires the lock and
  aborts the whole batch); skip the current month's verify, never its estimate.
- Verify goes through `verify_commission_statement` only (never PATCH + raise as two calls).
- `getDealPayments` `raised`/`remaining` and getEngagement's "₹X paid of ₹Y" exclude commission.
- `snorkelPaymentRow`: a commission payout is written as `payments.kind='commission'`, not `final`.
- `dealPaymentPayload` purpose carries the month (`… · commission 2026-11 · @handle`).
- `PaymentsCard.js:185`: "Raise full" hidden only by a live FEE request, not a commission one.
- S4 live proof needs a month that has ENDED → the first real verify is possible from 1 Dec 2026.

## S2 — as built (2026-11-09, throttle `b299acdb`, ignitionops version 16fb11b1)

- **Sync:** `coupon_redemptions.net_ex_gst` = `currentSubtotalPriceSet` less line GST when `taxesIncluded`
  (line GST = `currentTotalTaxSet` − shipping tax, shipping tax scaled by current/original shipping so a
  refunded shipping charge takes its tax with it). Fields checked live against the store. Per-order
  `commission_amount` = net_ex_gst × `affiliate_pct`, affiliate deal types only, **orders from Nov 2026
  IST only** (no back-dated rollups). `commission_rate` stays for UGC.
- **Rebuild** (`rebuildCommissionStatements`): after the 08:40 IST sync + admin POST. Skips verified
  months; creates a row only for a deal-month with orders; zeroes an existing estimate; removes only
  EMPTY estimates of deals no longer affiliate (a month with sales stays for D2C); paged reads; logs
  deal-months whose orders have no ex-GST value yet (`missing_net`).
- **Actions:** `getCommissionStatements` (?month= → verify or reports perm; ?engagement_id= → view;
  S3's deal card uses this), `verifyCommission` (one RPC; refused while any of the month's eligible
  orders lacks net_ex_gst; strict amount), `reopenCommission` (admin), `raiseCommissionPayment`
  (re-raise after reject/cancel), `rebuildCommissionStatements` (admin).
- `affiliate_pct` (0–100] required on affiliate deal types at create, update and advanceStage; a patch
  that does not change type/% saves (IGN-2026-00903 has none — list it for the team in S3).
- S1 checklist landed: deleteEngagement (statements first + re-check), hand-log pre-check, fee totals,
  payout kind `commission`, purpose with the month. Snorkel needed no change (it never receives kind).
- Reviews: hostile (7) + Codex gpt-6-astra (6), all fixed. Tests 279 + snorkelops 287.
- Live proof: synced HARIZPOPZEINLOT (barter) — 76/76 orders got net_ex_gst (ex/incl ratio 0.842),
  commission ₹0; rebuild → 81 affiliate deals, 0 written (no affiliate-type deal has a November order
  yet), 0 missing; list for 2026-11 → []; verify on a missing id → 404.
- Known limits: the sync re-reads the newest 150 orders of ACTIVE codes only, so a late refund on an old
  order or a retired code is not re-read — D2C's verification is the check. `commission_earned` /
  `commission_accrued` are all-time running figures, not "owed" (S3 copy must say so).

## S3 — as built (2026-11-09, throttle `c2c4cffb` + worker `2ea8a0b8` tds_amount)

- `/commission` (Analyze nav; `ignition_commission_verify` or `ignition_reports_view`): month picker from
  Nov 2026, statements table, Verify modal (reason required when it differs; raises the request), bulk
  verify at estimate (confirm names the month and the ₹0 rows), Re-raise, Reopen + Rebuild (admin).
  Paid shown GROSS (paid + TDS), like the Payments card.
- Deal page Commission card: affiliate deals, or any deal with commission history (a retyped deal keeps it).
- Affiliate % required on the new-deal page, New deal window and Deal terms edit (worker's rule + sentence).
- PaymentsCard: "Commission · <month>" labels, "Raise full" hidden only by a live FEE request, "Commission
  paid" line; a commission invoice is never pre-picked (Upload first).
- Hostile review: 7 findings fixed (month-switch race, invoice pre-pick, gross paid, bulk wording,
  retyped deals, stale state ×3). Build 0 errors, app tests 64/64.
- Smoke 2026-11-09: /commission renders (Nov 2026 running banner, empty state, admin Rebuild), 375px no
  page scroll; deal card renders on IGN-2026-00817. Nothing to verify until 1 Dec.
