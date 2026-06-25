# Relay — Foundational Design & PRD

> **System:** Relay — LOT's in-house customer-communications orchestration platform (email · SMS · WhatsApp).
> **Status:** Design / not yet building. **Date:** 2026-06-25 (Session 170).
> **Supersedes:** `2026-06-23-cx-comms-orchestration-design.md` (S163 strategy/phasing spine — carried forward and deepened here; that doc remains valid for the WABA deep-dive, reproduced in §11).
> **Purpose:** the authoritative foundation — the data model + core abstractions — designed so v1 is small but the base grows toward a CleverTap-class platform **without an architecture rethink**. Per-phase implementation plans are written from this when each phase is greenlit.
> **Companion brainstorm:** the design was worked through visually; this PRD is the durable capture.

---

## 0. TL;DR

- **Relay is a customer-data substrate with an orchestration engine on top** — not a message-sender with features bolted on. That framing is the whole reason it can grow toward CleverTap: get the substrate (profiles + identifiers + events + consent) right, and every future feature is additive.
- **It is a platform, not a feature** — built as an independent LOT system (own `commsops` worker + `comms` schema + `apps/relay`), a sibling of Odo and the outbound "actions" arm of Odo's control-plane vision.
- **v1 builds the full skeleton, fleshes out only email.** All six layers + all substrate tables exist from day one; functionality lands channel-by-channel (Email → SMS → WhatsApp).
- **Relay = the single outbound gateway** for all channels and all purposes (marketing, transactional, **and** agent 1:1 replies). **Pitstop = the inbound inbox.** They meet only at named shared seams.
- **The only non-incremental moment is the WhatsApp number migration** (one WABA per number). Everything else parallel-runs with Bitespeed fully live; Bitespeed is exited **one identity at a time**, lowest-risk first.

---

## 1. Goals & non-goals

**Goals**
- Own customer comms end-to-end: transactional + utility + marketing across email, SMS, WhatsApp (other channels if they open later).
- **Broadcasts** (one-off + scheduled sales/newsletter comms to a segment) and **journeys** (trigger → wait → branch → multi-channel send).
- A **unified customer profile + consent ledger** so every send is targeted and compliant.
- **Deep integration** with LOT's own data — trigger off orders, returns, repair status, cart events, Odo context — things an off-the-shelf tool can't.
- **Self-serve** for the marketing/CS teams (build + send without engineering), with governance.
- Retire Bitespeed once coverage matches actual usage.

**Non-goals (v1)**
- Drag-and-drop visual journey/email builder (config/form-driven first; the JSON definitions make a visual builder additive later).
- A/B split, holdout/incrementality, multi-touch attribution, RFM/predictive traits, real-time segment-entry triggers — all **model-ready, built later**.
- Channels we don't use (push, RCS).
- Customer-level comms to **marketplace** buyers (Amazon/Flipkart/QC) — they don't share PII; see §5.
- Rebuilding Bitespeed features we don't actually use (audit first — Phase 0).

---

## 2. Program context — three interlocking workstreams

This platform is one of three workstreams that must stay in view together:

1. **Leave Bitespeed** — depends on (3) carrying WhatsApp and Pitstop's inbox covering everything Bitespeed's inbox did. **Last to finish.**
2. **Bring Customer Success fully into Pitstop** — inbound consolidation incl. a *new inbound email channel* (`carecrew@`). Mostly independent, runs in parallel; its WhatsApp inbound + email domain ride the shared seams. **Worked in a dedicated Pitstop session, not here.**
3. **Marketing on Relay** — Email → SMS → WhatsApp; builds the substrate + spine. Its WhatsApp step is the same flip that unblocks #1.

### 2.1 The Relay ↔ Pitstop boundary (the clean separation)

The separation is **inbound vs outbound**:

- **OUTBOUND — Relay owns the spine.** Marketing campaigns, lifecycle journeys, transactional sends, **and agent 1:1 replies** all funnel through one send spine that enforces consent, suppression, frequency caps, and logging, behind per-channel adapters. Relay is the **single outbound communications gateway**; everything else is a consumer.
- **INBOUND — Pitstop owns the inbox.** Per-channel receivers (email parse, WhatsApp webhook, IG/FB, calls) → inbound router → Pitstop threads/tickets/agent UX (presence, routing, tags).
- **Shared seams** (designed once, owned by Relay, consumed by both): the single **WhatsApp pipe**, the **email domain/DNS**, **SMS sender IDs**, and **customer identity**.

**Agent experience vs transport (critical clarification):** the agent workspace is **always Pitstop** — agents never open Relay. Only the invisible *transport* (the WhatsApp connection) is Relay-owned. When an agent hits Send in Pitstop, Pitstop makes an internal server-to-server call to Relay's send API; inbound returns the same way into the Pitstop inbox. Because a number can live on only one connection, there must be a single owner — making it Relay keeps consent/suppression/logging unified.

> **Today's state is actually the two-system problem:** Pitstop shows WhatsApp read-only and agents deep-link into Bitespeed to reply. The migration *removes* that — agents get native two-way WhatsApp inside Pitstop and Bitespeed disappears. The agent's screen gets simpler.

**Inbound email — does it overlap Relay?** ~90% no. Inbound email (`carecrew@`) is a new Pitstop CS channel built in its own session (receiving, parsing, threading, agent reply UX). The **one** overlap is the **email domain**: inbound needs MX records; Relay's outbound needs SPF/DKIM/DMARC on the same domain. So we decide the email-domain strategy *once* (a CS inbound subdomain/address kept distinct from the marketing **sending** subdomain), and the Pitstop session builds the inbox on top. Agent email replies are outbound → routed through Relay's send spine even though composed in Pitstop.

### 2.2 Cross-session contract (so the WhatsApp cutover is a re-point, not a rewrite)

Pitstop's WhatsApp send + inbound webhook must sit behind a **thin transport seam** (one "send WhatsApp" call + one inbound handler). Today it points at Bitespeed's API; at cutover it points at Relay's send API. If the call *shape* Pitstop uses matches what Relay exposes — `send(channel, thread/profile, content)` — the cutover is a base-URL/adapter swap. **Consequence for Relay:** its send spine must be an internal service/API other systems can call, not a function buried inside Relay.

---

## 3. Sender identities & the incremental Bitespeed exit

**Current Bitespeed wiring (all configured in Bitespeed today):**

| Identity | Channel | Purpose | Home (in/out) | Migration approach |
|---|---|---|---|---|
| `carecrew@legendoftoys.com` | Email | CX support (inbound) | Pitstop · in | New inbound build (Pitstop session); needs **MX** on the domain |
| marketing sender — *TBD* | Email | Marketing + transactional (out) | Relay · out | **v1 — build now**; own sending subdomain (e.g. `send.legendoftoys.com`) |
| `9880212323` | WhatsApp | CX support — inbound + replies | Pitstop · in (shared pipe) | **Keep & migrate carefully** — recognition + history critical · **last** |
| `7022142666` | WhatsApp | Transactional — order/COD updates | Relay · out | Migrate *or* replace — recognition matters less |
| `9035697508` | WhatsApp | Marketing — ABC, sale comms | Relay · out | Migrate *or* replace — **lowest blast radius, move first** |
| Trustsignal header | SMS | Txn + marketing (out) | Relay · out | Go direct to gateway; own **DLT** entity/header/templates (Bitespeed hides this today) |

**Foundational consequence:** model **`sender_identities`** as a first-class table from day one — each row = (channel, address/number, purpose, provider, status, credentials-ref). v1 fills only the email sender; the slots for the 3 WhatsApp numbers + SMS header already exist, so messages always record *which* identity sent them, and the incremental migration below is "activate a sender row," never a schema change.

**Incremental Bitespeed exit (separate numbers ⇒ no single big flip):**
1. **Email outbound** (Relay) — zero Bitespeed impact; the whole engine is built & proven here.
2. **SMS direct** (Relay, own DLT) — additive; Bitespeed SMS runs until we flip campaigns over.
3. **WhatsApp marketing #** → Relay WABA — low risk (outbound only); rehearse the WABA dance here.
4. **WhatsApp transactional #** → Relay WABA — medium.
5. **WhatsApp support #** → Relay shared pipe + Pitstop inbox consumes it — highest care; WABA flip rehearsed twice by now.
6. **Cancel Bitespeed** — once all 3 numbers + SMS are off it AND Pitstop's inbox covers everything it did.

> SMS primer (for when we reach Phase 2): Indian SMS is not a phone number — it's a DLT-registered **6-char sender header** + DLT-approved templates routed through a gateway (Trustsignal is one). Bitespeed hides all this. Going direct = we own the DLT entity/header/template registration. To be walked through step-by-step at Phase 2.

---

## 4. Architecture

**Independent system** (sibling of Odo; the outbound "actions" arm of the Odo control-plane vision).

- **Worker:** `commsops` (Cloudflare) — channel adapters, send, webhooks, the ingestion API, journey orchestration. `service_role` DB client.
- **Orchestration runtime — the stack's standout fit:** **Cloudflare Workflows + Durable Objects + Queues + Alarms.**
  - **Workflows** = durable, resumable, time-spanning processes → a customer journey ("send now, wait 24h, if no purchase send SMS"). Native durability is the part most teams build badly.
  - **Durable Object per enrolment** = per-customer timer/state (alarms) + the natural place to enforce frequency-cap / quiet-hours / dedup atomically.
  - **Queues** = event-ingestion buffering + throttled broadcast fan-out (respects the 50-subrequest Worker limit).
- **Data:** Supabase `comms` schema, RLS-on, service_role-only (RULE-RLS-001). Schema must be added to the PostgREST exposed-schemas list (RULE-IGN-007 / PATTERN-092).
- **App:** `apps/relay` (Next.js static-export) on the shared `@throttle/*` kit + AppLauncher, perm-gated: campaign composer, segment builder, journey config, template/variable manager, analytics, admin (roles builder + approval settings + sender identities + connectors).
- **Layered shape (all 6 layers modeled in v1; functionality fleshed out email-first):**
  1. **Ingestion** — Shopify sync, internal events, delivery receipts (→ later: Pitstop interactions, Odo aggregate read).
  2. **Substrate (the CDP core)** — profiles · identifiers · attributes · events · consent · suppressions.
  3. **Audience** — segments (→ later: computed traits / RFM / predictive).
  4. **Orchestration** — campaigns · journeys · guardrails (→ later: A/B, visual builder).
  5. **Delivery** — sender_identities · templates/content · `send()` · per-channel adapters · `messages` log.
  6. **Analytics** — delivery/engagement/conversion, derived from events + messages (→ later: Odo attribution depth).

---

## 5. The substrate (the non-negotiable core)

### 5.1 Identity — profiles & identifiers

**One real person = one `profile`, with many `identifiers`.** This split is the single decision that prevents a future rethink.

- **`profiles`** — `id uuid PK`, `display_name`, a few promoted typed columns for hot filters (e.g. `locale`, `city`), `attributes jsonb` (everything else; new attribute = a key, no migration), `created_at`/`updated_at`.
- **`identifiers`** — `profile_id FK`, `type` (enum: `phone` E.164, `email`, `shopify_customer_id`, `whatsapp`/wa_id, `instagram`/igsid, `messenger`/psid, … extensible), `value`, `is_verified`, `source`, `first_seen`/`last_seen`. **`UNIQUE(type, value)`** = the dedup backbone (an identifier points to exactly one profile, ever).
- **Identity resolution** (on every inbound event/contact): look up each incoming identifier → **none match → create profile** · **one profile → attach** · **≥2 profiles → merge**. Phone is the strongest key (spans WhatsApp + SMS + most Shopify-IN orders).
- **Merge, don't dedupe-delete:** collisions merge into a survivor (repoint identifiers/events/consent/messages) and write a **`profile_merges`** audit row (`survivor_id`, `merged_id`, `at`, `by`, `reason`) — traceable + reversible. **Conservative auto-merge:** only on verified strong identifiers (phone/email/shopify_id); never blind-merge a shared family phone.
- **Anonymous/device profiles** are out of v1 (no website/app SDK yet — every profile is "known", arriving with a phone/email) but **model-ready**: add a device/cookie identifier type + a merge-on-login rule later, no rethink.

### 5.2 Profile sources & enrichment

Shopify (website) is **~30%** of identity and rich (name/email/phone/orders). The other **~70%** arrive thin — often a WhatsApp number only — because marketplaces (Amazon/Flipkart) and quick-commerce don't share PII. So:

- **Identity is channel-agnostic** — Shopify is one source, not the spine. Thin WA-only profiles are first-class.
- **The addressable universe grows by *interaction*, not data feed.** A marketplace sale gives us no person (aggregate-only, lives in Odo); the same buyer messaging us *does* (a profile is born from the phone). **Pitstop / inbound is therefore a primary profile source** — it's how the 70% become reachable. (Wiring Pitstop to feed the substrate is a later step via the shared event API; v1 doesn't need it.)
- **Provenance on every identifier and attribute** (`source`, `observed_at`, confidence-ready) so a future **identify-&-enrich engine** is just another writer that can resolve conflicts (WA name vs Shopify name) and append traits.
- **Layering:** v1 = flat `attributes` jsonb as the fast current read-model (segments/personalization read it directly). Later = a `profile_traits`/provenance layer slots *underneath* and recomputes `attributes`; consumers never change. That's the enrichment engine's home.

### 5.3 Events

A single **generic event envelope** that does three jobs at once: **triggers**, **behavioral segments**, **analytics**.

- **`events`** — `id`, `profile_id FK`, `name`, `occurred_at`, `properties jsonb`, `source`, `idempotency_key UNIQUE`. One table, infinite event types. (Typed per-event tables are rejected — they'd need a migration per new event.)
- **`event_definitions`** — lightweight registry (name + description + expected props + is_active): the known vocabulary powering journey/segment dropdowns and keeping the generic table from being a free-for-all. Seeds a handful, grows freely.
- **One ingestion path:** `POST /ingest {identifiers, name, occurred_at, properties, source, idempotency_key}` — any system calls it (Shopify adapter, internal, delivery receipts; **later** Pitstop). It resolves identity → appends the event → derives attributes → fires triggers. Buffered through Queues. `idempotency_key = source + source_event_id` so retried webhooks never double-count. This `/ingest` endpoint is the seam Pitstop calls later.
- **Event vs attribute:** an **event** = something that *happened* (append-only, immutable, timestamped); an **attribute** = current *state* (mutable, fast to target on; some synced from Shopify, some derived from events, e.g. `lifetime_orders`).
- **Curated to comms-relevant signals only** (we do NOT mirror floor scans/ops). v1 seed: `order_placed`, `order_fulfilled`, `order_delivered`, `add_to_cart`, `checkout_started`, `checkout_abandoned`, `return_created`, `repair_status_changed`, `ticket_opened`. *(Sourcing note: `add_to_cart` + `checkout_started` are storefront/client-side — captured via a Shopify Web Pixel, flowing through the same `/ingest`.)*
- **Engagement is also events:** delivered/opened/clicked/replied/bounced/opted_out are logged on `messages` (operational) **and** emitted as events (so "opened → branch" and "opened ≥3 last month" just work).

### 5.4 Consent & compliance (the legal backbone)

Consent is never a single boolean. **Grain = profile × channel × purpose.**

- **`consent`** — append-only ledger: `profile_id`, `channel`, `purpose` (`marketing` | `transactional` | `utility`), `state` (`opted_in` | `opted_out` | `unknown`; `pending` later for double opt-in), `source`, `captured_at`, `evidence`, `unsubscribe_token`. Every opt-in/out is a new immutable row (bulletproof legal audit); read the latest per (profile, channel, purpose). Opt-in/out also emit events.
- **`suppressions`** — hard blocks distinct from consent: `channel`, `value`/`profile`, `reason` (hard-bounce/complaint/invalid/global-opt-out), `at`. Checked first on every send; honoured forever.
- **The send-time gate** (one gate, every channel, every purpose — enforced centrally in the send spine), ordered: ① suppression? (overrides all) → ② consent for (channel, purpose)? (marketing needs opted_in) → ③ frequency cap? → ④ quiet hours / India DND? → ⑤ channel rule (WA: inside 24h window = free-form, else approved template). Pass → send + log; fail → a **skipped `messages` row with the reason** (never a silent drop).
- **Transactional/utility bypass** the marketing-consent check + frequency cap + quiet hours (an order update must go) — but **never** bypass a hard suppression.
- **Consent backfill** (the one Phase-0/legal policy call): do existing Shopify opt-ins + prior Bitespeed WA opt-ins count, or re-collect? The model is agnostic — they're rows with `source='shopify_import'` + original `captured_at`; we decide validity.

---

## 6. Audience — segments

- **Two kinds:** **static lists** (explicit set — CSV/hand-picked, fixed until changed) and **dynamic rule-based** (live, evaluated over the substrate).
- **Rules stored as a JSON predicate tree, never raw SQL** — so the same definition is rendered by a future visual builder, evaluated by the engine, and versioned. Supports AND/OR groups of predicates on attribute / event-occurrence-or-count-in-window / consent. v1 supports a limited predicate set; grows freely.
  *Example (win-back):* `{ all: [ {event:"order_placed", count:"≥2", within:"90d"}, {none:[{event:"order_placed", within:"30d"}]}, {attr:"city", in:["BLR","HYD"]} ] }`.
- **`segments`** — `id`, `name`, `kind` (static|dynamic), `definition jsonb`, timestamps; **`segment_members`** (segment_id, profile_id, added_at) materialized for dynamic segments.
- **Reusable first-class object** — target a broadcast, enrol a journey, or branch on "is in segment X?" mid-journey. Never embedded in a campaign.
- **Consent-agnostic audience; consent applied at send.** Always show two numbers: **segment size** and **reachable on (channel, purpose)** after consent/suppression — computed per send, not baked into the segment.
- **v1 evaluation = batch + on-demand** (scheduled/on-demand materialization + live preview-count). Real-time segment-entry/exit triggers are **later** (event-triggered journeys cover the urgent "moment X happens" cases). Computed traits / RFM / predictive = a later layer the same AST filters on.

---

## 7. Delivery — sender identities, templates, variables, transport

### 7.1 Templates & content

One template concept, three channel shapes; one personalization model.

- **`templates`** — `id`, `channel`, `name`, `purpose` (drives the consent gate), `language` (default `en`; multi-language built-in), `status`, `version`, `provider_template_id` + `approval_status` (SMS/WA), and a channel-specific `content jsonb`:
  - **Email** — subject, html_body, text_body, from/reply-to (a sender identity). Approval: none (author & go).
  - **SMS** — body, dlt_template_id, sender_header. Approval: DLT (pre-register every template).
  - **WhatsApp** — meta_name, language, header/body/footer, buttons, provider_template_id. Approval: Meta category (marketing/utility/auth).
- **Approval & versioning lifecycle:** `draft → submitted (SMS/WA) → approved/active → new version`. Editing publishes a **new version**; the `messages` log records which version sent, so in-flight journeys + history stay stable. Email skips to active.
- **Model-ready, not built:** reusable snippets/partials (header/footer/unsubscribe block), block-based / drag-drop authoring (v1 = HTML + a simple editor).

### 7.2 Variables (personalization)

- **Author-defined merge variables**, friendly tokens like `{Name}`, `{sale_name}`. A template **declares its variables** and **binds each to a source**: `profile.*` field · `event.*` field · **constant** (set per campaign at send) · **per-recipient input** (list column) · `system.*` (unsubscribe_url…). Each has a fallback (`{Name | "there"}`).
- **Unlimited & customizable** where we own the channel (email): author adds any number, add/remove anytime.
- **Provider-locked channels (SMS-DLT, WhatsApp-Meta):** the agency-approved template fixes the slot count/positions (`{{1}}`, `{#var#}`). We **import** that structure and **map** each positional slot → a named variable + source. Changing the variable set = re-approval by DLT/Meta; the mapping is reusable across campaigns.
- The engine **validates every declared variable is bound before send** — an unresolved `{token}` never ships. Same template + different per-campaign constants → different messages.

### 7.3 Sender identities

- **`sender_identities`** — `id`, `channel`, `address`/`number`, `purpose`, `provider`, `status` (active/inactive), credentials-ref, quality/limit metadata (WA). The bridge between abstract `send(channel,…)` and the concrete provider/number; what makes the incremental migration "activate a row." (See §3.)

### 7.4 Transport — the unified send log

- **`messages`** — one row per send on every channel/purpose: `id`, `profile_id`, `channel`, `purpose`, `sender_identity_id`, `template_id` + `version`, `source` (campaign/journey/enrolment), `provider`, `provider_message_id`, `status` (canonical), `provider_status` (raw, kept for audit), `reason` (skip/fail), `cost`, `dedup_key UNIQUE`, and timestamps (`queued_at`/`sent_at`/`delivered_at`/`read_at`…).
- **Canonical status lifecycle** (a superset; each channel fills the subset it supports): `queued → sent → delivered → [read] → [opened/clicked/replied]`; terminal `failed/bounced/rejected`; pre-send `skipped (gate)` / `suppressed`.
- **Adapter contract — the only channel-specific code anywhere:** `send(rendered) → {provider_message_id, status}` · `parseStatusWebhook(payload) → [{provider_message_id, canonical_status, at, reason}]` · `parseInbound(payload)` (two-way channels). Adding a channel = writing one adapter; the gate, log, engine, analytics stay channel-agnostic.
- **End-to-end send:** render template + vars → **gate** → queue (throttled fan-out) → `adapter.send` → `messages` row (queued→sent) → provider webhook → normalize → update status + emit engagement event. **Idempotent** via `dedup_key` (e.g. enrolment-step or campaign+profile) so a retried durable step never double-sends.
- **Inbound boundary:** `messages` logs Relay's **outbound** only. Inbound conversational messages are forwarded to **Pitstop** (its store) — Relay is the transport receiver. A customer reply within window surfaces as a `replied` event (for triggers); the conversation lives in Pitstop.
- **Cost** captured per message where the provider reports it (WA per-conversation, SMS per-segment) → ROI/analytics.

---

## 8. Orchestration — campaigns & journeys

Two primitives sharing segments, templates, the gate, and the `messages` log.

- **Campaign (broadcast):** segment + template + schedule → throttled one-time fan-out; audience snapshot at send. Lifecycle `draft → scheduled → sending → sent`.
- **Journey (flow):** a trigger enrols a profile into a durable per-person flow. Lifecycle `draft → active → (paused) → archived`.
- **Journeys stored as versioned JSON** (like segments — builder-ready, executable) → **compiled to a CF Workflow**.
  - **Step types (v1):** `send` (channel+template), `wait` (delay / until time-of-day / until window), `condition`/branch (on attribute/event/segment), `goal`/`exit`. **Later:** `split` (A/B), `wait-for-event`, `holdout`.
  - **Triggers:** event (name + optional filter), schedule, manual/API enrol. (Segment-entry triggers later.)
- **THE critical decision — versioning & in-flight enrolments:** each enrolment is **pinned to the journey version it started on**. Editing publishes a new version; new enrolments use it; in-flight ones finish safely on the old version. Editing never mutates a running flow. (Optional "drain + migrate" later.) This is why journeys are immutable versioned JSON, not live-mutated code.
- **Runtime mapping:** definition (JSON) → CF Workflow; **`enrolments`** (`journey_id`, `journey_version`, `profile_id`, `status` active/completed/exited/failed, `current_step`, `context jsonb`, `enrolled_at`, + step history) → a Workflow instance/DO; waits → DO alarms; events → Queues → enrol.
- **Re-enrolment policy per journey** (config): once-ever / once-while-active / re-enrollable with cooldown. **Default: once-while-active.**
- **Guardrails:** consent/suppression/frequency-cap/quiet-hours are the *shared send gate*; journey-level adds dedup, goal/exit, max-duration.

---

## 9. Analytics & attribution

- **Derived from `events` + `messages`** — no parallel metrics store to drift.
- **Per campaign:** sent/delivered/opened/clicked/replied/bounced/opted_out + cost (off canonical statuses).
- **Per journey (by version):** enrolment funnel through steps → conversions/exits (so v1 vs v2 are comparable).
- **Conversion & ROI:** an `order_placed` within an attribution window credits the send (**last-touch v1**); attributed revenue vs message cost.
- **Deliverability health** (first-class — we own reputation now, per sender identity): bounce rate, complaint rate, opt-out rate, WA quality rating, SMS DLT failures.
- **Grain discipline (RULE-SALES-001 respected):** Relay measures at **customer grain** (it has identity); it reads **Odo aggregate** net-revenue for the ROI macro view only; it **never pushes PII into Odo**.
- **Later (model-ready):** multi-touch attribution, cohort/retention, holdout incrementality (pairs with the deferred holdout step).

---

## 10. Self-serve & governance

"Self-serve" = the team builds & sends without engineering — with guardrails so **nobody blasts the whole base unchecked.**

- **Permission layer:** `store.relayops_roles` / `relayops_user_roles` (mirrors Snorkel/Podium/Manifest) with a per-user `active` kill-switch and a **super-admin** governance tier.
- **Custom role builder (Garage-style):** the model is **granular permission keys** + an admin **builder UI** that composes custom roles from keys (like Manifest's permissions-builder tab). Suggested keys: `relay_view`, `segment_manage`, `template_manage`, `campaign_build` (campaigns + journeys, draft), `send_activate`, `approve`, `data_consent_admin`, `connector_channel_manage`, `relay_admin`, `relay_super_admin`. Six **seeded presets** (Viewer / Author / Manager / Approver / Admin / Super-admin) are clonable/editable, not fixed.
- **Send-approval lifecycle:** `draft → submit → pending approval → approved → scheduled/active → sending → sent`; reject → draft (with reason). **Test-send/preview** (to self or a seed list) is **always allowed, no approval**. Audit: `created_by · approved_by · sent_by` + timestamps on every campaign/journey.
- **Approval policy — admin-configurable thresholds** (a settings row, not hardcoded), combining: `audience > threshold`, `purpose = marketing`, and `role`. **Default:** marketing sends above a small audience threshold require an Approver; transactional/utility and test-sends never do. Tunable any time.
- **Blast-radius guardrails:** a "you're about to send to N people" confirmation before any live send; a cancel window on scheduled sends; the send gate still filtering every recipient underneath.

---

## 11. The WhatsApp / WABA migration — deep dive

*(Carried forward from the S163 spec — the part to get right.)*

- **What a WABA is:** the Meta container owning your WhatsApp **number(s)**, **templates**, and **quality rating / messaging limits**. Today our numbers live inside **Bitespeed's WABA** (they're the BSP). "Going direct" = moving a number into **our own WABA** on Meta's Cloud API.
- **The rule that makes it a cutover, not a gradual move:** *a WhatsApp phone number can be active on exactly ONE WABA at a time.* So Bitespeed and our Cloud API cannot both serve the same number; the moment a number migrates, Bitespeed can no longer send/receive on it — our system must already be 100% live for it.
- **Does Bitespeed stop working meanwhile?** Phases 1–2 (email, SMS): zero impact. Phase 3 build/test: zero impact (we build/test on a **separate test number** on our WABA). At the final per-number cutover: a brief planned interruption on **that number only** (minutes–hours), after which we own it.
- **Calendar is dominated by prep, not the flip:** Meta Business Verification (likely already done — confirm Phase 0), WABA + Cloud API app + display-name approval, **template creation + approval** for every WA message, build/test on the test number. Estimate ~2–6 weeks per the WhatsApp phase, mostly Meta reviews + testing.
- **De-risking:** build & rehearse on a NEW test number (full parallel run, Bitespeed untouched) → pre-approve all production templates → pre-wire inbound webhooks + outbound + the Pitstop inbox (feature-flagged off) → scheduled cutover window (disable 2FA, migrate number, flip flag, smoke-test, point Pitstop inbound at our webhook; rollback = re-migrate to Bitespeed) → run in shadow before cancelling Bitespeed.
- **Verify against current Meta docs at build time:** whether quality rating + messaging limits transfer on a BSP→direct migration; whether approved templates migrate or need re-approval (plan to re-register the critical set regardless); exact 2FA-disable + number-migration steps + any cool-down; same-number (preserves recognition — **default**) vs new number (clean but resets quality/recognition — used only for the test number).

---

## 12. Channel compliance (per channel)

- **Email (Phase 1):** ESP over HTTPS (Resend front-runner; Postmark for deliverability-critical; SES for scale — decide Phase 0). Verify the sending domain (SPF/DKIM/DMARC on Cloudflare DNS). Separate **transactional** vs **marketing** streams/subdomains to protect reputation. Marketing email needs unsubscribe + physical address; transactional doesn't.
- **SMS (Phase 2):** Indian gateway (Trustsignal incumbent via Bitespeed; candidates MSG91/Gupshup/Kaleyra/Twilio — decide Phase 2). **India DLT (TRAI) is the gate:** register entity, header/sender IDs, and pre-register every template; marketing SMS obeys DND windows.
- **WhatsApp (Phase 3):** Meta WhatsApp Cloud API, direct. Message templates created + category-approved; the 24-hour customer-service window (free-form only within 24h of the customer's last message, else approved template); opt-in required for marketing; quality rating + messaging-limit tiers now ours.

---

## 13. Phasing roadmap

> **Living roadmap.** The spine is fixed (substrate skeleton first; engine-first; email→SMS→WhatsApp; Bitespeed live until the end); the contents flex.

- **Phase 0 — Foundation, audit & decisions (no customer impact).** Audit exact Bitespeed usage + per-channel volumes. Confirm Meta Business Verification + inventory existing assets. Decide ESP, the marketing sending subdomain, consent-backfill policy. Stand up the `comms` schema **full skeleton** (all substrate + delivery + orchestration tables) + the `commsops` worker shell + a single templated email send end-to-end. **Start the WhatsApp prep clock in parallel** (long pole).
- **Phase 1 — Email channel + the engine core.** ESP + domain auth + unsubscribe + suppression. **Shopify customer + consent + cart/abandoned-checkout sync** (profile store + addressable universe; incl. the Web Pixel for `add_to_cart`/`checkout_started`). The journey engine (CF Workflows/DO) + broadcast scheduler + segments + the send gate + governance/role-builder/approval — all proven on email. Ship: one transactional flow + one marketing broadcast + one journey (e.g. abandoned cart / win-back), all email.
- **Phase 2 — SMS channel.** DLT entity/header/template registration pipeline; SMS adapter behind the same `send()`; SMS as a journey step + campaign channel. Ship one SMS journey/broadcast.
- **Phase 3 — WhatsApp channel + WABA cutover (§11).** Cloud API adapter, template manager + approval pipeline, 24h-window logic, quality monitoring. Build/test on a temp number; pre-approve templates; pre-wire inbound + Pitstop inbox. Rehearsed per-number migrations (marketing → transactional → support).
- **Phase 4 — Authoring & analytics depth.** Richer composer / segment & journey UI, A/B split, attribution depth + Odo cross-ref. (Visual builder here or later.)
- **Phase 5 — Deprecate Bitespeed.** Once email+SMS+WhatsApp coverage ≥ actual usage AND Pitstop's inbox covers everything Bitespeed's did AND WA quality/volume are stable on our WABA → cancel.

---

## 14. Risks

- **WABA cutover** — the single hard moment; mitigated by test-number build + rehearsal + retained rollback (§11). The separate numbers let us do it incrementally, lowest-risk first.
- **Deliverability/compliance becomes ours forever** (WA quality rating, India DLT, email reputation, suppression) — ongoing ops Bitespeed shields us from today; deliverability-health dashboards from day one.
- **Opportunity cost** — months of build; mitigated by phasing + shipping value each phase.
- **Addressable-audience reality** — proactive comms is essentially Shopify + opt-ins + interactions; set expectations (not a gap to "fix").
- **Template-approval latency** (WA + DLT) can stall go-lives — start approvals early, keep a backlog.
- **Event/message volume growth** — `events`/`messages` are append-only and can grow large; design for an eventual archival/rollup + partitioning (not built v1; flagged).

---

## 15. Decisions & open questions

**Decided (this design):**
- Substrate-first architecture; full skeleton in v1, email-only functionality.
- Relay = single outbound gateway; Pitstop = inbound inbox; agent workspace always Pitstop; transport Relay-owned. Sender identities first-class; incremental number-by-number Bitespeed exit.
- Profiles ≠ identifiers (UNIQUE(type,value)); conservative auto-merge with audit; provenance everywhere; channel-agnostic identity; enrichment = later layer.
- Generic event envelope + registry + one `/ingest` API; event vs attribute split; engagement-as-events; seed vocabulary incl. `add_to_cart` + `checkout_started`.
- Consent grain profile×channel×purpose, append-only; one central send gate; transactional bypasses all but hard suppression.
- Segments static + dynamic, JSON predicate AST, consent-agnostic with reachable-count; batch eval v1.
- Templates channel-shaped + versioned + purpose-linked + multi-language built-in (English v1); author-defined variables (free) / mapped slots (locked); HTML authoring v1.
- Unified `messages` log + canonical status lifecycle + adapter contract; inbound forwarded to Pitstop.
- Campaigns + journeys; versioned-JSON journeys on CF Workflows; enrolments pinned to version; v1 steps send/wait/condition/exit; A/B → v2; re-enrolment default once-while-active.
- Analytics derived; last-touch v1; deliverability health v1; Odo aggregate cross-ref only.
- `relayops` perm layer + custom role builder; send-approval lifecycle with admin-configurable thresholds.

**Open (resolve at Phase 0 / as we go):**
1. **ESP + SMS-gateway selection** — research + recommendation at Phase 0 (Resend front-runner; Trustsignal incumbent for SMS).
2. **Consent backfill validity** — do Shopify opt-ins + prior Bitespeed WA opt-ins count, or re-collect? (Legal call; the model holds either.)
3. **Same WhatsApp number vs new** at each cutover (default: migrate existing; test on a temp number).
4. **Volume + budget targets** (drives ESP/gateway tier + whether direct-Meta beats Bitespeed on cost).
5. **Marketing sending subdomain** name + its relationship to `carecrew@` inbound (decide once, with the Pitstop email session).

---

## 16. Appendix — `comms` schema table summary (v1 skeleton)

| Table | Role | Fleshed out in |
|---|---|---|
| `profiles` | one row per person; promoted cols + attributes jsonb | v1 |
| `identifiers` | per-channel keys, UNIQUE(type,value) | v1 |
| `profile_merges` | merge audit | v1 |
| `events` | generic append-only event stream | v1 |
| `event_definitions` | event registry | v1 |
| `consent` | append-only consent ledger (profile×channel×purpose) | v1 |
| `suppressions` | hard blocks | v1 |
| `segments` / `segment_members` | audience definitions + materialized membership | v1 (batch) |
| `sender_identities` | channel addresses/numbers + provider + purpose | v1 (email row) |
| `templates` | channel-shaped content + version + approval + variables | v1 (email) |
| `messages` | unified outbound send log + canonical status | v1 |
| `campaigns` | broadcasts | v1 (email) |
| `journeys` / `journey_versions` | versioned JSON definitions | v1 (email) |
| `enrolments` (+ step history) | per-profile journey runtime state | v1 |
| `relayops_roles` / `relayops_user_roles` | permission layer + role builder | v1 |
| `relay_settings` | approval thresholds, frequency caps, quiet hours, etc. | v1 |
| `profile_traits` (provenance) | enrichment layer under `attributes` | later |

> **Naming:** the system is **Relay** — multi-channel message relay; the outbound voice of the Odo control plane.
