# CX Communications Orchestration Platform — Design

> **⚠ SUPERSEDED (2026-06-25, S170) by [`2026-06-25-relay-foundation-design.md`](2026-06-25-relay-foundation-design.md)** — the authoritative Relay PRD, which absorbs this strategy/phasing spine and adds the full foundational data model. This doc is retained for history; the WABA deep-dive (§8 here) is carried forward into §11 there.
>
> **Name:** Relay (confirmed, S163). · **Status:** Design / not yet building. · **Date:** 2026-06-23.
> **Goal:** Replace Bitespeed with an in-house, multi-channel (email · SMS · WhatsApp) customer-communications
> orchestration platform — broadcasts, scheduled campaigns, and trigger-based customer journeys — that LOT fully
> owns and deeply integrates with its own systems (Shopify, Pitstop, returns, Odo).
> **Companion:** per-phase implementation plans (`plans/…`) are written when each phase is greenlit. This is the
> design + phasing spine.

---

## 0. TL;DR

- **Doable, but it is a platform, not a feature** — realistically the scope of 2–3 existing LOT systems. Build it as an
  **independent system** (own worker(s) + schema + app), a sibling of Odo.
- **We are not at zero.** Bitespeed is our WhatsApp BSP (white-labelled Chatwoot); Pitstop already **mirrors inbound
  conversations** (`/webhooks/bitespeed`), and we already hold **direct Meta Graph access** (the S161 IG token → a
  Meta Business + app exist).
- **The send is the easy 20%.** The real work is the orchestration engine + customer profile/consent + segmentation +
  compliance + authoring + analytics.
- **Channel-by-channel, engine-first** (Afshaan): **Email → SMS → WhatsApp.** Email is the safe channel to build the
  whole engine against; WhatsApp is last because it carries the one hard cutover (the WABA migration, §8).
- **Segmentation lives HERE, not in Odo.** Odo is deliberately aggregate (no customer identity). This platform owns the
  customer-360 (PII + consent + events); Odo provides aggregate attribution. (§5)
- **The only non-incremental moment is the WhatsApp number migration.** Everything else parallel-runs with Bitespeed
  fully live. The WhatsApp number can live on only ONE WhatsApp Business Account at a time, so that one flip is a
  rehearsed cutover, not a gradual move. Details + de-risking in §8.

---

## 1. Goals & non-goals

**Goals**
- Own customer comms end-to-end: transactional + utility + marketing across email, SMS, WhatsApp.
- **Broadcasts** (one-off + scheduled sales/regular comms to a segment).
- **Journeys** (trigger → wait → condition → multi-channel action; "WhatsApp at this trigger, SMS at that one").
- A **unified customer profile + consent ledger** so every send is targeted and compliant.
- **Deep integration** with LOT's own data — trigger off returns, repair status, inventory, Odo segments — things an
  off-the-shelf tool cannot do.
- Retire Bitespeed once coverage matches our actual usage.

**Non-goals (v1)**
- A drag-and-drop visual journey builder on day one (start config/form-driven; visual builder later).
- Channels we don't use (push notifications, RCS) — add only if needed.
- Rebuilding Bitespeed features we don't actually use (audit first — §9 Phase 0).
- Customer-level comms to **marketplace** buyers (Amazon/Flipkart/QC) — not possible/permitted; see §5.

---

## 2. What Bitespeed does for us today (what we're actually replacing)

Bitespeed is **two products in one**; scope each separately so we don't rebuild what we don't use.

**2a. Support inbox (inbound)** — a white-labelled **Chatwoot** at `chat.bitespeed.co`. Pitstop already **mirrors**
these conversations inbound via `csops` `/webhooks/bitespeed` (`handleBiteSpeedWebhook` → `cs_wa_threads` /
`cs_wa_messages`). Outbound replies still go **through** Bitespeed's Application API (Pitstop's `sendWaMessage` was
scaffolded to flip to it; `waba_phone_number_id` is a NULL placeholder — **we do not hold a direct WABA yet**). → The
inbound mirror is half-insourced already; finishing it is *moderate*.

**2b. CX / marketing orchestration (outbound)** — broadcasts, abandoned-cart and lifecycle journeys, scheduled
campaigns across WhatsApp/SMS/email. **This is the platform** described here.

**Current wiring facts (verified 2026-06-23):**
- Bitespeed = our **WhatsApp BSP** (it holds the WhatsApp Business Account + our number).
- We already have **Meta Graph API access** (S161 `META_IG_TOKEN`) → Meta Business + app exist (shortens WhatsApp onboarding).
- No app-level email/SMS sending exists anywhere today (greenfield on those channels).
- Internal notifications go via **Slack** (~20 call sites) — staying on Slack (Afshaan); this platform is **customer**-facing only.

---

## 3. Strategy: channel-by-channel, engine-first

Build the **engine once** and prove it on the easiest channel, then add channels. Migration order **Email → SMS →
WhatsApp** is deliberately chosen to push all the hard *platform* risk early and all the hard *vendor-cutover* risk last:

| Order | Channel | Why here | New risk it introduces |
|---|---|---|---|
| 1 | **Email** | We fully control it; no BSP, no number, lowest stakes. Lets us build profile + consent + journey engine + scheduler against a forgiving channel. | Deliverability (domain auth), unsubscribe. |
| 2 | **SMS** | Additive; still no incumbent to displace. | India **DLT** registration (entity + header + every template pre-registered), DND windows. |
| 3 | **WhatsApp** | Last — by now the engine is proven on 2 channels, so the only new variable is the channel itself **+ the Bitespeed/WABA cutover** (§8). | The one hard cutover + WA template approval + quality-rating ownership. |

**Parallel-run principle:** Bitespeed stays fully live throughout Phases 1–2 (email/SMS are new, additive channels). Only
in Phase 3 do we touch the WhatsApp number, and even then we build/test on a **separate number** before a rehearsed flip.

---

## 4. Architecture

**Independent system** (heavy — confirmed). Sibling of Odo; it is the **outbound "actions" arm** of the Odo
control-plane vision (S156: "write-back behind approvals + audit").

- **Worker(s):** a new `commsops` (Cloudflare) — channel adapters, send, webhooks, journey orchestration.
- **Orchestration runtime — the stack's standout fit:** **Cloudflare Workflows + Durable Objects + Queues + Alarms.**
  - **Workflows** = durable, resumable, time-spanning multi-step processes → *exactly* a customer journey ("send now,
    wait 24h, if no purchase send SMS"). This is the part most teams build badly; we get it natively.
  - **Durable Object per customer (or per enrolment)** = a per-customer timer/state holder (alarms) + the natural place
    to enforce frequency-cap / quiet-hours / dedup atomically.
  - **Queues** = event ingestion buffering + throttled fan-out for broadcasts (respects the 50-subrequest limit).
- **Data:** Supabase (`comms` schema, RLS-on, service_role-only per RULE-RLS-001). Core tables (sketch):
  - `contacts` (customer-grain identity: phone, email, shopify_customer_id, name, attributes jsonb)
  - `consent` (per-contact × per-channel opt-in state + source + timestamp + unsubscribe token) — the legal backbone
  - `events` (ingested triggers: order_placed, checkout_abandoned, delivered, return_created, ticket_opened…)
  - `templates` (per-channel message templates + provider template id + approval status)
  - `journeys` / `journey_steps` (definition) + `enrolments` / `enrolment_state` (runtime per contact)
  - `campaigns` (broadcasts: segment, template, schedule, status)
  - `segments` (saved audience definitions) — see §5
  - `messages` (the unified send log: contact, channel, template, provider id, status, sent/delivered/read/reply, cost)
  - `suppressions` (hard bounces, complaints, opt-outs, invalid numbers)
- **App:** a new Next.js static-export app (`apps/relay`) on the shared `@throttle/*` kit + AppLauncher (perm-gated):
  campaign composer, segment builder, journey config, template manager, analytics, and (eventually) the support inbox.
- **Relationship to Pitstop (DECIDED, S163):** the **support inbox stays in Pitstop** — it belongs to the CS team
  (Afshaan). Relay owns only **outbound + orchestration + the single WhatsApp connection**; Pitstop's agent inbox
  consumes that shared connection (one WhatsApp pipe, owned by Relay, surfaced to agents in Pitstop). At the WhatsApp
  cutover (§8) Pitstop's inbound webhook simply re-points from Bitespeed to Relay; the CS agent UI is unchanged.

---

## 5. Customer data, identity, consent & segmentation

**The hard truth (Afshaan):** we only have transparent customer-level data from **Shopify (website)**. Marketplaces
(Amazon/Flipkart) and quick-commerce (Blinkit/Zepto/Instamart) **do not share customer PII** and prohibit using buyer
contact for marketing. So:

- **The addressable universe for proactive comms = Shopify customers + direct WhatsApp opt-ins + Pitstop interactions.**
  That's the standard D2C reality — accept it, don't fight it. Marketplace customers are simply not reachable 1:1.
- **Segmentation belongs in THIS platform, NOT in Odo.** Odo is deliberately **aggregate** (`sales_fact` grain =
  sale_date × channel × product; **no customer identity** — that's its charter, RULE-SALES-001). Customer segmentation
  needs PII + per-channel consent + per-contact event history → a **customer-360** that Odo intentionally avoids.
  - This platform owns the **customer-grain identity graph + consent + segments**.
  - **Odo provides aggregate context + attribution** ("did this campaign move net revenue?") — the two cross-reference
    but stay at their own grains. This platform may *read* Odo for product/category context; it never pushes PII into Odo.
- **Identity resolution:** key on phone + email; merge Shopify customer ↔ WhatsApp contact ↔ Pitstop ticket subject into
  one `contacts` row. Phone is the strongest key (WhatsApp + SMS + most Shopify IN orders).
- **Consent ledger is non-negotiable:** every channel send checks `consent`; marketing requires explicit opt-in
  (WhatsApp especially), transactional/utility has different rules. Unsubscribe/opt-out writes to `suppressions`
  immediately and is honoured forever.
- **Core early dependency: a Shopify customer + consent sync** (customers, orders, marketing-consent flags, abandoned
  checkouts) — this both populates the profile store and defines who we can legally talk to. (We already have a Shopify
  connector for Odo sales; this is a **customer/consent** sync, a different object — build it in Phase 1.)

---

## 6. The channels (adapters + compliance)

One interface — `send(channel, contact, template, vars)` — behind three adapters. Compliance differs sharply per channel:

- **Email (Phase 1).** ESP via HTTPS from the worker (recommend **Resend**; Postmark for deliverability-critical, SES for
  scale). One-time: verify `legendoftoys.com` (SPF/DKIM/DMARC — Cloudflare DNS, fast). Separate **transactional** vs
  **marketing** streams/subdomains to protect reputation. Marketing email legally needs **unsubscribe** + physical
  address (CAN-SPAM/GDPR); transactional doesn't.
- **SMS (Phase 2).** Indian gateway (MSG91 / Gupshup / Kaleyra / Twilio). **India DLT (TRAI) is the gate:** register the
  entity, register **header/sender IDs**, and **pre-register every template** on the DLT portal or it won't deliver.
  Marketing SMS obeys DND time windows. Plan a template-registration pipeline (mirrors WhatsApp template approval).
- **WhatsApp (Phase 3).** **Meta WhatsApp Cloud API, direct** (Meta now allows direct Cloud API — no mandatory BSP). The
  channel's rules: **message templates** must be created + category-approved (marketing / utility / authentication — each
  priced differently), the **24-hour customer-service window** (free-form replies only within 24h of the customer's last
  message; outside it you must use an approved template), **opt-in required** for marketing, and **quality rating +
  messaging-limit tiers** that *we* now own (start lower, ramp with good quality). See §8 for the migration itself.

---

## 7. The orchestration / journey engine (the core)

- **Events in:** Shopify webhooks (order_placed, fulfilled, **checkout_abandoned**, delivered), internal LOT events
  (return_created, repair_status, ticket_opened), and time-based ticks. Buffered through Queues → `events`.
- **Triggers:** an event (or segment-entry, or schedule) enrols a contact into a journey.
- **Journey = durable state machine** (CF Workflow): step types = `send` (channel+template), `wait` (delay / until
  time-of-day / until window), `condition` (branch on contact attribute or event, e.g. "purchased? exit"),
  `split` (A/B), `exit`. Per-enrolment state in a Durable Object with alarms for the waits.
- **Guardrails (must-haves, enforced centrally):** frequency capping, quiet hours, global suppression check, per-channel
  consent check, dedup (don't double-enrol), goal/exit conditions.
- **Broadcasts/campaigns:** pick a segment + template + schedule → throttled fan-out via Queues. One-off or recurring.
- **Analytics:** delivery / open / click / reply / opt-out / conversion per message + per journey + per campaign;
  conversion attribution cross-referenced with Odo net-revenue.

---

## 8. The WhatsApp / WABA migration — deep dive (the part to understand)

This is the question to get right, so in plain terms.

**What a WABA is.** A **WhatsApp Business Account (WABA)** is the Meta container that owns your WhatsApp **phone
number(s)**, your **message templates**, and your **quality rating / messaging limits**. Today your number lives inside
**Bitespeed's WABA** (they're the BSP). "Going direct" = moving your number into **your own WABA** on Meta's Cloud API.

**The one rule that makes this a cutover, not a gradual move:**
> A WhatsApp phone number can be active on **exactly ONE WABA at a time.**

So you **cannot** have Bitespeed and your own Cloud API both serving the same number simultaneously. The moment the number
is migrated to your WABA, **Bitespeed can no longer send or receive on it.** That's the crux of your concern.

**Does Bitespeed stop working meanwhile? — precise answer:**
- **During Phases 1–2 (email, SMS): no, zero impact.** Those are brand-new additive channels. Bitespeed's WhatsApp keeps
  running untouched.
- **During Phase 3 build/test: no.** We build and fully test our WhatsApp stack on a **separate test number** on our own
  WABA, while Bitespeed continues to run the real number normally. No customer impact.
- **At the final cutover: brief, planned interruption on the WhatsApp number only.** When we migrate the *production*
  number to our WABA, there's a short window (typically **minutes to a couple of hours** once initiated) where WhatsApp
  messaging on that number is unavailable. **After it completes, Bitespeed no longer controls the number — our system must
  already be 100% live** (webhooks receiving, templates approved, send working). Email/SMS and all other systems are
  unaffected. So it's not "Bitespeed slowly stops" — it's "Bitespeed runs fully until one rehearsed flip, then we own it."

**How long does the WhatsApp phase take?** The *technical* migration is short (minutes–hours). The **calendar time is
dominated by prep**, not the flip:
- Meta **Business Verification** (likely already done — we have IG/Meta access; confirm in Phase 0).
- Creating our **WABA + Cloud API app**, display-name approval.
- **Template creation + approval** for every WhatsApp message we send (each review = minutes to ~24–48h; marketing
  templates can be slower).
- Building + testing send/receive/journeys on the test number.
- Estimate: **~2–6 weeks of calendar** for the WhatsApp phase, mostly waiting on Meta reviews + testing — with the actual
  production cutover being a single short maintenance window at the end.

**De-risking plan (how we make the flip safe):**
1. **Build + rehearse on a NEW test number** on our own WABA — full parallel run, Bitespeed untouched. (Tradeoff: a brand-
   new number starts at a low messaging tier ~1k/day and ramps with quality — fine for testing.)
2. Get **all production templates pre-approved** on our WABA *before* the flip.
3. Pre-wire **inbound webhooks** + outbound send + the Pitstop inbox against our connection (feature-flagged off).
4. **Production cutover (scheduled window):** disable 2FA/PIN on the source number, migrate the number into our WABA,
   flip the feature flag, smoke-test send+receive, point Pitstop's inbound at our webhook. Roll-back path: re-migrate to
   Bitespeed if it fails (keep Bitespeed account open until stable).
5. Run Bitespeed and ours in **shadow** for a short stabilisation period (Bitespeed account retained, not deleted, until
   quality + volume are proven on ours), then cancel.

**Things to VERIFY against current Meta docs at build time (Meta changes these):**
- Whether **quality rating + messaging limits transfer** on a BSP→direct number migration (Meta has moved toward
  preserving them; do not assume — confirm).
- Whether **approved templates migrate** or must be **re-approved** on the new WABA (plan to re-register the critical set
  regardless).
- Exact **2FA-disable + number-migration** steps and any cool-down between de-registering and re-registering a number.
- Whether to keep the **same number** (preserves customer recognition + history) vs adopt a new one (clean, but resets
  quality + loses recognition). **Default: migrate the existing number** (recognition matters for CX); test on a temp one.

---

## 9. Phasing roadmap

> **Living roadmap (Afshaan, S163):** use cases + features will keep being refined and slotted into the right phase as
> we go. The phase *spine* (engine-first, email→SMS→WhatsApp, Bitespeed live until Phase 5) is fixed; the contents flex.

Each phase ships independently and leaves Bitespeed working until Phase 5.

**Phase 0 — Foundation, audit & decisions (no customer impact)**
- Audit *exactly* what we use Bitespeed for (which journeys, broadcasts, inbox volume) + monthly message volumes per
  channel → defines the real target (don't rebuild unused features).
- Confirm Meta **Business Verification** status; inventory the Meta app/assets we already have.
- Decide ESP (Resend?), SMS gateway, the system name, and the Pitstop-inbox question (§11).
- Stand up the `comms` schema skeleton (contacts, consent, messages, suppressions) + the `commsops` worker shell + a
  templated single send, end-to-end, on email.
- **Start the WhatsApp prep clock in parallel** (Business verification, WABA/app creation) — it's the long pole, begin early.

**Phase 1 — Email channel + the engine core**
- ESP + domain auth + unsubscribe + suppression handling.
- **Shopify customer + consent + abandoned-checkout sync** (the profile store + the addressable universe).
- The **journey engine** (CF Workflows/DO) + **broadcast scheduler** + **segments**, all proven on email.
- Ship: one transactional flow (e.g. order/shipping or return update) + one marketing broadcast + one journey
  (e.g. post-delivery / win-back) — all email.

**Phase 2 — SMS channel**
- DLT entity/header/template registration pipeline; SMS gateway adapter behind the same `send()` interface.
- Reuse the engine — add SMS as a step type in journeys + a campaign channel. Ship one SMS journey/broadcast.

**Phase 3 — WhatsApp channel + WABA cutover (§8)**
- Cloud API adapter, template manager + approval pipeline, 24h-window logic, quality monitoring.
- Build/test on a temp number; pre-approve templates; pre-wire inbound + Pitstop inbox.
- **Rehearsed production number migration** (the one cutover) → WhatsApp now ours; Bitespeed retained in shadow.

**Phase 4 — Authoring UI + analytics depth**
- Campaign composer, segment builder, journey config UI, template manager, unified analytics + Odo attribution.
- (Visual journey builder is here or later — config-driven until then.)

**Phase 5 — Deprecate Bitespeed**
- Once email+SMS+WhatsApp coverage ≥ our actual usage and WhatsApp quality/volume are stable on our WABA → cancel Bitespeed.

---

## 10. Risks

- **WABA cutover** is the single hard, irreversible-ish moment — mitigated by test-number build + rehearsal + retained
  rollback (§8).
- **Deliverability/compliance becomes ours forever** (WA quality rating, India DLT, email reputation, suppression) — these
  are ongoing ops Bitespeed currently shields us from.
- **Opportunity cost** — this is months of build competing with the rest of the roadmap. Mitigate by phasing + shipping
  value each phase.
- **Addressable-audience reality** — proactive comms is essentially Shopify-only; set expectations (not a gap to "fix").
- **Template-approval latency** (WA + DLT) can stall go-lives — start approvals early, keep a template backlog.

## 11. Decisions & open questions

**Decided (S163, Afshaan):**
- **Name = Relay.** (§12)
- **Support inbox stays in Pitstop** (CS team's home). Relay owns the outbound + orchestration + the single WhatsApp
  connection only; Pitstop's agent inbox consumes it. (§4)
- **ESP / SMS-gateway selection = research it properly when we start building** (not now) — produce a comparison +
  recommendation at Phase 0. (Resend is the email front-runner; SMS gateway candidates MSG91/Gupshup/Kaleyra/Twilio —
  all subject to the research.)
- **Internal notifications stay on Slack** — Relay is customer-facing only.

**Still open (resolve as we refine / at Phase 0):**
1. **Same WhatsApp number vs new** at cutover (default: migrate the existing number to preserve recognition; build/test on
   a temp one first).
2. **Consent backfill** — can existing Shopify marketing-opt-in + prior Bitespeed WA opt-ins count as consent, or must we
   re-collect? (Legal/source-of-truth — confirm before the first marketing send.)
3. **Volume + budget targets** (drives ESP/gateway tier + whether direct-Meta actually beats Bitespeed on cost).

## 12. Naming

**Resolved: the system is named "Relay"** (S163) — multi-channel message relay; the outbound voice of the Odo control plane.
