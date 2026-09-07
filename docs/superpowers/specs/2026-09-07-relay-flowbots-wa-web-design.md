# Relay — the two flow bots (WhatsApp + Web) on one engine: design

> **Status: APPROVED DESIGN, HOSTILE-REVIEWED (v2), ready for an implementation plan** (S355,
> 2026-09-07, Afshaan). v1 was reviewed the same day by an independent reviewer (Opus, high) against
> the live code and DB; 15 findings + 1 of the author's own were accepted and folded in — the log is
> §11. Supersedes the *inputs* document `2026-09-03-relay-wa-flowbot-design.md` and extends the S312
> `2026-08-26-bot-builder-design.md` (the engine this builds on).
> Inputs: Pruthvi's `WA Flowbot Build Plan.pdf` (#bugs `1788433215.944179`, 2026-09-03), his MVP
> answers (same thread, 2026-09-05 11:31, ts `1788588103.343509`), and his `In-House Website FlowBot
> Plan.pdf` (same thread, 2026-09-07 17:32, file `F0BVAGE1CEP`). Every figure below was measured on
> 2026-09-07 unless dated otherwise.

---

## 0. Decisions already made (do not re-open)

| Decision | Who / when | Where recorded |
|---|---|---|
| Any bot/flow builder with a UI is **Relay's**; Pitstop only consumes | Afshaan, 2026-09-03 | `reference/decisions.md` §S342 |
| Automations = exactly TWO builds, the WhatsApp bot and the Web bot; they **coexist** on one engine | Afshaan, 2026-09-04 | `reference/decisions.md` §S352 |
| WhatsApp bot answers on the **support number** `+919880212323` | Pruthvi, 2026-09-05 | #bugs thread |
| MVP nodes: Keyword Action · List · Quick Reply · Send Message · Chat with Agent · Order status | Pruthvi, 2026-09-05 | #bugs thread |
| Order mutations OUT of v1; LLM intent deferred (rule-based first); no Google Sheet node | Pruthvi, 2026-09-05 | #bugs thread |
| Pruthvi owns answer content and builds the flows | Pruthvi, 2026-09-05 | #bugs thread |
| **WhatsApp rollout = STAFF PILOT first** — allow-listed numbers on the real support number; public is Afshaan's later flip | Afshaan, 2026-09-07 | this spec |
| **Web widget stays staff-gated** in this build (`bot-widget.js:18`); un-gating is Afshaan's separate flip | Afshaan, 2026-09-07 | this spec |
| **No auto-ticket on handoff in v1** — pending the parked *everything-is-a-ticket* build, whose settled D3 (every inbound opens a ticket, auto-closed if not actionable) will cover bot handoffs when it ships. ⚠️ v1 of this spec cited S305 as the authority; that call is scoped to **marketing/utility numbers** and does not govern the support number. | this spec, corrected by review | `2026-09-04-pitstop-everything-is-a-ticket-design.md` §4 D3 |
| The awaiting-reply fix is an **explicit bot marker on the row** (`template_name`), not a widened trigger | S344b | `reference/decisions.md` §awaiting_reply |

## 1. The starting state, measured

**Engine + web bot exist (S312) and are live, staff-gated.**
- `commsops-worker/src/bot-engine.js` — pure `walk()`/`advance()`/`validateBotDef()`, six step types:
  `message` · `menu` · `collect` · `action:order_status` · `handoff` · `end`. Async work is returned
  as **effects** (`order_lookup`, `handoff`) that the route executes and re-enters with
  `action_result` — the pattern every new async need below reuses.
- `bot-web.js` (`runTurn`, `forwardToCsops`, flood check), the public routes `/web/session|message|poll`
  in `index.js:3038-3080` (CORS-locked, 20 msgs/min, 500-char cap), `bot-widget.js` (storefront
  script, gate = first statement, line 18), `bots.js` (CRUD + publish), `bot-order-status.js`
  (verified Shopify + `ecom_shipments` lookup).
- **A builder UI EXISTS**: `apps/relay/src/app/(auth)/journeys/page.js` `?mode=bot` →
  `components/bot-builder/BotBuilder.js` on the shared `journey-canvas/*` (`BOT_NEW_STEP` palette
  at `JourneyCanvas.js:168`, `BotDrawer.js`, bot lint in `graph.js:124-`), with a side-effect-free
  Test panel (`testBotTurn`, `index.js:1090`, which passes ONE definition to `advance()`). ⚠️ The
  2026-09-03 inputs doc said "there is no builder UI at all" — **that was wrong**.
- Tables (`comms`, migration `0058`): `bots`, `bot_versions`, `bot_sessions` (`visitor_key`
  indexed; `profile_id` nullable), `bot_session_steps`. ⛔ **`bots.channel` carries
  `CHECK (channel = 'web')`** (verified live) — the three-value model in §2 needs that CHECK widened
  in the same migration, or the first `whatsapp` insert fails 23514 (the CLAUDE.md enum-drift class).
- Usage: `bots` = 1, `bot_versions` = 1, `bot_sessions` = 5 — all from 2026-08-26, 0 since.

**Send-path sites that enumerate WhatsApp render modes BY NAME** (all must learn `list`, §4):
`gate.js:395` (window check runs only for `text|interactive|media` — an unknown mode is NOT gated,
the opposite of what its comment says) · `send.js:397-403` (builds the render ctx by hand and passes
only `interactiveButtons`) · `adapters/whatsapp.js:115` (an unknown mode falls into the free-text
`else` and is sent as plain text with the options lost).

**WhatsApp inbound is real volume, and it is all human-answered today** (support number, last 7 days):

| inbound messages | threads touched | NEW threads | human agent replies |
|---|---|---|---|
| 4,699 | 722 | 448 | 2,811 |

First inbound message of each new support-number thread, last 30 days (1,891 threads):

| shape | n | share |
|---|---|---|
| bare greeting (`hi`/`hello`/`hey`…) | 795 | 42% |
| the storefront click-to-chat prefill *"hey, could you help me out?"* | 386 | 20% |
| empty / media only | 89 | 5% |
| order-status wording (track/status/where is/deliver/ship…) | 162 | 9% |
| support issue (not working/broken/battery/charging…) | 61 | 3% |
| pre-sales (price/offer/available/stock/COD…) | 41 | 2% |
| returns / refund / replace | 32 | 2% |
| cancel | 18 | 1% |

⭐ **The first message carries no intent 67% of the time; ~17% carries a keyword.** A greeting
menu is the right shape; keyword routing on the first message is the secondary path. Both are
built, in that priority.

**Journeys are live on the same profiles**: 1,045 of 17,663 support-number inbound messages in 30
days (310 customers) arrived while a journey enrolment was live for that profile. The interactive
wait matcher (`journey-workflow.js:864-873`) keys on the **event name** `whatsapp_reply`, not on a
button id — so any tap emitted as `whatsapp_reply` wakes a parked step. csops already refuses to
auto-message mid-journey (`hasActiveEnrolment`, `index.js:7211`); the bot must too (§5.1).

**The Pitstop inbox during a bot session — measured, and it is the biggest thing v1 missed.**
`cs_wa_threads.awaiting_reply` and `has_unread_inbound` are GENERATED columns off
`last_inbound_at`/`last_outbound_at`/`last_read_at`; `last_outbound_at` is bumped by the trigger
`store.cs_touch_thread_outbound` for every outbound row that is not `(template_name NOT NULL AND
sent_by_user_id NULL)` and not `failed`. `cs_routing_config.auto_assign_enabled` is **TRUE on all
four channels** (live; `reference/db-schema.md` said FALSE — corrected 2026-09-07), so
`cs_autoassign_thread` runs on arrival and `retroAssignUnownedThreads` sweeps unassigned open
threads every 10 minutes. Consequence without a thread-level rail: a bot-handled thread shows
unread + awaiting, gets assigned to an agent within minutes, the agent replies, and by the
human-active rule the bot goes silent mid-flow. §5.3 adds the rail.

**What already carries an automated WhatsApp reply**: csops `maybeOutOfHoursAutoreply()` and
`maybeWrongNumberRedirect()` send free text through commsops `/send` (`purpose:'utility'`,
`template:{content:{text_body}}`, `phoneNumberId` = the number written to), stamp `template_name`
with a tag, and enforce "exactly one auto-message per thread per 24h" across both tags.

## 2. Architecture: one engine, one bot per channel, ONE level of shared sub-flow

Considered and rejected:
- *One flow definition serving both channels.* Different top menus per plan; WhatsApp has hard
  limits (3 reply buttons of 20 chars; 10 list rows of 24) the web does not.
- *A separate answers table with an `answer` step.* A second editing surface for what a shared
  sub-flow already delivers.
- *(v1 of this spec) a definition-resolver signature on `advance()` and a depth-3 call stack.*
  Cut by review: the MVP has one shared bot called from two parents (depth 1); the resolver broke
  three live call sites (`bot-web.js:71,82`, `index.js:1090`) and forced a composite `step_id`
  onto analytics. Sub-flow entry/return are **effects**, like `order_lookup`.

**Chosen:**
- `comms.bots.channel` ∈ `web` | `whatsapp` | `shared` (CHECK widened, §5.2 migration). A `shared`
  bot is a sub-flow: entry + steps like any bot, published the same way, never owns a session,
  and **may not itself contain a `subflow` step** (depth 1 — the only depth lint).
- A **`subflow` step** `{type:'subflow', bot_id, next}` in a channel bot. The engine emits effect
  `subflow_enter {bot_id}`; the route loads that bot's `active_version`, records the frame on the
  session (`sub_bot_id`, `sub_version`, `return_step`), and re-enters `advance(subDef, state,
  {kind:'open'})`. From then on the route passes the sub-flow's definition on every turn. A
  sub-flow's `end` emits `subflow_return`; the route clears the frame and walks the parent from
  `return_step`'s `next`. A sub-flow's `handoff` is terminal for the session. `advance()` keeps its
  signature; `current_step` stays a plain step id; `bot_session_steps` gains nothing but the
  session-level frame columns.
- The FAQ tree is authored ONCE as a shared bot. Pruthvi edits and publishes it; both channel
  bots pick up the new version at their **next `subflow_enter`** — no republish of parents, and a
  session already inside the FAQ keeps its pinned version.

## 3. Engine changes (`bot-engine.js`, pure, tests first)

`advance(def, prev, input)` is unchanged in signature. Additions:

1. **`menu.style`** ∈ `buttons` (default) | `list`; list rows may carry `description` (≤72). The
   engine emits `{text, buttons:[{id,label,description?}], style}`; rendering is the adapter's.
   This is Pruthvi's "List" — a menu property, not a new type.
2. **`subflow` step** — §2. Effects `subflow_enter` / `subflow_return`.
3. **Keywords** — bot-level `definition.keywords: [{match:[…], target}]` (case-insensitive
   whole-word/phrase, ≤20 entries), checked at exactly two moments: (a) the **first customer
   message** that opens a session, before the greeting walk (`{kind:'open', text}`), so *"where is
   my order"* skips the menu; (b) at a **`collect` step, only when validation fails** — so *"agent"*
   typed at the order-number prompt escapes. Never at a menu (buttons are on screen) and never on
   valid `collect` input. ⚠️ v1 checked on menu misses; cut by review — the value is in the first
   message, and interleaving with `menu_misses` is the fiddliest state in the file.
4. **`collect` gets a `fallback` handle + a miss cap.** Two failed validations (reusing
   `MAX_MENU_MISSES`) walk `fallback` (lint requires it wired, as for `menu`). Today a `collect` is
   an inescapable loop: `bot-engine.js:67-80` re-prompts forever, and a media message (→ empty
   text) or a stale button tap both fail `ORDER_RE`.
5. **The order-attempt cap hands off; it never ends with an email address.** `bot-engine.js:104-106`
   sets `status='ended'` and says *"Please write to support@…"* — on the support WhatsApp number
   the customer is already on. At `MAX_ORDER_ATTEMPTS` the engine now emits the `handoff` effect
   with the handoff copy (authorable on the action step as `text_exhausted`; default = the
   existing handoff default). Both channels. `identity_mismatch` reaches this path on WhatsApp for
   any order placed with a different phone (gift, family, null Shopify `phone`), so it is not rare.
6. **`handoff` copy is single and honest** (*"a human will reply right here as soon as one is
   available"* — the existing default promises no timing). The hours-aware second copy (web
   residual ④) is **DEFERRED** with the `/internal/on-shift` route it needed (§6); its documented
   failure mode was identical to not calling it.
7. **`input.kind==='expire'`** → status `ended`, no replies (route-driven, §5.3).

**Cut from v1 of this spec (review):** `message.delay_ms` (dead on WhatsApp, cosmetic on web —
defer); the "shared bot may not `collect phone_or_email`" lint (no possible violator in the MVP).

`validateBotDef(def, {channel})` — `publishBot` (`bots.js:29`) passes the bot's channel — gains:
- `whatsapp`: `buttons`-style menu with >3 buttons · button label >20 · list with >10 rows · row
  title >24 · row description >72 · menu text >1,024.
- all: `subflow` target must be a published `shared` bot (the route passes the set of published
  shared ids in the options) · a `shared` bot containing a `subflow` step · keyword `target` not a
  step id · `collect.fallback` unwired · `action.text_exhausted` over 1,024.

Tests: traversal into and out of a sub-flow via effects · handoff inside a sub-flow ends the
session · shared-containing-subflow lint · keyword on first message skips the greeting · keyword
at a failed collect · valid collect input ignores keywords · collect miss cap → fallback · order
attempt cap → handoff effect · list-style menu emits rows · expire · every lint rule above.

## 4. WhatsApp adapter — three files, not one (`render.js`, `adapters/whatsapp.js`, `send.js`, `gate.js`)

- **`render.js`** `renderWhatsapp`: `mode:'list'` when `ctx.interactiveList` is present;
  `interactive` when `ctx.interactiveButtons` (unchanged); else text.
- **`send.js:402`**: the hand-built render ctx passes `interactiveList: isTemplate ? null :
  (opts.interactiveList || null)` beside `interactiveButtons`. Without this the list never reaches
  the renderer and the customer gets a body with no rows.
- **`gate.js:395`**: `list` joins `text|interactive|media` in the window predicate. The comment
  says a new mode must opt IN to sending outside the window; the code does the opposite — an
  unlisted mode is NOT gated. Fix the predicate and the comment together.
- **`adapters/whatsapp.js`**: new `list` branch → Meta `interactive.type='list'`: `body.text`,
  `action.button` (≤20, authorable, default "Choose"), one section, rows `{id, title≤24,
  description≤72}` ≤10, truncated never rejected; `window_closed` → skipped. The trailing `else`
  catch-all (`:115`) becomes an explicit `text` branch plus `{status:'failed',
  reason:'unknown_render_mode'}` for anything else — silently downgrading a menu to prose is the
  failure this spec would otherwise ship.
- `parseInbound` already reads `interactive.list_reply` into `button_id`/`text` — no change.
- **Button/row id namespace on the wire: `bot:<step_id>:<handle>`.** The **adapter call in
  `bot-wa.js`** namespaces on send; **`bot-wa.js` strips `^bot:[^:]+:` on ingress** before building
  `{kind:'button', buttonId}` — `bot-engine.js:84` matches `b.id === input.buttonId` on the raw
  handle and there is no label fallback for `kind:'button'`, so an un-stripped id is a menu miss
  on every tap. Round-trip pinned by test.
- **`wa-webhooks.js:367-377` does NOT emit `whatsapp_reply` for a `bot:`-prefixed `button_id`.**
  The matcher keys on the event name; a bot tap emitted as `whatsapp_reply` would resolve a parked
  C2P/interactive step to `no_reply` and delete its wait (the ₹75,216 class). `whatsapp_inbound`
  is still emitted (inbox, window, analytics all key off it), and `detectOptOut` still runs on the
  tap's text.
- Tests: `test/wa-list.test.js` (payload shape, caps, window-closed skip, gate refuses an
  out-of-window list, unknown mode fails); `test/wa-interactive.test.js` extended for the `bot:`
  passthrough + strip; a `wa-webhooks` test asserting no `whatsapp_reply` for `bot:` ids.

## 5. WhatsApp ingress — `bot-wa.js` (new)

Hooked into `wa-webhooks.js handleInbound()` **after** the window upsert, ingest and STOP/START,
and **before** `forwardToCsops` — every substrate write and the opt-out guarantee are untouched,
and the forward carries what the bot said.

### 5.1 Engage conditions (all must hold; any failure = silent, forward exactly as today)
1. `m.phone_number_id` is the **support number** — resolved from `comms.sender_identities`
   (`channel=whatsapp, purpose=utility, status=active`, exactly one row, fail closed).
2. Exactly one bot with `channel='whatsapp'` and `status='active'` (two = log + no-op).
3. **Pilot gate**: `bots.config.mode` ∈ `pilot` (default) | `public`; in `pilot`, `m.from` must be
   in `bots.config.pilot_numbers`. ⚠️ **`mode` and `pilot_numbers` are written ONLY by a new
   `setBotMode` action gated `canActivate`** — `saveBot` (`canBuild`) strips them from `config`.
   Public is Afshaan's flip, and `saveBot` writing `config` wholesale would have let any builder
   flip it (author's own finding).
4. Not a STOP/START keyword (`detectOptOut` ran; a withdrawal is answered by nothing, as today).
5. **No human on the thread**: read `store.cs_wa_threads.last_outbound_at` for
   `(customer_phone, waba_phone_number_id)` via `A.sbStore` — ONE round trip, and it is exactly
   the trigger's definition of a human/agent reply (bot rows never bump it, §5.5). Engage if it is
   NULL or older than **12 h**. ⭐ **Thread not found = no human = ENGAGE** — this is the 62% case
   (new threads), because the bot runs before the forward creates the thread. Only a non-2xx read
   is "check failed → do not engage".
6. **No live journey enrolment for the profile** — the same predicate as csops
   `hasActiveEnrolment` (`comms.enrolments` for the profile `ingest()` just resolved, not ended).
   Mid-journey customers keep going to agents, as today.
7. Message is text, a button/list reply, or a bare media message (media → empty text; the bot
   re-shows where it is, never interprets a photo).

### 5.2 Session identity + idempotency
Migration `0068_comms_bots_channels.sql`: `bots` CHECK widened to `('web','whatsapp','shared')`;
`bot_sessions` + `channel text NOT NULL DEFAULT 'web'`, `wa_from text`, `phone_number_id text`,
`sub_bot_id uuid`, `sub_version int`, `return_step text`; partial unique index
`(wa_from, phone_number_id) WHERE channel='whatsapp' AND status='active'`;
`bot_session_steps` + `provider_message_id text` with a unique partial index `WHERE
provider_message_id IS NOT NULL`. `NOTIFY pgrst, 'reload schema'` in the migration.
- **Every WhatsApp turn is claimed first**: insert the `customer_message` step row carrying the
  inbound `provider_message_id` **before** `advance()`; a unique violation = this message was
  already processed (Meta redelivery after a 5xx, or a concurrent invocation) → skip the turn
  entirely. The unique index on active sessions covers only session *creation*; this covers the
  far commoner concurrent advance. `send()`'s `dedupKey` is `bot:<session>:<provider_message_id>:<i>`
  so a retried turn cannot double-send either.
- Active session → `advance()` with `{kind:'text'|'button'}`; none → new session on the bot's
  `active_version`, `advance()` with `{kind:'open', text}` (keyword check on the first message).
- Identity is **known**: `profile_id` = the profile `ingest()` just resolved for `+<wa_id>`;
  `context.identity = {phone}` is pre-filled from `m.from`, so the WhatsApp bot never collects a
  phone before `order_status` — the order's phone must match the sender's (the enumeration guard
  is unchanged; the order number is still collected and verified).

### 5.3 Session lifecycle and the inbox rail
- **Idle expiry 6 h**: on any inbound, an active session with `last_activity_at` older than 6 h is
  ended (`expire`) and a fresh one opens.
- **Agent supremacy**: §5.1.5 silences the bot the moment a human has replied; the session is then
  patched `handed_off` (one-way).
- **The thread rail — `store.cs_wa_threads.bot_active boolean NOT NULL DEFAULT false`** (csops
  migration, same session). csops sets it from the forward (§5.5):
  - `bot.session_status='active'` → `bot_active=true`; **`cs_autoassign_thread` is skipped on
    arrival and `retroAssignUnownedThreads` excludes `bot_active=true`**; the inbox's Awaiting and
    unread filters exclude it too, and the thread row shows a **"Bot"** badge instead. The customer
    is talking to the bot; nobody should be assigned it.
  - `handoff=true` → `bot_active=false`, thread open + unassigned, `awaiting_reply` is true by
    construction (the bot never bumped `last_outbound_at`); the 10-minute `retroAssignUnownedThreads`
    sweep picks it up — exactly the queue behaviour a fresh WhatsApp inbound gets today. ⚠️ v1 of this
    spec said "autoassign runs on that same request": **wrong for the relay-wa path** — no arrival-time
    `cs_autoassign_thread` call exists there (only `metaMessageCreated` and the Gmail poller call it
    on arrival; verified 2026-09-07). No ticket in v1 (§0).
  - **Sticky handoff (engage condition 8, added by the plan review):** while the newest session for
    the customer is `handed_off` and under 6 h idle, the bot does not engage on further messages — the
    customer asked for a human and is waiting; re-greeting them would also re-hide the thread.
  - An agent who closes, snoozes or claims a `bot_active` thread **by hand** (no message row) clears the
    rail via a `BEFORE UPDATE` trigger; the counting RPCs behind the topbar pills exclude `bot_active`
    the same way the list filter does.
  - `session_status='ended'` (customer self-served, e.g. read an FAQ and stopped) →
    `bot_active=false` and the thread is **closed** with `closed_reason='bot_resolved'`. A closed
    thread re-opens on the customer's next inbound exactly as today; without the close, every
    self-served thread would sit in the Awaiting queue forever (measured: ~450 new threads/week at
    public).
  - Any human outbound on the thread (existing agent send paths) → `bot_active=false`.
  ⚠️ This is the single largest addition over v1 and it is not optional: without it the pilot
  looks fine (staff threads) and the public flip floods the queue.

### 5.4 Replies
Every reply goes through `send(env, {channel:'whatsapp', purpose:'utility', to:'+<wa_id>',
phoneNumberId, template:{content:{text_body}}, interactiveButtons | interactiveList,
dedupKey:'bot:<session>:<provider_message_id>:<i>', source:'relay_bot'})` — the standard gate
(suppression → consent → frequency cap → quiet hours [bypassed for utility, deliberately, as the
OOO reply does] → channel rule → **24h window, once §4's `gate.js` fix lands**). A reply that comes
back `skipped`/`failed` is logged on the step row; the turn still persists so the next message is
understood.

### 5.5 The transcript (Pitstop is the consumption surface)
The forward payload to csops `/webhooks/relay-wa` gains, per message, an optional
`bot: {session_id, session_status:'active'|'handed_off'|'ended', replies:[{text, buttons?}],
handoff:bool, handled:true}`. csops `relayWaIngestInbound` then:
- writes the customer's inbound row exactly as today;
- writes one outbound row per reply — `direction='outbound'`, `kind='text'`, `body` = text plus
  numbered options, `template_name='relay_bot'`, `sent_by_user_id NULL`, `sent_by_name='Relay
  (bot)'`, `waba_phone_number_id`, `status='sent'`, `sent_at` after the inbound's `received_at`;
- ⚠️ **every row in a bulk insert carries the SAME key set** — `template_name: direction==='outbound'
  ? 'relay_bot' : null` on inbound rows too. PostgREST rejects heterogeneous bulk inserts with
  PGRST102 and this file lost whole turns to exactly that in S312 (`index.js:6797-6809`);
- **skips** `maybeWrongNumberRedirect` and `maybeOutOfHoursAutoreply` when `bot.handled` (the bot
  IS the auto-message; "exactly one auto-reply" holds);
- applies the §5.3 rail (`bot_active`, close on `ended`, re-open on `handoff` via `clearClosedFields`).
`template_name='relay_bot'` is the explicit marker the trigger needs: NOT-NULL template + NULL user
= automated, `last_outbound_at` untouched. `handleRelayWebForward` sets the same tag on its
outbound rows (same-key-set rule applies there too) — closing the latent decisions.md hole.
`relay_bot` is added to nothing else: the OOO/redirect 24h key filters on its own two tags.

**Answer to Afshaan's open Q3 (transcript inline before takeover): yes, by construction.**

### 5.6 What the forward must not lose
`forwardToCsops` is best-effort and runs once after the loop. If the route throws mid-loop (the
deliberate STOP-ingest throw at `wa-webhooks.js:336`), messages already botted have replied but
their transcript is not forwarded until Meta redelivers — and on redelivery §5.2's claim makes the
bot skip them, so those lines reach the transcript only via `bot_session_steps`. Accepted for v1:
the customer-facing path wins; the step rows are the audit copy. Recorded so it is not re-found.

## 6. Web bot — residuals (gate untouched)

- ① **Email-only identity reaches the thread.** `handleRelayWebForward` sets `customer_handle` to
  the email on create; it now also PATCHes `customer_handle` when a later turn collects an email on
  a "Web visitor" thread (mirror of the phone PATCH). No `customer_email` column exists on
  `cs_wa_threads` — do not add one.
- ② **Session survives navigation.** `bot-widget.js` stores `{session_id, bot_id}` in
  `localStorage.lot_chat_session`; on load it calls `POST /web/session` (`index.js:3038`) with
  `{resume: session_id}`; the route returns the existing session when `active` and under 6 h idle,
  else a new one. **The redraw payload is `bot_message` + `agent_reply` rows only** — never
  `customer_message` rows (they hold the typed phone/email). The session id is the bearer, as it
  already is for `/web/poll`; `loadSession` still validates the UUID shape.
- ④ **Hours-aware handoff copy — DEFERRED** (§3.6). Afshaan folded ①②④ into this build (S352);
  ④ is dropped from it by this review because its only delivery route was a new cross-worker call
  whose failure mode equals not calling it. Re-file it when the parked ticket design lands.
- `list`-style menus render on the web as a stacked full-width option list with descriptions.
- The widget's first line (`if (!staff) return;`) is **not touched**.

## 7. Builder UI (`apps/relay`)

- `BOT_NEW_STEP` gains `subflow`; `menu` gets a `style` toggle and per-row description; `collect`
  gets a `fallback` handle; `action:order_status` gets `text_exhausted`.
- A **bot settings drawer**: channel · keywords table · (activate-tier only) pilot mode + pilot
  numbers via `setBotMode` · the WhatsApp number it answers on, read-only from `sender_identities`.
- `subflow` picker lists only published `shared` bots; the bot list shows a "Shared" badge.
- `graph.js` bot lint mirrors §3's channel lint client-side; the server stays the authority.
- Test panel: `testBotTurn` API unchanged; when the draft emits `subflow_enter` the panel loads the
  shared bot's active version and continues, mirroring the route.
- Bot list gains a channel column and `bot_stats` a channel filter.
- **Cut (review):** "used by N bots" count, the test-panel channel selector.
- Permissions unchanged except `setBotMode` (activate tier).

## 8. Content seed + pilot

Pruthvi owns the words; this build seeds the **structure**:
- `shared` bot **"FAQ"** — list-style menu (shipping time, COD / payment options, warranty, return
  window, playtime) → one `message` each with `[Pruthvi: answer]` placeholder → `end`.
- `whatsapp` bot **"Support assistant"** (`mode: pilot`, `pilot_numbers` = Afshaan `917709991011`
  + Pruthvi + the CS members Pruthvi names) — greeting `menu` (buttons): *Track my order* →
  `collect order_number` (fallback → handoff) → `action:order_status` → found: end · not_found:
  menu (try again / chat with an agent) · exhausted: handoff · *FAQs* → `subflow FAQ` → next:
  greeting menu · *Chat with an agent* → `handoff`. Keywords: track/status/where → order branch;
  cancel/return/refund/agent/human → handoff.
- The existing `web` bot gains *FAQs* → `subflow FAQ` and an *Ask a question* list of Pruthvi's
  curated questions → unmatched → handoff. Web stays behind the gate.

**Smoke (in-session, surface order per CLAUDE.md), from Afshaan's number on the real support number
— ⚠️ the pilot number must have no agent reply in the prior 12 h or §5.1.5 keeps the bot silent:**
greeting → FAQ list → answer → back to menu → track a real order → wrong order number twice →
fallback → handoff → thread appears unassigned + awaiting in Pitstop, badge gone → agent reply →
bot silent afterwards; an FAQ-only session ends → thread closed `bot_resolved`; STOP still opts out
and gets no bot reply; a non-pilot number gets no bot reply and the normal OOO behaviour; a Meta
redelivery (replayed webhook body) produces no second reply. Web: `?lotchat=1`, navigate between
two PDPs mid-session, email identity, handoff, Pitstop reply. Every step row, `cs_wa_messages`
tag and `bot_active` transition checked in SQL.

## 9. Out of scope (v1) — say so when Pruthvi asks
API-call node · Google Sheet · LLM intent · order cancel/modify/re-order/confirm-address ·
Catalogue/Product-select/Payment/Template nodes · auto-ticket on handoff (pending D3) · public
WhatsApp mode (activate-tier flip) · web un-gating (one-line flip) · Instagram/Messenger entry
points · a `bot_answers` table · nested sub-flows · `delay_ms` · hours-aware handoff copy.

## 10. Risks
- **The bot answers on a number carrying ~450 new customer threads a week.** Pilot mode, the
  human-active check and the enrolment check are the controls. Public is a deliberate flip.
- **A sub-flow republished mid-day changes both channels at once.** By design; sessions pin
  versions. Recorded so nobody "fixes" it.
- **`template_name='relay_bot'` and `bot_active` are both load-bearing.** A future path writing bot
  rows without the tag re-opens the awaiting hole; a path setting `bot_active` without clearing it
  hides a thread from every agent. Both pinned by csops tests (a bot row leaves `last_outbound_at`
  untouched; `ended`/`handoff`/human-outbound each clear `bot_active`).
- **Meta's `list` payload contract** (10 rows / 24 / 72 / 20) was taken from memory, not verified
  against the current docs — verify at implementation before the first live send.

## 11. Hostile-review log (2026-09-07, v1 → v2)
Independent reviewer (Opus, high, read-only) + the author. All accepted; where the spec changed, the
section is named.
1. `bots.channel` CHECK = `'web'` only → §1, §5.2 migration.
2. Journey wait matcher keys on event name; 1,045 msgs/30d mid-enrolment → §1, §4 (no
   `whatsapp_reply` for `bot:` ids), §5.1.6.
3. `bot:` wire id never decoded → menu miss on every tap → §4 strip on ingress.
4. No per-message idempotency; redelivery/concurrency double-advance → §5.2 claim-first row.
5. Bot-handled threads stay awaiting/unread and get auto-assigned → §5.3 `bot_active` rail + close
   on `ended`.
6. `gate.js` skips the window check for an unlisted mode → §4.
7. `send.js` drops `interactiveList` → §4.
8. `collect` is an inescapable loop → §3.4 fallback + cap, §3.3 keywords at failed collect.
9. Order-attempt cap ends with an email address → §3.5 handoff.
10. Same-key-set rule for the bulk insert (PGRST102) → §5.5.
11. `resume` would expose typed identity → §6②.
12. "check failed → do not engage" ambiguous for new threads → §5.1.5.
13. S305 mis-cited; D3 says the opposite → §0.
14. Resolver map + depth-3 stack cut → §2 effects, depth 1.
15. Cut keyword-at-menu-miss, `delay_ms`, the shared-collect lint, "used by N", the channel
    selector; defer `/internal/on-shift` → §3, §6, §7.
16. (author) `saveBot` writes `config` wholesale, so any builder could flip pilot → public → §5.1.3
    `setBotMode`.
Knowledge-layer correction made alongside: `reference/db-schema.md` note on
`cs_routing_config.auto_assign_enabled` (said FALSE on all 3; live TRUE on all 4).

**Plan review, same day (2026-09-07, 22 findings on the implementation plan, log in
`docs/superpowers/plans/2026-09-07-relay-flowbots-wa-web.md`) — the ones that changed THIS spec:**
§5.3 autoassign sentence corrected (relay-wa has no arrival-time autoassign); sticky handoff added as
engage condition 8; manual close/assign clears `bot_active`; the counting RPCs exclude `bot_active`;
web threads get the `relay_bot` tag but no rail until the web un-gate (recorded in the backlog item);
a collect with no wired fallback hands off rather than going silent; the order-attempt cap and the
unwired-collect case both use the single handoff copy.
