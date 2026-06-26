# Ignition — Reann Batch C1 (dedicated UGC pipeline) design

> Design spec · 2026-06-26 (Session 177)
> Status: approved design (decisions locked via brainstorming), pre-implementation
> Systems touched: Ignition (ignitionops + apps/ignition), `ignition` schema
> Source: Reann's #bugs message `1782433531.017199` (Jun 26), 11 items — UGC pipeline

## Scope

Batch C = a dedicated UGC pipeline. Split into **C1 (this spec)** = everything buildable without the
Meta integration, and **C2 (next spec)** = the Meta Marketing API daily auto-pull (#8). C1 covers
items #1,2,3,4,5,6,7,9,10,11; C2 covers #8 (and wires auto-fed ad metrics into the dashboard/table/card
that C1 builds with manual-enterable fields).

**Decisions (brainstorming, Afshaan):**
- **Data home:** reuse `ignition.engagements` with `engagement_type='ugc'` + a UGC stage set + UGC
  columns. Reuses payments, multi-product lines (Batch A), Shopify, attachments. The "separate
  pipeline" is a UX separation (its own page/stepper/dashboard), not separate tables.
- **Meta pull:** daily cron on ignitionops reusing `META_SYSTEM_USER_TOKEN` — **C2**.
- **Brief (#11):** C1 generates + logs the brief (paper trail); email *send* is Batch B.
- **Phasing:** C1 now, C2 right after.

## Item coverage (C1)
| # | Item | Where |
|---|---|---|
| 1 | Dedicated UGC pipeline + stages (Outreach→Agreed→Shipped→Delivered→Draft→Live→Paused→Vault/Retired; Dropped exit) | stage set + stepper |
| 2 | Mandatory tracking link at Shipped, visible on card | `tracking_url` + advanceStage guard |
| 3 | UGC summary dashboard | `getUgcPipeline` |
| 4 | Pipeline table columns | `getUgcPipeline` rows + `/ugc` |
| 5 | ROAS colour code (green>4 / yellow 3–4 / red<3) | shared display helper |
| 6 | Single scrolling detail card | `/ugc/detail` |
| 7 | Mandatory video link at Live | **already enforced** (Batch A advanceStage) — reused |
| 9 | Vault (reopenable) vs Retired (permanent) | stage semantics |
| 10 | Payment + commission tracking (manual) | engagement cols + UI |
| 11 | UGC brief + contract (generate + log) | `ugc_briefs` + `generateUgcBrief` |

(#8 Meta auto-pull → C2.)

## Data model (migration `ignition_ugc_pipeline_v1`)

### `ignition.engagements` — stage/closed_reason CHECK expansion
- Stage CHECK becomes the **union**: existing `planning,agreed,shipped,delivered,scheduled,posting,live,completed,delayed,on_hold,ghosted,dropped` **+ `outreach,draft,paused,vault,retired`**. (Free-transition model unchanged; the UI picks the stage set by `engagement_type`.)
- `closed_reason` CHECK adds `retired`.

### `ignition.engagements` — new columns (all nullable, additive)
| Column | Type | Purpose |
|---|---|---|
| `hook_version` | text | hook script label (A/B/C) (#6) |
| `hook_script` | text | the hook copy (#6/#11) |
| `meta_ad_id` | text | entered at Live; consumed by C2 (#8) |
| `live_at` | timestamptz | stamped when stage first → live; drives "days active" (#4) |
| `tracking_url` | text | shipping tracking link (#2) |
| `creator_fee_status` | text | `pending`\|`paid` (#10) |
| `creator_fee_paid_date` | date | (#10) |
| `is_barter` | boolean | (#6/#10) |
| `commission_rate` | numeric | % (#10) |
| `commission_earned` | numeric | manual (#10) |
| `commission_paid` | numeric | manual (#10) |
| `ctr` | numeric | Meta (C2 fills; manual now) (#6) |
| `frequency` | numeric | Meta (C2) (#6) |
| `purchases` | int | Meta (C2) (#6) |

Creator fee = existing `payment_amount`; revenue = existing `conversions_value`; ad spend = existing
`ad_spend`. **Commission outstanding** = `commission_earned − commission_paid` (computed, never stored).
**ROAS** = `conversions_value / ad_spend` (computed). All added to `ENGAGEMENT_FIELDS`.

### `ignition.ugc_briefs` (NEW)
`id uuid PK`, `engagement_id uuid NOT NULL FK→engagements ON DELETE CASCADE`, `body text` (rendered
brief), `fields jsonb` (the auto-populated snapshot: creator/product/fee/commission/hook/posting),
`created_by uuid`, `created_at timestamptz DEFAULT now()`. RLS on, `GRANT ALL … TO service_role`.
Index on `engagement_id`. This is the paper trail; Batch B's email-send will read the latest brief.

## Worker (ignitionops)

- **Stages:** `UGC_STAGES = ['outreach','agreed','shipped','delivered','draft','live','paused','vault','retired','dropped']`; `UGC_TERMINAL = {retired, dropped}` (vault/paused are non-terminal holds). Add `retired` to the `TERMINAL` set used by `advanceStage` stamping; `retired` → `closed_reason='retired'`. Transitions stay free (any→any).
- **`advanceStage` additions:** stamp `live_at = now()` when moving to `live` and `live_at` is null. For `engagement_type==='ugc'`, require a non-empty `tracking_url` (existing or inline) when moving to `shipped` (#2) → 422 `tracking_url_required_for_shipped` (the Batch A `shipping_order_id` guard stays for non-ugc). (Video-link-at-Live #7 already enforced.) Extend the cur-select with `engagement_type,live_at,tracking_url`.
- **`getUgcPipeline` (GET):** loads `engagement_type=eq.ugc` engagements (+ influencer embed) and returns:
  - `summary`: `active_creatives` (non-terminal, i.e. not retired/dropped), `month_ad_spend`, `month_revenue` (this IST month, by `live_at`/`post_date`), `blended_roas` (= month_revenue/month_ad_spend), `commissions_owed` (Σ `commission_earned − commission_paid`), `by_stage` ({stage: count}).
  - `rows`: per deal `{ id, engagement_no, creator_name, ig_handle, stage, roas, ad_spend, revenue, days_active (today − live_at, null if not live), amount_owed (unpaid creator fee + commission outstanding) }`.
  - One read + JS aggregation (mirrors `getReports`). Gate `ignition_view`.
- **`generateUgcBrief` (POST, `{engagement_id}`, gate `ignition_manage`):** load engagement + influencer + product lines + hook + fee/commission; render a brief body (template) + a `fields` snapshot; insert a `ugc_briefs` row; return `{brief}`. Idempotent-friendly (each call logs a new timestamped version — that's the paper trail).
- **`getEngagement`:** already returns `engagement.*` (UGC cols ride along) + Batch A `products`; add `ugc_briefs` (latest-first) to the payload.
- New fields flow through `ENGAGEMENT_FIELDS` (so create/update/advance handle them).

## Frontend (apps/ignition)
- **`src/lib/ugcStages.js`** — `UGC_STAGE_VALUES/LABELS/PALETTE/HAPPY_PATH` + `roasTone(roas)` (green>4/yellow≥3/red<3) shared helper.
- **`/ugc` (rebuild):** top dashboard cards (active creatives · month ad spend · blended ROAS · month revenue · commissions owed · per-stage counts) + the pipeline table (creator, IG handle, stage badge, ROAS colour-coded, ad spend, revenue, days active, amount owed) from `getUgcPipeline`; stage filter; rows → `/ugc/detail?id=`.
- **`/ugc/detail?id=`:** single scrolling card with sections **Creator** (name, IG handle, phone, platform, follower count) · **Deal** (creator fee, commission rate, amount owed) · **Product** (Batch A product lines) · **Hook** (version + script) · **Ad performance** (spend, revenue, ROAS, CTR, frequency — editable now, auto in C2) · **Payment** (fee status/date, commission earned/paid/outstanding, barter). UGC stage stepper (uses `ugcStages`). **Generate Brief** button → `generateUgcBrief`, shows the rendered brief + lists logged briefs with timestamps. Edit controls save via `updateEngagement` / `setEngagementProducts`. Advance surfaces the `tracking_url_required_for_shipped` + existing video-link 422s inline.
- Nav: the existing `UGC` item now points at the rebuilt pipeline (no nav change needed).

## Non-goals (C1)
- Meta auto-pull (#8) → C2 (the ad-performance fields are manual-enterable until then).
- Emailing the brief → Batch B (C1 logs it as the paper trail).
- Per-product video metrics (deal-level, per Batch A).

## Build sequence
1. Migration `ignition_ugc_pipeline_v1` (stage/closed_reason CHECK swap + cols + ugc_briefs + RLS/grants). Verify advisors + CHECK accepts a UGC stage.
2. ignitionops: ENGAGEMENT_FIELDS; UGC stage consts; advanceStage (live_at, ugc tracking_url guard, retired terminal); getUgcPipeline; generateUgcBrief; getEngagement briefs. Deploy.
3. apps/ignition: ugcStages lib; `/ugc` dashboard+table; `/ugc/detail` card+stepper+brief+edit. Build green; deploy.
4. Browser smoke (authenticated): create a ugc deal, walk Outreach→…→Live (tracking link + video link enforced), Vault↔Live reopen, Retired terminal; dashboard + table + ROAS colours; generate a brief (logged). Then C2.
