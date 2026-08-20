# Pitstop × Exotel — integration build spec

> **Status:** APPROVED IN DIRECTION, ready to build. Afshaan 2026-08-20: *"let's not try to build
> anything we shouldn't, let's take your reco… spec it out properly so that we can integrate on
> pitstop."*
>
> **Date:** 2026-08-20 (S301) · **System:** Pitstop · **Worker:** `csops` · **Schema:** `store`
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
           ├─ (a) GET /Calls          reconcile poller   ← SOURCE OF TRUTH, no flow edit
           ├─ (b) agent-passthru-url  live agent + pop   ← needs a flow setting
           ├─ (c) post-conversation Passthru             ← needs a flow applet
           └─ (d) StatusCallback      outbound only      ← no flow edit
           │
        csops worker · src/telephony/
           exotel-client.js     Basic-auth client, 200/min budget, backoff
           exotel-poller.js     (a) cron reconcile + backfill
           exotel-webhooks.js   (b)(c)(d) normalise → pipeline
           call-pipeline.js     VENDOR-NEUTRAL: upsert · ticket policy · coalesce · attribution
           │
        store.cs_calls · cs_tickets · cs_telephony_agents
           │
        Pitstop  /calls · /calls/detail · /admin/telephony · <CallBar>
```

**`call-pipeline.js` is vendor-neutral and is the whole point.** MyOperator and Exotel both normalise
into one `NormalisedCall` shape (S299 §4) and call the same pipeline. Ticket policy, coalescing,
Shopify lookup and attribution are written once. LOT has changed voice vendor once in three months;
this seam — not owned infrastructure — is the answer to "what if we leave Exotel".

---

## 4. Layer 1 — data plane

### 4.1 ⭐ The structural change: poll-primary, webhook-accelerated

**The S299 design made a start-of-flow Passthru the primary inbound path. That is now rejected.**

A caller who hangs up during the greeting — a large share of the ~30 % short-call population — dials
no agent, holds no conversation and triggers no no-answer branch. **Under a webhook-only design that
call produces no event at all**, which is precisely the population we are trying to start measuring.
Webhooks cannot be made complete here without putting our endpoint in the customer's call path.

So:

| | Role | Latency | Completeness | Flow edit? |
|---|---|---|---|---|
| **(a) `GET /Calls` poller** | **Source of truth for the call log** | ≤ 5 min | **100 %** — every call Exotel billed, including greeting-abandons, no-answers and failures | **No** |
| (b) `agent-passthru-url` | Screen-pop + live agent attribution | seconds | Calls that reached a dial attempt | Yes — one field |
| (c) post-conversation Passthru | Immediate end-of-call record | seconds | Answered calls only | Yes — one applet |
| (d) `StatusCallback` | Outbound (click-to-call) state | seconds | Calls we placed | No |

**Consequences, and they are large:**

1. **Restoring the call log needs no Exotel-side change whatsoever** — only the API key and token.
   Phase 2 stops the bleeding without waiting on anyone's approval to touch a live IVR.
2. **The missed-call defect (§2.3) is fixed by the poller**, not by re-routing the no-answer branch.
   Exotel's `Status` on an unanswered call is authoritative and we read it directly.
3. The in-path risk the S299 design carried — *"Passthru holds a live call while csops works"* —
   **disappears**. (b) and (c) are accelerators; if either is down, the poller still records the call.
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
| `store.cs_calls` | `ticket_suppressed_reason text` | Why this call deliberately created no ticket — `short_call` \| `abandoned` \| `missed` \| `backfill`. Makes the §5 policy auditable instead of invisible. |
| `store.cs_calls` | `needs_callback bool DEFAULT false` | Drives the callback queue (§5.3). Set by the pipeline, cleared by `called_back_at`. |

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
SLA clock. Rows land as call history with `ticket_suppressed_reason='backfill'`; CS raises tickets by
hand for anything that needs one. Auto-creation begins at the moment the poller goes live and that
boundary is visible on the rows.

⚠️ **Snapshot first:** `CREATE TABLE store.safety_cs_calls_2026_08_20 AS SELECT * FROM store.cs_calls;`

---

## 5. Ticket policy at volume — the part Pitstop actually needs

> Afshaan 2026-08-20: *"get pitstop up to speed to handle the call volume and integrate tickets."*

### 5.1 What today's policy does, measured

Every answered call creates a ticket, or coalesces into an open same-phone ticket within 24 h
(RULE-PITSTOP-018). Measured over **July 2026, incoming calls only**:

| Measure | Value |
|---|---|
| Incoming calls | 2,778 |
| Calls that produced or joined a ticket | **2,778 — every single one** |
| Distinct tickets after coalescing | 1,432 |
| Calls lasting 1–15 s (nobody spoke) | **1,308 (47 %)** |
| **Tickets whose longest call was ≤ 15 s** | **428 (29.9 % of all call tickets)** |
| …of those, closed with disposition `query` | **427 of 428** |
| Median time those tickets sat open before closing | **~26 hours** |
| Closed across N distinct minutes / biggest one-minute burst | 274 / 6 |

**Read that carefully.** Roughly **14 tickets a day are created for calls in which nobody spoke**.
They are not bulk-cleared — they are closed in ones and twos across 274 separate minutes, after
sitting in the queue for a median of a day. That is a human triaging an empty ticket, 428 times a
month, and 427 of 428 land on the same catch-all disposition.

### 5.2 The policy (recommendation — Pruthvi's to confirm)

**A ticket is created when someone actually spoke. Everything else is a call record and, where
relevant, a callback.**

```
answered  AND talk_duration_seconds >= TICKET_MIN_TALK_S (default 15)
    → create ticket, or coalesce per RULE-PITSTOP-018   [unchanged behaviour]

answered  AND talk < 15s          → cs_calls only · ticket_suppressed_reason='short_call'
abandoned (talk = 0)              → cs_calls only · ticket_suppressed_reason='abandoned'
missed / busy / no-answer         → cs_calls only · ticket_suppressed_reason='missed'
                                    · needs_callback = true
failed                            → cs_calls only · ticket_suppressed_reason='missed'
outbound, any duration            → unchanged from today
```

- `TICKET_MIN_TALK_S` is a **worker env var, not a literal** — Pruthvi will want to tune it, and
  re-deploying for a number is how thresholds become permanent by accident.
- **RULE-PITSTOP-018 coalescing is untouched.** Scope stays phone + department + 24 h, and the S156
  amendment (a coalesced *incoming* call takes over ticket ownership; an outgoing one never does)
  is carried over verbatim. It encodes a real incident.
- **Every call still gets a `cs_calls` row.** This policy suppresses *tickets*, never call records —
  the same distinction RULE-PITSTOP-018 already draws.
- Expected effect at July volume: **~428 fewer tickets a month**, with zero loss of call history and
  a callback queue that surfaces the calls that genuinely need chasing.

⚠️ **This needs to be a documented amendment to RULE-PITSTOP-007/018, not a quiet code change.**
"Every answered call creates a ticket" is currently a stated invariant; changing it silently would be
exactly the kind of drift the knowledge layer exists to prevent.

### 5.3 Callback queue

Missed and unanswered calls stop being tickets and become a **worklist**. `needs_callback` is set by
the pipeline and cleared when `called_back_at` is stamped — the column and the "call back" affordance
already exist on `/calls/detail`; nothing new is invented, it is given a queue.

Sticky-agent interaction is favourable and worth stating: Exotel routes a repeat caller back to the
same agent, and RULE-PITSTOP-018 coalesces their calls onto one ticket. The two reinforce each other
— the agent who missed the call is the one it rings back to, and the ticket they eventually raise is
the one the earlier calls attached to.

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
| 5 | **Suppressed-ticket affordance** — a call with `ticket_suppressed_reason` shows why, with a one-click *Create ticket* | The policy must be reversible by an agent in the moment, or it will be experienced as data loss |
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
| **D-2** | Ticket policy §5.2 — is 15 s the right talk-time floor? | **15 s**, as an env var, tunable without a deploy |
| **D-3** | Should recording move to **dual**-channel? | **Leave single.** Revisit only if speaker-separated QA/transcription is wanted |
| **D-4** | Which agents get a softphone, which stay on a mobile leg? | All five with SIP devices; Pruthvi stays mobile-only (he has no SIP device) |

---

## 10. Phases

| Phase | Content | Gate |
|---|---|---|
| **0** | P-1 (top-up + billing email) · P-2 (credentials) · put P-3…P-8 and D-1…D-4 to Pruthvi | Pruthvi |
| **1** | Additive migration (§4.2) · extract `call-pipeline.js` vendor-neutral · re-point the MyOperator path at it with **behaviour byte-identical** | Reviewed diff |
| **2** | **Poller live (§4.1). The call log is restored.** No Exotel-side change required | P-2 only |
| **3** | Backfill the blind window · recording player · ticket policy §5.2 · callback queue · attribution | Snapshot before backfill |
| **4** | `agent-passthru-url` + post-conversation Passthru (screen-pop, live attribution) | P-5 |
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
| Ticket policy is experienced as lost tickets | MED | `ticket_suppressed_reason` is visible on the call with one-click *Create ticket* (§8 item 5) |
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
2. A call in which someone actually spoke has a ticket; one in which nobody did has a call record and,
   if it went unanswered, a place in the callback queue.
3. Any past call plays back inside Pitstop.
4. An agent opens a ticket, clicks **Call**, and talks without leaving Pitstop.
5. Missed and abandoned are separated, and both numbers are true.
6. Nobody on the CS team opens `my.in.exotel.com` in a normal week.

---

## 14. Provenance

Measured 2026-08-20 (S301) unless stated. Live Exotel account `legendoftoys1m` — flow `108159`
applet-by-applet, ExoPhones, payment history, company info (KYC **Verified**, Fraternitas Ventures
Pvt Ltd), VOIP settings, user billplan. `store.cs_calls` n=17,705, 28 May – 19 Aug 2026; July
ticket-policy figures from incoming calls 1–31 July. Concurrency from an interval sweep over
June–August. Prior facts carried from the S299 design + handover, 2026-08-19.
