# Odo — Checkout & Payment Funnel (Phase 1: Razorpay payment funnel)

> Design spec. Session S185 (2026-06-29). Author: Afshaan + Claude.
> Backlog: NEW — Odo on-site funnel depth. Phase 1 of a provider-agnostic checkout-funnel domain.
> Decided in brainstorming: **provider-agnostic, Razorpay adapter now, Shopflo later**; **Phase 1 = payment funnel** (Razorpay Payments API, pull). Phase 2 (abandoned-cart webhook + recovery) is a separate spec.

## Problem

Odo's `/funnel` shows a GA4 aggregate funnel — **Sessions → Add-to-cart → Checkout (begin) → Purchase**
(`sales.traffic_fact`). It is accurate at the top (June: GA4 purchases 4,511 vs actual Shopify
orders 4,046, ~11% GA4 over-count) but **coarse and blind at the bottom**: 15-month data shows
**159k begin-checkouts → 34.9k purchases = only 22% completion**, and Odo has zero visibility into
*why* the other 78% drop. That drop happens inside the **Razorpay Magic Checkout** overlay, which
GA4 cannot instrument. The business needs the payment-level funnel: how many payments are attempted,
how many **fail and why** (OTP, insufficient funds, method), and the success rate — the actual
money-leak diagnostics.

## What exists (reused, unchanged)
- **GA4 funnel** — `sales.traffic_fact` + `/funnel` page. Stays the top of funnel.
- **Shopify orders** — `sales.stg_orders` / `sales.sales_fact` (Website channel). The purchase truth,
  used for reconciliation and to source **COD** orders (which have no captured online payment).
- **Connector framework** — adapters (`fetch`/`stage`/optional `recompute`), per-connector
  `ConnectorWorkflow`, hourly cron, `connector_config` (cursor/config), `is_sale=false` synthetic
  channels invisible to the sales UI (`getBootstrap` filters `is_sale=true`).

## Capability findings (Razorpay, confirmed from docs)
- **Payments API** (`GET /v1/payments?from&to&count&skip`, Basic auth `key_id:key_secret`) returns
  per payment: `id`, `status` (created/authorized/**captured**/**failed**/refunded), `method`
  (upi/card/netbanking/wallet/**cod**), `error_code`, `error_reason` (e.g. `incorrect_otp`),
  `error_source`/`error_step`, `amount` (paise), `currency`, `order_id`, `created_at` (unix). → the
  payment funnel. **Pull-based, API keys only.**
- **Abandoned-cart webhook** (rich: contact, items, amount, UTM, abandon-URL; no step/no timestamp;
  webhook-only, no fetch API) → **Phase 2**, not this spec.
- **Intra-checkout micro-steps** (viewed → contact → address) are **dashboard-only** (no API) →
  out of scope; the funnel's checkout section is payment-attempt-onward.
- Razorpay standard API keys are **full-access** (no read-only scoping); we use them for GET only.

## Approach (provider-agnostic, pull-based)

A new **`razorpay_payments`** adapter on a new `is_sale=false` synthetic channel
("Razorpay Payments"), polling the Payments API on the existing cron, staging normalized payment
rows into a **provider-keyed** table. A rollup RPC reads staging directly (volume is low — same
precedent as `stg_orders`/`f_order_rollup`, no materialized fact). A new `/funnel` section renders the
payment funnel + failure breakdown + a tri-source reconciliation. Shopflo later = a second adapter
writing the same table; the RPC + UI are unchanged.

## Data flow
```
Razorpay Payments API (pull, windowed, cron)
  → stg_payments (provider × payment_id, normalized status/method/error/amount)
  → f_payment_funnel(from,to,provider?)  [reads staging directly]
  → getPaymentFunnel → /funnel "Checkout & payment" section
reconciliation: traffic_fact (GA4 purchases) ⟷ stg_orders (Shopify orders, incl. COD) ⟷ stg_payments (captured)
```

## Data model

### `sales.stg_payments` (NEW, provider-agnostic)
| column | type | note |
|---|---|---|
| `id` | bigint identity PK | |
| `run_id` | bigint | |
| `channel_id` | uuid | synthetic Razorpay-Payments channel |
| `provider` | text | `'razorpay'` (→ `'shopflo'` later) |
| `provider_payment_id` | text | Razorpay `pay_…` id |
| `order_ref` | text | Razorpay `order_id` |
| `status` | text | created/authorized/captured/failed/refunded |
| `method` | text | upi/card/netbanking/wallet/cod/null |
| `error_code` | text | null unless failed |
| `error_reason` | text | e.g. `incorrect_otp` |
| `amount` | numeric | ₹ (paise ÷ 100) |
| `currency` | text | |
| `created_at` | timestamptz | from unix `created_at` |
| `raw` | jsonb | full payment object |
| `ingested_at` | timestamptz default now() | |

**UNIQUE `(provider, provider_payment_id)`** — idempotent upsert (status can advance
created→captured across pulls; re-pull overwrites). RLS on, `GRANT ALL … TO service_role`.
Index `(provider, created_at)`.

### RPC `sales.f_payment_funnel(p_from date, p_to date, p_provider text default 'razorpay')`
Reads `stg_payments` over `[from,to]` (by `created_at` IST day), returns ONE row:
- `attempts` (distinct payment attempts), `captured`, `failed`, `authorized_uncaptured`,
- `success_rate` (captured / attempts),
- `captured_amount`, `failed_amount`,
- `by_method` jsonb (`{upi:{attempts,captured,failed}, card:{…}, …}`),
- `by_failure_reason` jsonb (`{incorrect_otp:N, payment_failed:N, …}` over failed rows).
`SECURITY DEFINER`, `EXECUTE TO service_role`. (One JSON-returning row keeps the worker/UI simple;
volumes are small.)

## Worker (`odoops-worker/src/index.js`)
- **`getRazorpayToken`-style Basic auth header** = `Basic base64(KEY_ID:KEY_SECRET)` from secrets
  `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.
- **`razorpay_payments` adapter** — `fetch` pulls `GET /v1/payments?from={unix}&to={unix}&count=100&skip=N`
  paginated (Razorpay caps `count` at 100; page via `skip` until `<100` returned), windowed backward
  like the ads adapters (cursor = last `created_at`; backfill from `backfill_start`). `stage` upserts
  into `stg_payments?on_conflict=provider,provider_payment_id`. **No `recompute`** (RPC reads staging
  directly) — but it still needs the connector framework to treat it like a stage-only connector
  (confirm `executeRun` handles an adapter with `stage` and no `recompute`/`datesOf`; if the framework
  requires `recompute`, provide a no-op that returns `{factsUpserted:0}`).
- **GET `getPaymentFunnel`** (`from`,`to`,`provider?`) — `canView`-gated — returns
  `f_payment_funnel` row + reconciliation counts (GA4 purchases from `f_traffic_rollup`/`traffic_fact`,
  Shopify orders from `stg_orders` Website non-cancelled split prepaid vs COD, captured payments from
  the funnel). Shape: `{ funnel, recon:{ ga4_purchases, shopify_orders, shopify_cod, razorpay_captured } }`.
- **Diagnostic `razorpayProbe`** (`canConnector`-gated) — fetch 1 page of recent payments, return
  count + sampled fields (confirm field names + that Live keys work) before relying on staging.
- **Secrets:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (Basic auth). No `wrangler.toml` change
  (rides the existing `ConnectorWorkflow`).
- **Channel/config seed (SQL, not migration):** `dispatch_channels` synthetic `is_sale=false`
  "Razorpay Payments" + `connector_config` (`adapter_kind='razorpay_payments'`, `config={backfill_start}`,
  enabled once secrets are set).

## UI (`apps/odo/src/app/(auth)/funnel/page.js`)
New **"Checkout & payment"** card below the GA4 funnel (one `getPaymentFunnel` fetch):
- **Payment funnel mini-viz:** Attempts → Captured (+ Failed), with success-rate %.
- **Failure breakdown:** two small bar lists — by **reason** (`incorrect_otp`…) and by **method**
  (UPI/card/COD…) — the leak diagnostics.
- **Method split** of captured payments.
- **Reconciliation tile:** GA4 purchases ⟷ Shopify orders (prepaid + COD) ⟷ Razorpay captured —
  a tracking-confidence line; explains gaps (COD has no online capture; GA4 over-counts).
- Provider label ("Razorpay") so the swap to Shopflo is visible later.

## Semantics & edge cases
- **COD (important, India):** Magic Checkout COD orders fire `payment.pending` / have **no captured
  online payment** (captured on delivery). So **prepaid** funnel = Razorpay payments; **COD** orders
  come from Shopify orders (`method=COD`). The UI splits prepaid vs COD so COD isn't miscounted as a
  payment failure, and the reconciliation expects `shopify_orders ≈ razorpay_captured + shopify_cod`.
- **IST day grain** for `created_at` (`AT TIME ZONE 'Asia/Kolkata'`), consistent with the rest of Odo.
- **Idempotency:** upsert on `(provider, provider_payment_id)`; re-pulling a window overwrites
  (status advances). The RPC reads staging directly, so re-pulls never double-count.
- **Multiple attempts per order:** a shopper who fails then retries = 2 payment rows on one
  `order_ref` — correct for the *payment* funnel (attempts), distinct from the *order* count.
- **Amount unit:** Razorpay returns paise → ÷100 at stage time.

## Provider-agnostic seam (for Shopflo)
- `stg_payments.provider` + a provider-keyed adapter is the whole seam. Shopflo migration = add a
  `shopflo_payments` adapter (Shopflo orchestrates multiple PGs; its payment/attempt data comes from
  Shopflo's API/reporting) writing the same `stg_payments` shape, flip the active connector, set the
  UI provider label. `f_payment_funnel` already filters by provider. No schema/UI rebuild.

## Out of scope (Phase 2 / later specs)
Abandoned-cart webhook receiver + recovery list (Relay tie-in); intra-checkout micro-steps
(dashboard-only); settlement/fees; Shopflo adapter (until migration); refunds analytics beyond the
status enum.

## Migrations
- `odo_payment_funnel_v1` — `stg_payments` + RLS/grants/indexes + `f_payment_funnel`.
- Synthetic channel + connector_config seeded via SQL.

## Dependency (access — user provisions)
- **Razorpay Live API keys** (`key_id` + `key_secret`) → set as odoops secrets `RAZORPAY_KEY_ID` /
  `RAZORPAY_KEY_SECRET`. Required before live pull/verify. (No webhook needed for Phase 1.)

## Verification
1. `razorpayProbe` confirms Live keys work + field names; backfill_start within data history.
2. After a refresh: `stg_payments` populated; `f_payment_funnel` returns sane attempts/captured/failed
   with a believable success rate; `by_failure_reason`/`by_method` populated.
3. Reconciliation: `razorpay_captured + shopify_cod ≈ shopify_orders` for a clean month; GA4 purchases
   in the same ballpark (~within its known over-count).
4. `/funnel` renders the payment section + reconciliation; failure breakdown shows real reasons.
