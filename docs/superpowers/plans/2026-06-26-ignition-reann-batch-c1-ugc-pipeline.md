# Ignition Reann Batch C1 (UGC pipeline) — Implementation Plan

> **For agentic workers:** execute task-by-task. No unit-test harness; "verify" = live Supabase query / worker curl / authenticated browser smoke. Sequence: migration → worker (edit→commit→push→`wrangler deploy`) → app (commit→push auto-deploys) → verify.

**Goal:** A dedicated UGC pipeline in Ignition (UGC stages, summary dashboard, pipeline table, single scrolling detail card, payment/commission tracking, hook, tracking-link guard, brief-log) — reusing `ignition.engagements` (type=ugc). Meta auto-pull is the separate C2.

**Architecture:** Additive on `ignition.engagements` (UGC stage values + UGC columns) + a `ugc_briefs` log table; one `getUgcPipeline` read powers the dashboard+table; a dedicated `/ugc` + `/ugc/detail` UI with a UGC stage stepper. Ad-performance fields are manual-enterable now; C2 fills them from Meta.

**Tech Stack:** Supabase Postgres, Cloudflare Worker (ignitionops), Next.js static-export (apps/ignition).

**Spec:** `docs/superpowers/specs/2026-06-26-ignition-reann-batch-c1-ugc-pipeline-design.md`

---

## Task 1: Migration `ignition_ugc_pipeline_v1`
- [ ] 1a. Swap `engagements_stage_check` → union incl. UGC stages: `DROP CONSTRAINT engagements_stage_check; ADD CONSTRAINT … CHECK (stage IN ('planning','agreed','shipped','delivered','scheduled','posting','live','completed','delayed','on_hold','ghosted','dropped','outreach','draft','paused','vault','retired'))`.
- [ ] 1b. Swap `engagements_closed_reason_check` → add `retired`: `CHECK (closed_reason IN ('completed','ghosted','declined','dropped','historical_import','retired'))`.
- [ ] 1c. `ALTER TABLE ignition.engagements ADD COLUMN IF NOT EXISTS` for: `hook_version text, hook_script text, meta_ad_id text, live_at timestamptz, tracking_url text, creator_fee_status text, creator_fee_paid_date date, is_barter boolean, commission_rate numeric, commission_earned numeric, commission_paid numeric, ctr numeric, frequency numeric, purchases int`.
- [ ] 1d. `CREATE TABLE ignition.ugc_briefs (id uuid pk default gen_random_uuid(), engagement_id uuid NOT NULL REFERENCES ignition.engagements(id) ON DELETE CASCADE, body text, fields jsonb, created_by uuid, created_at timestamptz NOT NULL DEFAULT now())`; index on engagement_id; `ENABLE ROW LEVEL SECURITY`; `GRANT ALL … TO service_role`.
- [ ] 1e. Verify: `UPDATE … SET stage='vault'` on a throwaway check (or just confirm constraint def); advisors clean for ugc_briefs (RLS-no-policy expected).

## Task 2: ignitionops worker
**File:** `05_Throttle/ignitionops-worker/src/index.js`
- [ ] 2a. Add to `ENGAGEMENT_FIELDS`: `hook_version, hook_script, meta_ad_id, tracking_url, creator_fee_status, creator_fee_paid_date, is_barter, commission_rate, commission_earned, commission_paid, ctr, frequency, purchases`. (NOT `live_at` — worker-stamped only.)
- [ ] 2b. Add UGC stage consts near `STAGES`: `const UGC_STAGES=['outreach','agreed','shipped','delivered','draft','live','paused','vault','retired','dropped'];` and add `'retired'` to the existing `TERMINAL` set (so terminal stamping fires); `retired`→`closed_reason='retired'` in advanceStage (extend the TERMINAL_FAIL-style mapping: if to_stage==='retired' set closed_reason='retired').
- [ ] 2c. `advanceStage`: extend cur-select to `stage,video_link,shipping_order_id,influencer_id,engagement_type,live_at,tracking_url`. Add: when `to_stage==='live'` and `!cur.live_at`, include `live_at: nowIso()` in patch. When `engagement_type==='ugc'` and `to_stage==='shipped'`: require non-empty `tracking_url` (existing or `body.tracking_url`) else 422 `tracking_url_required_for_shipped` (skip the shipping_order_id guard for ugc — guard only applies to non-ugc). Ensure `retired` terminal closed_reason mapping is applied.
- [ ] 2d. New GET `getUgcPipeline`: fetch `engagements?engagement_type=eq.ugc&select=*,influencer:influencer_id(channel_name,person_name,channel_link,channel_platform,follower_count,contact_number)&limit=1000`. Build `summary` {active_creatives (stage not in retired/dropped), month_ad_spend, month_revenue (sum where live_at/post_date in current IST month), blended_roas (month_revenue/month_ad_spend or null), commissions_owed (Σ max(0, commission_earned−commission_paid)), by_stage} + `rows` [{id,engagement_no,creator_name,ig_handle,stage,roas (conversions_value/ad_spend),ad_spend,revenue (conversions_value),days_active (floor((now−live_at)/86400e3) if stage active+live_at else null),amount_owed (unpaid fee=(creator_fee_status!=='paid'? payment_amount:0) + max(0,commission_earned−commission_paid))}]. Coerce numerics with Number(). Add to GET_ACTIONS. Gate via existing ignition_view.
- [ ] 2e. New POST `generateUgcBrief({engagement_id})` (gate ignition_manage): load engagement+influencer+products(engagement_products); render `body` (a templated brief string incl. creator, product list, creator fee, commission rate, hook_version/hook_script options, posting requirements) + `fields` snapshot; insert `ugc_briefs` row (created_by=auth.userId); return {brief}. Add to POST_ACTIONS.
- [ ] 2f. `getEngagement`: add a `ugc_briefs?engagement_id=eq.X&order=created_at.desc` fetch to the Promise.all; return `ugc_briefs` in payload.
- [ ] 2g. `node --input-type=module --check`; commit; push; `cd …/ignitionops-worker && npx wrangler deploy`.

## Task 3: apps/ignition frontend
**Files:** create `apps/ignition/src/lib/ugcStages.js`, `apps/ignition/src/app/(auth)/ugc/detail/page.js`; modify `ugc/page.js`.
- [ ] 3a. `lib/ugcStages.js`: `UGC_STAGE_VALUES`, `UGC_STAGE_LABELS` (Outreach/Agreed/Shipped/Delivered/Draft received/Live/Paused/Vault/Retired/Dropped), `UGC_STAGE_PALETTE`, `UGC_HAPPY_PATH = ['outreach','agreed','shipped','delivered','draft','live']`, and `roasTone(roas)` → 'good'(>4)/'warn'(>=3)/'bad'(<3)/'' (null).
- [ ] 3b. `/ugc` rebuild: dashboard cards (active creatives · month ad spend · blended ROAS · month revenue · commissions owed · per-stage chips) + table (creator, IG handle, stage badge, ROAS colour via roasTone, ad spend, revenue, days active, amount owed) from `getUgcPipeline`; stage filter chips; rows → `/ugc/detail/?id=`.
- [ ] 3c. `/ugc/detail?id=`: single scrolling card — sections Creator / Deal / Product (Batch A `products`) / Hook / Ad performance / Payment; UGC stage stepper (ugcStages, free transitions via `advanceStage`); edit fields via `updateEngagement` (hook_version/script, meta_ad_id, fee status/date, is_barter, commission_rate/earned/paid, ctr/frequency/purchases, ad_spend, conversions_value, tracking_url); **Generate Brief** button → `generateUgcBrief` then show rendered body + list `ugc_briefs` with timestamps. Surface `tracking_url_required_for_shipped` + `video_link_required_for_live` 422s inline on advance.
- [ ] 3d. `npx turbo build --filter=ignition` green; commit; push.

## Task 4: Verify + docs
- [ ] 4a. Authenticated browser smoke: create a ugc deal; advance Outreach→Agreed→Shipped (tracking link enforced)→Delivered→Draft→Live (video link enforced, live_at stamped, days-active counts); Vault then back to Live (reopen); Retired (terminal). Dashboard tiles + table ROAS colours; Generate Brief logs a timestamped entry.
- [ ] 4b. Update systems/ignition.md (UGC pipeline section: stages, columns, ugc_briefs, getUgcPipeline/generateUgcBrief) + BACKLOG (C1 shipped, C2 next).

## Self-review
- Spec coverage: #1(1a,2b,3a-c) #2(1c,2c,3c) #3(2d,3b) #4(2d,3b) #5(3a,3b) #6(1c,3c) #7(reused Batch A) #9(2b,2c,3c) #10(1c,2a,3c) #11(1d,2e,2f,3c). #8→C2.
- Naming: `getUgcPipeline`, `generateUgcBrief`, `ugc_briefs`, `live_at`, `tracking_url`, `roasTone`, `UGC_STAGES`/`UGC_STAGE_VALUES` — consistent.
- No placeholders; each step has the concrete change + verify.
