# Ignition monthly affiliate commission (Reann #3) — plan

> S443, 2026-11-09. Source: `#bugs` `1793690997.941679` item 3. Status: **DRAFT — waiting on Afshaan's answers (§Questions).**
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
| Affiliate code net sales by month (IST, order date): Aug ₹3,00,102 (170 orders, 26 deals) · Sep ₹5,43,675 (277, 46) · Oct ₹5,23,475 (265, 36) · Nov to date ₹99,126. At 10% ≈ **₹50,000 / month across ~40 deals**. | live SQL |
| No per-month rollup, no verification, no D2C role anywhere. D2C lead is Mohit Jain (`reference/decisions.md` S306). Returns: refunds already net per order; RTO lives in Odo (`sync_rto_returns`), not in Ignition. | reader |
| `CodesCard.js:114` shows affiliate codes as tracking-only, deliberately without a commission figure. | |

## Design

1. **One rate: `affiliate_pct`.** The commission formula reads `affiliate_pct`; `commission_rate` is retired (left in place, never read). Required on every new or edited `affiliate` / `paid_plus_affiliate` deal (worker + form), as Reann asked. The one affiliate deal without it is listed for the team.
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

## Questions for Afshaan (recommendation first)

1. **What counts as "net sales"?** (a) Shopify order value after the code's discount, minus refunds, **excluding GST** (recommended: commission on our revenue, not on tax); (b) the same including GST; (c) gross before discount.
2. **From which month?** (a) **From November 2026 onwards** (recommended: no surprise back-pay; Aug–Oct can be added later as a one-off if you choose); (b) backfill Aug–Oct (≈ ₹1.37 L at 10%) as statements to verify.
3. **Who verifies (D2C)?** (a) **Mohit Jain + admins** (recommended, Mohit is the D2C lead); (b) name the people.
4. **Who raises the payment after verification?** (a) **Automatic**: verifying creates the request, waiting for the creator's invoice (recommended — one less step, and D2C's number goes straight to Snorkel); (b) the deal owner presses Raise.
5. **Small amounts:** (a) **Pay any verified amount above ₹0** (recommended for now — simplest; revisit if Finance gets many tiny requests); (b) carry forward until a month reaches ₹500.

Not a question, a flag: Snorkel needs a creator invoice for every request (#2's rule). Monthly commission means a monthly invoice per creator. If that turns out impractical for creators, the fallback is a LOT-generated self-billing invoice — a separate decision, not in this plan.
