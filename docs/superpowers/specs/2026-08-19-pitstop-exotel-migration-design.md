# Pitstop × Exotel — telephony migration design

> ⚠️ **PARTIALLY SUPERSEDED 2026-08-20 (S301) by
> [`2026-08-20-pitstop-exotel-integration-build-spec.md`](./2026-08-20-pitstop-exotel-integration-build-spec.md).
> Read that first.** It was written after reading live flow `108159` applet-by-applet, which this
> document had not done. Superseded here: **§3.4 + §5.2** (the start-of-flow Passthru is rejected —
> a caller who hangs up during the greeting emits no webhook at all, so the design is now
> **poller-primary**, and restoring the call log needs no Exotel-side change), **§4** (hook
> inventory), **§8** (phases) and **§9** (dependencies — **everything Exotel now routes through
> Pruthvi**, per Afshaan 2026-08-20). Q-3 is **answered**: the flow is two applets with one group,
> so `main`/`abc` department routing is dead.
> Everything else here — API surface, `NormalisedCall`, schema §5.1, attribution §5.6, softphone §7,
> out-of-scope §10 — **still stands and is not restated in the build spec.**

> **Status:** DESIGN ONLY. Nothing in this document has been built. No change has been made to any
> live system, worker, database object or Exotel setting. Afshaan's instruction 2026-08-19:
> *"before building, confirm with me, do not make any changes to the live system."*
>
> **Date:** 2026-08-19 · **System:** Pitstop (Customer Success) · **Worker:** `csops`
> **Supersedes:** the MyOperator half of `docs/superpowers/specs/2026-05-27-pitstop-integrations-design.md`

---

## 1. Why this exists

LOT's voice traffic moved off MyOperator onto Exotel on the evening of **2026-08-19**. Pitstop's
call pipeline is wired to MyOperator only, so **Pitstop is blind to voice from the moment of the
cutover**. Separately, Afshaan's goal is not merely to restore parity: the team should stop opening
the Exotel dashboard at all. Exotel remains the carrier — LOT keeps paying for it, and the parts of
it that are genuinely telecom stay where they are — but **the operator-facing surface moves into
Pitstop**.

Two objectives, in priority order:

1. **Restore the call log**, with auto-ticketing, at least as good as MyOperator's.
2. **Move Exotel's day-to-day UI into Pitstop** — dialling, recordings, agent management, live call
   state — so a CS agent works in one tab.

---

## 2. Measured current state

All figures measured 2026-08-19 against `lot-production`. They are the baseline any later claim of
improvement must beat.

### 2.1 The MyOperator pipeline (what exists today)

`csops-worker/src/index.js` exposes one telephony surface: `POST /webhooks/myoperator?account=<slug>`,
authenticated by a per-slug shared secret (`MYOP_WEBHOOK_SECRET_<SLUG>`, falling back to
`MYOP_WEBHOOK_SECRET` for `main`). It handles three event types:

| Event | Handler | Effect |
|---|---|---|
| `call.answered` / `call.responded` | `webhookCallAnswered` | Upsert `store.cs_calls`; auto-create a `cs_tickets` row, or coalesce into an open ticket for the same phone + department within 24 h (RULE-PITSTOP-018); Shopify customer + order lookup |
| `call.end` / `call.ended` | `webhookCallEnd` | Patch duration / recording filename; `status = duration > 0 ? answered : missed`; create the ticket out-of-order if `call.answered` never arrived |
| `call.summary` | `webhookCallSummary` | Back-fill the agent from `legs[].agent.email` via `pickConnectedLeg()`, then reassign the ticket |

Supporting pieces that must survive the migration unchanged in behaviour:

- `pickConnectedLeg()` — on a routed call, picks the leg that actually connected, not the first one
  rung (S144: Maria missed → Sunitha answered, ticket was crediting Maria).
- `myopDirection()` — maps the vendor string onto the `{incoming, outgoing}` CHECK, storing NULL
  rather than dropping the row on an unknown value.
- `COALESCE_WINDOW_MS` = 24 h repeat-caller coalescing.
- `resolveAgentByEmail()` — GoTrue admin lookup → `users_profile.full_name`.
- `toE164()` — 10 digits → `+91…`.

### 2.2 The numbers

| Fact | Value |
|---|---|
| `store.cs_calls` rows | **17,705** (28 May → 19 Aug) |
| Rows with a playable `recording_url` | **0** |
| Rows with `recording_filename` only | 8,078 (46%) |
| Agent attribution rate, last 10 days | **56–79%** (≈30% of calls credit nobody) |
| Rows with `status = 'missed'` | **45 of 17,705 (0.25%)** |
| Incoming calls lasting 1–15 s | 30 of 92 (19 Aug), 69 of 222 (17 Aug) — **~30%** |
| Last call received | **2026-08-19 18:08 IST**, nothing since |
| Live DIDs | `+912262054541` (932/14d), `+918064124537` (585/14d) |
| Named agents resolving | 3 — Dhiraj Sharma, Sunitha B, Maria Kharkongor |

Three of these are defects, not merely gaps:

- **Recordings have never been playable in Pitstop.** `recording_url` is NULL on every row ever
  written; `calls/detail/page.js` renders `recording_filename` as inert `<code>`. The Recording
  section on a call has never once produced audio.
- **`missed` is effectively dead.** 0.25% missed is not credible against ~110 calls/day. MyOperator
  only marks missed when `call.end` reports `duration = 0`, which it evidently almost never does.
  Every "missed call" KPI, the `missed` nav badge and the Missed tab are therefore reading a number
  that is not what it claims.
- **~30% of incoming calls last 1–15 seconds** and are recorded as `answered` with no agent. These
  are near-certainly IVR-drop / abandon, and they inflate every call volume and handling metric.
  Exotel's richer status vocabulary lets us separate them; MyOperator's did not.

None of the three are caused by the migration. All three are cheaper to fix during it than after.

### 2.3 Schema constraints that bind the design

```
cs_calls_direction_check   CHECK (direction  = ANY (ARRAY['incoming','outgoing']))
cs_calls_status_check      CHECK (status     = ANY (ARRAY['answered','missed','abandoned','in_progress']))
cs_calls_myop_account_id_call_session_id_key   UNIQUE (myop_account_id, call_session_id)
cs_calls_myop_account_id_fkey                  FK → store.myop_accounts(id)
```

The UNIQUE key and the FK are both anchored on `myop_account_id`. **An Exotel call cannot be written
without either inventing a fake `myop_accounts` row or changing the key.** This is the single most
consequential schema fact in the migration and §5 addresses it directly.

---

## 3. What Exotel actually provides

Answering Afshaan's question — *"does it have an external number which dials our number, so if we
built it ourselves would we need that extra number?"*

**No extra number is needed. The model is two legs, one number.**

- **Inbound:** customer → ExoPhone (leg 1). Exotel's switch answers on the PSTN, then places a
  *fresh outbound call* to the agent — mobile or SIP client — (leg 2) and bridges the two.
- **Outbound (click-to-call):** we `POST Calls/connect`. Exotel rings the **agent** first (leg 1);
  on answer it dials the **customer** (leg 2), presenting the ExoPhone as caller ID.

The agent's own phone is the second leg in both directions. That is a billed leg, not a number to
provision. **One ExoPhone serves both directions.** Building the UI ourselves changes none of this.

### 3.1 Split of responsibility

| Stays with Exotel — cannot be rebuilt | Moves into Pitstop — pure UI over their APIs |
|---|---|
| The ExoPhone itself (PSTN number, telecom licence, carrier interconnect, DoT/TRAI) | Call log, search, filters, KPIs |
| The switch: answering, bridging, hold music, queueing, DTMF | Recording playback |
| IVR / call-flow execution (App Bazaar applets) | Agent & user management (Users API) |
| Recording capture + storage | Number + flow visibility |
| Media path for barge/whisper | Reports, analytics, campaign lists |
| SIP registrar for browser clients | Click-to-call, call disposition, live call state |

### 3.2 The live account, as configured (read 2026-08-19)

Account `legendoftoys1m`, region Mumbai, subdomain `api.in.exotel.com`, credits 538.

**ExoPhones — exactly one:**

| Number | Type | Installed flow |
|---|---|---|
| `080-446-56833` | Landline | "Incoming" (flow ID 108159) |

Unattached flows also exist: `copy - Incoming` (108160), `legendoftoys1m Landing Flow` (108084).

**Co-workers — six, five with SIP devices already provisioned:**

| Name | Role | Device | State |
|---|---|---|---|
| Pruthvi Thimmaiah | Admin | Mobile `07019103926` | ON |
| Kavya Chandran | User | `sip:kavyacad8e1f2c` | ON |
| Sunitha B | Supervisor | `sip:sunithab17b95f7f` | ON |
| Dhiraj Sharma | User | `sip:dhirajs63dd53fa` | ON |
| Afshaan Siddiqui | Admin | `sip:afshaansfb9fe074` | **UNVERIFIED** |
| Maria Kharkongor | User | `sip:mariakfad3213a` | **UNVERIFIED** |

Groups: Sales (1), Support (4), SundayGroup (2). Address book also holds each agent's mobile:
Afshaan `07709991011`, Dhiraj `07022269161`, Kavya `08589889327`, Maria `07005084698`,
Pruthvi `07019103926`, Sunitha `06361188308`.

**Call Settings → VOIP:**

| Setting | Value |
|---|---|
| VOIP Calling Status | **ACTIVE** |
| PSTN-VOIP Intermixing | **ON** |
| User VOIP Call Routing | OFF |
| Browser Calling | **ON** |
| VOIP domain | `legendoftoys1m.voip.exotel.com` |
| VOIP proxy | `voip.in1.exotel.com:443` |
| Auto-answer incoming | OFF |

Number masking is off (`isNumberMaskingEnabled = 'false'`). Whitelisting is off (0 numbers).
Recording is configured per-flow in App Bazaar, and is demonstrably **on** — every completed call in
the Exotel Inbox carries a recording with a duration.

**Two anomalies to resolve with Exotel, not in code:**

1. `08048332909` appears as an outgoing number in Exotel's own Inbox but **is not provisioned in the
   account** — absent from ExoPhones, Call Settings, Campaigns, Sales and the Address book.
2. Neither live Pitstop DID (`+912262054541`, `+918064124537`) is an ExoPhone on this account. If
   those numbers are being ported, the port is not yet visible here.

### 3.3 API surface we will use

Authentication for everything in Layers 1–2 is **HTTP Basic** with the existing key/token:
`https://<key>:<token>@api.in.exotel.com/v1/Accounts/legendoftoys1m/…`. Rate limit **200 calls/min**.

| Purpose | Endpoint |
|---|---|
| Click-to-call | `POST /v1/Accounts/{sid}/Calls/connect` |
| Single call detail | `GET /v1/Accounts/{sid}/Calls/{CallSid}?details=true` |
| Bulk call detail / backfill | `GET /v1/Accounts/{sid}/Calls` |
| Agent / user management | `GET·POST·PUT·DELETE /v2/accounts/{sid}/users` |
| Numbers | ExoPhones API |

`Calls/connect` parameters that matter to us:

| Param | Use |
|---|---|
| `From` | The agent. **Accepts an E.164 number *or* a SIP URI** — this is what lets one code path serve both the mobile and the softphone era |
| `To` | Customer, E.164 |
| `CallerId` | ExoPhone `08044656833` |
| `CallType` | `trans` (transactional) |
| `Record` | `true` |
| `TimeLimit` / `TimeOut` | Guardrails; max 14400 s |
| `CustomField` | **≤128 chars — carries our `ticket_id` / `thread_id` so the callback self-attributes** |
| `StatusCallback` | Our webhook |
| `StatusCallbackEvents` | `terminal` + `answered` |
| `StatusCallbackContentType` | `application/json` |

Response returns `Call.Sid` — our idempotency key. `Duration`, `Price` and `EndTime` settle
asynchronously **~2 minutes after the call ends**, which the design must tolerate (§5.4).

Call Details returns `Status` ∈ {completed, failed, busy, no-answer}, `Direction` ∈ {inbound,
outbound-dial, outbound-api}, `RecordingUrl`, `Price`, and under `details=true` a
`Details.Legs[]` array plus `Details.ConversationDuration` — **talk time as distinct from leg time**,
which is what fixes the 1–15 s problem.

Backfill limits: **6 months of history, 1-month range per request, PageSize ≤ 100**, cursor
pagination via `Before` / `After`.

### 3.4 Inbound

Inbound calls do not post to us by default. A **Passthru applet** is added to the "Incoming" flow;
Exotel then makes a **GET** to our URL with a query string carrying `CallSid`, `CallFrom`, `CallTo`,
`Direction=incoming`, `Created`, `StartTime`, `EndTime`, `DialCallDuration`, `DialWhomNumber`,
`CallType`, `RecordingUrl`, `flow_id`, `CurrentTime`. Passthru is a **flow edit in App Bazaar** —
an Exotel-side change, and therefore gated on Afshaan's approval like everything else here.

---

## 4. Architecture — three layers

```
                    ┌─────────────────────────── EXOTEL ──────────────────────────┐
                    │  ExoPhone 08044656833 · switch · IVR flow · recording store │
                    └──────┬──────────────────────────────────────────┬───────────┘
      inbound: Passthru +  │                                          │  outbound: Calls/connect
      StatusCallback (GET/POST)                                       │  (POST, Basic auth)
                           ▼                                          │
        ┌──────────────────────────────────────────────────────────────┴──────────┐
        │  csops worker — src/telephony/                                          │
        │    exotel-webhooks.js   inbound + status callbacks  → cs_calls          │
        │    exotel-client.js     Basic-auth API client, retries, rate limit      │
        │    exotel-backfill.js   cron: reconcile against Call Details            │
        │    call-pipeline.js     VENDOR-NEUTRAL: upsert, ticket, coalesce, agent │
        └────────────────────────────────┬────────────────────────────────────────┘
                                         ▼
                       store.cs_calls · cs_tickets · cs_telephony_agents
                                         ▲
        ┌────────────────────────────────┴────────────────────────────────────────┐
        │  Pitstop app                                                            │
        │   /calls  /calls/detail   log, filters, KPIs, recording player          │
        │   CallBar                 softphone: dialpad, incoming popup, controls  │
        │   /admin/telephony        agents, numbers, flows, live calls            │
        └─────────────────────────────────────────────────────────────────────────┘
```

**L1 · Data plane** — Exotel → Pitstop. The call log, auto-ticketing, attribution, recordings.
**L2 · Control plane** — Pitstop → Exotel. Dialling, agent admin, number/flow visibility.
**L3 · Softphone** — the browser SIP client embedded in Pitstop.

The critical structural decision: **`call-pipeline.js` is vendor-neutral.** The MyOperator handlers
and the Exotel handlers both normalise into one internal `NormalisedCall` shape and call the same
pipeline. Ticket creation, coalescing, Shopify lookup and agent resolution are written once. This is
what makes a dual-run safe and a future vendor change cheap, and it is the reason not to bolt Exotel
onto the existing handlers.

```js
// The one shape both vendors normalise into.
{ provider, provider_call_sid, direction, exophone, customer_phone,
  agent_ref: { sip_id?, phone?, email? },
  status, dial_status, started_at, ended_at,
  leg_duration_seconds, talk_duration_seconds,
  recording_url, price_inr, custom_field, raw }
```

---

## 5. Layer 1 — data plane

### 5.1 Schema changes

All additive. No column is dropped, no historic row is rewritten, and nothing is renamed in this
phase — a rename mid-cutover risks the one path that works.

**`store.cs_calls` — new columns**

| Column | Type | Purpose |
|---|---|---|
| `provider` | `text NOT NULL DEFAULT 'myoperator'` | `myoperator` \| `exotel`. The default back-stamps 17,705 historic rows correctly with no backfill. |
| `provider_call_sid` | `text` | Exotel `CallSid`. `call_session_id` is retained and mirrored so every existing query keeps working. |
| `talk_duration_seconds` | `int4` | `Details.ConversationDuration` — real conversation time. `duration_seconds` keeps its current meaning (leg time) so no existing metric silently shifts. |
| `dial_status` | `text` | Raw vendor outcome: `completed`/`busy`/`no-answer`/`failed`/`canceled`. The granularity `status` throws away. |
| `price_inr` | `numeric` | Per-call cost from Exotel. New capability. |
| `exophone` | `text` | The virtual number leg. Mirrors `did`. |
| `agent_sip_id` | `text` | Which SIP device took it — the primary attribution key in the softphone era. |
| `recording_duration_seconds` | `int4` | For the player UI. |

**Constraint changes**

```sql
-- 1. Uniqueness must stop being anchored on the MyOperator account.
ALTER TABLE store.cs_calls
  ADD CONSTRAINT cs_calls_provider_sid_key UNIQUE (provider, provider_call_sid);
-- The old UNIQUE (myop_account_id, call_session_id) is KEPT — MyOperator rows still rely on it.

-- 2. status must admit the outcomes Exotel actually reports.
ALTER TABLE store.cs_calls DROP CONSTRAINT cs_calls_status_check;
ALTER TABLE store.cs_calls ADD CONSTRAINT cs_calls_status_check
  CHECK (status = ANY (ARRAY['answered','missed','abandoned','in_progress','failed','busy','no_answer']));

-- 3. myop_account_id — NO CHANGE NEEDED. Verified 2026-08-19 via information_schema:
--    it is ALREADY nullable, so an Exotel row can leave it NULL. The FK permits NULL too.
```

⚠️ **Two columns are `NOT NULL` and constrain the insert path** (verified 2026-08-19):

- **`call_session_id NOT NULL`** — so every Exotel row must populate it. We mirror `CallSid` into
  both `call_session_id` and `provider_call_sid`. `call_session_id` is what ~20 existing worker and
  app call sites already select and search on; mirroring keeps every one of them working untouched,
  which is the whole reason not to introduce `provider_call_sid` as the only home for the SID.
- **`status NOT NULL`** — there is no "unknown" resting state. A row inserted the moment
  `Calls/connect` returns must therefore be written as `in_progress` immediately, not left blank
  pending the first callback.

⚠️ **`direction` CHECK is left exactly as is.** Exotel's `inbound` / `outbound-dial` / `outbound-api`
must be mapped in code to `incoming` / `outgoing`, with an unrecognised value stored as **NULL, never
passed through raw**. This is the `metaAttachmentKind` failure class that silently destroyed every
shared Instagram reel, and the existing `myopDirection()` comment already records it. `exotelDirection()`
mirrors that function exactly, including the log line on an unmapped value.

**New table — `store.cs_telephony_agents`**

The join between a Pitstop user and their Exotel identity. Without it, neither click-to-call
(needs a `From`) nor attribution (needs SIP → user) can work.

| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid PK` | Supabase auth user |
| `provider` | `text NOT NULL DEFAULT 'exotel'` | |
| `exotel_user_id` | `text` | From the Users API |
| `sip_id` | `text UNIQUE` | e.g. `sip:dhirajs63dd53fa` |
| `agent_phone` | `text` | E.164 mobile — the `From` for PSTN click-to-call |
| `device_preference` | `text` | `sip` \| `tel` — which leg to ring |
| `is_active` | `bool DEFAULT true` | |
| `last_synced_at` | `timestamptz` | From the Users API sync |

RLS on, service_role only, per RULE-RLS-001. Migration ends with `NOTIFY pgrst, 'reload schema';` —
a new table in an already-exposed schema is invisible to PostgREST until the cache reloads, and it
fails **silently** (CORE.md; cost a live round in S239).

**`store.myop_accounts`** gains `provider text DEFAULT 'myoperator'` and `exophone text`, and gets a
row for the Exotel account so `cs_department_id` routing keeps working. Renaming the table to
`telephony_accounts` is deliberately **deferred** to a later tidy-up: it touches 20+ call sites
across the worker and app, and doing it during a cutover trades a working system for a cosmetic win.

### 5.2 Inbound

`GET /webhooks/exotel/passthru` on csops.

- **Auth:** Passthru is a GET with no header slot, so authentication is a **shared secret in the
  query string** (`?token=…`), same posture as the MyOperator webhook. Compared in constant time,
  and the secret is a worker secret, never in `wrangler.toml`.
- Normalise → `call-pipeline.js` → upsert `cs_calls` keyed `(provider, provider_call_sid)`.
- Auto-create / coalesce the ticket via the **existing, unchanged** 24 h logic.
- **Must return quickly** — Exotel is holding a live call while it waits. Ticket creation, Shopify
  lookup and agent resolution go in `ctx.waitUntil()`; the response is a bare 200.

### 5.3 Outbound + terminal status

`POST /webhooks/exotel/status`, subscribed to `answered` and `terminal`.

- `answered` → `status = 'in_progress'`, stamp `started_at`, resolve the agent.
- `terminal` → final status, durations, `recording_url`, `price_inr`, `dial_status`.
- Idempotent on `(provider, provider_call_sid)`, additive-patch, exactly like `upsertCsCall`.
- **The INSERT result is checked and logged on failure.** The MyOperator version did not, so a
  rejected insert made a customer's call vanish with no trace anywhere — fixed in the same file, and
  the new pipeline inherits the check, not the bug.

**Status mapping — this is where the missed-call defect gets fixed:**

| Exotel | `status` | `dial_status` |
|---|---|---|
| `completed`, talk > 0 | `answered` | `completed` |
| `completed`, talk = 0 | `abandoned` | `completed` |
| `no-answer` | `missed` | `no-answer` |
| `busy` | `missed` | `busy` |
| `failed` | `failed` | `failed` |
| in flight | `in_progress` | — |

⚠️ **This will make the missed-call count jump from ~0 to its true value, and it will look like a
regression.** It is the correction landing. The same warning applies as to the S298 agent-report
rebuild: anyone comparing against a figure they wrote down last week must be told. `missed` is
currently 0.25% of 17,705 calls; the honest figure is unknown but certainly far higher.

Whether an abandoned IVR-drop should also count as `missed` is an **open question for Pruthvi**
(§9) — it changes the meaning of the Missed tab and the nav badge, and is his metric to define.

### 5.4 The async-settlement problem

Exotel settles `Duration`, `Price` and `EndTime` **~2 minutes after the call ends**. A terminal
callback can therefore arrive with a null duration and no recording URL.

**Resolution:** a `*/10 * * * *` cron in `exotel-backfill.js` re-reads any `cs_calls` row from the
last 24 h that is missing `talk_duration_seconds` or `recording_url`, via
`GET /Calls?Sid=<comma-separated>` — up to 100 SIDs per request, so one call covers a normal day.
Never a per-row loop (CORE.md global invariant).

### 5.5 The blind-window backfill

Voice moved at 18:08 IST on 2026-08-19 and nothing has reached Pitstop since. Those calls exist in
Exotel and are recoverable: `GET /Calls` serves 6 months, 1-month windows, PageSize 100, cursor
paginated.

A one-shot backfill walks from the cutover to now, writing `cs_calls` rows with
`provider='exotel'`. **It deliberately does NOT auto-create tickets** — retro-firing ticket creation
for a day of calls would spray dozens of `[Pending — auto-created from call]` tickets into a live
queue and reset every SLA clock. The rows land as call history; the CS team raises tickets by hand
for anything that needs one. Ticket auto-creation begins from the moment the webhook goes live, and
that boundary is recorded on the rows.

⚠️ Paging must **order by something unique and tie-break on the SID** — a non-unique sort silently
drops and repeats rows across page boundaries (CORE.md).

### 5.6 Agent attribution

Resolution order, first hit wins:

1. `agent_sip_id` → `cs_telephony_agents.sip_id` — exact, and the softphone path.
2. Leg `From`/`DialWhomNumber` in E.164 → `cs_telephony_agents.agent_phone`.
3. Email → the existing `resolveAgentByEmail()`.
4. For a Pitstop-initiated call, `CustomField` carries the initiating `user_id` — **authoritative,
   and independent of any Exotel identity**.

Route 4 is why `CustomField` is set on every click-to-call: it makes outbound attribution exact by
construction rather than inferred. `pickConnectedLeg()` is ported unchanged for inbound routed calls
— it encodes a real S144 incident and must not be re-derived.

---

## 6. Layer 2 — control plane

### 6.1 Click-to-call

`POST { action: 'placeCall', to, ticket_id?, thread_id? }` on csops.

- Guarded by a `canX()` check first, per RULE-011.
- `From` = the caller's `device_preference` → `sip_id` or `agent_phone` from `cs_telephony_agents`.
- `CallerId` = the account's ExoPhone. `Record=true`. `CallType=trans`.
- `CustomField` = compact `{u,t}` (user + ticket), **≤128 chars — enforced, not assumed**.
- On the 200, insert the `cs_calls` row immediately as `in_progress` so the UI shows the call the
  moment it starts, rather than waiting for a callback.
- **Rate limit 200/min** is a shared account budget — the client backs off on 429 rather than retrying
  blind.

Entry points: the ticket detail header, a call-log row (call back), the inbox thread header, and the
customer phone anywhere it renders.

### 6.2 Agent management — `/admin/telephony`

Replaces the Exotel *Co-workers* screen and the current `/admin/myop` page. Lists Pitstop users
joined to their Exotel identity; supports create/update/deactivate through the Users API and a
**sync** action that reconciles both directions and reports drift. Surfaces the two UNVERIFIED
devices (Afshaan, Maria) — invisible in Pitstop today and a silent cause of failed routing.

### 6.3 Numbers, flows, live calls

Read-only in v1: ExoPhones with the flow each is attached to, and the unattached flows. Flow
*editing* stays in App Bazaar — rebuilding an IVR editor is a project of its own and is explicitly
out of scope (§10). A live-calls strip renders in-flight `in_progress` rows.

---

## 7. Layer 3 — softphone

The agents already make browser calls; they do it in Exotel's tab. This layer moves that into
Pitstop, which is the actual objective.

**What is already true** (measured, §3.2): VOIP ACTIVE, PSTN-VOIP intermixing ON, Browser Calling ON,
SIP domain and proxy assigned, and SIP devices provisioned for 5 of 6 co-workers.

**The SDK is public and Apache-2.0** — no gate, contrary to the docs overview:

- `@exotel-npm-dev/exotel-ip-calling-crm-websdk` — the CRM wrapper. `new ExotelCRMWebSDK(accessToken,
  userId, autoConnectVOIP)` → `Initialize(HandleCallEvents, RegistrationEvent)`, then `MakeCall`,
  `AcceptCall`, `HangupCall`, `ToggleMute`, `ToggleHold`.
- `@exotel-npm-dev/webrtc-client-sdk` v3.0.11 — the lower-level client the wrapper sits on.

**Delivery:** a persistent `<CallBar>` in the Pitstop `(auth)` shell — registration state, dialpad,
incoming-call popup with the customer + ticket already resolved, mute/hold/hangup, and a live timer.
It must survive route changes, so it mounts in the layout, not a page. The SDK is ~1.4 MB and is
**lazy-loaded on demand for users who have a SIP device**, never in the shared bundle.

**Inbound to the browser** needs the Connect applet in the "Incoming" flow pointed at
`https://integrationscore.mum1.exotel.com/v2/integrations/call/inbound_call/{appId}?type={popup|incomingcallhungup|missedcall}`.
That is an Exotel-side flow edit.

### 7.1 ⚠️ The prerequisites that are NOT satisfied

Exotel's IP-PSTN onboarding article lists conditions that the dashboard alone cannot confirm:

1. A services agreement with **Veeno Communications Pvt. Ltd.** (Exotel's VNO entity) for VoIP.
2. **A new account** — the article states one is required even for existing customers, for
   regulatory separation.
3. **KYC, Bangalore only**, with a Customer Acquisition Form.
4. **Client ID + Client Secret**, obtainable only by asking Exotel tech support — not self-serve, and
   **not the API key/token in the dashboard**.
5. Commercials: a **fixed per-user monthly fee** on an Unlimited Calling Plan.
6. The programme is described as **Alpha**.
7. Firewall: `voip.in1.exotel.com`, tcp/80, tcp/443, **udp/10000–40000**, and the Mumbai media
   servers `182.76.143.61` / `122.15.8.18`.

The evidence cuts both ways and must not be resolved by assumption. VOIP is ACTIVE and SIP IDs
exist, which suggests much of 1–3 is already done for `legendoftoys1m`. But **the Client ID/Secret is
a hard, self-serve-impossible dependency**, and the per-user pricing is a commercial decision that is
Afshaan's alone.

**Therefore L3 is specified but sequenced behind one question to Exotel** (§9, DEP-1). L1 and L2 have
no such dependency — they need only the API key and token that already exist. Building L1+L2 first is
not a hedge; it is the only order that does not stall on a third party.

---

## 8. Migration & cutover

| Phase | Content | Gate |
|---|---|---|
| **0** | Approve this spec. Obtain the API token as a worker secret. Ask Exotel the §9 questions. | Afshaan |
| **1** | Schema migration (additive). `call-pipeline.js` extracted vendor-neutral, MyOperator path re-pointed at it with **behaviour unchanged**. | Reviewed diff |
| **2** | Exotel webhooks live. Passthru + Connect applets added to flow 108159. Verify on one real call before relying on it. | Afshaan approves the Exotel-side flow edit |
| **3** | Backfill the blind window. Recording player. Attribution fix. | — |
| **4** | Click-to-call + `/admin/telephony`. | — |
| **5** | Softphone. | DEP-1 resolved |

**MyOperator is not deleted.** Its webhook stays mounted and functional throughout. It costs nothing
while idle, and if a number turns out not to have moved, deleting the handler is the difference
between a quiet fallback and an outage. Removal is a separate decision once Exotel has run clean for
a week.

**Deploy order matters.** Worker before app, always: a new app calling an action the deployed worker
lacks is a broken button, while a new worker with an old app is inert. Per CORE.md the push must land
before the deploy, or a parallel session's live change is silently reverted (PATTERN-220).

**Rollback:** phases 1–2 are additive and reversible by not sending traffic. Once the Passthru applet
is live, rollback means removing it in App Bazaar — an Exotel-side action, so someone must be able to
do it out of hours.

---

## 9. Dependencies and open questions

**Blocking — Exotel must answer:**

- **DEP-1 · Client ID + Client Secret** for the integrations platform, and confirmation that
  `legendoftoys1m` is on the Veeno/IP-PSTN agreement with per-user VoIP pricing. **Blocks L3 only.**
- **DEP-2 · `08048332909`** — it shows as an outgoing number in Exotel's Inbox but is not provisioned
  on the account. What is it?
- **DEP-3 · The two live DIDs** `+912262054541` and `+918064124537` — are they being ported to
  Exotel, retired, or forwarded? Neither is an ExoPhone today.

**Blocking — Afshaan:**

- **DEP-4 · The API token.** Visible in the dashboard behind the eye icon on "Default API key". It is
  a vendor credential and must be set with `wrangler secret put EXOTEL_API_TOKEN` — never committed,
  never echoed. Also needs `EXOTEL_API_KEY`, `EXOTEL_ACCOUNT_SID`, `EXOTEL_WEBHOOK_TOKEN`.
- **DEP-5 · Approval to edit the Exotel call flow** (adding Passthru / Connect applets to flow
  108159). This is a change to a live customer-facing IVR.

**Open — Pruthvi:**

- **Q-1** Should an abandoned IVR-drop (~30% of inbound, 1–15 s, nobody spoke) count as **missed**,
  or as its own **abandoned** class? Changes the Missed tab, the nav badge and every historic
  comparison.
- **Q-2** Should Exotel calls still auto-create a ticket on every answered inbound, as MyOperator
  does? At ~110 calls/day with 30% abandoned, unchanged behaviour means a lot of empty tickets.
- **Q-3** Does the department routing (`main` / `abc`) still mean anything with one ExoPhone?
- **Q-4** Which agents get a softphone, and which stay on a mobile leg?

---

## 10. Explicitly out of scope

- Rebuilding the IVR / flow editor. Flows stay in App Bazaar.
- Barge / whisper / live listen — Exotel's media path, not reproducible.
- Campaigns and the auto-dialer. Read-only listing only; the campaign engine stays theirs.
- AI Voice Agents, CQA, transcription.
- Renaming `myop_accounts` → `telephony_accounts` and `myop_account_id` → `telephony_account_id`.
  Correct, and deliberately deferred out of the cutover.
- Deleting the MyOperator code path.
- Porting the two live DIDs — a telecom process, not a build.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Pitstop stays blind while this is built | **HIGH — live now** | Phase 2 first; backfill recovers the window from Exotel's own records |
| Missed-call count jumps and reads as a regression | MED | Stated in §5.3; warn the team in the same breath as the release, as with the S298 agent report |
| Passthru holds a live call while csops works | MED | Bare 200 immediately, all work in `ctx.waitUntil()` |
| Exotel direction/status strings drift | MED | Map to NULL and log, never pass through raw — the reel-drop failure class |
| Async settlement leaves rows incomplete | MED | 10-min reconcile cron against Call Details |
| L3 stalls on DEP-1 | MED | L1+L2 have no third-party dependency and deliver most of the value |
| Backfill double-writes | LOW | UNIQUE `(provider, provider_call_sid)`; unique sort key when paging |
| 200/min rate limit | LOW | Batch SID lookups 100-at-a-time; back off on 429 |
| Recording URLs are pre-signed and expire | MED | Never store a signed URL as permanent; resolve on demand via Call Details with `RecordingUrlValidity` |

⚠️ **Snapshot before any bulk write** — `CREATE TABLE store.safety_cs_calls_2026_08_19 AS SELECT …`
per CLAUDE.md, before the backfill runs.

---

## 12. What "done" looks like

1. A customer calls `08044656833`; within seconds the call is in Pitstop's log with the right agent,
   and its ticket exists or it coalesced into an open one.
2. An agent opens a ticket, clicks **Call**, and talks — in the browser — without leaving Pitstop.
3. Any past call can be played back inside Pitstop.
4. Adding, removing or re-deviceing an agent happens on `/admin/telephony`.
5. Missed and abandoned calls are separated and both are true.
6. Nobody on the CS team opens `my.in.exotel.com` in a normal week.
