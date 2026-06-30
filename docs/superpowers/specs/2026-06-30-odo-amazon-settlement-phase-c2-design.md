# Odo — Amazon Settlement (Phase C.2): true payout + marketplace fees → margin lens

> Spec for the `[odo] [P1] Phase C.2` backlog item. Builds on Phase C (S166, `stg_amazon_fin`).
> Date: 2026-06-30 (S186).

## Goal
Ingest the Amazon **settlement report** to surface, per the control-station charter, a *first-class
separate settlement fact*: **real per-order/SKU marketplace fees, true net payout, and a margin
(net-of-fees) lens** on `/amazon`.

## Scope of "margin" (v1)
Settlement gives **revenue − Amazon fees = the ₹ Amazon actually deposits** (contribution after
marketplace cost). It does NOT include COGS (landed cost + production) — that's the later P4
inventory/COGS layer. The settlement fact is built **COGS-ready** (a separate fact keyed by
product_code + date) so a future COGS join is additive, not a rebuild. v1 delivers: gross →
fee breakdown by category → net payout, take-rate %, and net-of-fees per SKU/model.

## Source: GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
- **Scheduled, not on-demand.** Amazon auto-generates one settlement report per disbursement
  (~14d). You cannot `createReport` it — you **list** already-generated reports and download new
  ones. Retrieval: `GET /reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&processingStatuses=DONE&pageSize=100`
  → for each `reportId` not yet ingested, GET the report → `reportDocumentId` → download doc
  (reuses `fetchAmazonDoc`, tab-delimited, may be GZIP). Track ingested **`settlement-id`s** in
  `connector_config.config.settlement_seen` (array) — idempotent, no re-ingest.
- **Flat-file V2 columns** (tab-delimited): `settlement-id, settlement-start-date,
  settlement-end-date, deposit-date, total-amount, currency, transaction-type, order-id,
  merchant-order-id, adjustment-id, shipment-id, marketplace-name, amount-type,
  amount-description, amount, fulfillment-id, posted-date, posted-date-time, order-item-code,
  merchant-order-item-id, merchant-adjustment-item-id, sku, quantity-purchased, promotion-id`.
  - **Header/summary row**: only `settlement-id` + dates + `total-amount` populated (the deposit).
  - **Detail rows**: `amount-type` (ItemPrice / ItemFees / Promotion / ItemWithheldTax / Cost of
    Advertising / FBA Inventory Fee / Other …) × `amount-description` (Principal / Tax / Commission /
    FBAPerUnitFulfillmentFee / Storage / RefundCommission / ShippingHB …) × signed `amount`.
  - Sign convention: revenue positive, fees/tax-withheld negative. **Net payout = Σ amount per
    settlement = the header `total-amount`** (our reconciliation check).

## Data model (migration `odo_amazon_settlement_v1`, `sales` schema, RLS-on, service_role)
- **`sales.stg_amazon_settlement`** — one row per flat-file detail line.
  `id, run_id, channel_id, settlement_id, posted_date date, deposit_date date, transaction_type,
   order_id, sku, amount_type, amount_description, amount numeric, quantity int, raw jsonb,
   ingested_at`. UNIQUE on `(settlement_id, order_id, sku, amount_type, amount_description, line_no)`
   (a `line_no` ordinal makes repeated identical fee lines distinct). Header rows stored with
   `transaction_type='--settlement--'` carrying `amount = total-amount`.
- **`sales.settlement_fact`** — the separate fact. Grain `(settlement_id, the_date, product_code)`.
  `the_date` = posted_date (IST). Cols: `principal, promo, tax_withheld, fee_commission,
   fee_fba, fee_storage, fee_refund, fee_other, fees_total (generated = sum of fee_*),
   net_amount (generated = principal+promo+tax_withheld+fees_total)`, plus `units`. Unknown
   amount-descriptions bucket into `fee_other`. Unmapped SKU → `product_code=''` residual (kept,
   not dropped — settlement must reconcile to the deposit). UNIQUE on grain.
- **`fee_category_map`** (small config table, seedable) — `amount_description → category`
  (commission/fba/storage/refund/other) so new fee descriptions are reclassified without a deploy
  (mirrors `amazon_return_reason_map`).

## RPCs
- `recompute_settlement(p_settlement_id text)` — delete+reinsert `settlement_fact` rows for that
  settlement from `stg_amazon_settlement` (idempotent; re-ingest is a no-op).
- `f_settlement_rollup(p_from date, p_to date, p_group text)` — `group ∈ {date, product, fee}`:
  by-date trend (gross/fees/net), by-product (net-of-fees per SKU/model via product_code), by-fee
  (fee category totals + take-rate).
- `f_settlement_recon(p_from, p_to)` — per settlement: header total vs Σ fact net_amount (must match);
  surfaces coverage (how much of the period is settled).

## Ingestion: settlement phase in `amazonAdapter`
A new phase (like the finance phase), gated to run when budget allows (reconciliation-grade —
every few ticks, not every tick). Own state in `connector_config.config`: `settlement_seen[]`.
List DONE settlement reports → for each new `settlement-id`, download + parse → stage →
`recompute_settlement`. Never throws into the orders pipeline (wrapped, like the finance phase).
NO new connector/channel — folds into the existing `amazon_spapi` connector (Amazon-FBA channel).

## UI — `/amazon` "Payout & fees" section (`apps/odo`, `AmazonPage.js`)
New block (below the existing orders/RTO/ads strips):
- KPI row: Gross (principal), Total fees, **Net payout**, Take-rate % (fees/gross), Settled coverage badge.
- Fee breakdown bar/table by category (Commission / FBA / Storage / Refunds / Other) with % of gross.
- Net-of-fees per **SKU/Model** (toggle, reuse `c2p`) — the margin-after-marketplace lens.
- Per-settlement reconciliation table (settlement-id, dates, deposit total, our net, ✓/✗ match).
Worker GET `getSettlement` → `{ rollup_by_date, rollup_by_product, rollup_by_fee, recon }`.
`sales_view`-gated (later `cost_view`/`margin_view` when the tiering lands).

## Out of scope (v1) / follow-ups
- COGS / true gross margin (P4 — Manifest landed cost + production COGS join onto `settlement_fact`).
- Other channels' settlement (Flipkart/QC payouts) — Amazon first; generalise the fact later.
- Ads spend is already in `mkt_fact`; if settlement carries "Cost of Advertising" deductions, keep
  them as a fee category here but DON'T double-count against `mkt_fact` ROAS (separate lens).

## Verify
First run = probe whether settlement reports exist for the account (list returns ≥1 DONE report).
Then: a settlement's header `total-amount` == Σ `settlement_fact.net_amount` (recon ✓); fee
categories sum to total fees; net payout sane vs gross (~12–18% take-rate typical for IN toys).
