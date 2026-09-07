# Relay — the two flow bots (WhatsApp + Web) on one engine: design

> **Status: APPROVED DESIGN, ready for an implementation plan** (S355, 2026-09-07, Afshaan).
> Supersedes the *inputs* document `2026-09-03-relay-wa-flowbot-design.md` (which was deliberately
> not scoped) and extends the S312 `2026-08-26-bot-builder-design.md` (the engine this builds on).
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
| No auto-ticket on handoff (S305 reversal stands) | S312 spec, unchanged | `2026-08-26-bot-builder-design.md` §Out of scope |

## 1. The starting state, measured

**Engine + web bot exist (S312) and are live, staff-gated.**
- `commsops-worker/src/bot-engine.js` — pure `walk()`/`advance()`/`validateBotDef()`, six step types:
  `message` · `menu` · `collect` · `action:order_status` · `handoff` · `end`.
- `bot-web.js` (public `/web/session|message|poll`, CORS-locked, 20 msgs/min, 500-char cap),
  `bot-widget.js` (storefront script, gate = first statement), `bots.js` (CRUD + publish),
  `bot-order-status.js` (verified Shopify + `ecom_shipments` lookup).
- **A builder UI EXISTS**: `apps/relay/src/app/(auth)/journeys/page.js` `?mode=bot` →
  `components/bot-builder/BotBuilder.js` (270 lines) on the shared `journey-canvas/*`
  (`BOT_NEW_STEP` palette at `JourneyCanvas.js:168`, `BotDrawer.js`, bot lint in `graph.js:124-`),
  with a side-effect-free Test panel (`testBotTurn`). ⚠️ The 2026-09-03 inputs doc said "there is no
  builder UI at all" — **that was wrong**; `systems/relay.md` §Bot builder was right.
- Tables (`comms`, migration `0058`): `bots` (already has a `channel text` column), `bot_versions`,
  `bot_sessions` (`visitor_key` indexed; `profile_id` nullable), `bot_session_steps`.
- Usage: `bots` = 1, `bot_versions` = 1, `bot_sessions` = 5 — all from 2026-08-26, 0 since.

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

⭐ **Consequence: the first message carries no intent 67% of the time.** A greeting menu is the
right shape; keyword routing is a secondary path (~15% of first messages carry a keyword). Both
are built, in that priority.

**What already carries an automated WhatsApp reply**: csops `maybeOutOfHoursAutoreply()` and
`maybeWrongNumberRedirect()` send free text through commsops `/send` (`purpose:'utility'`,
`template:{content:{text_body}}`, `phoneNumberId` = the number written to), stamp the row's
`template_name` with a tag (`out_of_hours_autoreply` / `wrong_number_redirect`), and enforce
"exactly one auto-message per thread per 24h" across both tags. The bot slots into this world.

**The trigger that will misread bot rows**: `store.cs_touch_thread_outbound()` treats an outbound
row as a human reply unless `template_name IS NOT NULL AND sent_by_user_id IS NULL`. The web bot's
rows today (`sent_by_name='Relay (bot)'`, `template_name` NULL) therefore clear "customer is
waiting" on every bot turn — latent (5 sessions ever), recorded in `reference/decisions.md`
§awaiting_reply as *"the fix is an explicit bot marker on the row"*. This build adds that marker.

## 2. Architecture: one engine, one bot per channel, shared sub-flows

Considered and rejected:
- *One flow definition serving both channels.* The two plans want different top menus, and
  WhatsApp has hard limits (3 reply buttons of 20 chars; 10 list rows) the web widget does not.
  One definition would be linted to the stricter channel everywhere.
- *A separate answers table (`bot_answers`) with an `answer` step.* A second editing surface for
  the same outcome that a shared sub-flow already delivers. Not built.

**Chosen:**
- `comms.bots.channel` ∈ `web` | `whatsapp` | `shared`. A `shared` bot is a sub-flow: it has an
  entry and steps like any bot, is published the same way, but never owns a session.
- A **`subflow` step** in a `web`/`whatsapp` bot jumps into a `shared` bot at runtime and returns
  to the caller's `next` handle when the sub-flow reaches `end`. The FAQ tree is authored ONCE as a
  shared bot and referenced from both channel bots. Pruthvi edits and publishes the FAQ bot; both
  channel bots pick up the new version on their **next session** — no republish of the parents.
- Sessions pin the version of every bot they enter (`bot_versions` is immutable), so a session
  mid-flow is never moved under its feet.

## 3. Engine changes (`bot-engine.js`, pure, tests first)

All of these keep the file free of I/O. `advance(defs, prev, input)` now takes a **definition
resolver** — a plain object `{ [bot_id]: { version, definition } }` the route pre-loads — instead of
one definition, so the engine stays pure and sub-flows stay testable.

1. **`menu.style`** ∈ `buttons` (default) | `list`. List rows may carry a `description` (≤72 chars).
   Rendering is the adapter's job (§4, §6); the engine only emits `{text, buttons:[{id,label,description?}], style}`.
   This is Pruthvi's "List" node — a menu property, not a new type.
2. **`subflow` step** `{type:'subflow', bot_id, next}`. Session state gains `stack:[{bot_id, version,
   return_step}]`, max depth **3** (deeper = lint error at publish, and a runtime guard that treats
   the 4th push as `end`). `walk()` resolves step ids against the definition at the top of the
   stack. A sub-flow's `end` pops and continues at `return_step`'s `next`; a sub-flow's `handoff`
   is terminal for the whole session (agent supremacy does not care which flow raised it).
   `current_step` is stored as `bot_id/step_id` when the stack is non-empty so `bot_session_steps`
   analytics can attribute drop-offs to the sub-flow.
3. **Keywords** — bot-level `definition.keywords: [{match:[…], target}]` (case-insensitive whole-word
   or phrase match, ≤20 entries). Checked at exactly two moments: on the **first customer message**
   that opens a session (before the greeting walk, so *"where is my order"* skips the menu), and on a
   **menu miss** before the miss is counted. Never checked at a `collect` (a phone number is not a
   keyword). This is Pruthvi's "Keyword Action".
4. **`message.delay_ms`** (0–3000) — emitted on the reply; the web widget shows a typing indicator
   for that long, the WhatsApp adapter ignores it. Pruthvi's "Add Delay" as a property, not a node.
5. **`handoff.text_out_of_hours`** — authorable second copy. The route decides which to emit from an
   `on_shift` boolean it passes in the input (§5.4). Closes web residual ④.
6. **Session expiry** is a route concern (§5.3), but the engine gains `input.kind==='expire'` →
   status `ended` with no replies, so the step row is written by the same path.

`validateBotDef(def, {channel, resolve})` gains channel lint (publish-blocking):
- `whatsapp`: a `buttons`-style menu with >3 buttons · a button label >20 chars · a list with >10
  rows · a row title >24 chars · a row description >72 chars · any menu text >1,024 chars.
- all channels: `subflow` whose target is not a published `shared` bot · sub-flow depth >3 (the
  resolver walks the graph) · keyword `target` not a step id · a `shared` bot that contains a
  `collect` of `phone_or_email` (identity is collected by the channel bot, once).

Tests (`test/bot-engine.test.js`, `test/bot-subflow.test.js`, `test/bot-keywords.test.js`):
traversal into and out of a sub-flow · handoff inside a sub-flow ends the session · depth guard ·
keyword on first message skips the greeting · keyword on a menu miss does not count as a miss ·
list-style menu renders rows · out-of-hours handoff copy · expire · every lint rule above.

## 4. WhatsApp adapter (`adapters/whatsapp.js`, `render.js`)

- New render mode **`list`** → Meta `interactive.type='list'`: `body.text`, `action.button`
  (≤20 chars, authorable, default "Choose"), one section, rows `{id, title≤24, description≤72}` ≤10.
  Same 24h-window rule as `interactive` (`window_closed` → skipped). Titles/descriptions are
  truncated, never rejected — same reasoning as the existing button branch.
- `render.js` `renderWhatsapp` picks `list` when `ctx.interactiveList` is present, `interactive`
  when `ctx.interactiveButtons` is present (unchanged), else text.
- `parseInbound` already reads `interactive.list_reply` into `button_id`/`text` — no change.
- **Button/row id namespace: `bot:<step_id>:<handle>`.** `wa-webhooks.js` still emits the
  `whatsapp_reply` event for any `button_id` (harmless — no journey waits on a `bot:` id) and
  `C2P.isConfirmButton` cannot match it, so nothing collides.
- Tests: `test/wa-list.test.js` (payload shape, caps, window-closed skip); extend
  `test/wa-interactive.test.js` for the `bot:` id passthrough.

## 5. WhatsApp ingress — `bot-wa.js` (new)

Hooked into `wa-webhooks.js handleInbound()` **after** the window upsert, ingest, STOP/START and
the `whatsapp_reply` event, and **before** `forwardToCsops` — so every substrate write and the
opt-out guarantee are untouched, and the forward can carry what the bot said.

### 5.1 Engage conditions (all must hold, evaluated per inbound message)
1. `m.phone_number_id` is the **support number** — resolved from `comms.sender_identities`
   (`channel=whatsapp, purpose=utility, status=active`, exactly one row, fail closed), never hardcoded.
   Same rule and same reason as `maybeOutOfHoursAutoreply`.
2. A bot with `channel='whatsapp'` and `status='active'` exists (exactly one; two = log + no-op).
3. **Pilot gate**: `bots.config.mode` ∈ `pilot` (default) | `public`. In `pilot`, `m.from` must be
   in `bots.config.pilot_numbers` (E.164 digits). Public is the same one-field flip pattern as the
   web widget's gate line — Afshaan's call.
4. The message is not a STOP/START keyword (`detectOptOut` already ran; a withdrawal is answered
   by nothing, exactly as today).
5. **No human on the thread**: no outbound row in `store.cs_wa_messages` for this
   `(customer_phone, waba_phone_number_id)` thread with `sent_by_user_id IS NOT NULL` in the last
   **12 h** — the same signal and window csops uses for `human_active`. commsops reads it via
   `A.sbStore` (service role, read-only here). If the check itself fails → **do not engage**.
6. The message is text, a button/list reply, or a bare media message (media → treated as an empty
   text: the bot re-shows where it is; it never tries to interpret a photo).

If any condition fails the bot is silent and the forward happens exactly as today.

### 5.2 Session identity
`bot_sessions` gains `channel text NOT NULL DEFAULT 'web'`, `wa_from text`, `phone_number_id text`
(migration `0068_comms_bots_channels.sql`, plus a partial unique index
`(wa_from, phone_number_id) WHERE channel='whatsapp' AND status='active'` so two concurrent
inbounds cannot open two live sessions). `visitor_key` stays web-only.
- Active session found → `advance()` with `{kind:'text'|'button'}`.
- None found → new session on the bot's `active_version`, `advance()` with
  `{kind:'open', text: m.text}` so the keyword check (§3.3) sees the first message.
- Identity is **known** on WhatsApp: the session's `profile_id` is the profile `ingest()` just
  resolved for `+<wa_id>` (`is_verified` on that identifier is whatever it already is — the bot
  adds nothing). `context.identity = {phone}` is pre-filled from `m.from`, so the WhatsApp bot
  never needs a `collect phone_or_email` step before `order_status`: the order's phone must match
  the sender's. (Order number is still collected and still verified — the enumeration guard is
  unchanged.)

### 5.3 Session lifecycle
- **Idle expiry 6 h**: on any inbound, an active session with `last_activity_at` older than 6 h is
  ended (`input.kind='expire'`) and a fresh one opens. A customer who says "hi" next morning gets
  the greeting again rather than a stale "please pick an option".
- **Agent supremacy**: condition 5.1.5 makes the bot silent the moment a human has replied; the
  session is then patched `handed_off` (one-way) so analytics count it correctly.
- **Handoff step**: session `handed_off`, the forward carries `handoff:true` (§5.5); the thread
  sits unassigned in the inbox and `cs_autoassign_thread` runs exactly as it does for every
  inbound today. No ticket is created (S305).

### 5.4 Replies
Every reply goes through `send(env, {channel:'whatsapp', purpose:'utility', to:'+<wa_id>',
phoneNumberId, template:{content:{text_body}}, interactiveButtons | interactiveList,
dedupKey:'bot:<session>:<turn>:<i>', source:'relay_bot'})` — i.e. the **same gate every other
WhatsApp send passes** (suppression → consent → frequency cap → quiet hours [bypassed for utility,
deliberately, same as the OOO reply] → channel rule → 24h window). A reply that comes back
`skipped`/`failed` is logged on the session step row; the turn still persists so the customer's
next message is understood.
`on_shift` for the handoff copy (§3.5): commsops calls csops `GET /internal/on-shift` (new,
`CSOPS_WA_FORWARD_TOKEN`-authed, returns `{on_shift:bool}` off the existing `anyoneOnShiftNow`)
over the `CSOPS` binding; on any error → `on_shift:true` (the in-hours copy is the safe default:
it promises nothing about timing).

### 5.5 The transcript (Pitstop is the consumption surface)
The existing forward payload to csops `/webhooks/relay-wa` gains, per message, an optional
`bot: {session_id, replies:[{text, buttons?}], handoff:bool, handled:true}`.
csops `relayWaIngestInbound` then:
- writes the customer's inbound row exactly as today;
- writes one outbound row per reply: `direction='outbound'`, `kind='text'`, `body` = text plus
  the numbered options (same flattening the web path uses), `template_name='relay_bot'`,
  `sent_by_user_id NULL`, `sent_by_name='Relay (bot)'`, `waba_phone_number_id`, `status='sent'`;
- **skips** `maybeWrongNumberRedirect` and `maybeOutOfHoursAutoreply` when `bot.handled` is true
  (the bot IS the auto-message for that inbound; "exactly one auto-reply" holds);
- on `handoff:true` re-opens a closed thread (`clearClosedFields`, as the web path does).
`template_name='relay_bot'` is the explicit bot marker the awaiting-reply trigger needs: the row
is NOT NULL-template + NULL-user, so it counts as automated and never clears "customer waiting".
The web forward (`handleRelayWebForward`) sets the same tag on its outbound rows — that closes
the latent hole. ⚠️ `relay_bot` must be added to nothing else: the OOO/redirect 24h key filters
on its own two tags and must not treat a bot turn as "already auto-messaged".

**Answer to Afshaan's open Q3 (transcript inline before takeover): yes, by construction** — every
bot line is a `cs_wa_messages` row in the thread the agent opens.

### 5.6 What the forward must not lose
`forwardToCsops` is best-effort (a csops outage never 500s Meta). If the forward fails after the
bot has already sent, the customer got their reply and the transcript is missing the bot's lines
until the next successful turn. Accepted: the customer-facing path is prioritised over the
transcript, and the session steps in `bot_session_steps` remain the audit copy.

## 6. Web bot — the three residuals (gate untouched)

- ① **Email-only identity reaches the thread.** `handleRelayWebForward` already sets
  `customer_handle` to the email on create; it now also PATCHes `customer_handle` when a later turn
  collects an email on a thread created as "Web visitor" (mirror of the phone PATCH at line ~7). No
  `customer_email` column exists on `cs_wa_threads` — do not add one; `external_user_id` is the
  email-channel convention and stays email-channel.
- ② **Session survives navigation.** `bot-widget.js` stores `{session_id, bot_id}` in
  `localStorage.lot_chat_session`; on load it calls `POST /web/session` with `{resume: session_id}`
  and `bot-web.js` returns the existing session (status + last 20 step rows to redraw) when it is
  `active` and under 6 h idle, else opens a new one. Same 6 h rule as WhatsApp.
- ④ **Hours-aware handoff copy** — §3.5 + §5.4 (`/internal/on-shift`), used by the web route too.
- `list`-style menus render on the web as a stacked full-width option list with descriptions;
  `delay_ms` shows a typing indicator.
- The widget's first line (`if (!staff) return;`) is **not touched**.

## 7. Builder UI (`apps/relay`)

- `BOT_NEW_STEP` gains `subflow`; `menu` gets a `style` toggle and per-row description; `message`
  gets `delay_ms`; `handoff` gets the second text box.
- A **bot settings drawer** (channel · keywords table · pilot mode + pilot numbers · the WhatsApp
  number it answers on, read-only, resolved from `sender_identities`).
- `subflow` picker lists only published `shared` bots; the bot list shows a "used by N bots"
  count on shared bots and a "Shared" badge.
- `graph.js` bot lint mirrors §3's channel lint client-side so the author sees it before publish;
  the server-side `validateBotDef` remains the authority.
- Test panel: unchanged API (`testBotTurn`), but the request carries the resolver map so sub-flows
  work in the panel; a channel selector previews the WhatsApp truncation.
- Bot list gains a channel column and a channel filter on `bot_stats`.
- Permissions unchanged (relayops build/activate keys).

## 8. Content seed + pilot

Pruthvi owns the words; this build seeds the **structure** so he edits, not builds from blank:
- `shared` bot **"FAQ"** — a list-style menu of the topics both plans name (shipping time, COD /
  payment options, warranty, return window, playtime) → one `message` each with placeholder copy
  marked `[Pruthvi: answer]` → `end`.
- `whatsapp` bot **"Support assistant"** (`mode: pilot`, `pilot_numbers` = Afshaan `917709991011`
  + Pruthvi + the CS team members Pruthvi names) — greeting `menu` (buttons): *Track my order* →
  `collect order_number` → `action:order_status` → end / handoff · *FAQs* → `subflow FAQ` · *Chat
  with an agent* → `handoff`. Keywords: track/status/where → order branch; cancel/return/refund →
  handoff; agent/human → handoff.
- The existing `web` bot "New web assistant" gains *FAQs* → `subflow FAQ` and an *Ask a question*
  list with Pruthvi's curated questions (placeholder copy) → unmatched → handoff.
- Nothing is published with placeholder copy on the **web** bot beyond the staff gate; the
  WhatsApp bot is published in pilot mode (only allow-listed numbers ever see it).

**Smoke (in-session, surface order per CLAUDE.md):** from Afshaan's number on the real support
number — greeting → list → FAQ answer → back → track a real order → handoff → agent reply from the
Pitstop inbox → bot silent afterwards; STOP still opts out and gets no bot reply; a non-pilot
number gets no bot reply and the normal OOO behaviour. Web: `?lotchat=1`, navigate between two
PDPs mid-session, email identity, handoff, Pitstop reply. Every step row and `cs_wa_messages` tag
checked in SQL.

## 9. Out of scope (v1) — say so when Pruthvi asks
API-call node · Google Sheet · LLM intent · order cancel/modify/re-order/confirm-address ·
Catalogue/Product-select/Payment/Template nodes · auto-ticket on handoff · public WhatsApp mode
(one-field flip) · web un-gating (one-line flip) · Instagram/Messenger entry points · a
`bot_answers` table.

## 10. Risks
- **The bot answers on a number carrying ~450 new customer threads a week.** Pilot mode is the
  control; the human-active check is the second. Public mode is a deliberate flip, never a default.
- **A sub-flow republished mid-day changes both channels at once.** By design (maintain once), and
  sessions pin versions, so nobody is moved mid-conversation. Recorded so nobody "fixes" it.
- **Free-text rate limit on WhatsApp is the customer's own phone**, so no flood cap is needed
  beyond Meta's; the web cap (20/min) is unchanged.
- **The `template_name='relay_bot'` tag is load-bearing** for the awaiting-reply trigger; a
  future path that writes bot rows without it re-opens the decisions.md hole. Pinned by a csops
  test that inserts a bot reply and asserts `last_outbound_at` is untouched.
