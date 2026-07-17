# BiteSpeed Exit — WhatsApp Cutover Runbook

> **Status:** DRAFT (2026-07-12). Execution companion to the Relay v2 plan
> `2026-07-07-relay-v2-execution-plan.md` (Phase 3, M14–M17) — this doc adds the ground
> truth confirmed 2026-07-12 (WABA ownership audit) and the concrete per-number + Pitstop-side steps.
> **Owner:** Afshaan. **Systems touched:** Relay (`commsops`) + Pitstop (`csops`).
> **Goal:** retire BiteSpeed — move all live WhatsApp onto LOT's own WABAs via Relay's Cloud API adapter,
> with Pitstop as the inbox and Relay as the outbound gateway.

---

## 0. TL;DR

- **We own every WABA.** BiteSpeed/BSPs are only *partners* (Meta WABA-Sharing model). Leaving is on our clock — **no fresh WABA, no Meta provisioning queue, no re-verification.**
- **The real work is one build:** Relay has only an email adapter today. Build **one WhatsApp Cloud API adapter** in `commsops` and it unlocks all three numbers.
- **BSP-to-BSP number migration is near-zero-downtime**; approved high-quality templates copy across without re-review; display name + quality rating retained.
- **Sequence:** build adapter → connect our Meta app to the WABAs we already own → migrate numbers **marketing → transactional → support** (lowest risk first) → swap Pitstop's WA transport off BiteSpeed → cancel BiteSpeed.
- **Honest timeline:** the marketing number can plausibly move within July. The **support** number (highest care, customer-facing, needs a quality soak) realistically lands **late July / early August** if we honor a stability soak. Full BiteSpeed cancellation is the *last* step, gated on all three being stable.

---

## 1. Ground truth (confirmed 2026-07-12)

**Ownership:** every LOT WABA reads `Owned by: Legend of Toys`. Meta deprecated the old "On-Behalf-Of" model; current model is **WABA Sharing** — the brand owns the WABA, the BSP holds partner access. Sources verified against Meta docs this session.

**The estate = 3 real live numbers** (the ~10 WABAs are mostly duplicate/legacy registrations left behind as numbers hopped BSPs — 360Dialog is fully legacy, everything "Transferred"):

> **Canonical copy of this table = `reference/bitespeed.md` §1.** Keep them in sync; prefer that one.

| # | Number | Function | Live on WABA | BSP (partner) | Cutover order |
|---|--------|----------|--------------|---------------|---------------|
| 1 | **9880212323** | **Support — ALL incoming WA** (BiteSpeed inbox 7625) | `2257035788468620` ("TS Legend of Toys") | **Smartping AI + TrustSignal** — ✅ **CONFIRMED on the Partners tab 2026-07-17**; credit line = **SMARTPING AI LIMITED**. (The "TS" name is a red herring — it is NOT TrustSignal-exclusive.) | **3rd (last, highest care)** |
| 2 | **7022142666** | Transactional + COD WA journey | `717043791430518` | Smartping + TrustSignal | 2nd |
| 3 | **9035697508** | Marketing + Abandoned-cart journey (ABC) | `4607501919493306` | Smartping + TrustSignal | **1st (outbound-only, lowest risk)** |

(+1 555-844-5590 on a 360Dialog WABA = Meta **test** number; useful for M14 sandbox testing, not a real line.)

**Key consequences of ownership:**
- No new WABA needed — we attach **our own Meta app + system-user token** to the *existing* owned WABAs. This makes v2-plan **M15 much lighter than written** (it assumed creating a WABA from scratch).
- We can sandbox the adapter (M14) against the existing **+1 555 test number** we already own, or the `7338402888` candidate, before touching a live number.
- Rollback for any number = re-migrate it back to its BSP (BiteSpeed/Smartping/TrustSignal). Non-destructive.

---

## 2. What BiteSpeed does today (the coupling to remove)

BiteSpeed runs a white-labeled **Chatwoot** at `chat.bitespeed.co`. It is **not** a Meta partner on any WABA — it rides *above* the underlying BSP as the software/inbox layer. Pitstop pulls the live conversation on demand and sends replies through Chatwoot's Application API.

**Pitstop-side code (`05_Throttle/csops-worker/src/index.js`):**
- `biteSpeedApiBase()` (~3009) → `chat.bitespeed.co`; auth header `api_access_token` = `BITESPEED_API_TOKEN`.
- `getWaConversation()` (~3111) — GETs the live Chatwoot conversation (`/api/v1/accounts/{provider_account_id}/conversations/{provider_thread_ref}/messages`), derives the 24h window, merges local internal notes.
- `sendWaReply()` (~3189) — POSTs an agent reply into Chatwoot (`message_type:'outgoing'`); no local insert (the `message_created` webhook mirrors it back).
- `handleBiteSpeedWebhook()` (~3461) + `biteSpeedMessageCreated()` (~3622) — inbound capture → `cs_wa_threads` / `cs_wa_messages`; `BITESPEED_DROP_INBOX_IDS` off-ramp already drops email/FB/IG/WA-marketing inboxes.
- Secrets: `BITESPEED_API_TOKEN`, `BITESPEED_WEBHOOK_SECRET`, `BITESPEED_API_BASE`, `BITESPEED_DROP_INBOX_IDS`, `BITESPEED_INBOX_CHANNEL`.

**The inbox itself is transport-agnostic** — `cs_wa_threads`/`cs_wa_messages` already back Meta DMs and email. So the support cutover swaps only the *transport under* the inbox, exactly like the email channel did. Routing, presence, tags, priority, Done/Reopen, ticket-link all stay.

---

## 3. The gap in Relay

Relay's send spine is channel-generic but has **exactly one adapter**:
- `commsops-worker/src/send.js` → `const ADAPTERS = { email: emailAdapter }` (line 10). Adds a new channel by registering it here.
- Adapter contract (`adapters/email.js`): `send(rendered, env) → {provider_message_id, status, reason, raw}` + `parseStatusWebhook(payload) → [{provider_message_id, canonical_status, engagement_event, at, reason, to}]`. For two-way, WhatsApp adds `parseInbound(payload)`.
- `gate.js` step ⑤ is the per-channel rule (currently only validates email addresses). WhatsApp adds its rule here (window/template logic).
- **TEST MODE (`gate.js` step ⓪)** blocks every send — including transactional/agent-reply — to any address off `test_mode_allow`. **This means live WA agent replies cannot happen while TEST MODE is globally ON.** The support cutover is therefore coupled to the M10 go-live decision (see §6, Risk R1).

---

## 4. Target architecture (post-cutover)

```
Customer WA  ─┐
              ▼
   Meta WhatsApp Cloud API  (our Meta app + system-user token, on the WABAs WE own)
              │
   ┌──────────┴───────────────────────────────┐
   ▼ inbound                                    ▲ outbound
POST /webhooks/whatsapp (commsops)         send() spine → adapters/whatsapp.js
   │  status → messages                         ▲
   │  inbound → emit event + FORWARD ───────►  Relay /send  ◄── Pitstop sendWaReply (agent replies)
   │           to csops (Pitstop inbox)         ▲            ◄── campaigns/journeys (marketing, ABC)
   ▼                                            │
Pitstop inbox (cs_wa_threads / cs_wa_messages)  └── one gate, one log, all channels
```

- **Outbound:** everything (agent replies, transactional, marketing, journeys) goes through Relay `send()` → `adapters/whatsapp.js` → Graph `/<phone_number_id>/messages`. One gate, one `messages` log.
- **Inbound:** Meta → `POST /webhooks/whatsapp` (commsops) → status updates onto `messages`; customer messages → emit `replied` event + **forward to csops** (token-authed) → Pitstop inbox upserts `cs_wa_threads`/`cs_wa_messages` (same as the BiteSpeed webhook does now).
- **Pitstop:** `getWaConversation` reads local `cs_wa_messages` (no more Chatwoot pull); `sendWaReply` re-points to Relay `/send` (channel `whatsapp`, purpose `utility`/`transactional` for agent replies → bypasses the marketing gate, never suppression).

---

## 5. Workstreams

### WS-A — Relay WhatsApp Cloud API adapter  *(= v2 plan M14; the critical path)*
> **STATUS: CODE BUILT + DEPLOYED (2026-07-13, commsops version `629e4a97`) — INERT until WS-B.**
> The whole channel is shipped behind the config gate: **inert until `WA_*` secrets + an active
> `whatsapp` `sender_identity` exist**; TEST MODE stays ON; the email path is untouched
> (`send.js` only branches on `channel==='whatsapp'`). Migration `0016_comms_wa_windows` applied.
> 16 node unit tests green; live smoke confirms the webhook is inert (GET verify → 403 without
> `WA_VERIFY_TOKEN`; POST → 503 `wa_not_configured` without `WA_APP_SECRET`). **Remaining in WS-A:**
> the M8 deliverability-panel surfacing of WA quality (alerts already wired). Files: `adapters/whatsapp.js`,
> `wa-webhooks.js`, `wa-templates.js`, hooks in `render.js`/`send.js`/`gate.js`/`index.js`, `test/wa.test.js`.

All new channel code lives in `adapters/` + small hooks in `send.js`/`gate.js`/`render.js`/`index.js`.

1. **`adapters/whatsapp.js`** — mirror the email contract:
   - `send(rendered, env)` → Graph `POST /<phone_number_id>/messages`. Two modes: **`template`** (name/language/components from the rendered mapping — valid anytime) and **`text`** (free-form — valid **only inside the 24h window**; the adapter enforces by requiring `rendered.window_open === true`).
   - `parseStatusWebhook(payload)` → `sent/delivered/read/failed` + per-conversation cost from the webhook pricing object.
   - `parseInbound(payload)` → normalized inbound shape `{from, wa_id, name, text, type, media?, ts, phone_number_id}` (the contract Pitstop consumes — agree it in a shared note before WS-D).
   - Register `whatsapp: whatsappAdapter` in `send.js ADAPTERS`.
2. **Template manager** — `templates.content` WA shape `{meta_name, language, header, body, footer, buttons, mapping}`; worker actions `waSubmitTemplate` (Graph create) + `waSyncTemplateStatus` (poll approval → `approval_status`); templates-page UI panel (submit + status badge). Reuse the positional slot-binder from the SMS milestone if built; otherwise build it here.
3. **`gate.js` step ⑤ WA rule:** marketing → requires an approved template + opted-in consent (existing consent step covers this); free-form text → requires `window_open`. Quiet-hours/freq-cap already central. (Agent replies use purpose `utility`/`transactional` → skip marketing checks, still hit suppression + TEST MODE.)
4. **`render.js` `renderWhatsapp(template, ctx)`** — build the components/param array from the mapping; unresolved slot = throw (same discipline as email).
5. **Inbound seam** — `POST /webhooks/whatsapp` in `index.js` (Meta verify token + `X-Hub-Signature-256`): statuses → `messages`; inbound → emit `replied` via `/ingest` + forward to csops (§WS-D). Reuse the Meta-webhook verify pattern already in csops (`metaHandleMessage`).
6. **Quality monitoring** — subscribe `message_template_status_update` + `phone_number_quality_update` → write `sender_identities.metadata` + Slack alert (`SLACK_WEBHOOK_ALERTS`, already wired) on quality drop; surface in the M8 deliverability panel.

**Acceptance (against the test number, WS-B):** template send; free-form inside window; block outside window; inbound forwarded + logged; statuses + cost land on `messages`.

### WS-B — Connect our Meta app to the owned WABAs  *(= v2 plan M15, simplified — we already own the WABAs)*

> **DECISION (2026-07-13, Afshaan + Claude): a SEPARATE standalone Meta app for Relay/WhatsApp — NOT
> reusing Pitstop's Messenger/IG DM app.** Both are technically viable (one app can route
> `whatsapp_business_account` webhooks to commsops while `page`/`instagram` webhooks stay on csops —
> callback URLs are per-product). We chose separate for long-term robustness: **(1) blast-radius/policy
> isolation** — WhatsApp is a different Meta product with its own quality/rate-limit/ban regime; an
> app-level restriction over a WA marketing-quality strike must NOT be able to take the Messenger/IG DM
> inbox down (or vice versa); **(2) least-privilege tokens** — Relay's system-user token carries only
> `whatsapp_business_messaging`+`_management`, never page/IG messaging scopes; **(3) clean service
> ownership + independent secret rotation** — csops (Pitstop=inbox) and commsops (Relay=gateway) are
> separate workers/secret stores; **(4) different asset classes** — the DM app is on Page+IG assets, the
> WA app on WABA assets (near-zero overlap). Cost is negligible (apps free; Business verification is
> shared at the portfolio level; a 2nd app can be granted access to the same owned WABAs). Note WhatsApp
> for our own opted-in customers does NOT need the Messenger-style App Review that Pitstop's DM scopes
> await, so there is no "shared review" upside to reuse. **The WS-A code already assumes this** — its
> `WA_APP_SECRET`/`WA_VERIFY_TOKEN`/`WA_TOKEN` are distinct from csops's `META_*`, so the separate app
> slots in with zero code change.

1. Confirm Meta Business verification is current (portfolio-level; already done for LOT).
2. **Create a NEW dedicated LOT Meta app "Relay"** (under the same verified Business portfolio) with the
   **WhatsApp product** added; grant `whatsapp_business_messaging` + `whatsapp_business_management`;
   generate a **never-expiring system-user token** (Business Settings → System Users) for THIS app, scoped
   to the owned WABAs. Keep it entirely separate from Pitstop's DM app.
3. Add the new app on the **existing owned WABAs** (no new WABA). For each target number, get its
   **`phone_number_id`** (WhatsApp Manager → Phone numbers).
4. **Sandbox first** on the **+1 555 test number** we already own (or `7338402888`) → run WS-A acceptance end-to-end before any live number.
5. Pre-register the **production template backlog** — re-author every BiteSpeed WA template we actually use (utility + marketing categories), submit via `waSubmitTemplate`, track approvals. Keep a running template registry doc in `docs/superpowers/specs/`.
6. Secrets on `commsops` (the Relay app's, NOT csops's): `WA_TOKEN` (system user), `WA_WABA_ID`,
   `WA_PHONE_NUMBER_ID_<slug>` per number, `WA_VERIFY_TOKEN`, `WA_APP_SECRET` (`WA_GRAPH_VERSION` optional,
   default `v21.0`). Point the new app's **WhatsApp** webhook at `commsops.afshaan.workers.dev/webhooks/whatsapp`
   with that verify token. Add an active `sender_identities` row (channel `whatsapp`) carrying
   `metadata.phone_number_id` per number.

**Acceptance:** test number fully working through Relay; production template set approved; this runbook's per-number steps rehearsed.

### WS-C — Per-number migration  *(= v2 plan M16; order = lowest risk first)*
For each number: register it on **our Cloud API** under the owned WABA → add a `sender_identities` row (channel `whatsapp`, active) → verify send/receive → let quality rating settle before the next. Rollback = re-migrate to the BSP.

1. **Marketing `9035697508`** (outbound-only, lowest risk) → journeys/campaigns can now select WhatsApp; the abandoned-cart journey gains a WA channel alongside email. **Candidate to move within July.**
2. **Transactional + COD `7022142666`** → transactional sends + the COD journey route through Relay. Coordinate with the GoKwik/COD flow owner.
3. **Support `9880212323`** (highest care) → the BiteSpeed-critical cutover; do WS-D jointly. Move only after 1 and 2 are stable.

**Acceptance per number:** first real message in/out on our WABA; quality rating stable **≥1 week** before the next number (this soak is what pushes support past month-end on the safe path).

### WS-D — Pitstop transport swap (the support cutover)  *(Pitstop/`csops` session; joint with WS-C step 3)*
1. Agree the `parseInbound` contract (WS-A) so the csops inbound handler and the Relay forward match.
2. **Inbound:** add a csops handler that accepts Relay's forwarded WA inbound (token-authed, before JWT — mirror `handleBiteSpeedWebhook`) → upsert `cs_wa_threads`/`cs_wa_messages` (`channel='whatsapp'`), auto-reopen + round-robin, exactly as today. Feature-flag which source (BiteSpeed vs Relay) is authoritative so we can shadow-run then flip.
3. **Outbound:** re-point `sendWaReply` from the Chatwoot POST to **Relay `/send`** (channel `whatsapp`, purpose `utility`; free-form inside 24h window else an approved template). Keep the local insert/echo behavior consistent.
4. **Read path:** `getWaConversation` reads local `cs_wa_messages` instead of pulling Chatwoot (once Relay is the capture source there's a full local history).
5. Shadow-verify (both sources writing, compare) → scheduled cutover window → flip the flag → monitor.

### WS-E — BiteSpeed exit + cleanup  *(= v2 plan M17)*
Preconditions: all 3 numbers live on our WABAs **and** Pitstop inbox covers everything BiteSpeed did.
1. Final **conversation-history export/archive** from BiteSpeed/Chatwoot.
2. **Cancel the BiteSpeed subscription.**
3. Remove `BITESPEED_*` plumbing from csops (`handleBiteSpeedWebhook`, `biteSpeedMessageCreated`, `getWaConversation` Chatwoot path, `sendWaReply` Chatwoot path, the drop-list vars).
4. **Dead-WABA cleanup** (separate, low-risk, do anytime): delete/deregister the legacy 360Dialog WABAs (numbers all "Transferred"), the `1300...` Unverified straggler, and the +1 555 sandbox once WS-B testing is done. Confirm each is truly empty before removing. Snapshot the WABA/number inventory first (this session's `waba-inventory.md`).
5. Update `systems/pitstop.md`, `systems/relay.md`, and memory (`project_waba_ownership_bitespeed_exit`, `project_cx_comms_platform`).

---

## 6. Risks & rollback

- **R1 — TEST MODE vs live agent replies.** TEST MODE (gate ⓪) blocks ALL sends off the allowlist, incl. transactional. Live WA support replies through Relay require TEST MODE **off** — so the support cutover (WS-D) is coupled to the M10 go-live sign-off. *Mitigation:* sequence marketing/transactional first (they can validate while support stays on BiteSpeed), and lift TEST MODE only at the support cutover with the go-live decision.
- **R2 — Quality-rating drop on the support number** (highest volume). *Mitigation:* migrate marketing + transactional first as rehearsals; soak each ≥1 week; keep rollback (re-migrate to BSP) ready; quality alert wired (WS-A.6).
- **R3 — Template gaps** — a BiteSpeed template not re-approved on our WABA before cutover = a blocked utility send. *Mitigation:* WS-B.5 template registry; audit BiteSpeed's live templates before scheduling the support window.
- **R4 — Brief registration downtime** during the final register step of a number migration (until template duplication completes). *Mitigation:* scheduled low-traffic window per number; source WABA keeps running until the final step.
- **Rollback (any number):** re-migrate the number to its prior BSP; flip the Pitstop source flag back to BiteSpeed. Nothing is destroyed until WS-E.

---

## 7. Pre-flight checklist (before build starts)

- [x] ~~Confirm the **Partners tab on WABA `2257035788468620` (support)**~~ — **DONE 2026-07-17.** Partners tab shows **2 partners with partial access: Smartping AI + TrustSignal**; credit line = **SMARTPING AI LIMITED**; the single number 9880212323 is **Connected / quality High**. So the detach-from set for support is **both**, not TrustSignal alone. (`reference/bitespeed.md` §1 previously claimed "TrustSignal + 360dialog across all three" and "corrected" this table's "Smartping + TrustSignal" — **that correction was itself wrong**; this table was right. The reference doc is now fixed + carries a correction log.)
- [ ] Audit **BiteSpeed's live WA templates** (utility + marketing) → the re-authoring backlog for WS-B.5.
- [ ] Confirm who owns the **COD/GoKwik** flow on `7022142666` (WS-C.2 coordination).
- [ ] Decide the **go-live / TEST MODE** posture for the support cutover (ties to M10).
- [ ] Confirm SMS phase (M11–M13) sequencing — the plan builds SMS before WA; if BiteSpeed exit is the priority, WA (M14) can run in parallel with / ahead of SMS since the adapter contract is shared.

---

## 8. Realistic timeline (from 2026-07-12)

| Item | Effort | Earliest |
|------|--------|----------|
| WS-A adapter build (M14) | ~2–3 wks | late July |
| WS-B WABA connect + sandbox + templates | parallel w/ WS-A (external-ish) | late July |
| WS-C.1 marketing number live | days after WS-A/B | **within July (plausible)** |
| WS-C.2 transactional number | +1 wk soak | early Aug |
| WS-C.3 + WS-D support cutover | +1 wk soak, joint Pitstop | **early Aug (safe) / late July (compressed, higher risk)** |
| WS-E BiteSpeed cancellation | after all 3 stable | Aug |

**Bottom line for "off BiteSpeed by end of July":** the *marketing* half (what Relay is built to own) is realistically doable in July. The *support* cutover — the actual BiteSpeed dependency — is a late-July-to-early-August item on a safe path, because the honest constraint is the adapter build + a quality soak on a customer-facing number, not any Meta queue. A compressed path can pull support into July if we accept a shorter soak and keep rollback hot.

---

## 9. Cross-references
- v2 execution plan (authoritative milestone breakdown): `docs/superpowers/plans/2026-07-07-relay-v2-execution-plan.md` (M14–M17).
- v2 PRD (WABA deep-dive, foundation §11): `docs/superpowers/specs/2026-07-07-relay-v2-roadmap-prd.md`.
- Relay foundation design: `docs/superpowers/specs/2026-06-25-relay-foundation-design.md`.
- Pitstop email-channel precedent (same "swap transport under the inbox" pattern): `docs/superpowers/specs/2026-06-25-pitstop-inbound-email-design.md`.
- WABA inventory (this session): scratchpad `waba-inventory.md`.
- Memory: `project_waba_ownership_bitespeed_exit`, `project_cx_comms_platform`, `project_pitstop_channel_topology`.
