# Relay Journey Authoring UI — Multi-Channel Orchestration (Design)

> **Status:** DESIGN (2026-07-13, Session 210). Approved by Afshaan section-by-section.
> **System:** Relay (`commsops` worker + `apps/relay`). **Owner:** Afshaan.
> **Supersedes/extends:** the M7 journey engine (`docs/superpowers/plans/2026-06-26-relay-m7-journey-engine.md`)
> and the single-shape `/journeys` page. Maps to Relay v2 **M18 (journey depth)** + **M20 (authoring)**.
> **Incumbent teardown that motivates this:** `reference/bitespeed.md` (workspace root, load-on-demand).
> **Gate:** everything ships behind **TEST MODE** until the M10 go-live sign-off.

---

## 1. Problem & goal

Today `apps/relay/.../journeys/page.js` authors exactly **one hardcoded shape** — linear
`wait → condition → send/exit → exit` — and falls back to read-only JSON for anything else, while the
M7 `JourneyWorkflow` interpreter already runs **arbitrary step-graphs**. The authoring layer is the gap.

**Goal:** a canvas-based, **multi-channel journey orchestration** authoring UI — CDP/CleverTap/Braze-class,
**not** single-channel WhatsApp. The load-bearing requirement (Afshaan, S210):

> A journey escalates across channels with wait-for-response gates. E.g. cart abandoned →
> **WhatsApp** → (no reply/action after N) → **SMS** → (still nothing) → **email** → (still nothing) →
> **voice call** → done. Per-step channel choice + "wait for engagement, else advance" + branch-on-engagement.

Plus the harder **interactive class** (COD-to-prepaid: send quick-reply buttons → branch on the button →
payment/order actions). Built **for scale** (80k+ Shopify customers and growing) and **once** — no rebuild.

**Decision (S210):** authoring surface = **node canvas (option A)**, not a structured spine — chosen because
Afshaan is committed to increasingly complex journeys (genuine DAGs: merges, parallel, reuse), and a canvas
is the shape mature orchestration engines use precisely to avoid a rebuild. Cost: adds React Flow (first heavy
client dep in the monorepo app), accepted.

## 2. Architecture — the canvas is a *view* over the engine definition

The canvas never invents a runtime. It reads/writes the same `journey_versions.definition` JSON the M7
interpreter already runs, so **versioning, enrolment, analytics, and the runtime are unchanged** — we add a
visual author + new step *types*.

- **Nodes** ↔ engine steps (one node = one step id).
- **Edges** ↔ step outcome targets (generalized — see §3).
- **Node `(x,y)`** = `layout` metadata stored alongside logic; the interpreter ignores it.
- **`compile()`** stays the validator (single entry, no dangling targets, reachable exit, active templates),
  extended for the new node types.
- The `isLinearShape → rawOnly` fallback is **retired** — the canvas renders any definition.

**In scope:** the canvas UI; the node-type set + definition mapping; the engine primitives the multi-channel +
interactive requirement forces (`wait_response` gate, interactive-reply routing, ambient exit rules, the
event→enrolment index). **Named dependencies (not designed here — own milestones):** SMS/voice adapters
(v2 M11–M13+), segment-entry + external-lifecycle triggers (need substrate ingestion), order/payment action
backends (Razorpay link, Shopify modify/cancel). The canvas is **channel-agnostic**: a Send node offers only
channels with a live adapter (email + WA now); SMS/voice are authorable-but-"not live yet" until their adapters land.

## 3. Node model — named outcome handles (the core generalization)

Today branching is hardcoded (`condition` → `if_true/if_false`; else `next`). Generalize so **every node
declares a set of named outcome handles, and each edge wires one handle → one target step:**

```
step = { type, …config, outcomes: { <handle>: <stepId>, … }, layout:{x,y} }
```

`next` = single-handle case; `if_true/if_false` = two-handle case. **Adding any future node type = declaring
its handles** — no schema surgery, no interpreter special-casing (the "build-once" property).

### Palette

| Category | Node | Engine `type` | Outcome handles | Status |
|---|---|---|---|---|
| **Trigger** (one, entry) | Event trigger (+ attribute filter) | `journey.trigger` | → entry | exists |
| | Segment-entry trigger | `journey.trigger` | → entry | dep (membership-change events) |
| | *Exit-on-event guard — journey property, not a node (see §4.3)* | `journey.exit_rules[]` | — | new |
| **Send** | Send message (WA/email/SMS/voice/push) | `send` | `next` | exists; channel-agnostic |
| | Interactive send (WA buttons) | `send` + `interactive` | one per button + `no_reply` | new |
| **Control flow** | Wait (duration / till-time) | `wait` | `next` | exists |
| | **Wait for response (or timeout)** | `wait_response` | `responded`, `timeout` | new — escalation gate |
| | Condition / split | `condition` | `if_true`, `if_false` → generalize to N | exists; extend |
| **Actions** (commerce) | Payment link (Razorpay) | `action:payment_link` | `paid`, `failed` | dep |
| | Modify / cancel order (Shopify) | `action:order_modify \| order_cancel` | `done`, `not_done` | dep |
| | Set attribute / tag | `action:set_attr` | `next` | new (small) |
| **Exit** | Exit (outcome label) | `exit` | — | exists |

### Worked example — escalation waterfall
`[Trigger: checkout_started] → Send:WA → Wait-for-response(order_placed, 6h){responded→Exit:recovered · timeout→
Send:SMS → Wait-for-response(12h){responded→Exit · timeout→ Send:Email → Wait → timeout→ Action:Voice call → Exit}}`.
Every escalation step is the same unit: **Send(channel) → wait-for-response(event, within) → responded→exit /
timeout→next channel.**

### Worked example — COD-to-prepaid (interactive)
`[Trigger: ORDER_PLACED where COD=true] → Interactive Send:WA {buttons: Make Payment / Confirm COD / Cancel}`:
- `make_payment` → Action:payment_link → paid → Action:order_modify → Exit:converted
- `confirm_cod` → Action:order_modify → Send:"confirmed" → Exit
- `cancel` → Condition:cancellable? → yes→Action:order_cancel→Exit / no→Send:"already processed"→Exit
- `no_reply` (24h) → Exit:no_response

Works because `parseInbound` already normalizes button taps into `whatsapp_inbound` events the interactive
node's handles key on.

**Interactive-button constraint (Meta reality):** outside the 24h window a WA send must be an
**approved template**, and quick-reply buttons are part of that template — so the Interactive Send
config **binds outcome handles to the template's declared buttons** (read from `templates.content`),
it does NOT free-form button labels. Free-form interactive is only possible for in-window utility
replies. `compile()` validates handles ⊆ the template's buttons.

### Canvas UX
Drag from palette; connect handle→node by dragging edges; click a node → **config drawer** (channel, template
picker, wait duration, button↔handle binding, condition builder — reusing existing template/segment form
components); inline validation badges (dangling handle, unwired declared handle, no reachable exit, inactive
template, handle/template-button mismatch); Save publishes a new version as today.

## 4. Engine primitives (runtime work)

All extend the existing per-enrolment `JourneyWorkflow` interpreter (Workflows-only, no DO — consistent with
the M7 ADR).

### 4.1 `wait_response` — escalation gate
Race the awaited event(s) against the timeout.
- `awaited` is **any-of a list** of event names (e.g. `[order_placed, link_clicked, whatsapp_inbound]` — "reply
  OR act"), optional filter. **v1 correlation is profile-level:** any matching event for the profile counts (a
  *different* order's `order_placed` still reads as "responded") — acceptable for v1, per-entity correlation
  (order/checkout id) is a later refinement.
- **Primary (immediate):** `await step.waitForEvent('response', { timeout: within })` → event → `responded`;
  elapsed → `timeout`. A customer who converts at minute 5 advances at minute 5.
- **Durable fallback (if the Workflows event API doesn't fit):** `step.sleep(within)` then query `comms.events`
  since step-start. Fully durable, **but degrades semantics**: no early wake AND exit rules (§4.3) become
  checked-on-wake instead of ambient — `step.sleep` cannot be interrupted. So the fallback preserves
  *correct outcomes* but not *immediacy*; validating `waitForEvent` is a J1 first-week task, not an afterthought.
- **O(1) per parked enrolment** — one sleeping instance (native to Workflows).

### 4.2 Send-outcome policy — gate-skip × escalation (load-bearing)
Two facts collide: the central gate can **skip** a send (`freq_cap` · `quiet_hours` · `budget_exhausted` ·
`no_consent` · `suppressed` · `window_closed` · `test_mode_blocked` · `no_identifier`), and an escalation
waterfall **multiplies marketing sends per customer inside ~24h — the frequency cap will otherwise silently
kill later legs**, and the flow would "wait 6h for a response" to a message that never went out.
- **Send nodes gain an `on_skip` policy** (config, default `continue`): `continue` (proceed as if sent — today's
  behavior, right for consent/suppression since the customer shouldn't be re-targeted on another leg either) ·
  `advance` (jump straight to the step's `timeout`-path target — skip the pointless wait, go to the next channel) ·
  `exit(outcome)`. The skip reason is logged on `enrolment_steps` either way (never silent).
- **Frequency-cap guidance:** journey sends stay gate-governed (correct), but the canvas surfaces a
  **waterfall lint**: if consecutive sends fall inside `frequency_cap_window_hours`, warn the author. A per-journey
  "cap-exempt" flag is deliberately NOT offered v1 (the cap is a customer-protection); revisit only with data.
- **`#doSend` today resolves ONLY email identifiers** (hardcoded `type=eq.email`) — a WA journey send would
  skip with `no_email_identifier`. **J0 must extend identifier resolution per channel** (phone for WA/SMS/voice,
  email for email) — a concrete work item, not an assumption.

### 4.3 Interactive send + reply routing
Interactive Send node sends the button template (handles bound to the template's approved buttons, §3), then
parks on `whatsapp_inbound`; the button-id payload selects the outcome handle; `no_reply` on timeout. Uses the
existing `parseInbound` normalization.

### 4.4 Exit rules — *ambient* (correct semantics)
An exit guard must fire while parked in **any** wait, not only at a node — so it is a **journey-level list of
rules** (`journey.exit_rules = [{event, filter?, outcome}]`), not an on-canvas node (generalizes BiteSpeed's
single guard to a set; surfaced in a dedicated "Exit rules" panel). Implementation: every wait/await becomes a
race `waitForEvent(['response','exit'], {timeout})`; on enrol, register each exit rule's event in the wait-index;
an incoming exit event signals the instance → terminate with the rule's outcome. (**Under the §4.1 poll fallback
this degrades to checked-on-wake** — see the caveat there.)

**Journey `max_duration`** (new journey property, default **30d**): bounds every enrolment's lifetime —
auto-exit `outcome='expired'` when reached. This is both a customer-safety backstop (no zombie enrolments
messaging weeks later) and what gives exit-wait rows a real `expires_at` (enrolled_at + max_duration) so the
wait-index stays bounded.

### 4.5 The wait-index — the one load-bearing scale piece
So an incoming event finds parked enrolments without scanning:
```
comms.enrolment_waits ( enrolment_id, instance_id, profile_id, awaited_event,
                        kind('response'|'exit'), expires_at )   index on (profile_id, awaited_event)
```
- Insert a `response` row on entering a wait_response/interactive step; insert `exit` rows per exit-rule on enrol.
- Delete on transition/terminate; expiry sweeper clears orphans.
- **Ingest matcher extension:** on event `E` for profile `P`, `SELECT … WHERE profile_id=P AND awaited_event=E`
  (O(log n)) → for each hit, `env.JOURNEY_WORKFLOW.get(instance_id).sendEvent(...)`. Event-id dedupe so a
  re-delivered webhook can't double-advance.

### 4.6 Action nodes (dependency-gated)
`action:payment_link` → `step.do` Razorpay create-link → send → park on payment event (Razorpay webhook →
`stg_payments` → emitted event, already ingested). `action:order_modify|cancel` → `step.do` Shopify Admin
mutation → route `done`/`not_done`. Durable `step.do` calls with success/failure handles.
**Honest COD note:** converting COD→prepaid is **not one clean Shopify mutation** — it's mark-order-paid /
record-payment or cancel-and-recreate, each with side effects. The exact mechanism is a **J3 design decision**
(with the COD/GoKwik flow owner), deliberately not assumed here.

### 4.7 Scale characteristics
Parked enrolments = cheap Workflow sleeps (native). `enrolment_waits` = lean, indexed, delete-on-transition +
sweeper. Event→enrolment = O(log n) via the index. Enrol fan-out = existing Queue pagination (same as
broadcasts). Send volume multiplies per-customer under escalation → handled by the existing gate + warm-up
budget (a capacity note, not a risk). Double-advance guarded by instance-id=enrolment-id + event-id dedupe.
**Holds at the 80k base and well past it** on the existing architecture.

### 4.8 New schema (migrations) + `compile()` additions
- `enrolment_waits` (+ indexes).
- `journeys.exit_rules jsonb` (or a child table if queryable rules are wanted) + `journeys.max_duration`.
- `journey_versions.definition` per-step `outcomes` + `layout{x,y}` (additive; interpreter compat-reads old shape).
- New step-types (`wait_response`, `send.interactive`, `action:*`) handled in `compile()` + interpreter, not schema.
- **`compile()` new rules:** every declared outcome handle is wired (no dangling handles both ways); interactive
  handles ⊆ the bound template's buttons; `wait_response.awaited` non-empty + `within` valid; new internal step
  names added to the reserved-id list (alongside `load-definition`/`load-trigger`/…); `on_skip` values valid.

## 5. Phasing

Each phase ships usable value; dependencies come in order; TEST MODE holds throughout. **This spec is the
umbrella; each phase becomes its own implementation plan** (J0 first).

- **J0 — Schema generalization + canvas MVP (no new engine primitives).** Definition gains `outcomes`+`layout`
  (interpreter compat-shim; backfill the abandoned-cart journey); **per-channel identifier resolution in `#doSend`**
  (phone for WA — today it hardcodes email, §4.2); React Flow canvas for the steps the engine already runs
  (event-trigger, send [email/WA], wait, condition, exit) + config drawer + `compile()` validation + versioned
  save; retire the linear form/rawOnly. **End state:** visual authoring of today's engine, email+WA, with
  branching + multi-step. Lowest risk, immediate value.
- **J1 — Escalation gate.** **Validate `step.waitForEvent` first week** (it decides ambient-vs-on-wake semantics,
  §4.1/§4.4); `wait_response` (any-of awaited list), `enrolment_waits` index, ingest-matcher extension, event-id
  dedupe, `on_skip` send policy + waterfall freq-cap lint, journey `max_duration`; Wait-for-response node.
  **End state:** full multi-channel escalation waterfalls on the live channels (email↔WA) — the core requirement.
- **J2 — Exit rules (ambient).** `journey.exit_rules` + wait-race + registration; "Exit rules" panel. **End state:**
  lifecycle parity (cancel-guard class); no over-messaging cancelled/converted customers.
- **J3 — Interactive + actions (COD class; external deps → last).** Interactive send + reply routing; action nodes
  (payment_link, order_modify/cancel, set_attr); Razorpay + Shopify wiring. **End state:** COD-to-prepaid rebuilt
  natively — ceiling reached.

**Cross-cutting parallel tracks (no journey-UI rework when they land):** SMS adapter (M11–M13, DLT-gated) → Voice
adapter (later) — become selectable channels on Send nodes automatically. Segment-entry + external-lifecycle
(Shiprocket RTO, popup opt-in) triggers — light up as trigger options as their events flow into the substrate.
Analytics — extend `journey_funnel` for the general-handle model + per-branch counts.

## 6. Open items / risks
- **R1 — Workflows event API.** `wait_response` immediacy AND ambient exits depend on `step.waitForEvent`;
  the poll fallback preserves correct *outcomes* but degrades both to on-wake semantics (§4.1). Validate the
  API in J1 week one; if it genuinely doesn't fit, the ambient-exit promise must be re-scoped, not hand-waved.
- **R2 — Gate × waterfall.** The frequency cap will fight multi-send waterfalls (§4.2) — mitigated by `on_skip`
  policy + the authoring lint; watch skip-reason analytics after the first real waterfall and revisit.
- **R3 — React Flow dep** in the static-export app — first heavy client dep; client-side only, works with export;
  accepted with the canvas decision.
- **R4 — `enrolment_waits` write volume** at scale — bounded by delete-on-transition + `max_duration` expiry +
  the index.
- **R5 — Definition back-compat** — interpreter must read both old (`next/if_true/if_false`) and new (`outcomes`)
  shapes so in-flight enrolments finish on their pinned version.
- **R6 — v1 correlation is profile-level** (§4.1) — a concurrent unrelated order can read as "responded";
  acceptable at current volumes, per-entity correlation is the flagged refinement.
- **Dependencies restated:** SMS/voice adapters; segment-entry + Shiprocket/popup ingestion; Razorpay link +
  Shopify modify/cancel (COD→prepaid mechanism = a J3 decision, §4.6). None block J0/J1/J2 on the live channels.

## 7. Cross-references
- M7 engine: `docs/superpowers/plans/2026-06-26-relay-m7-journey-engine.md`.
- Relay v2 roadmap/plan: `docs/superpowers/specs/2026-07-07-relay-v2-roadmap-prd.md` + `.../plans/2026-07-07-relay-v2-execution-plan.md` (M11–M13 SMS, M18 depth, M20 authoring).
- Incumbent teardown: `reference/bitespeed.md`.
- Relay spoke: `systems/relay.md` (journey-authoring section).
