# Relay v2 — Full Marcomms Roadmap PRD (CleverTap-class)

> **System:** Relay — LOT's in-house customer-communications orchestration platform.
> **Status:** Approved roadmap / execution-ready. **Date:** 2026-07-07 (Session 196).
> **Builds on:** `2026-06-25-relay-foundation-design.md` (the foundation PRD — data model + abstractions; still authoritative for the substrate). This doc is the **v2 program**: everything between today's state (Phase-1 email engine, LIVE behind TEST MODE) and a full CleverTap-class platform.
> **Companion:** `plans/2026-07-07-relay-v2-execution-plan.md` — the milestone-by-milestone implementation plan (agent-executable).

---

## 0. TL;DR

- Phase 1 built the hard part: the CDP substrate + orchestration engine are live and CleverTap-shaped. The v2 gap is concentrated in **analytics (placeholder page), channels (email-only), experimentation (none), and operational hardening (no scheduler/DLQ/alerting)**.
- v2 is sequenced **value-first, dependency-aware**: see-what-you-send (analytics) → actually-send (go-live + ops hardening) → SMS → WhatsApp/WABA (the Bitespeed-retirement lever) → orchestration depth (A/B, richer journeys) → intelligence (RFM, predictive) — with **scale hardening built into every milestone**, not bolted on later.
- Milestones continue the Phase-1 numbering: **M8–M22**. Each is independently shippable, ends in a verifiable state, and never requires reworking a prior milestone (the substrate guarantees this).
- External long poles (DLT registration, Meta WABA reviews) are **tracked as their own workstreams started early**, so engineering never idles on a review queue.

## 1. Where we are (verified 2026-07-07)

**LIVE (behind TEST MODE):** substrate (profiles/identifiers/identity-resolution/events/consent/suppressions; ~14.7k Shopify customers, ~11.8k email-reachable) · Shopify live sync (webhooks + Web Pixel) · dynamic segments (predicate AST) · broadcasts + approval lifecycle + queued fan-out · journey engine (durable CF Workflows, versioned, pinned enrolments) · email channel (Resend, DKIM/SPF/DMARC, unsubscribe, status webhooks) · UTM tagging + `link_clicked` events · self-serve UI (templates/segments/campaigns/contacts/admin) · role-builder governance.

**NOT built:** `/analytics` (placeholder) · campaign scheduler (a `scheduled_at` column with no cron behind it) · DLQ/alerting/observability · link-redirect Phase B · SMS adapter + DLT · WhatsApp adapter + WABA · A/B & holdouts · journey step depth (4 step types) · recurring campaigns · RFM/predictive · visual journey canvas.

**Operational state: zero real customer sends.** TEST MODE ON; abandoned-cart journey seeded but draft; awaiting Afshaan's team-confirmed sign-off.

## 2. Goals & non-goals

**v2 goals**
1. **Relay becomes LOT's only marcomms system** — Bitespeed cancelled, all three WhatsApp numbers + SMS on our own rails.
2. **Full channel coverage:** email + SMS + WhatsApp behind one `send()`, one gate, one log. (Web push: deliberately deferred — see non-goals.)
3. **Self-serve marketing team**: build → preview → approve → send → **measure** without engineering. Analytics is a first-class product, not a report dump.
4. **Experimentation-capable:** A/B variants, holdout groups, per-variant stats — so sends improve over time instead of repeating.
5. **Built for scale + long-term stability:** every message path idempotent, dead-letterable, alertable; data model ready for 10–100× event volume without re-architecture; deliverability health visible per sender identity.

**Non-goals (v2)**
- Web/app push + RCS (no app; revisit only with a PWA/app decision).
- Multi-touch attribution (last-touch within window stays until Odo cross-channel attribution matures).
- Visual drag-drop journey canvas (M20 keeps definitions JSON-first; canvas is additive later — explicitly last).
- Predictive/ML (RFM computed traits YES in M21; churn/propensity models NO — revisit post-volume).
- Marketplace-buyer comms (Amazon/Flipkart don't share PII — unchanged from foundation).

## 3. The roadmap at a glance

| Phase | Milestones | Theme | Duration guess* | Hard external dependency |
|---|---|---|---|---|
| **1.5 — See & Ship** | M8 analytics · M9 scheduler+ops hardening · M10 customer go-live | Measure what we send; send for real | ~1–2 wks build | Afshaan sign-off (gate) |
| **2 — SMS** | M11 link redirect (Phase B) · M12 DLT+gateway workstream · M13 SMS adapter | Second channel; first provider-locked templates | ~1 wk build | **DLT PE/header/template registration (2–4 wks, start immediately)** |
| **3 — WhatsApp** | M14 Cloud API adapter+template mgr · M15 WABA+test number · M16 per-number cutovers · M17 Bitespeed exit | The Bitespeed-retirement lever | ~2–3 wks build | **Meta WABA + template approvals (~2–6 wks, start with Phase 2)** |
| **4 — Depth** | M18 journey step depth · M19 A/B + holdouts · M20 authoring polish (recurring campaigns, nested segment UI, canvas-lite) | Orchestration + experimentation | ~2 wks build | none |
| **5 — Scale & intelligence** | M21 RFM/computed traits + attribution depth · M22 volume hardening (partition/archival, DB-side triggers) | Grow without rethink | ongoing | Supabase MEDIUM upgrade (precondition for volume) |

*Build-effort guesses at LOT pace, excluding external review queues. Phases 2's and 3's external clocks should be **started in parallel during Phase 1.5** — that is the single most schedule-critical action in this PRD.

## 4. Phase rationale (why this order)

1. **Analytics before go-live (M8 < M10):** sending real customer volume blind is how reputations die. The first real campaign must be observable (delivery/bounce/complaint per send) from day one. All data is already captured — this is a render + RPC layer.
2. **Ops hardening before go-live (M9 < M10):** scheduler (so scheduled sends actually fire), dead-letter queue, failure alerting to Slack, and a **warm-up send budget** (a new gate step: daily cap while the Resend domain builds reputation against an 11.8k cold-ish list).
3. **SMS before WhatsApp:** matches the foundation's risk ladder (§3) — SMS is additive (no cutover moment), rehearses provider-locked templates + positional variable mapping + the first-party link redirect, all of which WhatsApp then reuses. DLT registration is also faster than Meta's WABA pipeline, and both clocks start together anyway.
4. **Experimentation after channels:** A/B on one channel is a nice-to-have; A/B across three channels with holdouts is a strategy. Also the split/holdout stats render into the M8 analytics layer, which by then is proven.
5. **Intelligence last:** RFM/computed traits are only as good as the event volume beneath them; by M21 there are months of real send + engagement + order data.

## 5. Success criteria per phase

- **1.5:** first real customer campaign sent + measured; abandoned-cart journey ACTIVE earning revenue; zero silent failures (every drop visible in analytics or Slack).
- **2:** one SMS journey step + one SMS broadcast live on our own DLT header; per-recipient click attribution working via `/r/<code>`.
- **3:** all three WA numbers on our WABA; Pitstop agents replying natively via Relay `/send`; **Bitespeed cancelled** (the program's headline ROI — its subscription ends here).
- **4:** a campaign shipped as an A/B with a holdout, and the winner is readable from the analytics page without SQL.
- **5:** substrate sustains 10× event volume with flat query times; RFM segments usable in the segment builder.

## 6. Scale & long-term-stability principles (cross-cutting, enforced in every milestone)

1. **One send spine, forever.** Every new channel is ONLY an adapter (`send/parseStatusWebhook/parseInbound`). Any PR that adds channel logic outside `adapters/` is wrong.
2. **Idempotency everywhere:** `dedup_key` on sends, `idempotency_key` on events, deterministic Workflow step names, at-least-once queue consumers with idempotent handlers. Retries must never double-send or double-count.
3. **No silent drops:** every gate-fail, adapter error, and queue exhaustion lands in a queryable row (`messages.reason`, `queue_failures`) AND (for systemic failures) a Slack alert.
4. **Append-only facts, derived state:** events/consent/messages are immutable; attributes/segments/stats are recomputed derivations. Anything can be rebuilt from the ledgers.
5. **Versioned definitions, pinned execution:** journeys (already) and templates (already) — extended to A/B variants (assignment recorded per message).
6. **Provider quotas respected structurally:** fan-out pacing lives in the queue consumer (per-channel `SENDS_PER_MSG` + per-provider rate ceilings in `sender_identities.metadata`), not in application sleep loops.
7. **Data growth is planned, not discovered:** `events` + `messages` get time-index + archival strategy at M22 *before* they hurt; the Supabase MEDIUM upgrade precedes any six-figure-volume month.
8. **External-review pipelines never block engineering:** DLT + Meta approvals run as tracked parallel workstreams with template backlogs pre-registered.

## 7. Decisions locked by this PRD

1. **Phase order:** analytics/ops → go-live → SMS → WhatsApp → depth → intelligence (rationale §4).
2. **Push/RCS stay out of scope** until an app/PWA exists.
3. **SMS gateway:** start with **Trustsignal** (incumbent; creds + routes known-working via Bitespeed history), evaluate MSG91 only if Trustsignal's API/DLT support disappoints during M12. One adapter interface either way.
4. **Number plan:** `7338402888` is the **WhatsApp Phase-3 asset** (test/first-migration number candidate — NOT an SMS sender; India A2P needs a DLT header, not a number). Final per-number mapping decided at M15 with fresh Meta docs.
5. **Analytics is derived in-DB (SQL RPCs over `messages`/`events`/`enrolment_steps`), rendered in the app.** No separate metrics store, no client-side aggregation over raw rows.
6. **Warm-up budget** is a real gate feature (settings-driven daily cap), not a manual discipline.
7. **A/B assignment = deterministic hash** (profile_id + campaign/journey salt), recorded on the message row — reproducible, no RNG in replay paths.
8. **The `/r/<code>` redirect goes on `go.legendoftoys.com`** (free subdomain, custom domain route on commsops). A paid ultra-short domain is a later cosmetic call if SMS char budgets demand it.

## 8. Open questions (resolve at the flagged milestone)

1. **M10:** exact warm-up ramp for the first marketing broadcast (proposal in plan: 500/day → 2k → 5k → full over ~2 weeks; tune on bounce/complaint observed).
2. **M12:** which DLT operator portal (Airtel/Jio/Vi) for PE registration + who owns the KYC paperwork (needs Afshaan/company docs — flag early).
3. **M15:** same-number migration vs new number per WA identity; whether quality rating + templates transfer BSP→direct (verify against **current** Meta docs at build time — foundation §11 caveat stands).
4. **M16:** support-number cutover window + Pitstop feature-flag rehearsal plan (joint session with Pitstop).
5. **M19:** default holdout % (proposal: 5% on marketing broadcasts above the approval threshold, off for journeys v1).
6. **M21:** RFM boundary definitions (recency/frequency/monetary quantiles) — propose from real data at build time.

## 9. Risks (delta from foundation §14)

- **Reputation at go-live** — an 11.8k-address first blast could spike bounces (stale Shopify emails). Mitigation: M9 warm-up budget + M8 bounce dashboards + start with highest-engagement segments.
- **DLT bureaucracy** — PE registration is paperwork-bound and operator-dependent; can stall Phase 2 by weeks. Mitigation: start at M10 time, treat as workstream not blocker; SMS build (M13) proceeds against Trustsignal sandbox.
- **Workflows product limits** — CF Workflows quotas (concurrent instances, steps/instance) are generous but real; verify current limits at M18 before adding heavy step types. Fallback shapes exist (queue-driven waits) without schema change.
- **Single Supabase instance shared with all LOT systems** — comms volume growth degrades everyone (already memory-bound at SMALL). Mitigation: MEDIUM upgrade precondition (M22, or sooner per the existing infra item); `comms` is architecturally extractable to its own project later because no cross-schema FKs exist.
- **Scope seduction in Phase 4** — visual canvas + recommender-type features can eat months. The PRD deliberately fences them: canvas-lite only, predictive out.

## 10. What "done" looks like

Relay is done as a *program* when: all customer comms (marketing + transactional + agent replies) flow through `send()`; Bitespeed is cancelled; the marketing team ships measured, experimented campaigns weekly without engineering; and adding channel #4, journey-step #12, or 10× volume is a normal PR, not a project.
