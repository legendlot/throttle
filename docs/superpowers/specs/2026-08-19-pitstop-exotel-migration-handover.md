# Pitstop × Exotel migration — conversation handover

> **Purpose:** resume the Exotel migration discussion without re-deriving anything. Read this first,
> then the design spec: [`2026-08-19-pitstop-exotel-migration-design.md`](./2026-08-19-pitstop-exotel-migration-design.md).
>
> **Session:** S299, 2026-08-19 · **Participants:** Afshaan + Claude · **State:** design agreed in
> outline, build NOT started, planning session scheduled for 2026-08-20.
>
> ⚠️ **NOTHING HAS BEEN BUILT OR CHANGED.** No worker edit, no migration, no Exotel setting, no
> deploy. Afshaan's instruction, verbatim: *"before building, confirm with me, do not make any
> changes to the live system, we'll discuss first. i want you to explore and create the spec on
> what's required."* That instruction still stands going into tomorrow.

---

## 1. Where things stand right now

**Voice moved from MyOperator to Exotel on the evening of 2026-08-19.**

**Pitstop is blind to voice as of 18:08 IST today.** That was the last call written to
`store.cs_calls`; nothing since. The MyOperator webhook is still mounted and still works — it simply
has no traffic, because the numbers moved.

**Nothing is permanently lost.** Exotel retains 6 months of call history and serves it through
`GET /v1/Accounts/{sid}/Calls`. The blind window is recoverable by backfill. **The gap widens every
day the wiring is not done**, and past 6 months it stops being recoverable.

---

## 2. What Afshaan decided in this session

| Decision | Value |
|---|---|
| **Goal** | Piggyback on Exotel's platform — LOT keeps paying for it — but **the operator-facing UI moves into Pitstop**. The team should not need to open `my.in.exotel.com`. |
| **Softphone** | **In the same build**, not deferred. Agents should talk inside Pitstop. |
| **Cutover** | MyOperator is done; traffic moved this evening. |
| **Process** | Explore + spec first. **Confirm before building.** No live changes without approval. |
| **Pace** | Fast, but thorough. |

Superseded during the session: Afshaan initially picked "Exotel rings the agent's mobile", then
moved to the softphone once it emerged that browser calling is already provisioned on the account
(see §4). **The softphone is the chosen direction.**

---

## 3. The question Afshaan asked, and the answer

> *"Does it have an external number which dials our number, so if we build it ourselves would we
> need that extra number?"*

**No. The model is two legs, one number — no extra number is needed.**

- **Inbound:** customer → ExoPhone (leg 1). Exotel's switch answers on the PSTN, then places a fresh
  outbound call to the agent (leg 2) and bridges them.
- **Outbound:** we `POST Calls/connect`. Exotel rings the **agent** first (leg 1); on answer it dials
  the **customer** (leg 2), showing the ExoPhone as caller ID.

The agent's phone/softphone is the second leg in both directions — a billed leg, not a number to
provision. Building the UI ourselves changes none of this.

**What can never move off Exotel:** the ExoPhone itself (telecom licence, carrier interconnect,
DoT/TRAI), the switch (answering, bridging, hold music, queueing, DTMF), IVR execution, recording
capture and storage, and the media path for barge/whisper.

**What is only UI and can move:** call log, search, filters, KPIs, recording playback, agent
management, number/flow visibility, reports, campaign lists, click-to-call, live call state.

---

## 4. Facts established — do not re-derive these

All measured 2026-08-19 against `lot-production` and the live Exotel dashboard.

### 4.1 Pitstop / MyOperator today

| Fact | Value |
|---|---|
| `store.cs_calls` rows | 17,705 (28 May → 19 Aug) |
| Rows with playable `recording_url` | **0** — recordings have NEVER worked in Pitstop |
| Rows with `recording_filename` only | 8,078 (46%), rendered as inert text on the detail page |
| Agent attribution, last 10 days | 56–79% (~30% credit nobody) |
| `status = 'missed'` | **45 of 17,705 (0.25%)** — not credible at ~110 calls/day |
| Incoming calls of 1–15 s | ~30% (30 of 92 on 19 Aug; 69 of 222 on 17 Aug), logged `answered`, no agent |
| Last call received | **2026-08-19 18:08 IST** |
| Old live DIDs | `+912262054541` (932/14d), `+918064124537` (585/14d) |
| Named agents resolving | Dhiraj Sharma, Sunitha B, Maria Kharkongor |

**MyOperator was webhook-in only.** `POST /webhooks/myoperator` handling `call.answered` /
`call.end` / `call.summary`. **There has never been any click-to-call in Pitstop** — agents dialled
from the vendor's own console.

### 4.2 Schema constraints that bind the build

```
cs_calls_direction_check  CHECK (direction = ANY (ARRAY['incoming','outgoing']))
cs_calls_status_check     CHECK (status    = ANY (ARRAY['answered','missed','abandoned','in_progress']))
UNIQUE (myop_account_id, call_session_id)      -- anchored on the MyOperator account
FK myop_account_id → store.myop_accounts(id)   -- likewise
call_session_id  NOT NULL
status           NOT NULL
myop_account_id  NULLABLE   (verified — no ALTER needed)
```

**An Exotel call cannot be written today** without either faking a `myop_accounts` row or adding a
`(provider, provider_call_sid)` key. The spec adds the key, additively, with
`provider DEFAULT 'myoperator'` so all 17,705 historic rows are back-stamped correctly with no
backfill.

### 4.3 The live Exotel account (`legendoftoys1m`)

Region Mumbai · subdomain `api.in.exotel.com` · credits 538 · API key created 18-08-2026.

**Exactly one ExoPhone:** `080-446-56833` (Landline), on flow **"Incoming" (ID 108159)**.
Unattached flows: `copy - Incoming` (108160), `legendoftoys1m Landing Flow` (108084).

**Six co-workers, five with SIP devices already provisioned:**

| Name | Role | Device | State | Mobile |
|---|---|---|---|---|
| Pruthvi Thimmaiah | Admin | mobile only | ON | 07019103926 |
| Kavya Chandran | User | `sip:kavyacad8e1f2c` | ON | 08589889327 |
| Sunitha B | Supervisor | `sip:sunithab17b95f7f` | ON | 06361188308 |
| Dhiraj Sharma | User | `sip:dhirajs63dd53fa` | ON | 07022269161 |
| Afshaan Siddiqui | Admin | `sip:afshaansfb9fe074` | **UNVERIFIED** | 07709991011 |
| Maria Kharkongor | User | `sip:mariakfad3213a` | **UNVERIFIED** | 07005084698 |

Groups: Sales (1), Support (4), SundayGroup (2).

**Call Settings → VOIP:** VOIP Calling **ACTIVE** · PSTN-VOIP Intermixing **ON** · Browser Calling
**ON** · User VOIP Call Routing OFF · Auto-answer OFF · domain `legendoftoys1m.voip.exotel.com` ·
proxy `voip.in1.exotel.com:443`. Number masking off. Whitelisting off (0 numbers). Recording is on
(configured per-flow in App Bazaar; every completed call in the Inbox carries audio).

Campaigns, Lists, Contacts and Sales are all empty.

### 4.4 Corrections made during the session — do not revert to the earlier belief

1. **The WebRTC softphone is NOT commercially gated.** I said it was, from the docs overview page.
   The SDK is public and Apache-2.0: `@exotel-npm-dev/exotel-ip-calling-crm-websdk` and
   `@exotel-npm-dev/webrtc-client-sdk` v3.0.11 on npm. The account is already VOIP-ACTIVE with SIP
   devices provisioned. **However** — a separate hard dependency does exist (§6, DEP-1): the
   integrations-platform Client ID/Secret is not self-serve.
2. **"MyOperator is dead" was not true when stated.** At that moment it was still carrying ~110
   calls/day into Pitstop on two DIDs, neither of which is the Exotel ExoPhone. It became true a few
   hours later, at 18:08 IST. Building to the earlier premise would have removed the only working
   path.

---

## 5. The design, in one page

Full detail in the spec. Three layers:

- **L1 · Data plane** — Exotel → Pitstop. Passthru applet on inbound + `StatusCallback` on outbound
  → `store.cs_calls`; auto-ticket and 24 h repeat-caller coalescing preserved unchanged; agent
  attribution; playable recordings; backfill of the blind window.
- **L2 · Control plane** — Pitstop → Exotel. Click-to-call, `/admin/telephony` (agents via the Users
  API), number + flow visibility, live-call strip.
- **L3 · Softphone** — `<CallBar>` in the Pitstop auth shell: registration state, dialpad,
  incoming-call popup with customer + ticket pre-resolved, mute/hold/hangup. SDK is ~1.4 MB, lazy-
  loaded only for users with a SIP device.

**The key structural decision:** extract a **vendor-neutral `call-pipeline.js`**. Both MyOperator and
Exotel normalise into one shape and call the same pipeline, so ticket creation, coalescing, Shopify
lookup and agent resolution are written once. This is what makes keeping MyOperator mounted as a
fallback safe, and it is why Exotel should not be bolted onto the existing handlers.

**Three existing defects to fix during the migration, not after:** recordings that have never played,
a missed-call count that is 0.25% and therefore false, and ~30% of inbound being IVR-drops counted as
answered calls.

⚠️ **Fixing the missed count will make it jump, and it will look like a regression.** It is the
correction landing. Warn the team in the same breath as the release — same shape as the S298 agent-
report rebuild, where August closed moved 4,496 → 5,743.

---

## 6. Blocking items — the agenda for tomorrow

### On Afshaan

- **DEP-4 · The Exotel API token.** Behind the eye icon on "Default API key" in API Credentials.
  Set as a worker secret, never committed: `wrangler secret put EXOTEL_API_TOKEN` on csops. Also
  needed: `EXOTEL_API_KEY` (`d59f1a4ffb…` — visible, not secret), `EXOTEL_ACCOUNT_SID`
  (`legendoftoys1m`), `EXOTEL_WEBHOOK_TOKEN` (we mint this one).
- **DEP-5 · Approval to edit Exotel call flow 108159.** Adding the Passthru applet is what makes
  inbound calls reach Pitstop. It is a live customer-facing IVR, so it is his call.

### On Exotel (someone must ask them)

- **DEP-1 · Client ID + Client Secret** for the integrations platform — *not* the dashboard API
  key/token; obtainable only from Exotel tech support. Also confirm `legendoftoys1m` is on the
  Veeno Communications / IP-PSTN agreement, and what the per-user VoIP pricing is. Their onboarding
  article says a **separate account** is required for VoIP and describes the programme as **Alpha** —
  but this account is already VOIP-ACTIVE with SIP IDs, so the position needs confirming rather than
  assuming either way. **Blocks L3 only.**
- **DEP-2 · `08048332909`** — appears as an outgoing number in Exotel's own Inbox but is not
  provisioned on the account (absent from ExoPhones, Call Settings, Campaigns, Sales, Address book).
  What is it?
- **DEP-3 · The two old DIDs** `+912262054541` and `+918064124537` — being ported to Exotel, retired,
  or forwarded? Neither is an ExoPhone today. This determines whether customers dialling the old
  numbers still reach anyone.

### On Pruthvi

- **Q-1** Should an abandoned IVR-drop (~30% of inbound, 1–15 s, nobody spoke) count as **missed**,
  or get its own **abandoned** class? Redefines the Missed tab, the nav badge and every historic
  comparison.
- **Q-2** Should every answered inbound still auto-create a ticket? At ~110 calls/day with ~30%
  abandoned, unchanged behaviour means a lot of empty tickets.
- **Q-3** Does the `main` / `abc` department routing still mean anything with one ExoPhone?
- **Q-4** Which agents get a softphone, and which stay on a mobile leg?

**Sequencing note for the discussion:** L1 and L2 need only the API key and token — **no third-party
dependency at all**. L3 is the only part waiting on Exotel. If DEP-1 takes a week, that week is not
wasted.

---

## 7. Proposed phase order (for tomorrow's plan)

| Phase | Content | Gate |
|---|---|---|
| 0 | Approve spec · API token as worker secret · put the §6 questions to Exotel | Afshaan |
| 1 | Additive schema migration · extract vendor-neutral `call-pipeline.js`, MyOperator path re-pointed at it with behaviour unchanged | Reviewed diff |
| 2 | Exotel webhooks live · Passthru applet on flow 108159 · verify on one real call | Afshaan approves the flow edit |
| 3 | Backfill the blind window · recording player · attribution fix | — |
| 4 | Click-to-call · `/admin/telephony` | — |
| 5 | Softphone | DEP-1 resolved |

**MyOperator is not deleted.** Its webhook stays mounted throughout — it costs nothing idle, and if a
number turns out not to have moved, deleting it is the difference between a quiet fallback and an
outage. Removal is a separate decision after Exotel runs clean for a week.

**Deploy order is always worker → app** (a new app calling a missing worker action is a broken
button; a new worker with an old app is inert), and **the push must land before the deploy** or a
parallel session's live change is silently reverted (PATTERN-220).

⚠️ **Snapshot before the backfill:** `CREATE TABLE store.safety_cs_calls_2026_08_19 AS SELECT …`

---

## 8. Open risk while we wait

**Every day without the wiring is a day of voice history that exists only in Exotel.** It is
recoverable for 6 months, so this is not an emergency — but it is a clock, and the CS team currently
has no call log, no call-linked tickets and no callback list in Pitstop. If tomorrow's discussion is
likely to run long, **phase 2 alone (inbound webhook) stops the bleeding** and can ship ahead of the
rest.
