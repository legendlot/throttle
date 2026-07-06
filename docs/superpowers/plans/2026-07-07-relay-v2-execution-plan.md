# Relay v2 — Execution Plan (M8–M22)

> **Companion to:** `specs/2026-07-07-relay-v2-roadmap-prd.md` (the WHY + phase order). This doc is the HOW — per-milestone scope, schema, files, acceptance criteria. Written to be executable milestone-by-milestone by an agent or inline, in order, without re-reading the whole program each time.
> **Ground rules for every milestone (non-negotiable):**
> - Load `systems/relay.md` + this milestone's section before starting. Grep `reference/db-schema.md` before any SQL.
> - Migrations: `commsops-worker/migrations/NNNN_<name>.sql` (next free number), applied via Supabase `apply_migration`, idempotent (existence-guarded), RLS + `GRANT ALL … TO service_role` on every new table, new tables added to the PostgREST exposed list only if schema-new (comms already exposed).
> - Worker: edit → commit → push → `cd 05_Throttle/commsops-worker && npx wrangler deploy`. Never loop await per row (50-subrequest limit) — batch via RPCs/IN filters. All new channel code lives in `adapters/` only.
> - Idempotency: every send carries `dedupKey`; every ingested event carries `idempotency_key`; every Workflow step name is deterministic.
> - App: pages follow S174 conventions (`useAuth`, `garageFetch`/`workerFetch`, `@/components/ui.js`); build `npx turbo build --filter=relay` zero-error before commit; deploy = push to main (gh-pages workflow).
> - TEST MODE stays ON through every milestone except where M10 explicitly flips it.
> - After each milestone: update `systems/relay.md` + `BACKLOG.md`, commit both repos.

---

## Phase 1.5 — See & Ship

### M8 — Analytics layer (the render over data we already capture)

**Goal:** `/analytics` becomes real; campaigns + journeys get in-context stats; deliverability health per sender is visible. No new capture — pure derivation from `messages`, `events`, `enrolment_steps`, `enrolments`.

**Migration `0013_comms_analytics_rpcs.sql`** — SQL-side aggregation (never ship raw rows to the client):
- `campaign_stats(p_campaign_id uuid)` → one row: queued/sent/delivered/read/bounced/failed/suppressed/skipped counts (+ skipped-by-reason jsonb), clicks (join `events` `name='link_clicked'` on `properties->>message_id`), unsubscribes within window. Derive campaign membership from `messages.dedup_key LIKE 'campaign:<id>:%'` — **verify the actual dedup/source convention in `campaigns.js` first and key on whichever of `source`/`dedup_key` is canonical.**
- `journey_funnel(p_journey_id uuid, p_version int default null)` → per step_id: entered count, results breakdown (from `enrolment_steps`), plus enrolment totals by status. Grain = journey version (v1 vs v2 comparable).
- `sends_overview(p_days int)` → per day × channel × purpose: sent/delivered/failed/skipped (drives the overview chart).
- `deliverability_health(p_days int)` → per sender_identity: sent, bounce %, complaint % (Resend `email.complained` — **check webhooks.js captures it; add if missing**), opt-out %.
- `campaign_attribution(p_campaign_id uuid)` → last-touch v1: profiles with `link_clicked`/`read` for this campaign's messages AND `order_placed` within `settings.attribution_window_days` → attributed order count + revenue (sum `properties->>total` — verify the order_placed property shape in `shopify-webhooks.js`).
- Indexes to support these: `messages(profile_id, sent_at)`, `messages(dedup_key text_pattern_ops)` if LIKE-scanned, `events(name, occurred_at)` — **check existing indexes first** (some shipped in 0001).

**Worker (`index.js` GET actions):** `getCampaignStats`, `getJourneyFunnel`, `getSendsOverview`, `getDeliverabilityHealth`, `getCampaignAttribution` — thin RPC pass-throughs, `relay_view`-gated.

**App:**
- `/analytics` page: overview cards (30d sends/delivery rate/click rate/opt-outs), sends-by-day chart, campaign table (per-campaign stats + attribution), deliverability panel per sender.
- Campaign detail: stats panel replacing/joining the status poller (poll `getCampaignStats` while `sending`).
- Journeys page: per-journey funnel view (step list with entered/branch/sent counts, by version selector).

**Acceptance:** internal-test data (S187 56-staff broadcast + S178 journey runs) renders correctly; RPC latency <500ms on current volume; zero client-side aggregation over raw message rows; build clean; deployed live.

### M9 — Scheduler + operational hardening

**Goal:** scheduled campaigns actually fire; failures are dead-lettered + alerted; a warm-up send budget exists. This is the milestone that makes unattended operation safe.

**1. Cron + scheduled campaigns:**
- `wrangler.toml`: add `[triggers] crons = ["*/5 * * * *"]` (**wrangler.toml edit = get explicit permission first — standing rule**).
- `scheduled()` handler in `index.js`: sweep `campaigns?status=eq.approved&scheduled_at=lte.<now>` → for each, `CAMP.startCampaign(env, id, 'scheduler')`. Atomicity: `startCampaign` must transition approved→sending via **conditional PATCH** (`&status=eq.approved` in the filter) so a concurrent manual send can't double-fire — verify/add.
- UI: campaigns page shows scheduled state + "fires at" prominently; cancel-schedule action (PATCH `scheduled_at=null`), `campaign_build`-gated.

**2. Dead-letter queue:**
- `wrangler.toml`: `dead_letter_queue = "commsops-dlq"` on the consumer + a `[[queues.consumers]]` for `commsops-dlq`.
- Migration `0014_comms_queue_failures.sql`: `queue_failures(id, kind, body jsonb, error text, failed_at)` + RLS/grants.
- DLQ consumer: write the row, fire a Slack alert.

**3. Slack alerting:**
- New `src/alerts.js`: `alert(env, text)` → Slack incoming webhook (`SLACK_ALERT_WEBHOOK` secret, `wrangler secret put` — ask Afshaan to mint one for #system-updates or a new #relay-alerts).
- Wire: DLQ writes; cron sweep errors; and a 15-min cron branch computing failure/bounce spike (e.g. >10% failed of last 100 sends, or any `suppressed` complaint) → alert once per hour max (dedup via a settings/kv timestamp).

**4. Warm-up send budget (gate step ③b):**
- Migration `0015_comms_send_budget.sql`: `settings.daily_send_budget int null` (null = unlimited) + `settings.budget_used_date date` + `settings.budget_used_count int` (or a tiny `send_counters` table keyed by date — pick the table if PATCH-increment races matter; an RPC `consume_send_budget()` doing an atomic `UPDATE … RETURNING` is the clean shape).
- `gate.js`: after frequency cap, marketing-purpose sends consume budget; over budget → `{pass:false, reason:'budget_exhausted'}` (skipped row like all gate fails). Transactional/utility bypass.
- Admin settings UI: budget field beside test-mode panel, super-admin-gated.

**Acceptance:** a campaign with `scheduled_at` in the past + status approved sends within 5 min with no human action; a poisoned queue message lands in `queue_failures` + Slack; a marketing broadcast halts (visibly, with reason rows) at the budget and resumes next day; all deployed.

### M10 — Customer go-live (runbook milestone, small code)

**Goal:** first real customer sends, safely ramped. Blocked on **Afshaan's team-confirmed sign-off** — the runbook executes only after it.

**Pre-flight checklist (execute in order):**
1. M8 + M9 deployed + verified. `/ingest`-driven enrol smoke done (the S178 leg (c) — needs `INGEST_TOKEN` at hand).
2. `saveJourney` error-details passthrough fixed (S178 leg (b): `index.js` returns `err(r.error,400)` dropping compile `details` — pass through).
3. DMARC: review first Postmark weekly digests; keep `p=none` until ≥2 clean weeks (tighten to quarantine later, tracked not blocking).
4. Set `daily_send_budget` = 500. Choose the first real audience: highest-engagement segment (e.g. `lifetime_orders ≥ 2` + email opted-in), NOT the full 11.8k.
5. **Flip `test_mode` OFF** (super-admin, the deliberate act).
6. Activate the abandoned-cart journey (`setJourneyStatus active`) — low volume, transactional-adjacent, the ideal first real traffic.
7. Watch M8 deliverability panel + Slack alerts for 48h. Then first marketing broadcast to the small segment; ramp budget 500→2k→5k→null over ~2 weeks, gated on bounce <2% + complaint <0.1%.

**Acceptance:** abandoned-cart journey live with real enrolments + sends visible in analytics; first broadcast delivered with healthy rates; zero unexplained skips; `systems/relay.md` gate line updated (the internal-test gate is CLOSED/DONE at this point).

---

## Phase 2 — SMS

### M11 — Link tracking Phase B: first-party redirect (`/r/<code>`)

**Goal:** per-recipient click capture for channels with no ESP click tracking (SMS/WA), per the S189 deferral. Spec exists: `specs/2026-07-01-relay-link-tracking-utm-design.md` §Phase-B — follow it; deltas here.

- Migration `0016_comms_links.sql`: `links(id uuid, code text UNIQUE, message_id uuid, profile_id uuid, url text, context jsonb, created_at, click_count int default 0, last_clicked_at)`. Code = 7–8 char base62 from `gen_random_bytes` (collision-retry insert).
- `send.js`: for `channel in ('sms','whatsapp')` (email keeps Resend native), post-render wrap LOT-host links: mint a `links` row per (message, url) → replace with `https://go.legendoftoys.com/r/<code>`. UTM params go on the **destination** URL before wrapping (same `tagLinks`).
- Worker route `GET /r/<code>` (public): look up → 302 to url; async (ctx.waitUntil) bump click_count + write `events{name:'link_clicked', profile_id, properties:{url, channel, message_id, code}}` keyed `redirect:<code>:<ts-bucket-seconds>`. Unknown code → 302 to `legendoftoys.com`.
- Custom domain: route `go.legendoftoys.com/*` → commsops (Cloudflare dashboard/`wrangler.toml` route — permission gate applies) + DNS.
- Sequencing note: message must exist before body render (need message_id for the link row) — the dedup-reserve row in `send.js` already provides an id when `dedupKey` is set; for keyless sends mint the links row with `message_id=null` + backfill in `finalize`, or simply require dedupKey on SMS/WA sends (preferred — campaigns/journeys always have one).

**Acceptance:** unit tests on wrap/skip logic; a test SMS-shaped render produces working `/r/` links; click → 302 + one `link_clicked` event with profile attribution; email path unchanged (no wrapping).

### M12 — DLT + gateway workstream (external; start during Phase 1.5)

**Not a code milestone — a tracked checklist with Afshaan actions:**
1. Choose DLT operator portal (Airtel/Jio/Vi — pick whichever Trustsignal recommends for fastest header approval) and register **Principal Entity** (company KYC: GST, PAN, CIN — Afshaan provides).
2. Register a 6-char **header** (e.g. `LGDTOY` — propose options to Afshaan). Note: `7338402888` is NOT an SMS asset (numbers aren't senders in India A2P); it stays earmarked for WhatsApp Phase 3.
3. Trustsignal: direct account (not via Bitespeed), API key, DLT PE/header linkage, sandbox/test route confirmed. Fallback candidate if Trustsignal API disappoints: MSG91 (decision point, PRD §7.3).
4. Register the initial **template backlog** (marketing + transactional starters, ~5–10): draft with the marketing team; every template pre-registered with `{#var#}` slots. Keep a running registration doc in `docs/superpowers/specs/` as approvals land (template text ↔ dlt_template_id).
5. Capture in `sender_identities`: one SMS row (channel `sms`, address = header, provider `trustsignal`, metadata: `{entity_id, route, tps}`).

**Acceptance:** header approved + ≥3 templates DLT-approved + a successful test SMS via Trustsignal's console. Only then does M13's live leg run (M13 build proceeds in parallel against mocks).

### M13 — SMS adapter + provider-locked template model

**Goal:** SMS as a first-class channel behind the unchanged `send()` spine.

- **`adapters/sms.js`** (the second-ever adapter — its cleanliness proves the contract): `send(rendered, env)` → Trustsignal HTTP API (secrets `TRUSTSIGNAL_API_KEY` etc.), returns `{provider_message_id, status}`; `parseStatusWebhook(payload)` → canonical `sent/delivered/failed` mappings + reason codes. Register `sms: smsAdapter` in `send.js ADAPTERS`. Cost per SMS segment (160/70-char GSM/unicode calc) → `messages.cost`.
- **Render:** `render.js` grows `renderSms(template, ctx)` — template `content jsonb` = `{body, dlt_template_id, header}`; **positional slot mapping** (foundation §7.2): `variables` array maps slot index → source binding; validation = slot count must match the registered template (unresolved slot = throw, like email). Char-count + segment warning surfaced in the editor.
- **Gate:** channel rule step ⑤ for SMS: marketing purpose requires an approved `dlt_template_id`; quiet hours already central (DND alignment: keep 21:00–09:00; TRAI promo window is 10:00–21:00 — tighten `quiet_hours` for SMS marketing to 10–21 in the channel rule, not globally).
- **Webhook route:** `POST /webhooks/trustsignal` (public, verify per their signing scheme; if none, a URL token) → `parseStatusWebhook` → same status-update path as Resend.
- **`/r/` links:** SMS renders wrap links via M11 automatically (send.js channel check).
- **UI:** template editor SMS shape (body + slot binder + dlt id + live segment count); campaign/journey channel pickers un-hide `sms`; contacts detail shows sms consent (already modeled).
- **Consent seed:** decide + run the SMS-consent backfill (Shopify SMS marketing consent field where present; else `unknown` → SMS marketing unreachable until collected — reachable counts will show it honestly).

**Acceptance:** node unit tests (segment calc, slot binding, webhook parse); live test SMS to Afshaan through the full spine (TEST-MODE-style allowlist respected — extend `test_mode_allow` matching to phone entries **before** the first live SMS test); one SMS journey step + one small SMS broadcast run end-to-end; delivery statuses land on `messages`.

---

## Phase 3 — WhatsApp

> Foundation §11 is the authoritative WABA deep-dive (one-WABA-per-number, cutover mechanics, de-risking). Verify against CURRENT Meta docs at build time. Joint scheduling with Pitstop for M16.

### M14 — Cloud API adapter + template manager + 24h-window logic

- **`adapters/whatsapp.js`:** `send(rendered, env)` → Graph API `/<phone_number_id>/messages`; two modes: `template` (name/language/components from the rendered mapping) vs `text` (free-form — only valid inside the 24h window; the adapter enforces by requiring `rendered.window_open === true` for text mode). `parseStatusWebhook` → sent/delivered/read/failed + per-conversation cost from webhook pricing objects. `parseInbound(payload)` → normalized inbound (see below).
- **Window state:** migration `0017_comms_wa_windows.sql`: `wa_windows(identifier_value text PK, last_inbound_at timestamptz)` (tiny, hot). Inbound webhook upserts; `send()` for whatsapp+text checks `last_inbound_at > now()-24h`. Template sends skip the check.
- **Template manager:** `templates.content` WA shape `{meta_name, language, header, body, footer, buttons, mapping}`; worker actions `waSubmitTemplate` (Graph create), `waSyncTemplateStatus` (poll approval → `approval_status`); UI panel on templates page (submit + status badge). Positional mapping reuses the M13 slot binder.
- **Inbound seam:** `POST /webhooks/whatsapp` (Meta verify token + signature): status updates → messages; inbound customer messages → (1) upsert `wa_windows`, (2) emit `replied` event via ingest, (3) **forward payload to csops** (Pitstop inbox owns the conversation — token-authed internal POST; the Pitstop-side handler is Pitstop-session work, contract = the normalized `parseInbound` shape, agreed in a shared doc before M16).
- **Quality monitoring:** subscribe `message_template_status_update` + `phone_number_quality_update` → `sender_identities.metadata` + Slack alert on quality drop; render in the M8 deliverability panel.

**Acceptance:** all against the M15 test number — template send, free-form within window, window-block outside, inbound forward stub logged, statuses + cost on `messages`.

### M15 — WABA + test number + template pre-approval (external workstream; start with Phase 2)

Checklist: Meta Business verification confirmed → create WABA + app + system-user token (never-expiring) → register **test number** (candidate: `7338402888`) → display name approval → pre-register the production template backlog (marketing/utility categories; every currently-used Bitespeed WA template re-authored + submitted) → sandbox end-to-end with M14. Secrets: `WA_TOKEN`, `WA_PHONE_NUMBER_ID(s)`, `WA_VERIFY_TOKEN`, `WA_APP_SECRET`.

**Acceptance:** test number fully working on our WABA through Relay; production template set approved; cutover rehearsal doc written (per-number steps + rollback = re-migrate to Bitespeed).

### M16 — Per-number cutovers (marketing → transactional → support)

Per foundation §3/§11 ladder, one number at a time, scheduled windows:
1. **Marketing `9035697508`** (outbound-only, lowest risk): migrate into WABA → sender_identities row active → journeys/campaigns may select WA.
2. **Transactional `7022142666`**: same, plus re-point order/COD notification flows to Relay `/send`.
3. **Support `9880212323`** (highest care, rehearsed twice by now): joint Pitstop session — Pitstop's WA send re-points from Bitespeed API to Relay `/send` (channel `whatsapp`, purpose `transactional`/`utility` for agent replies — bypasses marketing gate, never suppression); inbound webhook → M14 forward seam → Pitstop inbox. Feature-flagged, shadow-verified, scheduled window, rollback ready.

**Acceptance per number:** first real message in/out on our WABA; quality rating stable ≥1 week before the next number.

### M17 — Bitespeed exit

Preconditions: all 3 numbers + SMS off Bitespeed AND Pitstop inbox covers everything Bitespeed's did (Pitstop's own checklist). Actions: final data export (conversation history archive), cancel subscription, remove `BITESPEED_*` drop-list plumbing from csops (Pitstop session), update `systems/pitstop.md` + `systems/relay.md` + memory (`project_cx_comms_platform` → done).

---

## Phase 4 — Orchestration depth

### M18 — Journey step depth

New step types in `journeys.js compile()` + `journey-workflow.js` interpreter (each = a validator clause + an interpreter branch; the generic-interpreter design absorbs them):
- `split` — `{type:'split', variants:[{id, weight, next}]}`; assignment = deterministic hash (enrolment_id + step id) mod 100 → weight buckets; logged in `enrolment_steps.result.variant`.
- `wait_until` — time-of-day/day-of-week aware wait (compute next occurrence in IST, `step.sleep` the delta).
- `wait_for_event` — check CF Workflows' current `step.waitForEvent` API at build time; if available, use it (+ an ingest-side `sendEvent` to the instance); else poll-loop shape (capped sleep+check cycles). This unlocks "wait up to 3 days for order_placed, else nudge".
- `segment` condition — `{kind:'in_segment', segment_id}` branch (RPC membership check; dynamic segments evaluated live via `eval_segment_node` on the single profile).
- `channel_fallback` send — try WA template; on gate-fail/no-identifier fall through to SMS then email (a send wrapper, one step, results logged per attempt).
- `goal` — `{type:'goal', event, within}` records conversion on the enrolment (`context.goal_met`) then continues/exits; feeds M8 funnel + per-journey conversion rate.
- UI: step builder grows the new types (list-form remains fine; canvas explicitly deferred).

**Acceptance:** compile() rejects malformed defs for each type; a test journey exercising split + wait_until + goal runs both branches correctly on the live Workflow runtime; funnel shows variant + goal columns.

### M19 — Campaign A/B + holdouts

- Migration `0018_comms_campaign_variants.sql`: `campaigns.variants jsonb null` (`[{id,label,template_id,vars,weight}]`) + `campaigns.holdout_pct numeric default 0`; `messages.variant text null`.
- Fan-out (`campaigns.js processQueueMessage`): per recipient, deterministic hash (profile_id + campaign_id) → holdout (write a `messages` row status `holdout`, no send) or variant → send with that template, `variant` recorded.
- Stats: `campaign_stats` grows a per-variant breakdown + holdout conversion baseline (attribution RPC compares variant vs holdout order rates — honest incrementality v1).
- UI: campaign builder variants editor (add variant = pick template + weight) + holdout % field (approver-visible); campaign detail renders the variant table + a plain-language winner line.

**Acceptance:** an internal A/B (2 variants + 10% holdout) fans out with correct proportions (±2% on ≥500 sims — unit-test the hash bucketing, not live volume); stats table per variant renders; no variant row on non-A/B campaigns (back-compat).

### M20 — Authoring polish (bounded scope)

- **Recurring campaigns:** `campaigns.recurrence jsonb` (`{freq:'weekly', dow, hour}`) — the M9 cron sweep clones-and-fires from a recurring "master" (new rows per occurrence keep the immutable-send-record property). Guard: recurring requires approval once; each occurrence inherits it but respects budget/gate.
- **Nested segment groups in the UI** (the eval RPC already supports nesting; builder is one-level) — recursive group component.
- **Template niceties:** shared snippet block (header/footer partial, `{{> footer}}`-style include resolved at render), template duplicate action, per-template send stats chip (from M8).
- **Canvas-lite (optional, only if appetite):** read-only visual graph render of a journey definition (nodes+edges SVG) — visualization, not editing. Full drag-drop canvas stays out of v2.

**Acceptance:** one live weekly recurring internal campaign fires twice correctly; a nested segment (group-in-group) builds, previews, materializes; build clean.

---

## Phase 5 — Scale & intelligence

### M21 — Computed traits (RFM) + attribution depth

- Migration `0019_comms_rfm.sql`: RPC `recompute_rfm()` — quantile-based R/F/M scores from `order_placed` events → `profiles.attributes.rfm_{r,f,m,segment}` (e.g. `champion/loyal/at_risk/hibernating` from the standard grid; boundaries proposed from real data, PRD §8.6). Cron: daily via `scheduled()`.
- Segment builder: RFM attributes appear as normal attr leaves (zero engine change — the payoff of the substrate).
- Attribution depth: extend the M8 attribution RPC to journey sends + a per-channel revenue view; still last-touch; write an `attribution` section into `/analytics`.
- **Explicitly not:** predictive/ML models.

### M22 — Volume hardening

Trigger condition: any of — `events`+`messages` > ~5M rows, sends > 100k/mo, or RPC p95 > 1s. Until then this milestone stays parked (the design work is done here; execution on trigger):
- **Supabase MEDIUM upgrade precedes this** (existing infra item — quiet-window resize).
- `events` + `messages`: monthly range partitioning (pg_partman or native) OR archival rollup (move >12-month rows to `events_archive`; analytics RPCs union when asked for long windows). Decide by then-current Supabase tooling; partitioning preferred (transparent to PostgREST).
- Journey trigger matching: move from JS-side scan (fine ≤ low tens of journeys) to a DB-side `trigger_index` (journey_id × event_name, partial index on active) once journey count > ~30.
- Frequency-cap + budget reads: verify `messages(profile_id, sent_at)` index holds p95; consider a `send_counters` rollup if not.
- Queue throughput: revisit `SENDS_PER_MSG=4` + `max_batch_size=1` pacing per provider ceilings (Resend/Trustsignal/Meta tiers in `sender_identities.metadata`).
- Extraction option (documented, not executed): `comms` has no cross-schema FKs → liftable to its own Supabase project if LOT-wide instance pressure demands.

---

## Dependency graph (what can start when)

```
M8 ──► M10 ◄── M9          (analytics + ops both gate go-live)
M12 (external, start during Phase 1.5) ──► M13 live leg
M11 ──► M13                (redirect before SMS sends)
M15 (external, start with Phase 2) ──► M14 acceptance ──► M16 ──► M17
M18, M19, M20 — independent of each other, all after M10
M21 after M10 (needs real data) · M22 on trigger condition
```

## Standing update rule

Each milestone closes with: `systems/relay.md` updated (header + relevant section), `BACKLOG.md` `[relay]` item ticked/added, this plan's milestone marked `— DONE (S<n>, <commit>)` in place, commit + push root and 05_Throttle.
