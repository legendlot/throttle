# Bot Builder — design (S312, 2026-08-26)

> Approved direction from Afshaan (this session): Relay owns the feature end to end; one
> builder, not two; the **web bot is the first consumer** (refines the earlier "web bot
> parked" call — the builder and its first bot ship together, gated to staff); shape is the
> BiteSpeed scripted tree (`reference/bitespeed.md` §7), NOT an LLM router; fallback re-shows
> the menu; **v1 actions = order status + agent handoff only**; **identity captured at chat
> start**; conversion = **order by that profile within 24h of the session**. Authoring must be
> fully self-serve (Pruthvi/Mishica build flows without a dev).

## What it is

A scripted decision-tree bot: entry → message/menu steps → quick-reply branches → action
steps → handoff. Same step-graph model as journeys — a bot is a flow whose starting point is
an inbound "Hi" instead of an event trigger. BiteSpeed's own C2P design confirms journeys and
bots don't conflict: a journey sends the buttons, the tap routes into the flow attached to
that template. No intent guessing, no crossed paths.

## Ownership

- **commsops** owns: flow storage, versions, the turn engine, the public web ingress, session
  state, analytics RPCs.
- **csops** owns: the conversation record (`store.cs_wa_messages` via the existing
  `CSOPS` service-binding forward, same as WhatsApp), the inbox, agents, business hours.
  Each worker writes only its own schema.
- **Relay app** owns the builder UI. Pitstop can later render CS-facing analytics off the
  same `comms` RPCs; no second builder, no second engine.

## Data model (`comms`, migration `0058_comms_bots`)

Mirrors the journey shape; separate tables because `enrolments.profile_id` is NOT NULL and
re-enrolment/dedup semantics are wrong for chat.

- `bots` — id, name, status(draft/active/paused), active_version, channel (v1: 'web'),
  config jsonb (widget copy, staff_gate, business-hours message), created_by, timestamps.
- `bot_versions` — bot_id, version, definition jsonb, created_by, created_at. Immutable;
  sessions pin the version they started on (same rule as `journey_versions`).
- `bot_sessions` — bot_id, bot_version, profile_id **nullable**, visitor_key, thread_id
  (loose ref → `store.cs_wa_threads.id`, no FK — the `ignition.connects` precedent), status
  (`active`/`handed_off`/`ended`), current_step, context jsonb, started_at, ended_at,
  last_activity_at.
- `bot_session_steps` — session_id, step_id, step_type, entered_at, result jsonb.
  Append-only. **This is the analytics substrate** — handled / drop-off / handoff /
  conversion all derive from it.

RLS on, service_role-only, `NOTIFY pgrst, 'reload schema'` in the migration (PATTERN: S239
silent-cache trap).

## Step palette (bot mode)

Reuses `journey-graph.js` handle discipline (one outcome handle per button, `handlesFor` is
data-driven). Bot step types:

- `message` — text to customer → `next`.
- `menu` — text + quick-reply buttons (no fixed cap on web; the WhatsApp 3-button limit is a
  channel lint rule for later, not a model constraint) → one handle per button + `fallback`.
  **Fallback rule (Afshaan):** free text that matches no button re-shows the menu; after 2
  misses the fallback handle fires (author wires it → handoff or a message).
- `collect` — ask for a value (name/phone/email/order number) with server-side validation →
  `next`. Used at chat start for identity capture; writes `context`, and phone/email resolve
  a profile via the existing `resolve_identity` RPC (bot sessions may create/attach a
  profile — that is what makes the 24h conversion join possible).
- `action:order_status` — looks up the order server-side and renders status from
  `public.ecom_shipments`. Handles: `found` / `not_found`. **Verification: order number +
  phone/email must match the order** — order numbers are sequential and the ingress is
  public; an unverified lookup is an enumeration hole. 5 failed attempts ends the session.
- `handoff` — marks session `handed_off`, forwards transcript context to csops, tells the
  customer honestly (inside `cs_business_minutes`: "connecting you"; outside: "we'll reply
  when we're back at HH:MM"). Terminal for the bot.
- `end` — closes the session politely. Terminal.

## Turn engine (commsops)

Synchronous, no Workflow, no queue: `POST /web/message` loads the session, reads the pinned
definition, applies the input to `current_step`, walks non-blocking steps (message → menu),
returns the reply bundle inline. One new module `src/bot-engine.js` (pure: definition +
session + input → next state + replies), unit-tested like `journey-graph.js`.

Public web ingress (first unauthenticated write surface — deliberately tiny):
- `POST /web/session` — mint session for a bot with status='active'; sets `visitor_key`.
- `POST /web/message` — one turn; also appends the customer message + bot replies to the
  csops thread via the service binding.
- `GET /web/poll` — agent messages after handoff (the widget polls only in that state).
- CORS locked to the storefront origin; message length cap; per-visitor rate limit;
  kill switch = `bots.status` (paused bot answers with the off-hours copy, never 404s).

## The thread + the `channel='web'` trap

Web sessions create a `store.cs_wa_threads` row via a new csops forward route (mirror of
`/webhooks/relay-wa`). ⚠️ `isRelayThread` (csops `~5561`) hard-routes `channel!='whatsapp'`
to Chatwoot, which is dark — the reason 1,084 web conversations are unanswerable. New web
threads use `channel='web'` **plus a positive marker** (`relay_web=true` or a
`waba_phone_number_id`-style stamp) and `isRelayThread` gains a scoped branch: web thread
with the marker → agent replies route to commsops (`/internal/web-reply` → widget poll),
never Chatwoot. Discriminate on the marker the new path always stamps, never on the absence
of a Chatwoot ref (the function's own recorded rule).

## Guards (all three; nothing else from the WhatsApp guard set applies to web)

1. **Agent supremacy.** Once `handed_off` — or the thread is assigned to a human — the bot
   never speaks in that thread again. One-way transition, checked in the turn engine.
2. **Order lookup verification** as above (order no. + matching phone/email, attempt caps).
3. **Honest off-hours handoff** via existing `cs_business_minutes` — no second
   business-hours implementation.

## Builder UI (Relay app)

Same canvas surface, **mode toggle at the top: Journey (default) | Bot** — switches the node
palette, the lint set, and the save target (`journeys`/`journey_versions` vs
`bots`/`bot_versions`). Components stay shared (`journey-canvas/*`); the page owns the mode.
Bot list + status + "Test" panel (run a session against the draft version in a side pane —
this is how Pruthvi validates a flow without the widget). Permission keys: reuse
`campaign_build`-tier relayops keys; no new permission layer.

## Widget (storefront)

Small self-contained script + iframe-less panel served by commsops (`GET /web/widget.js`),
injected via a Shopify theme app-embed block. **Staff-gated at launch:** renders only when
`?lotchat=1` or the staff cookie is present. Going public later = removing the gate check,
one line. No BiteSpeed/Chatwoot remnant dependencies (verified live: storefront currently
has zero chat elements).

## Analytics

RPC over `bot_sessions` + `bot_session_steps`: sessions, handled (ended without handoff),
deflection rate, handoffs, drop-offs (last step before abandon), conversions (**order placed
by the session's profile within 24h of session start** — join via profile_id captured at
chat start). Surfaced in Relay v1; Pitstop can read the same RPC later.

## Testing

- `bot-engine` unit tests (traversal, fallback-after-2, attempt caps, handed_off silence).
- Canvas lint: dangling handles, unreachable steps, menu without fallback wiring.
- Live staff-gated smoke end to end: session → identity → order status (real order) →
  handoff → agent reply lands in widget; verified from the Pitstop inbox side too.

## Out of scope (v1)

WhatsApp/IG/Messenger bots (the runtime is channel-shaped for later, but no non-web entry
points ship); LLM intent routing (recorded ambition, `bitespeed.md` §8.3); cancel/reorder/
recommendation actions; auto-ticket creation (S305 reversal stands); public un-gating
(Afshaan flips it); Verifast replace-or-coexist decision (moot until un-gated).
