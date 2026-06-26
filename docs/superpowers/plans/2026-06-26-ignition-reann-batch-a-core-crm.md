# Ignition Reann Batch A (core CRM) — Implementation Plan

> **For agentic workers:** execute task-by-task. LOT has no unit-test harness; "verify" = a live Supabase query / worker curl / authenticated browser smoke. Sequence: migration → worker (edit→commit→push→`wrangler deploy`) → app (commit→push, auto-deploys) → verify.

**Goal:** Ship the 8 non-Shopify items of Reann's Batch A in Ignition (campaigns pick/manage/analysis, delete deal, mandatory rating-at-Completed, multi-product deals, POC dropdown, mandatory order-ID-at-Shipped, multi-stage filter, delete 4 test deals).

**Architecture:** Additive on the `ignition` schema + ignitionops + apps/ignition. Multi-product via a child table `engagement_products` whose per-product cost rolls up into the engagement's existing cost columns so the GENERATED `total_cost` + all reports stay correct untouched; the first line mirrors into `engagements.product_code/variant` for single-product back-compat.

**Tech Stack:** Supabase Postgres, Cloudflare Worker (ignitionops, vanilla JS + PostgREST), Next.js static-export (apps/ignition).

**Spec:** `docs/superpowers/specs/2026-06-26-ignition-reann-batch-a-core-crm-design.md`

---

## Task 1: Migration `ignition_reann_batch_a_v1`
- [ ] 1a. `CREATE TABLE ignition.engagement_products` (id uuid pk default gen_random_uuid(); engagement_id uuid NOT NULL REFERENCES ignition.engagements(id) ON DELETE CASCADE; product_code text NOT NULL; product_variant text; quantity int NOT NULL DEFAULT 1; goodies_cost numeric; shipping_cost numeric; sort_order int DEFAULT 0; created_at timestamptz DEFAULT now()); index on engagement_id; `ENABLE ROW LEVEL SECURITY`; `GRANT ALL … TO service_role`.
- [ ] 1b. `ALTER TABLE ignition.engagements ADD COLUMN poc_user_id uuid, ADD COLUMN poc_name text;`
- [ ] 1c. Verify: `get_advisors(security)` shows only the expected "RLS enabled no policy" for the new table; columns present.

## Task 2: ignitionops worker
**File:** `05_Throttle/ignitionops-worker/src/index.js`
- [ ] 2a. Add `poc_user_id`,`poc_name` to `ENGAGEMENT_FIELDS`.
- [ ] 2b. Add helper `rollupEngagementProducts(env, engagement_id)`: read lines ordered by sort_order; PATCH engagement `goodies_cost`=Σ, `shipping_cost`=Σ, `product_code`/`product_variant`=first line (if any lines). Single source of the rollup.
- [ ] 2c. `createEngagement`: after insert, if `body.products` is a non-empty array, insert lines (sort_order by index) then `rollupEngagementProducts`.
- [ ] 2d. New POST `setEngagementProducts({engagement_id, products[]})` (gate `ignition_manage`): delete existing lines for the engagement, insert the new set, rollup. Add to POST_ACTIONS.
- [ ] 2e. `getEngagement`: include `products` (select from engagement_products order sort_order; if none, synthesize one line from the engagement's product_code/variant/goodies_cost so the UI always has ≥1 row).
- [ ] 2f. New POST `deleteEngagement({engagement_id})` (gate `ignition_manage`): 404 if missing; 409 if any `ignition.payments` row references it ("has payments — cancel/close instead"); else NULL `discount_codes.engagement_id` pointing at it, delete the engagement (children cascade), return ok. Add to POST_ACTIONS.
- [ ] 2g. New POST `deleteCampaign({campaign_id})` (gate `ignition_manage`): 409 if any engagement has that campaign_id (count in message); else delete; add to POST_ACTIONS. Ensure `getCampaigns` rollup payload includes `agreed_total`.
- [ ] 2h. `advanceStage`: add guard — `to_stage==='completed'` requires the influencer `quality_rating` ∈ {green,yellow,red}; if unrated and `body.rating` provided, apply it (set influencers.quality_rating) before advancing; else 422 `rating_required_for_completed`. (Need the engagement's influencer_id — extend the cur select to include `influencer_id`.) And `to_stage==='shipped'` requires non-empty `shipping_order_id` (existing on row or `body.shipping_order_id`); else 422 `shipping_order_id_required_for_shipped`.
- [ ] 2i. New GET `getIgnitionUsers`: roles set = `store.roles` where `permissions->>'ignition_view'='true'`; then `store.users_profile?active=eq.true&role=in.(…)&select=id,full_name` → `[{id,full_name}]`. Add to GET_ACTIONS.
- [ ] 2j. `getEngagements`: accept `stages` param (comma list) → `stage=in.(…)`; keep single `stage`.
- [ ] 2k. `node --input-type=module --check`; commit; push; `cd …/ignitionops-worker && npx wrangler deploy`.
- [ ] 2l. Verify via curl (no JWT path won't work for gated actions; rely on syntax + a public read where possible) + code review; confirm deploy version printed.

## Task 3: apps/ignition frontend
**Files:** `apps/ignition/src/app/(auth)/engagements/{new,detail}/…`, `campaigns/…`, `engagements/page.js`, lib as needed.
- [ ] 3a. New Deal + engagement detail: multi-row product picker (product→variant from `getCatalogs`, qty, goodies cost). Submit via `createEngagement` `products[]`; edit via `setEngagementProducts`. Render lines + rolled cost on detail. Legacy single-product deals show their one synthesized line.
- [ ] 3b. New Deal: POC dropdown from `getIgnitionUsers` (sets `poc_user_id`+`poc_name`); show POC on detail.
- [ ] 3c. `/campaigns`: add Create + Delete (delete surfaces the linked-engagement 409); add a cross-campaign **Spend vs Budget** table (campaign, agreed_total, spend, videos, views, orders) from `getCampaigns` rollups.
- [ ] 3d. Engagement detail: Delete-deal button (confirm; surfaces has-payments refusal).
- [ ] 3e. Stage advance UI: surface the `rating_required_for_completed` / `shipping_order_id_required_for_shipped` 422s with an inline prompt (mirror the existing go-live video-link prompt).
- [ ] 3f. Engagements page: multi-select stage filter (chips) → `stages`.
- [ ] 3g. `npx turbo build --filter=ignition` green; commit; push (auto-deploys).

## Task 4: Data op #10
- [ ] 4a. Snapshot → `ignition.safety_test_deals_del_20260626` (CREATE TABLE AS SELECT the 4 rows + their children). Delete `IGN-2026-00147/148/149/150` (children cascade). Verify gone.

## Task 5: Verify + close
- [ ] 5a. Authenticated browser smoke (documented pending if no JWT): create a multi-product deal, set POC, manage campaigns + analysis, delete a deal, mandatory-rating/order-id guards, multi-stage filter.
- [ ] 5b. Update systems/ignition.md (engagement_products, poc cols, new actions, campaign analysis, guards) + BACKLOG (Batch A shipped; B/C remain). Reply Reann's #bugs thread `1782392242.217249` when browser-verified.

## Self-review
- Spec coverage: #1(2g,3c) #2(2f,3d) #3(2h,3e) #4(1a,2b-2e,3a) #5(1b,2i,3b) #7(2h,3e) #10(4a) #11(2j,3f). All 8 covered.
- Naming consistent: `engagement_products`, `rollupEngagementProducts`, `setEngagementProducts`, `deleteEngagement`, `deleteCampaign`, `getIgnitionUsers`, `poc_user_id`/`poc_name`, `stages`.
- No placeholders; each task names files + concrete change + verify.
