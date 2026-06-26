# Ignition — Reann Batch A (core CRM) design

> Design spec · 2026-06-26 (Session 177)
> Status: approved design (decisions locked via brainstorming), pre-implementation
> Systems touched: Ignition (ignitionops + apps/ignition), `ignition` schema
> Source: Reann's #bugs message `1782392242.217249` (Jun 25), 11 items

## Scope

Batch A = the **non-Shopify-coupled** CRM items from Reann's 11-item list. Three items
(#6 Shopify lookup when shipping#≠contact#, #8 true product cost vs ₹0-from-100%-off, #9
coupon not flipping to "used") are **folded into Batch B** (the Shopify/coupon-sync pass) where
they're built coherently — confirmed with Afshaan. This spec covers the remaining 8:

| # | Item | Type |
|---|---|---|
| 1 | Campaign on a deal + add/delete campaigns + cross-campaign spend/budget view | feature |
| 2 | Delete a deal (human-error cleanup) | feature |
| 3 | Mandatory colour rating when moving to Completed | guard |
| 4 | Multiple products per deal | feature (child table) |
| 5 | POC dropdown (team member taking the collab forward) | feature |
| 7 | Mandatory Shopify order ID when moving to Shipped | guard |
| 10 | Delete 4 test deals IGN-2026-00147/148/149/150 | data op |
| 11 | Multi-stage filter on the engagements page | feature |

## Decisions (brainstorming, Afshaan)

- **#4 multi-product = full child rows** (`ignition.engagement_products`), per-product cost; but
  **video/engagement metrics stay deal-level** (one video features all products — views/likes/
  ROAS/CPM can't be split per product). Per-product cost rolls up into the engagement's existing
  cost columns so the generated `total_cost` and all reports stay correct untouched.
- **#1 "campaign type" = pick an existing campaign** (the deal's `campaign_id`, already exists) +
  add a manage-campaigns UI (create/delete) + a cross-campaign spend/budget analysis view. No new
  taxonomy.
- **#5 POC source = Ignition team users** (people on ignition-permissioned roles).
- **A/B split:** #6/#8/#9 → Batch B.

## Data model (migration `ignition_reann_batch_a_v1`)

### `ignition.engagement_products` (NEW)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | |
| `engagement_id` | uuid NOT NULL, FK→`ignition.engagements(id)` ON DELETE CASCADE | |
| `product_code` | text NOT NULL | |
| `product_variant` | text | |
| `quantity` | int NOT NULL DEFAULT 1 | |
| `goodies_cost` | numeric | per-product goods value |
| `shipping_cost` | numeric | per-product shipping (optional) |
| `sort_order` | int DEFAULT 0 | first = primary |
| `created_at` | timestamptz DEFAULT now() | |

RLS on, `GRANT ALL … TO service_role`. Index on `engagement_id`.

**Rollup invariant:** whenever the line set changes, the worker writes
`engagements.goodies_cost = Σ line.goodies_cost`, `engagements.shipping_cost = Σ line.shipping_cost`,
and `engagements.product_code/product_variant = first line (sort_order)`. This keeps the GENERATED
`engagements.total_cost` (`payment+commission+ad_spend+goodies+shipping+return`) and every existing
single-product reader/report correct with zero changes to them. Existing engagements keep their
single product on the engagement row; a line set is created lazily the first time products are
edited (back-filled from the engagement's current product_code as one line).

### `ignition.engagements` — new columns
- `poc_user_id uuid` (no hard FK — loose, mirrors other LOT cross-refs), `poc_name text`.
  Added to `ENGAGEMENT_FIELDS`.

## Worker changes (ignitionops)

- **#4** `createEngagement` accepts optional `products: [{product_code,product_variant,quantity,goodies_cost,shipping_cost}]`; inserts lines + runs the rollup. New `setEngagementProducts({engagement_id, products[]})` (replace-set, gate `ignition_manage`) → re-inserts lines + rollup. `getEngagement` returns `products[]` (lazily back-filled from the engagement's single product if no lines exist yet). A `rollupEngagementProducts(engagement_id)` helper is the single source of the sum/primary write.
- **#1** new `deleteCampaign({campaign_id})` (gate `ignition_manage`) — refuse 409 if any engagement has that `campaign_id` (message lists the count; detach first). `getCampaigns` already returns per-campaign rollups (spend/views/orders) — the analysis view consumes it; ensure it also returns `agreed_total` (budget) for the spend-vs-budget columns.
- **#2** new `deleteEngagement({engagement_id})` (gate `ignition_manage`) — load the engagement; **refuse 409 if it has any `ignition.payments` rows** ("has payments — cancel/close instead"); else delete (children `engagement_products`/`engagement_history`/`engagement_notes`/`engagement_attachments` cascade or are deleted explicitly) and NULL out any `discount_codes.engagement_id` pointing at it.
- **#3** `advanceStage`: when `to_stage==='completed'`, require the influencer's `quality_rating` ∈ {green,yellow,red} OR a `rating` passed in the same call (apply it via the existing setRating path) — else 422 `rating_required_for_completed`. Mirrors the existing `video_link_required_for_live` guard.
- **#5** new GET `getIgnitionUsers` — `store.users_profile` (active) whose `role` is in the set of `store.roles` carrying `ignition_view` → `[{id, full_name}]`. Drives the POC dropdown. `poc_user_id`/`poc_name` flow through `ENGAGEMENT_FIELDS`.
- **#7** `advanceStage`: when `to_stage==='shipped'`, require a non-empty `shipping_order_id` (existing or inline) — else 422 `shipping_order_id_required_for_shipped`. (No Shopify call — just mandates the value.)
- **#11** `getEngagements` accepts `stages` (comma-separated) → `stage=in.(a,b,c)`; existing single `stage` still honored.

## Frontend (apps/ignition)

- **New Deal form + engagement detail (#4):** a multi-row product picker (product → variant dropdowns from `getCatalogs`, qty, goodies cost) replacing the single product field; writes via `createEngagement` `products[]` / `setEngagementProducts`. Detail shows the product lines + the rolled-up cost. Keep it graceful for legacy single-product deals.
- **New Deal (#5):** POC dropdown from `getIgnitionUsers`.
- **#1:** create/delete on `/campaigns` (delete with the linked-engagement guard surfaced) + a cross-campaign **spend vs budget** table/section (columns: campaign, budget=`agreed_total`, spend, videos, views, orders) from `getCampaigns` rollups.
- **#2:** a Delete button on the engagement detail (confirm dialog; surfaces the has-payments refusal).
- **#3/#7:** the advance/stage UI surfaces the new 422 reasons (prompt for rating / order ID inline, mirroring how go-live prompts for the video link).
- **#11:** the engagements stage filter becomes multi-select (chips); sends `stages`.

## Data op (#10)
Delete the 4 test deals `IGN-2026-00147/148/149/150` (snapshot first → `ignition.safety_test_deals_del_20260626`). Reann-requested; uses the destructive-SQL gate.

## Non-goals (Batch A)
- Shopify/coupon items (#6/#8/#9) → Batch B.
- Per-product video metrics (deal-level only).
- No change to the generated `total_cost` or existing reports (rollup keeps them correct).

## Build sequence (for the plan)
1. Migration `ignition_reann_batch_a_v1` (engagement_products + poc cols + grants/RLS) + perm sanity.
2. ignitionops: rollup helper + multi-product create/get/set; deleteEngagement; deleteCampaign; getIgnitionUsers; advanceStage guards (#3/#7); getEngagements `stages`. Deploy.
3. apps/ignition: New Deal + detail product lines + POC; campaigns create/delete + analysis; delete-deal button; multi-stage filter; stage-guard prompts. Build green.
4. Data op #10 (snapshot + delete).
5. Browser smoke (authenticated) + close Reann's thread `1782392242.217249`.
