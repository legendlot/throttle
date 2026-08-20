# Pitstop × Exotel — integration build spec

> **Status:** APPROVED IN DIRECTION, ready to build. Afshaan 2026-08-20: *"let's not try to build
> anything we shouldn't, let's take your reco… spec it out properly so that we can integrate on
> pitstop."*
>
> **Date:** 2026-08-20 (S301) · **System:** Pitstop · **Worker:** `csops` · **Schema:** `store`
>
> **Revised 2026-08-20 after Afshaan's review** — §5 reversed (ticket for **every** call; the
> suppression policy is rejected and recorded as wrong) and **§5A added** (the agent has the customer,
> their last order, its delivery state, tracking and their call history on screen *before they say
> hello*). §4.1 amended accordingly: the poller guarantees completeness, webhooks give speed.
>
> **Supersedes** [`2026-08-19-pitstop-exotel-migration-design.md`](./2026-08-19-pitstop-exotel-migration-design.md)
> on §3.4, §4, §5.2, §8 and §9. Everything that document says about the API surface, the normalised
> shape, attribution and the softphone still stands and is not restated here. **Read this document
> first; go to the design doc for the parts it references.**
>
> ⚠️ **Nothing is built yet. No live change has been made to Exotel, csops or the database.**

---

## 1. The decision this rests on

**LOT keeps Exotel as the carrier. Pitstop takes the operator interface. We build nothing that
carries dial tone.**

Settled 2026-08-20 against measured evidence: peak **6 concurrent calls**, ~6,300 calls and ~6,200
minutes a month, 4 active agents, one number. Voice spend ≈ ₹2,000–2,500/month against ₹10–25k/month
for the cheapest self-hosted path, before engineering and before taking on out-of-hours ownership of
a customer-facing line. Full reasoning in the decision brief; not re-argued here.

**What that licenses us to build:** the call log, ticket integration, attribution, recordings,
dialling, agent admin and the softphone. **What it forbids:** anything that replaces the ExoPhone,
the switch, the IVR runtime or the recording store.

---

## 2. What changed after reading the live call flow

The S299 design was written without having opened flow `108159`. It was read in full on 2026-08-20.
Five findings change the build — three of them make it materially cheaper and safer.

### 2.1 The entire inbound flow is two applets

| Step | Applet | Configuration (read from the live flow) |
|---|---|---|
| 1 | **Greeting** | TTS: *"Hello and thankyou for calling Legend of Toys. Please wait while we connect your call."* |
| 2 | **Connect** | Dials group **Support** · distributed **equally** (`randomize-group-dial=on`, i.e. round-robin) · **sticky agent ON** (`dnf-sticky-agent-busy` off) · recording **ON**, `mp3`, **single**-channel · ring duration blank → 30 s default · conversation limit blank → 4 h · **queue OFF** · music-on-hold default · on no-answer: **`no-answer-action=hangup`** |

**There is no IVR menu, no department branch, no business-hours logic and no voicemail.** Campaigns,
Lists, Contacts, Sales and AI Voice Agents are all empty.

➡️ **This settles Q-3 from the S299 design: `main` / `abc` department routing is dead.** One number,
one flow, one group. Nothing in the call path distinguishes a department, so any department on a call
row is invented by Pitstop, not observed. `cs_department_id` on a call must be treated as a Pitstop-side
default from here on, and the spec stops pretending Exotel supplies it.

### 2.2 There is a purpose-built agent hook and it is empty

The Connect applet carries **`agent-passthru-url`** — Exotel's own *"when dialling multiple agents,
we will pass the details of the currently active agent to this URL"* callback. It is blank.

This is strictly better than the start-of-flow Passthru the S299 design proposed: it carries the
**agent who is actually being rung** (the ~30 % attribution gap), and it is a notification rather
than a step the caller waits behind.

### 2.3 Missed calls are discarded at the switch

`no-answer-action = hangup`. When nobody picks up, Exotel says sorry and hangs up and **emits
nothing**. So the notorious `status='missed'` = 0.25 % figure will **not** fix itself by moving to
Exotel. Fixing it requires the no-answer branch to be redirected somewhere that emits — *or*
the poller in §4.1, which sees it without any flow edit at all.

### 2.4 Recording is already on — the Pitstop bug is entirely ours

`record-call=on`, `recording-format=mp3`, `dual-channel-record=single`, on every completed call.
`recording_url` being NULL on all 17,705 Pitstop rows is a Pitstop-side failure to fetch and persist,
not a missing Exotel setting. Nothing to enable on their side.

⚠️ Single-channel recording means agent and customer are mixed on one track. Fine for playback;
it forecloses speaker-separated transcription/QA later. Flipping to `dual` is a radio button, and is
worth doing *before* a recording archive builds up on the wrong setting — but it is a Pruthvi call,
not a build dependency.

### 2.5 The flow edit is low-risk, and no longer on the critical path

`DEP-5` in the S299 design asked for approval to edit "a live customer-facing IVR". It is a greeting
and a dial. Every change wanted is additive and reversible. More importantly, §4.1 removes it from
the path to restoring the call log at all.

---

## 3. Architecture

Unchanged in shape from the S299 design §4 — three layers, one vendor-neutral pipeline:

```
        EXOTEL   ExoPhone 08044656833 · switch · flow 108159 · recording store
           │
           ├─ (a) GET /Calls          COMPLETENESS + settlement   ← no flow edit
           ├─ (b) agent-passthru-url  live agent → screen-pop      ← one flow field
           ├─ (c) post-conversation Passthru                       ← one flow applet
           ├─ (d) StatusCallback      outbound only                ← no flow edit
           └─ (e) start-of-flow Passthru  WARMS THE CONTEXT CACHE  ← one flow applet
           │
        csops worker · src/telephony/
           exotel-client.js     Basic-auth client, 200/min budget, backoff
           exotel-poller.js     (a) cron reconcile + backfill
           exotel-webhooks.js   (b)(c)(d)(e) normalise → pipeline
           call-context.js      (e) assemble + cache the agent's context card  [§5A]
           call-pipeline.js     VENDOR-NEUTRAL: upsert · ticket · coalesce · attribution
           │
        store.cs_calls · cs_tickets · cs_telephony_agents
           │
        Pitstop  /calls · /calls/detail · /admin/telephony · <CallPop> · <CallBar>
```

**`call-pipeline.js` is vendor-neutral and is the whole point.** MyOperator and Exotel both normalise
into one `NormalisedCall` shape (S299 §4) and call the same pipeline. Ticket policy, coalescing,
Shopify lookup and attribution are written once. LOT has changed voice vendor once in three months;
this seam — not owned infrastructure — is the answer to "what if we leave Exotel".

---

## 4. Layer 1 — data plane

### 4.1 ⭐ The structural change: the poller guarantees completeness, webhooks give speed

**Neither mechanism alone is sufficient, and each was primary in an earlier draft. Both were wrong.**

- **A webhook-only design is incomplete.** A caller who hangs up during the greeting dials no agent,
  holds no conversation and triggers no no-answer branch — so no webhook fires, and that is precisely
  the ~30 % short-call population we most need to see (§5.1 shows 79 % of them are repeat callers
  failing to get through). Webhooks cannot be made complete without putting our endpoint in the
  customer's call path.
- **A poller-only design is too slow.** §5A requires the agent to have full context *before they say
  hello*. A 5-minute reconcile cannot serve a screen-pop.

So the roles are split, and neither is "primary":

| | Role | Latency | Completeness | Flow edit? |
|---|---|---|---|---|
| **(a) `GET /Calls` poller** | **Completeness guarantee + settlement.** No call is ever missing; duration/recording/price settle here | ≤ 5 min | **100 %** — every call Exotel billed | **No** |
| **(e) start-of-flow Passthru** | **Warms the context cache** so the pop is instant (§5A) | — | Best-effort | Yes — one applet |
| (b) `agent-passthru-url` | Screen-pop delivery + live agent attribution | seconds | Calls that reached a dial attempt | Yes — one field |
| (c) post-conversation Passthru | Immediate end-of-call record | seconds | Answered calls only | Yes — one applet |
| (d) `StatusCallback` | Outbound (click-to-call) state | seconds | Calls we placed | No |

⚠️ **Nothing downstream may assume a webhook fired.** Every hook writes through the same idempotent
upsert on `UNIQUE (provider, provider_call_sid)`, and the poller is what closes the gap when one
does not arrive. If a webhook path is ever the only writer of some field, that field will be silently
missing on the calls that matter most.

**Consequences, and they are large:**

1. **Restoring the call log needs no Exotel-side change whatsoever** — only the API key and token.
   Phase 2 stops the bleeding without waiting on anyone's approval to touch a live IVR. The screen-pop
   (§5A) is what needs the flow edits, and it is a later phase.
2. **The missed-call defect (§2.3) is fixed by the poller**, not by re-routing the no-answer branch.
   Exotel's `Status` on an unanswered call is authoritative and we read it directly.
3. The in-path risk — *"Passthru holds a live call while csops works"* — is **contained rather than
   eliminated**: (e) does sit in the flow, so it returns a bare 200 and does every piece of work in
   `ctx.waitUntil()`. If (b), (c) or (e) is down, the poller still records the call and the pop
   degrades to an on-demand fetch.
4. Ticket creation moves from "during the call" to "within 5 minutes of it". Acceptable for a queue-
   worked team, and (b) restores instant awareness for the agent on the call once approved.

Everything downstream is idempotent on `UNIQUE (provider, provider_call_sid)`, so the poller and the
webhooks may both write the same call in any order without duplication.

**Poller shape** — `*/5 * * * *` cron on csops:

- `GET /v1/Accounts/{sid}/Calls` with `DateCreated` bounded to the last 30 min (overlapping window,
  cheap because of the idempotent upsert), `PageSize=100`, cursor-paginated.
- Order by a **unique** key and tie-break on `Sid`. A non-unique sort silently drops and repeats rows
  across page boundaries (CORE.md).
- A second pass re-reads rows from the last 24 h still missing `talk_duration_seconds` or
  `recording_url` — Exotel settles `Duration`, `Price` and `EndTime` **~2 min after the call ends**
  (S299 §5.4). Batched `Sid=` lookups, up to 100 per request. **Never a per-row loop** (CORE.md).
- Rate limit is a shared 200/min account budget. Back off on 429; do not retry blind.

### 4.2 Schema

**Carried forward from the S299 design §5.1 unchanged** — all additive, nothing dropped, nothing
renamed during a cutover:

`store.cs_calls` gains `provider` (`NOT NULL DEFAULT 'myoperator'`, which back-stamps all 17,705
historic rows correctly with no backfill), `provider_call_sid`, `talk_duration_seconds`,
`dial_status`, `price_inr`, `exophone`, `agent_sip_id`, `recording_duration_seconds`. New
`UNIQUE (provider, provider_call_sid)`; the old `UNIQUE (myop_account_id, call_session_id)` is
**kept** because MyOperator rows still rely on it. `status` CHECK widened to admit
`failed` / `busy` / `no_answer`. `myop_account_id` needs no change — already nullable.

New table `store.cs_telephony_agents` (user ↔ Exotel identity: `sip_id`, `agent_phone`,
`device_preference`, `exotel_user_id`). RLS on, service_role only.

**Added by this spec:**

| Object | Column | Purpose |
|---|---|---|
| `store.cs_calls` | `needs_callback bool DEFAULT false` | Drives the callback queue (§5.3). Set by the pipeline, cleared by `called_back_at`. |

⛔ **`ticket_suppressed_reason` was in an earlier draft and is DELETED** — §5.1 rejects the
suppression policy it existed to audit. Do not reintroduce it.

⚠️ **Two `NOT NULL` columns constrain the insert path** (verified 2026-08-19): `call_session_id` —
mirror `CallSid` into both it and `provider_call_sid` so the ~20 existing call sites keep working —
and `status`, which has no "unknown" resting state, so a click-to-call row is written `in_progress`
immediately.

⚠️ **`direction` CHECK is left as is.** Map Exotel's `inbound` / `outbound-dial` / `outbound-api` in
code; an unrecognised value stores **NULL and logs**, never passes through raw. This is the
`metaAttachmentKind` failure class that silently destroyed every shared Instagram reel.

⚠️ Migration ends with **`NOTIFY pgrst, 'reload schema';`** — a new table in an already-exposed schema
is invisible to PostgREST until the cache reloads, and it fails *silently* (CORE.md; cost a live
round in S239).

### 4.3 Status mapping

Per S299 §5.3, driven off Exotel's `Status` plus `Details.ConversationDuration` (talk time, distinct
from leg time — this is what separates a real conversation from a ring-out):

| Exotel | `status` | `dial_status` |
|---|---|---|
| `completed`, talk > 0 | `answered` | `completed` |
| `completed`, talk = 0 | `abandoned` | `completed` |
| `no-answer` | `missed` | `no-answer` |
| `busy` | `missed` | `busy` |
| `failed` | `failed` | `failed` |
| in flight | `in_progress` | — |

⚠️ **The missed count will jump from ~0 to its true value and will read as a regression.** It is the
correction landing — same shape as the S298 agent-report rebuild, where August closed moved
4,496 → 5,743. Tell the team in the same breath as the release.

### 4.4 The blind-window backfill

Voice moved at 18:08 IST on 2026-08-19; nothing has reached Pitstop since. The same poller code,
run once over a wider window, recovers it — Exotel serves 6 months, 1-month windows, `PageSize` 100.

⚠️ **The backfill deliberately creates NO tickets.** Retro-firing ticket creation over days of calls
would spray hundreds of `[Pending — auto-created from call]` rows into a live queue and reset every
SLA clock. Rows land as call history only; CS raises tickets by hand for anything that needs one. Auto-creation begins at the moment the poller goes live and that
boundary is visible on the rows.

⚠️ **Snapshot first:** `CREATE TABLE store.safety_cs_calls_2026_08_20 AS SELECT * FROM store.cs_calls;`

---

## 5. Ticket policy at volume

> Afshaan 2026-08-20: *"get pitstop up to speed to handle the call volume and integrate tickets."*
> And, on the policy below: *"my idea is to get a ticket created for every call that hits us, cos I
> can't think of a reason that we'd get a random call for no reason… it could be a trivial call sure
> — for which if we end up creating a ticket, it should be fairly easy to close that ticket (one
> click close)."*

### 5.1 ⛔ The suppression policy is REJECTED. A ticket is created for every call.

An earlier draft of this spec proposed suppressing ticket creation for calls under a talk-time
threshold. **That was wrong, and the data that was used to justify it actually refutes it.** Recorded
here so it is not re-proposed.

Measured over **July 2026, incoming calls**: 2,778 calls → 1,432 tickets after coalescing, of which
**428 had no call longer than 15 s**. The draft read those 428 as noise. They are not:

| Of the 428 "nobody spoke" tickets | Count | What it actually means |
|---|---|---|
| **Had repeat calls coalesced in** | **337 (79 %)** | The customer called back — often three or four times in minutes. These are people **failing to get through**, not noise |
| Went on to host a WhatsApp conversation | 39 | The call ticket became the container a later channel attached to |
| Customer wrote in themselves afterwards | 12 | Same |

**Suppressing those tickets would have deleted the record of a service failure** — 337 tickets a
month evidencing customers who tried repeatedly to reach us — and would have broken the container
that WhatsApp and email later attach to. A short call is the *strongest* signal that someone needs
calling back, not the weakest.

**So: every call gets a `cs_calls` row AND a ticket, or coalesces into an open one per
RULE-PITSTOP-018. No `ticket_suppressed_reason` column. No `TICKET_MIN_TALK_S`. RULE-PITSTOP-007
stands unamended.**

### 5.2 The real problem is the CLOSE, and it is already solved in the backend

The 428 tickets sat a median **~26 hours** before closing, closed in ones and twos across 274
separate minutes. The draft blamed ticket creation. The actual cause is triage friction: closing one
means opening the ticket, opening the triage form, and choosing **issue category + subcategory +
disposition** — visible in the history as four field-writes in the same second.

**The one-click close already exists.** `updateTicket` fast-closes on disposition
(`csops-worker/src/index.js` ~2469):

```
disposition → 'query'      ⇒ stage='closed', closed_reason='resolved',  closed_at, closed_by_user_id
disposition → 'no_action'  ⇒ stage='closed', closed_reason='no_action', closed_at, closed_by_user_id
```

`updateTicket` gates on **`cs_ticket_manage`**, which **every `cs_agent` holds** (verified against
`store.roles`: `cs_agent` has `cs_ticket_manage=true`, `cs_ticket_admin=null`). So no permission
change and no new stage transition is required.

⚠️ Note this is *not* the `closeTicket` handler — that one takes the mid-flight path and **does**
demand `cs_ticket_admin` plus a reason. Anything built here must use the disposition fast-close, or
ordinary agents will be locked out.

**Build:** a **`Nothing needed`** action on the call row, the call detail and the ticket header —
one click, one `updateTicket` call setting `disposition='query'` plus a default
category/subcategory, with an **Undo** toast (re-triage to `awaiting_info` already reopens a
fast-closed ticket, ~2483). A second button **`Needs callback`** leaves it open and flags it.

That is the whole fix. It turns a ~26-hour median into a keystroke, and it needs no schema change.

### 5.3 Callback queue

Missed and unanswered calls keep their ticket **and** raise `needs_callback` — a worklist, not a
substitute for the ticket. Cleared when `called_back_at` is stamped; the column and the "call back"
affordance already exist on `/calls/detail`.

Sticky-agent interaction is favourable: Exotel routes a repeat caller back to the same agent, and
RULE-PITSTOP-018 coalesces their calls onto one ticket. The agent who missed the call is the one it
rings back to, and the ticket is the one the earlier attempts already attached to.

---

## 5A. The agent knows everything before saying hello

> Afshaan 2026-08-20: *"as soon as the call is connected the agent should have all the info ready —
> who the customer is, what was their last purchase, is that order delivered or not, tracking
> details, is this the customer's first call or nth call… so the agent doesn't waste time digging
> for basic info, which is very irritating if the customer has a grievance."*

### 5A.1 The latency budget, and why §4.1 had to be amended

A poller cannot serve this. **This requirement is what reinstates the start-of-flow hook** that
§4.1 rejected — but for a different job. §4.1's reasoning still holds: a start-of-flow webhook can
never be the *source of truth*, because a caller who hangs up during the greeting may not fire it
reliably. It can be the thing that **warms the cache**.

The runway is generous, and it is free:

```
call lands ──► Greeting TTS (~6–8 s) ──► Connect rings agent (up to 30 s) ──► agent answers
     │                                          │
     └─ (e) start Passthru                      └─ (b) agent-passthru-url
        bare 200, work in waitUntil:               fires with the ACTIVE agent
        resolve + cache context                    → push pop to that agent's browser
        ≈ 35 s of runway before hello              → reads the already-warm cache
```

By the time the agent's headset clicks, the context has been ready for half a minute.

### 5A.2 Hook roles, restated

| Hook | Job | Notes |
|---|---|---|
| **(e) start-of-flow Passthru** | **Warm the context cache.** Resolve identity + orders + shipments + history, key it by `CallSid` **and** `customer_phone` | **Bare 200 immediately**, everything in `ctx.waitUntil()` — Exotel is holding a live call. Never blocks; a failure degrades to an on-demand fetch |
| **(b) `agent-passthru-url`** | Deliver the pop to the **agent who is actually being rung** | Also the attribution fix |
| **(d) `StatusCallback`** | Outbound state | Unchanged |
| **(a) `GET /Calls` poller** | **Completeness backstop + settlement.** Guarantees no call is ever missing; settles duration, recording and price ~2 min after the call | **Demoted from "source of truth" to "guarantee".** Still essential — it is what makes greeting-hangups and no-answers visible at all |

**The poller is not dropped and its role is not diminished in importance** — only in latency
primacy. Webhooks give speed; the poller gives certainty. Neither alone is sufficient.

### 5A.3 The context card — most of it already exists

`csops` already has the expensive parts. This is assembly and pre-warming, not new integration:

| Field the agent needs | Source | Status |
|---|---|---|
| Who the customer is | `shopifyLookup({phone})` → customer + `recent_orders` | ✅ built |
| Last purchase — order no, date, items, value | same, with the Shopify admin deep link | ✅ built |
| **Is it delivered?** | `attachShipments()` → `ecom_shipments.lifecycle` + `SHIPMENT_LIFECYCLE_LABEL` ("Out for delivery", "Delivered 18 Jul") | ✅ built |
| **Tracking details** | same → `courier`, `awb`, `tracking_link`, `dispatched_at`, `delivered_at`, `parcels` | ✅ built |
| COD amount due | same → `is_cod`, `cod_collectable`, `cod_collected` | ✅ built |
| **RTO alert** | same → `alert` flag on `lifecycle='rto'` | ✅ built |
| Past tickets (last 5) | `lookupPastCases({phone})` | ✅ built |
| **First call or nth call** | `count(*)` + `max(started_at)` on `cs_calls` by phone | ❌ **new — trivial** |
| Open ticket right now | `cs_tickets` open by phone | ❌ new — trivial |
| Open WhatsApp thread | `cs_wa_threads` by phone | ❌ new — trivial |

⚠️ `attachShipments` exists precisely because **Shopify's fulfilment stops at "dispatched" and never
moves** — "where is my order" cannot be answered from Shopify alone. Do not re-derive delivery state
from Shopify; the lifecycle comes from `public.ecom_shipments`.

**New: `GET getCallContext({ phone | call_sid })`** — one action returning the whole card, served
from the warm cache when present and resolved live otherwise. Same payload feeds the screen-pop, the
call detail page and the ticket header, so there is one shape to get right.

### 5A.4 What the agent sees

A `<CallPop>` in the Pitstop `(auth)` shell, driven by hook (b):

- **Identity line** — name, phone, `3rd call in 7 days` (or **`First-time caller`**), *last call 2 days
  ago about …*
- **Live order card** — most recent order, its lifecycle label, courier + AWB with a one-click
  tracking link, COD due if any. **RTO shows as a red banner without being asked for.**
- **History strip** — last 5 tickets as chips (disposition + date), any open ticket surfaced first,
  any open WhatsApp thread linked.
- **Actions** — *Open ticket* · *Nothing needed* (§5.2 one-click close) · *Needs callback*.

**Degradation is explicit, never a spinner in the agent's face:** an unknown number renders as
`Unknown caller — no Shopify match`, with search; a Shopify timeout renders the card without the
order block rather than blocking the pop. The agent must never wait on our fetch while a customer is
talking.

⚠️ The pop must survive route changes → it mounts in the **layout**, not a page. Same constraint as
`<CallBar>` (§7), and they should be one component tree.

⚠️ **Never key its data-loading effect on `session`** (CORE.md) — a token refresh lands ~hourly and
would tear down a live call surface mid-conversation. Key on `userId`.

---

## 6. Layer 2 — control plane

Unchanged from the S299 design §6. Summary only:

- **Click-to-call** — `POST { action:'placeCall', to, ticket_id?, thread_id? }`, `canX()` guard first
  per RULE-011. `From` resolves from `cs_telephony_agents.device_preference` → `sip_id` or
  `agent_phone`; `CallerId` = the ExoPhone; `Record=true`; `CallType=trans`; `CustomField` carries a
  compact `{u,t}` (**≤128 chars — enforced, not assumed**) so outbound attribution is exact by
  construction rather than inferred. Row inserted `in_progress` on the 200.
  Entry points: ticket header, call-log row, inbox thread header, and any rendered customer phone.
- **`/admin/telephony`** — replaces the Exotel *Co-workers* screen and the current `/admin/myop`.
  Lists Pitstop users joined to their Exotel identity, create/update/deactivate via the Users API,
  and a two-way **sync** that reports drift. Must surface the two **UNVERIFIED** devices (Afshaan,
  Maria) — invisible in Pitstop today and a silent cause of failed routing.
- **Numbers & flows** — read-only. Flow *editing* stays in App Bazaar; rebuilding an IVR editor is a
  project of its own and is out of scope.

---

## 7. Layer 3 — softphone

Unchanged from the S299 design §7. `@exotel-npm-dev/exotel-ip-calling-crm-websdk` (public,
Apache-2.0), lazy-loaded ~1.4 MB only for users with a SIP device, delivered as a persistent
`<CallBar>` mounted in the Pitstop `(auth)` **layout** so it survives route changes.

**Still gated on one external dependency** — the integrations-platform **Client ID + Secret**, which
is not the dashboard API key and is not self-serve. See §9.

---

## 8. Pitstop UI — handling the volume

`/calls` already has tabs, 50-row pagination, filters, KPIs and a trend chart. The gaps are specific:

| # | Change | Why |
|---|---|---|
| 1 | **Recording player** — replace the inert `<code>{recording_filename}</code>` on `/calls/detail` with a real `<audio>` element, source resolved on demand | Recordings have never been playable. §2.4 — the fix is entirely ours |
| 2 | **`Abandoned` tab + badge**, distinct from `Missed` | 47 % of inbound is currently mislabelled `answered`. Two different operational meanings: nobody spoke vs nobody picked up |
| 3 | **`Needs callback` tab**, driven by `needs_callback` | The worklist that replaces 428 empty tickets/month |
| 4 | **Talk time vs leg time** shown separately in the row and detail | `duration_seconds` keeps its current meaning so no existing metric silently shifts; `talk_duration_seconds` is the honest one |
| 5 | **`Nothing needed` one-click close** on the call row, call detail and ticket header (§5.2), with Undo | Turns a ~26-hour median close into a keystroke. Backend already supports it — `updateTicket({disposition:'query'})` |
| 6 | KPI cards recomputed on the corrected statuses; **answer rate** = answered ÷ (answered + missed + abandoned) | Today's KPIs read a `missed` figure that is 0.25 % and false |
| 7 | Keyset pagination on `(started_at, id)` rather than offset | 6,300 rows/month; offset paging degrades and can drop rows under concurrent inserts |
| 8 | Agent column resolves via `cs_telephony_agents` | ~30 % of calls currently credit nobody |

⚠️ **`useAuth()` — key the data-loading effects on `userId`, never on `session`** (CORE.md). A token
refresh lands ~hourly and hands the page a new session object; the classic damage is a spinner
replacing a surface that holds unsaved input. `/calls` has filter state and the detail page has a
callback note — gate any spinner `loading && !editing`.

---

## 9. Dependencies — everything Exotel goes through Pruthvi

> Afshaan 2026-08-20: *"Pruthvi runs the CS team and is our way to reach out to exotel, how he did
> with bitespeed as well, so any questions, should go to him instead."*

**This replaces the S299 design §9 split across Afshaan / Exotel / Pruthvi.** Pruthvi is the single
channel. He is also **Admin on the Exotel account**, so the credential and flow items are his to
action directly, not merely to relay.

| Ref | Ask | Blocks | Note |
|---|---|---|---|
| **P-1** | **Account balance.** ₹456.87 left; the burn is ~₹80/day and payment history shows only three coupon credits (₹150 + ₹350 + ₹100) — nothing has ever been paid. **The billing email and service-disruption email are both blank.** Confirm with Exotel whether hitting zero suspends service, set both emails, top up. | **Everything — including the calls happening right now** | Not a build dependency. It is the most urgent item on this page |
| **P-2** | **API key + token.** `EXOTEL_API_KEY` (`d59f1a4ffb…`, visible, not secret) and the token behind the eye icon on "Default API key". Set via `wrangler secret put EXOTEL_API_TOKEN` on csops — never committed, never echoed. Plus `EXOTEL_ACCOUNT_SID=legendoftoys1m` and `EXOTEL_WEBHOOK_TOKEN` (we mint it). | **Phases 2–5** | The only credential the call log needs |
| **P-3** | **Commercial terms, while there is still leverage.** Per-minute rates in writing (in/out); **the agent seat price** — the account reads `all users @ 0.0 credits per user per month`, so lock the softphone seats at zero *before* they are priced; Truecaller/Google verified caller ID. | Nothing technical | Nothing is paid and nothing is embedded yet. That position ends the week we go live |
| **P-4** | **Client ID + Client Secret** for the integrations platform — not the dashboard key/token, only from Exotel tech support. Confirm `legendoftoys1m` sits on the Veeno / IP-PSTN agreement and what per-user VoIP costs. | **Phase 5 only** | The single external unknown. Phases 1–4 do not wait on it |
| **P-5** | **Flow settings on 108159** — set `agent-passthru-url`, add the post-conversation Passthru, and decide on the no-answer branch. Low-risk (§2.5) and reversible. | Phase 3 only (accelerators) | **Not needed to restore the call log** — that is the §4.1 change |
| **P-6** | **Turn the queue on.** It is off; with 4 agents and a peak of 6 concurrent calls, callers are told sorry and dropped at peaks. A checkbox plus a hold message. | Nothing | Probably the cheapest customer-facing improvement available |
| **P-7** | **`08048332909`** appears as an outgoing number in Exotel's own Inbox but is not provisioned on the account. What is it? | Nothing | Loose end |
| **P-8** | **The two old DIDs** `+912262054541` (932 calls/14d) and `+918064124537` (585/14d) — ported, retired or forwarded? Neither is an ExoPhone today. | Nothing, but it decides whether customers dialling the old numbers reach anyone | Highest-value unknown after P-1 |

**Decisions for Pruthvi** (not blockers — each has a stated default that ships if he does not object):

| Ref | Question | Default if unanswered |
|---|---|---|
| **D-1** | Should an abandoned IVR-drop count as **missed**, or its own **abandoned** class? | **Its own class.** They mean different things operationally and merging them hides both |
| **D-2** | Default issue category/subcategory that `Nothing needed` stamps | **General Queries / General queries** — what the team already uses on 427 of 428 of these |
| **D-3** | Should recording move to **dual**-channel? | **Leave single.** Revisit only if speaker-separated QA/transcription is wanted |
| **D-4** | Which agents get a softphone, which stay on a mobile leg? | All five with SIP devices; Pruthvi stays mobile-only (he has no SIP device) |

---

## 10. Phases

| Phase | Content | Gate |
|---|---|---|
| **0** | P-1 (top-up + billing email) · P-2 (credentials) · put P-3…P-8 and D-1…D-4 to Pruthvi | Pruthvi |
| **1** | Additive migration (§4.2) · extract `call-pipeline.js` vendor-neutral · re-point the MyOperator path at it with **behaviour byte-identical** | Reviewed diff |
| **2** | **Poller live (§4.1). The call log is restored.** No Exotel-side change required | P-2 only |
| **3** | Backfill the blind window · recording player · **one-click close (§5.2)** · callback queue · attribution | Snapshot before backfill |
| **4** | **Screen-pop (§5A)** — start-of-flow Passthru warms the cache, `agent-passthru-url` delivers the pop, `getCallContext` + `<CallPop>` | P-5 |
| **5** | Click-to-call · `/admin/telephony` | — |
| **6** | Softphone | P-4 |

**Phase 2 is the one that matters and it depends on a single credential.** If everything else stalls,
that alone ends the blind window.

**MyOperator is not deleted.** Its webhook stays mounted throughout — it costs nothing idle, and if a
number turns out not to have moved, deleting it is the difference between a quiet fallback and an
outage. Removal is a separate decision after Exotel runs clean for a week.

**Deploy order is always worker → app**, and **the push must land before the deploy** or a parallel
session's live change is silently reverted (PATTERN-220).

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Account balance hits zero and voice stops** | **HIGH — live now** | P-1. Nothing in this build protects against it |
| Pitstop stays blind while this is built | **HIGH — live now** | Phase 2 needs only P-2; backfill recovers the window |
| Missed count jumps and reads as a regression | MED | §4.3 — warn the team in the same breath as the release |
| Context fetch blocks a live call | MED | Start Passthru returns a bare 200; all work in `ctx.waitUntil()`. The pop degrades to a partial card, never a spinner (§5A.4) |
| Poller misses calls at a page boundary | MED | Unique sort key + tie-break on `Sid`; overlapping 30-min window; idempotent upsert |
| Async settlement leaves rows incomplete | MED | Second poller pass over the last 24 h (§4.1) |
| Exotel status/direction strings drift | MED | Map to NULL and **log**, never pass through raw |
| Recording URLs are pre-signed and expire | MED | Never persist a signed URL as permanent; resolve on demand via Call Details |
| Phase 6 stalls on P-4 | LOW | Phases 1–5 carry most of the value and have no external dependency |
| 200/min rate limit | LOW | Batch `Sid` lookups 100 at a time; back off on 429 |

---

## 12. Out of scope

Rebuilding the IVR / flow editor · barge / whisper / live listen · campaigns and the auto-dialer
(read-only listing at most) · AI Voice Agents, CQA, transcription · renaming `myop_accounts` →
`telephony_accounts` (correct, deliberately deferred out of a cutover) · deleting the MyOperator code
path · porting the two old DIDs (a telecom process, not a build) · **anything that replaces the
ExoPhone, the switch, the IVR runtime or the recording store.**

---

## 13. What "done" looks like

1. A customer calls `08044656833` and within five minutes the call is in Pitstop's log with the right
   agent and the right status — and within seconds, once Phase 4 lands.
2. **Every call has a ticket.** A trivial one is closed in a single click; an unanswered one also sits
   in the callback queue.
3. Any past call plays back inside Pitstop.
4. An agent's phone rings and the customer, their last order, its delivery state, tracking and their
   call history are **already on screen** — nth-caller included.
5. An agent opens a ticket, clicks **Call**, and talks without leaving Pitstop.
6. Missed and abandoned are separated, and both numbers are true.
7. Nobody on the CS team opens `my.in.exotel.com` in a normal week.

---

## 14. Provenance

Measured 2026-08-20 (S301) unless stated. Live Exotel account `legendoftoys1m` — flow `108159`
applet-by-applet, ExoPhones, payment history, company info (KYC **Verified**, Fraternitas Ventures
Pvt Ltd), VOIP settings, user billplan. `store.cs_calls` n=17,705, 28 May – 19 Aug 2026; July
ticket-policy figures from incoming calls 1–31 July. Concurrency from an interval sweep over
June–August. Prior facts carried from the S299 design + handover, 2026-08-19.
