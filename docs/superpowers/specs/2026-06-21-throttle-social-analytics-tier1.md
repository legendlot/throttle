# Throttle Social — Tier 1: Analytics + Reconciliation (spec)
> Drafted Session 161 (2026-06-21). Status: scoped, not yet built.
> Owner system: Throttle (`apps/throttle` + `throttleops` + `brand` schema).
> Depends on: the live Instagram access established in S161 (Meta app "Pitstop messaging",
> @legendoftoys IGAA token). See systems/pitstop.md "Meta DMs" + RESUME POINT.

## Goal

Turn Throttle's social module from a **manual planning calendar** (draft → approve → tick
"published" by hand, no metrics) into a **closed loop**: pull what @legendoftoys actually
published on Instagram + its real performance, auto-reconcile against the planned posts, and
surface a social performance dashboard. **All within the access we already hold — no new Meta
permission, no App Review.** (Publishing-from-Throttle and a comments console are Tiers 3/2,
backlogged.)

## What the current token already exposes (probed live S161, @legendoftoys)

Token = the IGAA Instagram-Login user token (`graph.instagram.com`), perms
`instagram_business_basic` + `manage_comments` + `manage_messages`. Confirmed working:

- **Profile** — `GET /me?fields=user_id,username,account_type,media_count,followers_count`
  → Creator account, 108 media, 64,266 followers.
- **Published media** — `GET /me/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count`
  (paged) → every post with engagement counts.
- **Per-media insights** — `GET /{media-id}/insights?metric=reach,saved,likes,comments,shares,total_interactions,views`
  (period=lifetime) → e.g. a reel reach 380, a carousel reach 3,739. (Metric availability varies
  by media_type — reels expose `views`/`plays`; pick per type, tolerate missing metrics.)
- **Account insights** — `GET /me/insights?metric=reach,profile_views,follower_count&period=day`
  → daily reach (270,631 / 156,486 on Jun 20/21), profile views, follower count.
  (`instagram_business_basic` includes insights read — no `manage_insights` needed on the IG-Login path.)

NB the API returns insight `title`/`description` in the account's locale (Kannada here) — ignore
them, key off `name`/`value`.

## Data model (additive, `brand` schema, service_role-only, RLS on)

1. **`brand.social_media`** — the canonical record of an actually-published IG post.
   - `ig_media_id text PRIMARY KEY` · `channel_id uuid → social_channels` · `media_type text`
     (IMAGE/VIDEO/CAROUSEL_ALBUM) · `permalink text` · `caption text` · `published_at timestamptz`
     (the IG `timestamp`) · `like_count int` · `comments_count int`
   - metrics: `reach int` · `saved int` · `shares int` · `total_interactions int` · `views int`
   - `metrics_raw jsonb` (full insight payload, forward-compat) · `last_synced_at timestamptz`
   - `matched_post_id uuid → social_posts.id NULL` (reconciliation link; NULL = unplanned/organic)
2. **`brand.social_account_metrics`** — daily account snapshot for trends.
   - `channel_id uuid` · `metric_date date` · `reach int` · `profile_views int` · `follower_count int`
   - UNIQUE `(channel_id, metric_date)` (idempotent upsert — re-pull a day = no-op).
3. **`brand.social_post_channels`** gains `external_media_id text NULL` — set when a planned
   channel-variant is matched to a real `social_media` row (the inverse pointer for the calendar).
   No other change to the existing planning tables.

Migration name suggestion: `social_analytics_tier1_v1`. Advisor-clean (RLS + grants on new tables).

## Worker (`throttleops`)

- **Secret:** set `META_IG_TOKEN` on `throttleops` (same IGAA token as csops — workers don't share
  secrets). Read-only use here.
- **`syncSocialInsights`** (cron + manual trigger): for the Instagram `social_channels` row →
  (a) page `/me/media` (cap pages, newest-first, stop when older than last sync), upsert
  `social_media`; (b) for each new/recent media, pull `/{id}/insights` (batch carefully — 50-subreq
  limit; cap to the N most-recent or those updated within a window); (c) pull `/me/insights` daily
  account metrics → upsert `social_account_metrics`. Idempotent (PK / unique upserts).
- **`reconcilePublished`** (runs inside the sync, or on demand): match each unmatched `social_media`
  row to a planned `social_posts` for the Instagram channel by **published_at within ±X h of
  `scheduled_date`+`scheduled_time`** (single best candidate); on match set
  `social_media.matched_post_id`, `social_post_channels.external_media_id`, and flip the
  post/channel status → `published` + stamp `published_at`. Unmatched media stay `matched_post_id
  NULL` → surface as "Posted (unplanned)". Never auto-create a `social_posts` (planning stays
  human-owned); reconciliation only links + marks-published.
- **`getSocialAnalytics`** (read): dashboard payload — follower/reach/profile-view series
  (`social_account_metrics`), top posts by reach/engagement, per-post metrics, planned-vs-posted
  counts. Gated `brand` read (same as `getSocialFeed`).
- **Cron:** add a **daily** trigger (the worker already has `crons = ["29 18 * * 3"]`; append a
  daily entry, e.g. `"17 2 * * *"` ≈ 07:47 IST) that runs `syncSocialInsights`.

### Token durability (REQUIRED — applies to Pitstop too)

The IGAA "Generate token" output is a **long-lived user token good for ~60 days**, refreshable via
`GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<tok>`
(token must be ≥24 h old and unexpired). **Without a refresh job it dies in ~60 days** and BOTH
Pitstop DMs and Throttle analytics break. Add a **monthly refresh cron** that refreshes the token
and writes the new value back (to a shared store both workers read, or to each worker's secret via
a small ops step). **Decide token-home now:** simplest = each worker holds its own `META_IG_TOKEN`
and each refreshes; cleaner = one owner (csops) refreshes and stores the current token in a tiny
`brand`/`store` table the other reads. Flag for Pitstop regardless — its token has the same 60-day clock.

## Frontend (`apps/throttle` Social screen)

- **Calendar:** published days show real metric badges (reach · likes · comments) pulled from
  `social_media`; auto-detected `published` state (no more manual tick); "Posted (unplanned)"
  chips for organic posts with no plan.
- **New "Performance" view** (tab on the Social screen): follower-growth + reach trend lines
  (reuse the Volt/Recharts chart pattern — Throttle already has one), top-posts table (by reach /
  engagement, thumbnail + permalink), and a planned-vs-posted summary. Read via `getSocialAnalytics`.
- Graceful empty states until the first sync runs.

## Scope / non-goals

- **IG only.** LinkedIn + YouTube (the other two `social_channels`) are separate API projects (backlog).
- **No publishing** (Tier 3 — needs `instagram_business_content_publish` + App Review) and **no
  comments console** (Tier 2 — `manage_comments`). Both backlogged.
- Reconciliation **links + marks published**; it never authors or edits planning content.

## Open decisions before build

1. Token home + refresh ownership (see "Token durability").
2. Reconciliation match window (±X hours) + tie-break when multiple planned posts sit in-window.
3. How far back the first backfill pulls (all 108 media, or last 90 days).
4. Whether per-post insights sync for ALL media each run or only recent/changed (subrequest budget).
