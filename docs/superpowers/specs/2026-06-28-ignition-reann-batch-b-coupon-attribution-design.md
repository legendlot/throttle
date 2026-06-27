# Ignition — Reann Batch B theme ② · Coupon + attribution + goodies pricing design

> Design spec · 2026-06-28 (Session 181)
> Status: approved (decisions locked in chat), pre-implementation
> Systems touched: Ignition (ignitionops + apps/ignition), `ignition` schema, Shopify custom app
> Source: Reann's Ignition messages — B `1782426076.945029` (#1, #9) + A `1782392242.217249` (#8, #9)

## Goal
Turn Ignition into the system of record for influencer **discount codes** and the **revenue they
drive**, and stop showing ₹0 goodies cost on barter deals. Three problems, one theme:

- **A#9** — a code used on Shopify never flips to "used" in Ignition (no reconciliation).
- **B#1** — codes should be auto-generated per creator and synced to Shopify so redemptions attribute back.
- **A#8 / B#9** — goodies cost shows ₹0 because it's read off the (100%-off, ₹0) order; it must come from
  the product's list **price**, not the order.

## The core reframe — there are TWO code types, not one
Reann's "coupon code" is really two different objects with different lifecycles. Do not merge them.

| | **Gifting code (Code 1)** | **Affiliate code (Code 2)** |
|---|---|---|
| Who uses it | Internal team, ordering the product **for** the creator | The creator's **audience** |
| Discount | 100% off, **single-use** | Negotiated %, **multi-use** |
| Granularity | **Per deal** (engagement) | **Per video** (engagement) |
| Lifetime | Dies after the one gifted order | Lives until **retired** (open-ended) |
| Commission | None (it's a gift) | Accrues **only while the engagement is active**, net of refunds |
| Counts as affiliate revenue | **No** — must stay out of `conversions_value` | **Yes** |

Both are 1:1 with an **engagement** (Ignition's per-video unit), so renegotiation is handled by the
unit itself: a new video = a new engagement = a new code at the new %, while old videos keep their
frozen economics forever. Influencer-level totals are just `SUM` across that influencer's engagements.

### Key simplification (locked)
The code **string does not encode IDs**. Attribution comes from a stored `code → engagement` mapping,
not from parsing the string. So codes are **human-friendly vanity strings** (`REANNLOT`, `REANNLOT2`…)
*and* give exact influencer-video granularity via the lookup. Embedding `IN0198-V12`-style identifiers
buys nothing the mapping doesn't already give and hurts audience usability.

## Locked decisions (Afshaan, in chat)
1. **Shopify scope:** add `write_discounts` + `read_products` to the custom app (we already have
   read_orders / read_customers). Code ships gated; auto-create lights up once the scope is live —
   same pattern as the Meta token. Until then: graceful no-op + assign-from-pool fallback.
2. **Goodies price source:** **cache** Shopify variant prices into `ignition.product_prices`; auto-fill
   from there. (Live lookup and a hand-maintained table were rejected.)
3. **Commission accrues only while the engagement is active** — a redemption earns commission **only if
   its order date falls in the engagement's active window**. After the engagement deactivates, the code
   may still be live and still **attribute revenue**, but commission = 0.
4. **Codes are retirable** and in practice every code is eventually killed — so the redemption sync only
   runs over still-live codes (self-pruning, not infinite).

### "Active window" mechanism
Stamp two dates on the engagement rather than re-deriving stage transitions each sync:
- `affiliate_active_from` = `live_at` (already stamped when the video goes live).
- `affiliate_active_to` = set when the engagement leaves the active state (completed / paused / vault /
  retired / dropped); cleared if it re-opens to live.
- A redemption earns commission iff `order_date ∈ [affiliate_active_from, affiliate_active_to)`
  (open-ended while `affiliate_active_to IS NULL`). **Revenue** attributes regardless, until the **code**
  is retired. (Open Q below: should paused/vault still earn commission? Default = no.)

## Data model (migration `ignition_coupon_attribution_v1`)

### `ignition.coupon_codes` (NEW — the code registry; supersedes the generic pool for new deals)
One row per issued code. Both types live here, distinguished by `kind`.
- `id uuid pk`
- `code text unique` — the Shopify code string (vanity, uppercased)
- `kind text check in ('gift','affiliate')`
- `engagement_id uuid` → `ignition.engagements(id)` (the video/deal it's tagged to)
- `influencer_id uuid` → `ignition.influencers(id)` (denormalised for fast rollups)
- `discount_pct numeric` — 100 for gift; negotiated % for affiliate (frozen at issue)
- `shopify_discount_gid text` — the `discountCodeNode` GID returned by create (for deactivate)
- `status text check in ('active','retired') default 'active'`
- `usage_limit int` — 1 for gift, null (unlimited) for affiliate
- `redemptions int default 0`, `attributed_revenue numeric default 0`,
  `attributed_revenue_net numeric default 0`, `commission_accrued numeric default 0`
  (rollup caches refreshed by the sync; raw rows live in `coupon_redemptions`)
- `created_by uuid`, `created_at timestamptz`, `retired_at timestamptz`, `last_synced_at timestamptz`
- RLS on; `grant all … to service_role`.

### `ignition.coupon_redemptions` (NEW — one row per Shopify order that used a code)
The grain that makes attribution auditable and refund-aware. Idempotent on the Shopify order id.
- `id uuid pk`
- `coupon_code_id uuid` → `coupon_codes(id)` on delete cascade
- `shopify_order_id text`, `shopify_order_name text` (e.g. `#LOT39291`)
- `order_date timestamptz` (the order's createdAt — drives the commission window check)
- `gross_value numeric`, `net_value numeric` (gross − refunds), `refunded boolean default false`
- `commission_eligible boolean`, `commission_amount numeric`
- `synced_at timestamptz`
- `unique (coupon_code_id, shopify_order_id)` — re-sync is a no-op / update, never a duplicate.
- RLS on; service_role only.

### `ignition.product_prices` (NEW — the goodies-cost catalogue, Half B)
- `sku text primary key`, `title text`, `price numeric`, `currency text`, `synced_at timestamptz`
- Populated by a Shopify `read_products` sweep. RLS on; service_role only.

### `ignition.engagements` — additive columns
- `affiliate_active_from date`, `affiliate_active_to date` (the commission window; from/to as above).
- (Commission fields `commission_rate` / `commission_earned` / `commission_paid` already exist from C1
  and are reused — `commission_earned` is the rollup of `coupon_redemptions.commission_amount`.)

> The legacy `ignition.discount_codes` pool (1,000 generic codes) is **left as-is** for historical
> deals and as the fallback when auto-create is unavailable. New deals use `coupon_codes`. No wipe.

## Shopify integration (ignitionops — extend the existing custom-app client)
Reuse `getShopifyToken` (client-credentials) + the GraphQL endpoint already in the worker. Three new calls:

- **Create** (`discountCodeBasicCreate`): on issuing a code — title = the Ignition code, `customerGets`
  = percentage (100 for gift, negotiated for affiliate), `usageLimit` (1 for gift, null for affiliate),
  `appliesOncePerCustomer` (true for gift), optional `items` restriction to the gifted product's
  variant. Store the returned `codeDiscountNode` GID on `coupon_codes.shopify_discount_gid`. Needs
  **`write_discounts`**.
- **Deactivate** (`discountCodeDeactivate`): on retire — flip the Shopify discount off, set
  `coupon_codes.status='retired'` + `retired_at`. History preserved (redemptions stay).
- **Read redemptions:** query `orders(query:"discount_code:<CODE>")` for each **active** code —
  `name, createdAt, currentTotalPriceSet, totalRefundedSet, discountCodes`. Needs **read_orders**
  (already have). Used by the sync below.
- **Read products** (`products`/`productVariants`, paginated): the price-cache sweep. Needs
  **`read_products`**.

**Inert without the scope:** if a create/deactivate returns an access-scope error, the worker logs it,
leaves the code in a `pending_shopify` state (code reserved in our DB, not yet on Shopify), and the
fallback path (assign-from-pool / manual creation) is offered. Mirrors every other gated LOT connector.

## Worker actions (ignitionops)
**POST**
- `issueCoupon ({engagement_id, kind, discount_pct?})` — gate `ignition_manage`. Mints the vanity code
  (`slug(person/channel) + 'LOT'`, deduped with a numeric suffix), inserts `coupon_codes`, calls Shopify
  create, returns the row. For `kind='gift'` defaults pct=100, usage_limit=1.
- `retireCoupon ({coupon_code_id})` — gate `ignition_manage`. Shopify deactivate + mark retired.
- `syncCouponRedemptions ({coupon_code_id?})` — gate `ignition_manage`. On-demand reconcile (one code,
  or all active if omitted). Same logic as the cron (below).
- `refreshProductPrices ()` — gate `ignition_manage`. Run the Shopify product price sweep into
  `product_prices` (also runs on a slow cron).

**GET**
- `getCouponsForEngagement ({engagement_id})` — codes + redemption summary for the deal card.
- `getProductPrice ({sku})` — single price lookup for the New Deal goodies auto-fill (reads the cache).
- `getInfluencerAttribution ({influencer_id})` — SUM of net attributed revenue + commission across the
  influencer's engagements' codes (the "how much did this creator drive" number).

**Cron / scheduled()** (needs a `wrangler.toml` triggers entry — separate go-ahead per the no-toml rule):
- `syncCouponRedemptions()` daily — for every **active** `coupon_codes` row (oldest `last_synced_at`
  first, capped per run for the 50-subrequest budget; drains over days, logs deferrals):
  1. Read Shopify orders using that code since `last_synced_at` (watermark).
  2. Upsert `coupon_redemptions` (idempotent on order id); set `net_value = gross − refunds`,
     `refunded` when fully refunded.
  3. `commission_eligible = order_date ∈ active window`; `commission_amount =
     commission_eligible ? net_value × engagement.commission_rate : 0`.
  4. Refresh the `coupon_codes` rollups + `engagements.commission_earned` + `conversions_value`
     (net attributed revenue). **Gift codes never touch `conversions_value`.**
- `refreshProductPrices()` weekly (cheap, low churn).

## Frontend (apps/ignition)
- **New Deal / engagement detail:** when a product is picked, call `getProductPrice(sku)` → prefill
  `goodies_cost` (editable; falls back to manual/₹0 if the SKU isn't in the cache). Fixes A#8/B#9.
- **Engagement detail — "Codes" card:** shows the gift + affiliate code(s), each with status,
  redemptions, net attributed revenue, commission accrued. Buttons: **Issue affiliate code**, **Issue
  gift code**, **Retire**, **Sync redemptions**. The affiliate code string is shown big for the team to
  hand to the creator / put on the video.
- **Influencer detail:** a "Business driven" line = `getInfluencerAttribution` (Σ net revenue + Σ
  commission across all their videos). Reann's "how much has this creator sent me" number.
- **Discount-codes page:** keep the pool view; add the new `coupon_codes` registry (filter by
  kind/status, search by code/creator).

## Edge cases / watch-outs (carry into build + the team note)
1. **Code leakage to coupon sites** inflates a video's attribution and pays commission on sales the
   creator didn't drive. Mitigations: less-guessable codes (suffix), a `commission_cap` per engagement
   (optional), and an anomaly flag when a dormant code spikes. (Inherent to code attribution, not this
   model.)
2. **Refund clawback:** the sync recomputes `net_value` on every pass, so a later refund reduces revenue
   **and** commission automatically. Don't compute commission off gross.
3. **Overlap with Odo:** every affiliate order is also in Odo's Website sell-out. Ignition attribution is
   a **lens on Shopify orders, not additive revenue** — never sum influencer-driven + website revenue.
4. **Gift exclusion:** the 100%-off gift order must never land in `conversions_value` or affiliate
   rollups (enforced by `kind` separation).
5. **Operational discipline:** per-video attribution requires a **distinct code actually used in each
   video**. The system generates per-video codes; it can't force the creator to use the right one. If a
   creator reuses one code across videos, granularity blurs to the code.
6. **Commission window edges:** re-opening a closed engagement clears `affiliate_active_to`; a paused/
   vault UGC defaults to **no** commission accrual (open Q).

## Permissions
All new POST actions gate on the existing **`ignition_manage`**. No new permission key. Reports/rollup
reads are `ignition_view`. (If issuing/retiring live Shopify codes should be tighter than general manage,
introduce `ignition_coupon_manage` — flag for Afshaan; default reuses `ignition_manage`.)

## Build order
1. Migration `ignition_coupon_attribution_v1` (all tables + engagement columns).
2. `product_prices` cache + `refreshProductPrices` + New-Deal goodies auto-fill (**Half B — ships fully
   now**, only needs read_products).
3. Redemption sync + `coupon_redemptions` + rollups (**fixes A#9 now** — read-only, no write scope).
4. `issueCoupon` / `retireCoupon` + Shopify create/deactivate (**gated on `write_discounts`**;
   fallback to pool/manual until the scope is live).
5. Frontend: Codes card, goodies auto-fill, influencer "business driven", registry on the codes page.
6. Cron triggers (`wrangler.toml`) — separate go-ahead.

## Non-goals (v1)
- Per-customer / per-region affiliate analytics (just per-code/per-video/per-influencer rollups).
- Combined-discount stacking (assume one code per order — Shopify default).
- Auto-negotiation or auto-% logic — the % is entered by the team per engagement.
- WhatsApp/email delivery of the code (that's theme ① — Relay).

## Open questions — RESOLVED (Afshaan, S181)
1. Paused/vault UGC — commission accrues while parked? → **No.** Commission accrues only while the
   engagement is in `live` (active window); paused/vault sets `affiliate_active_to`.
2. Tighter perm for issuing/retiring live Shopify codes? → **No — reuse `ignition_manage`.**
3. `commission_cap` per engagement to bound leakage? → **Deferred** (not in v1). Tracked as a BACKLOG
   follow-up to revisit once leakage is observed in practice.
