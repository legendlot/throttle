# Ignition Connects — Pitstop→Ignition conversation transfer

> Design spec · 2026-06-26 (Session 177)
> Status: approved design, pre-implementation
> Systems touched: Pitstop (csops + apps/pitstop), Ignition (ignitionops + apps/ignition), `store` + `ignition` schemas

## Problem

Reann runs the Influencer team. Collaboration requests ("influencer connects") arrive on the
LOT Instagram / WhatsApp / email channels, but those channels are **owned and operated by the
Pitstop CS team** (csops + the `store.cs_wa_*` inbox). Reann is not a Pitstop agent and should
not become one — making him a CS agent to chase influencer DMs is the wrong model and would give
him general access to all customer conversations.

We need **interoperability**, not a second inbox: the Pitstop team transfers a specific
conversation to the Influencer team, and Reann gets a **single consolidated place inside Ignition**
to see and reply to everything that was transferred to him — across IG, WhatsApp, and email —
**without any general access to the channels**.

## Constraints (from Afshaan)

1. **Channel ownership stays with Pitstop.** csops remains the only system that actually
   sends/receives on IG/WA/email. The conversation data stays in Pitstop's `store` schema.
2. **Reann sees only transfers.** He must be structurally unable to see general channel traffic —
   only conversations the CS team explicitly hands to him.
3. **Reann replies and works the conversation inside Ignition itself.** No bouncing to Pitstop.
4. **Not "split into two parts."** One source of truth for the conversation; one working surface
   for Reann.

## Decisions (brainstorming)

- **Transfer model:** a transferred conversation becomes a **standalone "Connect"** (a lead) in a
  new Ignition Connects inbox. Reann replies on it and can later **promote** it into an
  `ignition.influencers` record + deal when warranted. Not auto-linked to an influencer; not
  forced to bind to a known influencer at transfer time.
- **Handoff semantics:** **full handoff with Pitstop oversight.** On transfer the conversation
  leaves the CS team's active inbox (CS stops replying); Reann owns replies from Ignition; Pitstop
  retains **read-only** visibility because it owns the channel.
- **Architecture:** **Approach 1 — Pitstop stays the single store; Ignition is a scoped remote
  console** that reads/replies via sibling-worker calls to csops. (Rejected: mirroring threads into
  the `ignition` schema = dual source of truth + a sync pipeline; a shared `packages/inbox` =
  risky refactor of the live high-traffic Pitstop inbox. Both fight constraint #4.)
- **Channel scope:** all three channels by construction (the inbox is channel-agnostic). Email
  rides the same path; replies stay inert until Pitstop's `carecrew@` Gmail channel is armed
  (no extra Ignition work later).
- **Destination:** a **shared team Connects inbox** for the Influencer team (perm-gated), not
  Reann personally.

## Architecture overview

```
  Customer (IG / WhatsApp / email)
        │            ▲
        ▼            │  (reply goes out on the SAME LOT account)
  ┌─────────────────────────────┐
  │ csops  (CHANNEL OWNER)       │  store.cs_wa_threads / cs_wa_messages
  │  • Meta Graph / BiteSpeed /  │  ── single source of truth for the conversation
  │    Gmail send+receive        │
  │  • transferThreadToIgnition  │◄── CS agent clicks "Transfer to Influencer team"
  │  • BRIDGE (token-authed):    │
  │     getIgnitionConnects      │
  │     getIgnitionThread        │      scope-checked: ignition_connect = true ONLY
  │     sendConnectReply         │
  └─────────────┬───────────────┘
                ▲  sibling-worker calls (shared IGNITION_BRIDGE_TOKEN + acting-user identity)
                │
  ┌─────────────┴───────────────┐
  │ ignitionops (REMOTE CONSOLE) │  ignition.connects  (linkage + workflow ONLY, no messages)
  │  • getConnects / getConnect  │  ── overlays status + influencer link onto the live threads
  │  • replyConnect              │
  │  • promoteConnect            │
  │  • setConnectStatus          │
  └─────────────┬───────────────┘
                ▲ JWT (ignition_connects perm)
                │
        apps/ignition  /connects  ── Reann's single consolidated surface
```

The `ignition_connect` boolean on the thread is the **one gate** that does three jobs:
1. Excludes the thread from every CS inbox list / count / routing query.
2. Includes it in Ignition's read path (and nothing else is reachable from Ignition).
3. Stops Meta/BiteSpeed inbound auto-assign from pulling a transferred thread back to CS.

## Data model

### `store.cs_wa_threads` — additive columns (migration `pitstop_ignition_transfer_v1`)

| Column | Type | Notes |
|---|---|---|
| `ignition_connect` | `boolean NOT NULL DEFAULT false` | the transfer gate |
| `ignition_transferred_at` | `timestamptz` | when transferred |
| `ignition_transferred_by` | `uuid` | CS agent (auth user) who transferred |

Partial index `(ignition_connect) WHERE ignition_connect` for the Ignition list query.
No CHECK / enum changes. WhatsApp/IG/email flows byte-unaffected for non-transferred threads.

### `ignition.connects` — new table (migration `ignition_connects_v1`)

Linkage + Reann's workflow state. **Never stores message bodies** — those live in
`store.cs_wa_messages` and are fetched live from csops.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid PK default gen_random_uuid()` | |
| `thread_id` | `uuid UNIQUE NOT NULL` | loose ref to `store.cs_wa_threads.id`; **no cross-schema FK** (RULE-IGN-003) |
| `channel` | `text` | denormalized at create for filter/tabs (`instagram`/`messenger`/`whatsapp`/`email`) |
| `status` | `text NOT NULL DEFAULT 'new'` | CHECK in (`new`,`working`,`promoted`,`closed`) |
| `influencer_id` | `uuid` | FK → `ignition.influencers(id)` ON DELETE SET NULL; set on promote |
| `handoff_note` | `text` | the note the CS agent left at transfer (snapshot) |
| `transferred_by_name` | `text` | display |
| `transferred_at` | `timestamptz` | snapshot of the thread's transfer time |
| `created_at` | `timestamptz default now()` | |
| `updated_at` | `timestamptz default now()` | |

RLS **on**, `GRANT ALL … TO service_role` (RULE-RLS-001 / global invariant). Lazily materialized:
created by `ignitionops` on first list/open of a transferred thread (upsert on `thread_id`), so the
transfer action does not perform a cross-worker write.

## Flows

### 1. Transfer (Pitstop side — csops)

New action **`transferThreadToIgnition`** on the JWT switch, gate `cs_ticket_manage` (any agent who
can work the thread; mirrors the existing `transferThread`):

1. Validates the caller may act on the thread (own/unassigned, or `cs_ticket_reassign`/admin for any).
2. `UPDATE cs_wa_threads SET ignition_connect=true, ignition_transferred_at=now(),
   ignition_transferred_by=<auth>, assigned_agent_id=NULL, assigned_agent_name=NULL` for the thread.
3. Inserts an internal note row (`cs_wa_messages` `kind='note'`, `is_internal=true`,
   `body='↪ Transferred to Influencer team (Ignition): <note>'`) — audit + visible in the oversight view.
4. Returns ok. **No call to ignitionops** — the marker is the source of truth.

**CS scope exclusion (the critical guard).** Add `ignition_connect IS NOT TRUE` to:
- `getMessagingThreads` (all tabs) + `getMessagingStats`
- `cs_autoassign_thread` RPC candidate set (so routing never targets a transferred thread)
- the META inbound webhook auto-reopen/auto-assign branch (`metaHandleMessage`) and the BiteSpeed
  `message_created` path: an inbound on a transferred thread still appends the message + bumps
  `last_message_at`/`customer_window_until`, but **must not** set `assigned_agent_id` or re-add it
  to CS's active queue.

UI: a **"Transfer to Influencer team"** item in the `/inbox` conversation-header transfer popover
(beside the existing agent transfer), with an optional handoff note. Confirm dialog notes it
leaves the CS queue.

### 2. Read (Ignition side — ignitionops → csops bridge)

csops **bridge endpoints**, placed **before the JWT gate**, authed by `X-Ignition-Bridge-Token`
(env `IGNITION_BRIDGE_TOKEN`, set on both workers), each scope-checked to `ignition_connect=true`:

- **`getIgnitionConnects`** — returns all transferred threads with a batched last-message preview,
  channel, handle/phone/subject, `last_message_at`, and an `awaiting_reply` flag (latest inbound
  newer than latest outbound). Mirrors `getMessagingThreads`' batching (≤3 subrequests).
- **`getIgnitionThread`** (`thread_id`) — full message history + window state + channel for one
  thread; **404/403 if the thread is not `ignition_connect`** (Reann cannot fetch a CS-only thread).

ignitionops:
- **`getConnects`** (GET, gate `ignition_connects`) — calls `getIgnitionConnects`; **upserts**
  `ignition.connects` for any new `thread_id` (`status='new'`, snapshot channel + handoff note);
  left-joins the overlay; returns merged rows (status, influencer link, who/when transferred).
- **`getConnect`** (GET, `?thread_id=`) — calls `getIgnitionThread`; merges the overlay; returns
  the conversation for the detail view.

Acting-user identity (Reann's auth uuid + name + email) is forwarded on every bridge call so csops
can stamp `sent_by_*` and log correctly.

### 3. Reply (Ignition → customer, on the Pitstop-owned channel)

csops bridge **`sendConnectReply`** (`thread_id`, `body`, optional media, acting-user): scope-checks
`ignition_connect=true`, then routes by `cs_wa_threads.channel`:
- `instagram`/`messenger` → existing `sendMetaMessage` path
- `whatsapp` → existing `sendWaReply` path (24h-window rule RULE-PITSTOP-013 inherited)
- `email` → existing `sendEmailReply` path (inert until `carecrew@` armed → returns
  `gmail_not_configured`; surfaced gracefully in the Ignition composer)

It records the outbound `cs_wa_messages` row with `sent_by_user_id/name` = Reann, **does not**
auto-claim the thread to a CS agent, and leaves `ignition_connect` intact. ignitionops
**`replyConnect`** (POST, gate `ignition_connects`) wraps this.

### 4. Promote / status (Ignition)

- **`promoteConnect`** (POST, gate `ignition_connects`) — create or link an `ignition.influencers`
  row prefilled from the thread (channel_name/handle, contact_number, email; mints `influencer_code`
  via `next_influencer_seq()` when new); set `connects.influencer_id` + `status='promoted'`.
  (Creating an engagement is a follow-up button on the influencer, reusing the existing New Deal flow —
  not part of this action.)
- **`setConnectStatus`** (POST, gate `ignition_connects`) — `working` / `closed` (and reopen).

### 5. Pitstop oversight (read-only)

`getMessagingThreads` gains an optional `scope=ignition` param that **includes only**
`ignition_connect=true` threads (default behaviour unchanged = exclude them). Surfaced as a
read-only "Transferred to Ignition" filter in Pitstop `/inbox` for `cs_ticket_reassign`/admin, so CS
leads keep visibility of what they own. No reply controls there (handoff is full).

## Permissions

- New perm key **`ignition_connects`** on `store.roles`, granted to `ignition_manager`,
  `ignition_lead`, `admin`, `super_admin`. (Confirm Reann's role carries it; he is expected to be
  `ignition_manager`.) Added to Ignition `PERM_DEFS` + `nav.js` so the Connects nav item gates on it.
- CS side: transfer uses existing `cs_ticket_manage`; oversight view uses `cs_ticket_reassign`.
- The csops bridge endpoints are **not** behind the JWT/perm switch — they are service-to-service,
  authed by `IGNITION_BRIDGE_TOKEN`, and self-limited to `ignition_connect=true` rows. This is what
  guarantees Reann can never reach general channel data even if the Ignition UI had a bug.

## Frontend (apps/ignition)

- New nav group/item **Connects** (gate `ignition_connects`), before the admin section.
- **`/connects`** — channel tabs (All / Instagram / WhatsApp / Email), status filter
  (New / Working / Promoted / Closed), rows with handle + last-message preview + `awaiting_reply`
  badge + transferred-by/when. Powered by `getConnects`.
- **`/connects/detail?thread_id=`** — conversation render mirroring Pitstop's inbox detail: IG/WA
  text + media bubbles, email rendered as subject header + **sandboxed-iframe HTML body**, customer
  window state; composer → `replyConnect` (disabled with a reason when the channel window is closed
  or email is unarmed); **Promote to influencer** + status controls; handoff-note banner.
- Reuse Ignition's existing `ignitionopsFetch.js`; add `lib/connects.js` for channel/status labels.

## Non-goals (v1)

- No mirroring of messages into the `ignition` schema.
- No automated reply / AI drafting in Connects (that's the separate Reann email-brief workstream).
- No per-person assignment inside the Influencer team (shared team queue; `assigned_to` can be added
  later if needed).
- No "reclaim to Pitstop" pull-back (handoff is full + oversight; a `reclaimFromIgnition` action is a
  cheap future add if asked — clears `ignition_connect`).
- Email replies remain inert until `carecrew@` is armed (Pitstop GCP-creds gate, tracked separately).

## Open items to confirm during implementation

- How `openPitstopTicket` currently authenticates ignitionops→csops — reuse that mechanism for the
  bridge token if one already exists, rather than inventing a parallel secret.
- Exact `customer_email` source for email connects (sender address lives in
  `cs_wa_threads.external_user_id` for email per S175 mapping) — confirm before prefilling promote.
- Whether the oversight facet should also appear for plain agents or leads-only (default: leads/admin).

## Build sequence (for the implementation plan)

1. Migrations: `pitstop_ignition_transfer_v1` (thread cols + index) + `ignition_connects_v1`
   (table + RLS + grants) + `ignition_connects` perm key grant.
2. csops: `transferThreadToIgnition` + the three bridge endpoints + CS-scope exclusion guards +
   `scope=ignition` oversight param. Deploy.
3. ignitionops: `getConnects` / `getConnect` / `replyConnect` / `promoteConnect` /
   `setConnectStatus` + `IGNITION_BRIDGE_TOKEN` secret. Deploy.
4. apps/pitstop: transfer button + oversight filter.
5. apps/ignition: Connects list + detail + nav + perm.
6. Verify end-to-end on a real transferred IG thread (the existing `afshan1000`/`krishna_sharma__75`
   test threads); WA + email per channel availability.
