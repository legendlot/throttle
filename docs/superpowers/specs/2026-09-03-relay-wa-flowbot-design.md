# Relay — WhatsApp FlowBot: design inputs

> **Status: INPUTS COMPLETE, NOT SCOPED TO BUILD.** Afshaan (2026-09-03, S342): *"Take it to a point
> where we have all the inputs, and then stop. We will do a build in a fresh session."*
> Source: Pruthvi's `WA Flowbot Build Plan.pdf` (Slack `#bugs` `1788433215.944179`, file `F0BUJFAKUJX`,
> 2026-09-03 16:30 IST). Every figure below was measured on 2026-09-03 — re-measure before building.

---

## 0. The ownership question is SETTLED — it is Relay's

Afshaan, 2026-09-03, as a **standing rule** (→ `reference/decisions.md`):

> *"Flow Bot or any kind of Bot Design or Step by Step, whatever needs building and has a UI, needs to
> be owned by Relay. It cannot be done in Pitstop. Only a surface where it can be **consumed** can be
> somewhere else, because the **engine is owned by Relay**."*

The plan offers "within Relay or Pitstop" as an open question. It is closed: **engine, builder UI, flow
definitions and every send are Relay's.** Pitstop is a *consumption surface* — it receives the handoff
and renders the thread. Do not re-open this per bot.

---

## 1. ⛔ The plan's critical path is WRONG — its step 1 is already done

The plan opens with:

> *"Set up the WhatsApp Business API access first — get the Meta Business verification, phone number,
> and API access moving immediately, since this has the longest and least controllable lead time in the
> whole plan."*

**This is false for LOT.** We already run **four production WABAs on Meta Cloud API directly** — no
vendor in the path (measured from `comms.sender_identities`, 2026-09-03):

| Number | Purpose | WABA id |
|---|---|---|
| +919880212323 | utility / **support — this is the inbound number** | `1350960337019398` |
| +917022142666 | transactional | `2256935928455031` |
| +917338402888 | transactional (spare) | `1734668990887383` |
| +919035697508 | marketing | `1829828347997765` |
| +15551748518 | Meta sandbox | `1752135339132947` |

And the inbound path is not theoretical — it is carrying real volume **today**:

- **7,918 inbound messages / 1,986 distinct threads in the last 7 days** (`store.cs_wa_messages`,
  `direction='inbound'`). The support number alone is ~4,370 messages / 682 threads.
- **47 active WhatsApp templates**, authored through Relay's own `/templates` UI and submitted to Meta
  via `waSubmitTemplate()`.
- The **24-hour session window** — which the plan lists as a top risk — is already modelled:
  `comms.wa_windows` is upserted on every inbound and `send.js waWindowOpen()` gates free-form sends.

⭐ **Consequence for costing: delete step 1 and the "longest lead time" risk. The build starts at the
flow engine.** This is the single biggest correction to the plan and it shortens the critical path
materially.

⚠️ It also means something the plan does not: **the bot would be answering on a number that already
receives ~4,370 real customer messages a week, which Pitstop agents answer by hand today.** That makes
the closed-pilot step (plan step 6) a hard requirement, not a nicety — and the plan's own instinct to
pilot on an internal number first is right.

---

## 2. What already exists — and what the plan assumes must be built

Relay shipped a bot engine in S312. Measured 2026-09-03:

**Exists and is reusable:**
- `commsops-worker/src/bot-engine.js` — `walk()` / `advance()`. **The core traversal logic is
  channel-agnostic**; it takes a flow definition and a state and returns replies + effects.
- Flow definitions are versioned: `comms.bots.draft_definition` (JSONB) → immutable `bot_versions`,
  numeric versions, sessions pin `active_version`.
- A validator with real wiring checks (`fallback_unwired`, `button_unwired`, `menu_no_buttons`).
- **Handoff already reaches a human**: `bot-web.js` forwards to csops, which writes
  `store.cs_wa_threads`; `createTicketFromThread()` raises the Pitstop ticket.
- An **out-of-hours auto-responder already replies automatically on WhatsApp**
  (`maybeOutOfHoursAutoreply()`), so an automated WhatsApp reply is not unprecedented.
- Payments infrastructure exists (`cashfree.js`).

**Does NOT exist, despite the backlog calling this a "bot builder":**
- ⛔ **There is no builder UI at all.** The Relay app has no `bots` route (`apps/relay/src/app/(auth)/`
  = activity, admin, analytics, campaigns, contacts, experiments, journeys, library, links, manual,
  segments, suppressions, templates). **Flows are edited directly in the database.** The S312 spec
  called for a canvas mode toggle; it was never built. Anyone reading "bot builder residuals" in the
  backlog will overestimate what is there.
- No answer source — all copy is hardcoded in step definitions.
- No AI/LLM anywhere in commsops (grep for anthropic/openai/claude/llm: clean).
- No catalogue, no keyword routing, no order mutations.

**Usage: `comms.bots` = 1 row, `comms.bot_sessions` = 5 rows, ALL from its build day, 0 in 7 days.**
The existing bot is a proof of concept that no customer has used.

---

## 3. The real gap: 6 of the plan's 31 nodes exist

The engine supports exactly six step types (`bot-engine.js:37-51`): `message`, `collect`, `menu`,
`action` (only `kind:'order_status'`), `handoff`, `end`.

The plan's palette lists **31 nodes**. Mapping them honestly:

| Plan node | Status |
|---|---|
| Text/Message · Quick Reply · User Input · Chat with Agent · Order Status Checker | ✅ **exists** (`message`, `menu`, `collect`, `handoff`, `action:order_status`) |
| Text Fallback List | ✅ mostly — menu fallback exists |
| Template Node | ⚠️ the *capability* exists (47 templates, `send.js`); the **node** does not |
| Payment Node | ⚠️ Cashfree exists; the node does not |
| List · Catalogue | 🔴 new — WhatsApp-specific message formats |
| Keyword Action · Add Delay · Flow Node (sub-flow) · Customer Tag · API Call · Product Select · Review Flow · QR | 🔴 new engine nodes |
| Order Select · Order Condition · Delivery Timeline · Track Return · Delayed Order Handling | 🔴 new — reads, feasible (Shopify + `ecom_shipments` already wired) |
| **Cancel Order · Modify Order · Re Order · Confirm Address** | 🔴🔴 **order MUTATIONS from a chat UI — the highest-risk group in the plan, and it is not flagged as such** |
| **AI Intent · Enable AI Bot** | 🔴🔴 **no LLM exists anywhere in Relay today.** A policy decision, not a node |
| Google Sheet | 🔴 questionable — see §6 |
| Abandoned Checkout | ⚠️ exists as a *journey*, not a bot node — decide which layer owns it |

⭐ **The structural finding: the engine's brain is reusable, its whole body is web-shaped.** The
coupling points that must be rebuilt for WhatsApp, all cited:
- `bot-web.js:7-14` — CORS locked to `legendoftoys.com`; routes are `/web/session` + `/web/message`.
  WhatsApp arrives instead on the existing Meta webhook (`wa-webhooks.js`).
- Session identity is a `visitor_key` UUID; WhatsApp identity is a phone number on a WABA
  (`waba_phone_number_id` + contact), which is also how `wa_windows` is keyed.
- `renderStep()` (`bot-engine.js:18-21`) emits `{id,label}` buttons — not WhatsApp interactive
  quick-reply/list payloads.
- Rate limiting is per visitor UUID (`bot-web.js:113-116`).
- `bot-widget.js` is pure DOM and is simply not used on this channel.

---

## 4. Architecture that follows from the above

1. **Keep `walk()`/`advance()` as the single engine.** Extract the web-specific wrapper into an
   *adapter* interface (ingress → normalized input; replies → channel payload). Add a WhatsApp adapter
   beside the web one. This is what makes the same flow definition drive both channels, and it is the
   main structural work.
2. **Ingress is the EXISTING webhook, not a new one.** `wa-webhooks.js` already receives, upserts
   `wa_windows`, ingests the profile and forwards to Pitstop. The bot must slot in *before* the Pitstop
   forward, and must fall through to a human cleanly.
3. **Every bot-initiated send goes through `send.js`/`runGate`** — suppression → consent → frequency
   cap → quiet hours → channel rule. This is precisely why the engine belongs in Relay. ⚠️ Note the
   24h window: a reply inside the window is free-form; outside it, only an approved template.
4. **Answer source as data, not code** — the plan is right about this. A table Relay's UI edits, read
   by the flow, so support/marketing change an answer without a deploy.
5. **Builder UI** — the plan says a config file or admin table is enough on day one, and that is the
   correct instinct. But note this is net-new (§2), so it is not a small line item.
6. **Handoff reuses the proven path** (csops → `cs_wa_threads` → `createTicketFromThread`).

---

## 5. Open questions — FOR PRUTHVI

Not yet raised; needs Afshaan's go before sending.

1. **The 31-node palette reads like a vendor feature list. Which nodes does the FIRST release actually
   need?** Six exist. Building 31 is a different project from building the ~10 that answer the traffic
   we measured. Rank them.
2. **Which of the four numbers does this answer on?** The plan does not say. Support (+919880212323) is
   where the ~4,370 inbound/week land and where agents work today.
3. **Order mutations (Cancel / Modify / Re-order / Confirm Address) — are these in scope for v1?**
   These write to Shopify from a chat UI, and C2P already covers cancellation. Highest-risk group in
   the palette and unflagged in the risk section.
4. **"AI Intent" / "Enable AI Bot" — is an LLM actually intended?** Relay has none today. That is a
   cost, a vendor, a data-sharing decision and a customer-facing risk, not a node.
5. **Google Sheet node — is this a real requirement,** or a habit carried over from vendor tooling? The
   answer source should be Relay's own, per §4.4.
6. **Who owns the answer content?** The plan names this as a risk and does not resolve it. It needs a
   named person before launch, not a role.
7. **The Web bot he offers next — hold it.** Same engine, same adapter question; scoping it separately
   would duplicate this work.

## 6. Open questions — FOR AFSHAAN

1. **Does this supersede or coexist with the S312 web bot?** That surface is staff-gated with 0 use in
   7 days. If WhatsApp is the real target, the web bot may be the thing that gets retired rather than
   extended — and the `[relay][build][MED]` bot-builder residuals become moot.
2. **Pilot number:** internal test number first (plan step 6), or a low-volume production number?
3. **How far does "consumed elsewhere" go for Pitstop** — does an agent need to see the bot transcript
   inline in the thread before taking over? (Recommended: yes; it is the difference between a handoff
   and a restart for the customer.)

---

## 7. What is NOT decided here

No estimate, no phasing, no task list — deliberately. The scoping happens in a fresh session once the
§5 answers land. What this document fixes is the **starting state**: the WABA is solved, the engine
core is reusable, the builder UI and the adapter layer are the real work, and six of thirty-one nodes
exist today.
