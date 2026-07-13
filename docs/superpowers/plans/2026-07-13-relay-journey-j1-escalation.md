# Relay Journey J1 — Multi-Channel Escalation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable "wait for a response event, else advance / branch" primitive to the Relay journey engine so a journey can escalate across channels (WhatsApp → SMS → email → …) with ambient exit-on-event and a lifetime cap, authored on the existing React Flow canvas — all behind TEST MODE.

**Architecture:** The runtime stays Workflows-only (no Durable Object), one `commsops-journey` instance per enrolment (instance id = enrolment id). The spike (2026-07-13) confirmed Cloudflare Workflows' `step.waitForEvent(desc, {type, timeout})` throws on timeout (recoverable in `try/catch`) and `env.JOURNEY_WORKFLOW.get(id).sendEvent({type, payload})` reaches a parked instance over the binding. **Key design decision from the spike:** we do NOT race a list of event types or use `Promise.race`. Every wait parks on a SINGLE event type `'signal'`; the SQL `comms.enrolment_waits` index does the "which event was awaited" matching, and our ingest matcher (the sole event producer) calls `sendEvent` with a normalized `{kind:'response'|'exit', outcome?}` payload. This collapses the any-of-list + response-vs-exit + ambient-exit requirements into one durable wait + one indexed lookup, and delivers immediate wake + ambient exits (no degraded poll fallback). `max_duration` (lifetime cap) is enforced by the existing `*/5` cron sweeper via the same exit-signal mechanism, keeping the hot interpreter loop free of wall-clock control flow (replay-safe).

**Tech Stack:** Cloudflare Workers + Workflows + Queues (`commsops`), Supabase Postgres (`comms` schema, PostgREST via `A.sbComms`), Next.js static-export app (`apps/relay`) with `@xyflow/react` v12 canvas. Worker tests are plain `node test/*.test.js` (assert + stubbed `global.fetch`). Migrations applied via Supabase `apply_migration`.

---

## Background facts the engineer must know

- **Worker dir:** `05_Throttle/commsops-worker/`. Deploy: `cd 05_Throttle/commsops-worker && npx wrangler deploy` (auto-allowed; commit+push first). Blast radius = Relay only.
- **App dir:** `05_Throttle/apps/relay/`. Auto-deploys on push to `main` (gh-pages). Build one app: `cd 05_Throttle && npx turbo build --filter=@throttle/relay`.
- **DB access pattern:** everything goes through `A.sbComms(path, env, {method, headers, body})` (PostgREST REST). `A.enc(x)` URL-encodes a filter value. Numeric columns come back as strings. Reads return `{ok, data}`.
- **The interpreter (`src/journey-workflow.js`)** is a `for` loop over `def.steps[cur]`, dispatching by `s.type`. `step.do(name, fn)` = a cached/retryable durable unit (name must be deterministic & unique per run). `step.sleep(name, duration)` = durable sleep. `G.resolveTarget(step, handle)` reads the target for a named outcome handle (reads BOTH legacy `next`/`if_true`/`if_false` AND the new `outcomes:{}` map).
- **Instance id = enrolment id** (`enrol()` calls `env.JOURNEY_WORKFLOW.create({ id: enrolment.id, ... })`). So `env.JOURNEY_WORKFLOW.get(enrolmentId)` fetches the running instance.
- **`send()` (`src/send.js`)** returns `{ status, reason, message_id, provider_message_id }`. `status ∈ {sent, delivered, skipped, suppressed, deduped, failed}`. A gate skip → `status:'skipped'|'suppressed'` with a `reason` (`test_mode_blocked`/`suppressed`/`no_consent`/`freq_cap`/`quiet_hours`/`invalid_address`/`window_closed`/`budget_exhausted`/`no_<idtype>_identifier`). "Went out" = `status ∈ {sent, delivered, deduped}`.
- **Ingest (`src/ingest.js`)** already: resolves identity → inserts the event (idempotent on `idempotency_key`) → derives attributes → matches active event-triggered journeys → enqueues `{kind:'enrol'}`. All post-insert work runs only when `!deduped`, so a re-delivered webhook (same `idempotency_key`) never re-runs the matcher — **this is our event-id dedupe** (documented, not re-implemented).
- **`comms.enrolments`**: `id, journey_id, journey_version, profile_id, status('active'|'completed'|'exited'|'failed'|'expired'), current_step, context jsonb, enrolled_at, ended_at`.
- **TEST MODE is ON** (`gate.js` step 0). Everything below is inert against real customers regardless. Keep it ON.
- **Reserved internal step ids** (rejected by `compile()` as user step ids): currently `load-definition`, `load-enrolment`, `load-trigger`, `load-journey-name`, `boot`, and any `log:*`/`end:*`. J1 adds `register-waits` and `clear-waits`.

## File structure (what each task touches)

**Worker (`src/`)**
- `journey-graph.js` — pure shared helpers (validator + interpreter). ADD: `durationToMs`, `HANDLES` map incl. `wait_response`, `RESERVED_STEP_IDS`, `sendWentOut`.
- `journeys.js` — `compile()` extended for `wait_response`/`on_skip`/`exit_rules`/`max_duration`; `saveJourney` persists `exit_rules`/`max_duration`.
- `journey-workflow.js` — interpreter: uniform `waitForEvent`-based waits, `wait_response` step, ambient exit registration + pre-check, `on_skip` policy, terminal wait-row cleanup.
- `ingest.js` — matcher extension: `enrolment_waits` lookup → dedupe-by-instance → `sendEvent`.
- `index.js` — `runScheduled` gains the `enrolment_waits` expiry sweep + `max_duration` enrolment sweep.
- `migrations/0017_comms_journey_escalation.sql` — new table + journey columns.
- `test/journey-graph.test.js`, `test/journeys-compile.test.js` — extend. `test/journey-matcher.test.js` — new.

**App (`apps/relay/src/`)**
- `components/journey-canvas/graph.js` — `HANDLES` gains `wait_response`; lint gains the waterfall warning.
- `components/journey-canvas/JourneyCanvas.js` — `STEP_META` + `NEW_STEP` + node subtitle for `wait_response`.
- `components/journey-canvas/NodeDrawer.js` — config forms for `wait_response` + `on_skip` on Send.
- `app/(auth)/journeys/page.js` — journey-level Exit rules + Max duration panel; pass `exit_rules`/`max_duration` through save.
- `components/journey-canvas/graph.test.js` — extend.

---

## Task 1: Migration — `enrolment_waits` + journey escalation columns

**Files:**
- Create: `05_Throttle/commsops-worker/migrations/0017_comms_journey_escalation.sql`

- [ ] **Step 1: Write the migration SQL**

Create `05_Throttle/commsops-worker/migrations/0017_comms_journey_escalation.sql`:

```sql
-- J1 (journey escalation). The wait-index: an incoming event for a profile finds
-- every parked enrolment awaiting it WITHOUT scanning. instance_id == enrolment id
-- (see enrol()). kind='response' rows are written on entering a wait_response step;
-- kind='exit' rows are written once at boot per journey exit-rule. 'expired' does NOT
-- need a row (the sweeper has the enrolment id directly). Rows are deleted on
-- transition / terminate; the */5 cron sweeps expired orphans.
CREATE TABLE IF NOT EXISTS comms.enrolment_waits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  uuid NOT NULL REFERENCES comms.enrolments(id) ON DELETE CASCADE,
  instance_id   text NOT NULL,                       -- Workflow instance id (== enrolment id)
  profile_id    uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  awaited_event text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('response','exit')),
  outcome       text,                                -- exit rules only: the outcome label to terminate with
  step_id       text,                                -- response rows: the wait_response step that parked (diagnostics)
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The hot lookup path: (profile, event) → parked instances. O(log n).
CREATE INDEX IF NOT EXISTS enrolment_waits_match_idx
  ON comms.enrolment_waits (profile_id, awaited_event);
-- Cleanup path: the sweeper deletes rows past expiry.
CREATE INDEX IF NOT EXISTS enrolment_waits_expiry_idx
  ON comms.enrolment_waits (expires_at);
-- One row per (enrolment, awaited_event, kind) — re-entering a step upserts, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS enrolment_waits_uniq
  ON comms.enrolment_waits (enrolment_id, awaited_event, kind);

ALTER TABLE comms.enrolment_waits ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.enrolment_waits TO service_role;

-- Journey-level escalation config (additive; existing rows default correctly).
-- exit_rules: [{event, filter?, outcome}] — ambient (fire while parked in ANY wait).
-- max_duration: hard lifetime cap; the sweeper auto-exits enrolments older than this.
ALTER TABLE comms.journeys ADD COLUMN IF NOT EXISTS exit_rules   jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE comms.journeys ADD COLUMN IF NOT EXISTS max_duration text  NOT NULL DEFAULT '30 days';
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool (project `jkxcnjabmrkteanzoofj`), name `comms_journey_escalation_v1`, with the SQL above. (Non-destructive CREATE/ALTER — runs without the sql-gate prompt.)

- [ ] **Step 3: Verify the table + columns exist**

Run this read via `execute_sql`:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='comms' AND table_name='enrolment_waits' ORDER BY ordinal_position;
SELECT column_name FROM information_schema.columns
WHERE table_schema='comms' AND table_name='journeys' AND column_name IN ('exit_rules','max_duration');
```

Expected: 9 `enrolment_waits` columns; `exit_rules` + `max_duration` present on `journeys`.

- [ ] **Step 4: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/migrations/0017_comms_journey_escalation.sql
git commit -m "relay(J1): migration — enrolment_waits index + journey exit_rules/max_duration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pure helpers in `journey-graph.js` (duration parse, handles, reserved ids)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journey-graph.js`
- Test: `05_Throttle/commsops-worker/test/journey-graph.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/journey-graph.test.js` (match the existing assert/`t()` harness in that file — read its header first and reuse its runner):

```js
const G2 = require('../src/journey-graph.js');
// durationToMs
assert.equal(G2.durationToMs('30 minutes'), 30 * 60 * 1000);
assert.equal(G2.durationToMs('6 hours'), 6 * 3600 * 1000);
assert.equal(G2.durationToMs('2 days'), 2 * 86400 * 1000);
assert.equal(G2.durationToMs('1 hour'), 3600 * 1000);
assert.equal(G2.durationToMs('90 seconds'), 90 * 1000);
assert.equal(G2.durationToMs('garbage'), null);
// handles for the new step type
assert.deepEqual(G2.HANDLES.wait_response, ['responded', 'timeout']);
assert.deepEqual(G2.HANDLES.wait, ['next']);
// reserved ids include the J1 internal step names
assert.ok(G2.RESERVED_STEP_IDS.includes('register-waits'));
assert.ok(G2.RESERVED_STEP_IDS.includes('clear-waits'));
// sendWentOut classifier
assert.equal(G2.sendWentOut({ status: 'sent' }), true);
assert.equal(G2.sendWentOut({ status: 'delivered' }), true);
assert.equal(G2.sendWentOut({ status: 'deduped' }), true);
assert.equal(G2.sendWentOut({ status: 'skipped', reason: 'freq_cap' }), false);
assert.equal(G2.sendWentOut({ status: 'suppressed' }), false);
console.log('journey-graph J1 helpers ok');
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/journey-graph.test.js`
Expected: FAIL — `G2.durationToMs is not a function`.

- [ ] **Step 3: Implement the helpers**

Edit `src/journey-graph.js`. Add after the existing `ID_TYPE_FOR_CHANNEL` const and before `module.exports`:

```js
// Outcome handles each step type declares (kept in sync with the app's graph.js HANDLES).
// wait_response is the J1 escalation gate: responded (awaited event arrived) vs timeout.
const HANDLES = {
  send: ['next'], wait: ['next'], condition: ['if_true', 'if_false'],
  wait_response: ['responded', 'timeout'], exit: [],
};

// Internal step names the interpreter uses as step.do/step names — never valid user ids.
const RESERVED_STEP_IDS = [
  'load-definition', 'load-enrolment', 'load-trigger', 'load-journey-name', 'boot',
  'register-waits', 'clear-waits',
];

// Parse a human duration string ("6 hours", "30 minutes", "2 days", "90 seconds")
// to milliseconds. Returns null on anything unrecognised. Used for expires_at math;
// the durable wait itself passes the raw string to step.waitForEvent/step.sleep.
const _UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
function durationToMs(str) {
  const m = String(str || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * _UNIT_MS[m[2]]);
}

// Did a send() result actually leave the building? (vs a gate skip/suppression/failure)
function sendWentOut(res) {
  return !!res && (res.status === 'sent' || res.status === 'delivered' || res.status === 'deduped');
}
```

Update the exports line to:

```js
module.exports = { resolveTarget, stepTargets, ID_TYPE_FOR_CHANNEL, HANDLES, RESERVED_STEP_IDS, durationToMs, sendWentOut };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/journey-graph.test.js`
Expected: PASS incl. `journey-graph J1 helpers ok`.

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/journey-graph.js commsops-worker/test/journey-graph.test.js
git commit -m "relay(J1): journey-graph helpers — durationToMs, HANDLES.wait_response, reserved ids, sendWentOut

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `compile()` validates the new shapes

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journeys.js:22-53` (the `compile()` function)
- Test: `05_Throttle/commsops-worker/test/journeys-compile.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/journeys-compile.test.js` (reuse its runner + the existing `compile(env, def)` call convention; `env` there uses a stubbed fetch that returns active templates — copy the existing pattern in the file). Add:

```js
// wait_response: valid awaited list + within, both handles wired
{
  const def = { entry: 'w', steps: {
    w: { type: 'wait_response', awaited: ['order_placed'], within: '6 hours',
         outcomes: { responded: 'ex', timeout: 'ex' } },
    ex: { type: 'exit', outcome: 'completed' },
  } };
  const r = await compile(env, def);
  assert.ok(r.ok, 'valid wait_response should compile: ' + JSON.stringify(r.errors));
}
// wait_response: empty awaited → error
{
  const def = { entry: 'w', steps: {
    w: { type: 'wait_response', awaited: [], within: '6 hours', outcomes: { responded: 'ex', timeout: 'ex' } },
    ex: { type: 'exit', outcome: 'completed' } } };
  const r = await compile(env, def);
  assert.ok(r.errors.includes('wait_response_no_awaited:w'), JSON.stringify(r.errors));
}
// wait_response: bad within → error
{
  const def = { entry: 'w', steps: {
    w: { type: 'wait_response', awaited: ['x'], within: 'soon', outcomes: { responded: 'ex', timeout: 'ex' } },
    ex: { type: 'exit', outcome: 'completed' } } };
  const r = await compile(env, def);
  assert.ok(r.errors.includes('wait_response_bad_within:w'), JSON.stringify(r.errors));
}
// wait_response: an unwired declared handle → error
{
  const def = { entry: 'w', steps: {
    w: { type: 'wait_response', awaited: ['x'], within: '6 hours', outcomes: { responded: 'ex' } },
    ex: { type: 'exit', outcome: 'completed' } } };
  const r = await compile(env, def);
  assert.ok(r.errors.includes('wait_response_handle_missing:w'), JSON.stringify(r.errors));
}
// on_skip: bad value on a send → error
{
  const def = { entry: 's', steps: {
    s: { type: 'send', channel: 'email', on_skip: 'teleport', outcomes: { next: 'ex' } },
    ex: { type: 'exit', outcome: 'completed' } } };
  const r = await compile(env, def);
  assert.ok(r.errors.includes('bad_on_skip:s'), JSON.stringify(r.errors));
}
console.log('compile J1 ok');
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/journeys-compile.test.js`
Expected: FAIL — `wait_response` currently hits `bad_type:w:wait_response`.

- [ ] **Step 3: Implement the compile changes**

Edit `src/journeys.js`. At the top ensure `const G = require('./journey-graph.js');` exists (it does). Inside `compile()`:

Replace the reserved-id + type check lines:

```js
    if (G.RESERVED_STEP_IDS.includes(id) || /^(log:|end:)/.test(id))
      errors.push(`reserved_step_id:${id}`);
    if (!['wait', 'condition', 'send', 'wait_response', 'exit'].includes(s.type)) errors.push(`bad_type:${id}:${s.type}`);
```

Add, alongside the existing per-step checks (after the `wait_no_duration` line):

```js
    if (s.type === 'wait_response') {
      if (!Array.isArray(s.awaited) || s.awaited.length === 0) errors.push(`wait_response_no_awaited:${id}`);
      if (!s.within || G.durationToMs(s.within) === null) errors.push(`wait_response_bad_within:${id}`);
      if (!G.resolveTarget(s, 'responded') || !G.resolveTarget(s, 'timeout')) errors.push(`wait_response_handle_missing:${id}`);
    }
    if (s.type === 'send' && s.on_skip !== undefined &&
        !['continue', 'advance', 'exit'].includes(s.on_skip)) errors.push(`bad_on_skip:${id}`);
```

Then add journey-level validation. Change the `compile` signature to also accept the journey fields. Update `compile(env, definition)` → `compile(env, definition, journey)` and at the end, before the return, add:

```js
  // Journey-level escalation config (optional; passed from saveJourney).
  if (journey) {
    if (journey.max_duration !== undefined && journey.max_duration !== null &&
        G.durationToMs(journey.max_duration) === null) errors.push('bad_max_duration');
    if (journey.exit_rules !== undefined) {
      if (!Array.isArray(journey.exit_rules)) errors.push('bad_exit_rules');
      else journey.exit_rules.forEach((r, i) => {
        if (!r || !r.event) errors.push(`exit_rule_no_event:${i}`);
        if (!r || !r.outcome) errors.push(`exit_rule_no_outcome:${i}`);
      });
    }
  }
```

Update the call site inside `saveJourney`: `const c = await compile(env, definition, body);` (was `compile(env, definition)`), and the `compileJourney` route in `index.js:323` — read it and pass `body` as the third arg there too: `J.compile(env, body.definition, body)`.

- [ ] **Step 4: Run to verify it passes**

Run: `node test/journeys-compile.test.js`
Expected: PASS incl. `compile J1 ok`. Also re-run `node test/journey-graph.test.js` (still green).

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/journeys.js commsops-worker/src/index.js commsops-worker/test/journeys-compile.test.js
git commit -m "relay(J1): compile() validates wait_response, on_skip, exit_rules, max_duration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `saveJourney` persists `exit_rules` + `max_duration`

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journeys.js` (`saveJourney`)

- [ ] **Step 1: Thread the two new fields through create + update**

Edit `saveJourney`. Destructure them from `body`:

```js
  const { id, name, trigger, reenrolment, reenrol_cooldown_hours, definition, status, exit_rules, max_duration } = body;
```

In the **create** branch (the `POST /rest/v1/journeys` body), add:

```js
        exit_rules: Array.isArray(exit_rules) ? exit_rules : [],
        max_duration: max_duration || '30 days',
```

In the **update** branch (the `patch` object), add:

```js
    if (exit_rules !== undefined) patch.exit_rules = Array.isArray(exit_rules) ? exit_rules : [];
    if (max_duration !== undefined) patch.max_duration = max_duration;
```

- [ ] **Step 2: Verify build parses**

Run: `cd 05_Throttle/commsops-worker && npx wrangler deploy --dry-run --outdir /tmp/j1-dry 2>&1 | tail -5`
Expected: no bundling error (a clean dry-run; do not deploy yet).

- [ ] **Step 3: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/journeys.js
git commit -m "relay(J1): saveJourney persists exit_rules + max_duration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Interpreter — extract the send-skip routing decision (pure, testable)

The interpreter class is awkward to unit-test directly, so first extract the one branchy decision (what a skipped send does) into a pure helper, TDD it, then call it from the class.

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journey-graph.js`
- Test: `05_Throttle/commsops-worker/test/journey-graph.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/journey-graph.test.js`:

```js
// resolveSendNext(step, sendRes, def) → { next, terminate?, skippedWait? }
{
  const def = { steps: {
    s: { type: 'send', channel: 'whatsapp', on_skip: 'advance', outcomes: { next: 'wr' } },
    wr: { type: 'wait_response', awaited: ['x'], within: '6 hours', outcomes: { responded: 'ex', timeout: 's2' } },
    s2: { type: 'send', outcomes: { next: 'ex' } }, ex: { type: 'exit', outcome: 'completed' } } };
  // sent → always plain next
  assert.deepEqual(G2.resolveSendNext(def.steps.s, { status: 'sent' }, def), { next: 'wr' });
  // skipped + advance + next-is-wait_response → jump to that wait's timeout target, note skippedWait
  assert.deepEqual(G2.resolveSendNext(def.steps.s, { status: 'skipped', reason: 'freq_cap' }, def),
    { next: 's2', skippedWait: 'wr' });
}
{
  // skipped + continue (default) → plain next
  const def = { steps: { s: { type: 'send', outcomes: { next: 'ex' } }, ex: { type: 'exit' } } };
  assert.deepEqual(G2.resolveSendNext(def.steps.s, { status: 'skipped', reason: 'quiet_hours' }, def), { next: 'ex' });
}
{
  // skipped + exit → terminate with on_skip_outcome
  const def = { steps: { s: { type: 'send', on_skip: 'exit', on_skip_outcome: 'unreachable', outcomes: { next: 'ex' } }, ex: { type: 'exit' } } };
  assert.deepEqual(G2.resolveSendNext(def.steps.s, { status: 'suppressed' }, def), { terminate: 'unreachable' });
}
console.log('resolveSendNext ok');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/journey-graph.test.js`
Expected: FAIL — `G2.resolveSendNext is not a function`.

- [ ] **Step 3: Implement `resolveSendNext`**

Add to `src/journey-graph.js` (before `module.exports`):

```js
// Decide where a send step goes after send() returns, honoring on_skip (spec §4.2).
//  - sent/delivered/deduped → plain 'next'.
//  - skipped/suppressed/failed with on_skip:
//      'continue' (default) → plain 'next' (customer not re-targeted on another leg either).
//      'exit'               → terminate with on_skip_outcome (default 'skipped').
//      'advance'            → skip the pointless downstream wait: if 'next' is a wait_response,
//                             jump to ITS 'timeout' target (the next channel) and report skippedWait.
// Returns { next } | { next, skippedWait } | { terminate }.
function resolveSendNext(step, res, def) {
  const plainNext = resolveTarget(step, 'next');
  if (sendWentOut(res)) return { next: plainNext };
  const policy = step.on_skip || 'continue';
  if (policy === 'exit') return { terminate: step.on_skip_outcome || 'skipped' };
  if (policy === 'advance') {
    const nx = def.steps && def.steps[plainNext];
    if (nx && nx.type === 'wait_response') return { next: resolveTarget(nx, 'timeout'), skippedWait: plainNext };
  }
  return { next: plainNext };
}
```

Add `resolveSendNext` to `module.exports`.

- [ ] **Step 4: Run to verify it passes**

Run: `node test/journey-graph.test.js`
Expected: PASS incl. `resolveSendNext ok`.

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/journey-graph.js commsops-worker/test/journey-graph.test.js
git commit -m "relay(J1): resolveSendNext — pure on_skip routing decision

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Interpreter — `wait_response`, uniform interruptible waits, exit registration, `on_skip`, cleanup

This is the core runtime task. The interpreter loads `exit_rules`/`max_duration`, registers exit-wait rows once at boot, makes every wait a `waitForEvent('signal')` in try/catch (so it's interruptible by exit/expire signals AND still advances on timeout), adds the `wait_response` step, applies `on_skip`, and deletes wait rows on terminate.

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journey-workflow.js`

- [ ] **Step 1: Load journey-level config + exit rules at boot**

In `run()`, after the `load-journey-name` step.do, add a load of the journey's escalation config:

```js
    // J1: journey-level escalation config (exit rules + lifetime cap).
    const jcfg = await step.do('load-journey-cfg', async () => {
      const r = await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=exit_rules,max_duration&limit=1`, env);
      if (!r.ok) throw new Error('load_journey_cfg_failed:' + JSON.stringify(r.data));
      const row = r.data?.[0] || {};
      return { exitRules: Array.isArray(row.exit_rules) ? row.exit_rules : [], maxDuration: row.max_duration || '30 days' };
    });
    const expiresAt = new Date(Date.parse(enrolledAt || new Date().toISOString()) + (G.durationToMs(jcfg.maxDuration) || 2592000000)).toISOString();
```

Add `'load-journey-cfg'` and `'load-journey-name'` are already reserved via the `boot`-family; ensure `RESERVED_STEP_IDS` (Task 2) also lists `'load-journey-cfg'` — add it there and to `compile()`'s reserved check is automatic (it reads `G.RESERVED_STEP_IDS`). **Update Task 2's `RESERVED_STEP_IDS` to include `'load-journey-cfg'`** (add it now if you're doing tasks out of order).

- [ ] **Step 2: Register exit-rule wait rows once at boot**

Immediately after loading `jcfg`, add:

```js
    // Register ambient exit-rule rows so an incoming customer event can find + wake this
    // parked instance (instance_id == enrolmentId). Idempotent upsert (unique index).
    if (jcfg.exitRules.length) {
      await step.do('register-waits', async () => {
        for (const rule of jcfg.exitRules) {
          if (!rule?.event || !rule?.outcome) continue;
          await A.sbComms('/rest/v1/enrolment_waits?on_conflict=enrolment_id,awaited_event,kind', env, {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ enrolment_id: enrolmentId, instance_id: String(enrolmentId), profile_id: profileId,
              awaited_event: rule.event, kind: 'exit', outcome: rule.outcome, expires_at: expiresAt }) });
        }
        return true;
      });
    }
    // Fast set of exit-rule event names for the between-waits pre-check.
    const exitEventSet = new Set(jcfg.exitRules.map((r) => r && r.event).filter(Boolean));
    const exitOutcomeFor = (evName) => (jcfg.exitRules.find((r) => r.event === evName) || {}).outcome || 'exited';
```

- [ ] **Step 3: Add the uniform interruptible-wait helper as a private method**

Add these private methods to the class (after `#doSend`):

```js
  // Park on the single 'signal' event type with a timeout. Returns:
  //   { kind:'timeout' }            — the timeout elapsed (waitForEvent threw). Normal wait completion.
  //   { kind:'response', event }    — an awaited response event arrived (wait_response).
  //   { kind:'exit', outcome, event}— an ambient exit / expiry signal arrived → terminate.
  // NOTE: waitForEvent THROWS on timeout (spike-verified) — the catch IS the timeout path.
  async #park(step, stepName, within) {
    try {
      const ev = await step.waitForEvent(stepName, { type: 'signal', timeout: within });
      const p = (ev && ev.payload) || {};
      if (p.kind === 'exit') return { kind: 'exit', outcome: p.outcome || 'exited', event: p.event };
      return { kind: 'response', event: p.event };
    } catch (e) {
      return { kind: 'timeout' };
    }
  }

  // Before parking, cheaply check whether a qualifying event ALREADY happened since
  // enrol (closes the tiny window where an event lands while the instance is between
  // waits, i.e. not inside waitForEvent). Reuses the events-since-enrol read.
  async #eventSince(env, profileId, names, sinceIso) {
    if (!names.length) return null;
    const inList = names.map((n) => A.enc(n)).join(',');
    const r = await A.sbComms(
      `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=in.(${inList})` +
      `&occurred_at=gte.${A.enc(sinceIso)}&select=name&order=occurred_at.asc&limit=1`, env);
    if (!r.ok) return null;
    return r.data?.[0]?.name || null;
  }
```

- [ ] **Step 4: Rewrite the `wait` branch to be interruptible**

Replace the existing `if (s.type === 'wait') { ... }` block with:

```js
      if (s.type === 'wait') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { duration: s.duration });
        // Pre-check: an exit event already fired between waits? (only if exit rules exist)
        const pre = exitEventSet.size
          ? await step.do(`precheck:${cur}`, async () => this.#eventSince(env, profileId, [...exitEventSet], enrolledAt))
          : null;
        if (pre) { await this.#terminate(env, step, enrolmentId, exitOutcomeFor(pre), cur, jcfg); return; }
        // Interruptible sleep: timeout = normal completion (→ next); exit signal → terminate.
        const r = await this.#park(step, cur, s.duration);
        if (r.kind === 'exit') { await this.#terminate(env, step, enrolmentId, r.outcome, cur, jcfg); return; }
        cur = G.resolveTarget(s, 'next');
      } else if (s.type === 'wait_response') {
        // Register the response rows for the awaited events, then park.
        await step.do(`waitreg:${cur}`, async () => {
          for (const evName of (s.awaited || [])) {
            await A.sbComms('/rest/v1/enrolment_waits?on_conflict=enrolment_id,awaited_event,kind', env, {
              method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
              body: JSON.stringify({ enrolment_id: enrolmentId, instance_id: String(enrolmentId), profile_id: profileId,
                awaited_event: evName, kind: 'response', step_id: cur, expires_at: expiresAt }) });
          }
          return true;
        });
        await this.#logStep(env, step, enrolmentId, cur, s.type, { awaited: s.awaited, within: s.within });
        // Pre-check: response OR exit event already happened since enrol?
        const preNames = [...(s.awaited || []), ...exitEventSet];
        const pre = await step.do(`precheck:${cur}`, async () => this.#eventSince(env, profileId, preNames, enrolledAt));
        let outHandle = null, terminateOutcome = null;
        if (pre && exitEventSet.has(pre)) terminateOutcome = exitOutcomeFor(pre);
        else if (pre) outHandle = 'responded';
        else {
          const r = await this.#park(step, cur, s.within);
          if (r.kind === 'exit') terminateOutcome = r.outcome;
          else if (r.kind === 'response') outHandle = 'responded';
          else outHandle = 'timeout';
        }
        // Clear this step's response rows (delete-on-transition).
        await step.do(`waitclr:${cur}`, async () => {
          await A.sbComms(`/rest/v1/enrolment_waits?enrolment_id=eq.${A.enc(enrolmentId)}&kind=eq.response&step_id=eq.${A.enc(cur)}`, env, { method: 'DELETE' });
          return true;
        });
        if (terminateOutcome) { await this.#terminate(env, step, enrolmentId, terminateOutcome, cur, jcfg); return; }
        cur = G.resolveTarget(s, outHandle);
      } else if (s.type === 'condition') {
```

(The `condition` and `exit` branches stay as-is; the `send` branch is replaced in Step 5.)

- [ ] **Step 5: Apply `on_skip` in the `send` branch**

Replace the `else if (s.type === 'send') { ... }` block with:

```js
      } else if (s.type === 'send') {
        const res = await step.do(cur, async () => this.#doSend(env, s, profileId, enrolmentId, cur, triggerProps, journeyName));
        const decision = G.resolveSendNext(s, res, def);
        await this.#logStep(env, step, enrolmentId, cur, s.type, { ...res, on_skip: s.on_skip || 'continue', skipped_wait: decision.skippedWait || null });
        if (decision.terminate) { await this.#terminate(env, step, enrolmentId, decision.terminate, cur, jcfg); return; }
        cur = decision.next;
```

- [ ] **Step 6: Add `#terminate` (wraps `#end` + deletes wait rows)**

Add a private method that clears the enrolment's wait rows then ends. Replace direct `#end` calls in the exit branch + transition-cap with `#terminate` where a running enrolment stops. Add:

```js
  // Terminal stop: clear this enrolment's wait-index rows, then mark the enrolment ended.
  async #terminate(env, step, enrolmentId, status, lastStep, jcfg) {
    await step.do(`clear-waits:${lastStep || 'end'}`, async () => {
      await A.sbComms(`/rest/v1/enrolment_waits?enrolment_id=eq.${A.enc(enrolmentId)}`, env, { method: 'DELETE' });
      return true;
    });
    await this.#end(env, step, enrolmentId, status, lastStep);
  }
```

Update the `exit` branch to call `#terminate`:

```js
      } else if (s.type === 'exit') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { outcome: s.outcome || 'completed' });
        await this.#terminate(env, step, enrolmentId, s.outcome === 'exited' ? 'exited' : (s.outcome || 'completed'), cur, jcfg);
        return;
```

Note: the `end:<status>` step name inside `#end` must stay unique per run. When both a `wait_response` exit and a natural `exit` can occur, statuses differ (`exited`/`expired`/`completed`) so names don't collide within one run path. The `clear-waits:<lastStep>` name is unique per terminal step. Leave the two `#end(env, step, enrolmentId, 'failed', cur)` guard calls (bad step / transition cap) as direct `#end` — a failed enrolment's orphan rows are handled by the sweeper (Task 8).

- [ ] **Step 7: Dry-run the bundle**

Run: `cd 05_Throttle/commsops-worker && npx wrangler deploy --dry-run --outdir /tmp/j1-dry 2>&1 | tail -5`
Expected: clean bundle, no syntax error.

- [ ] **Step 8: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/journey-workflow.js commsops-worker/src/journey-graph.js
git commit -m "relay(J1): interpreter — wait_response, interruptible waits, exit-rule registration, on_skip, wait-row cleanup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Ingest matcher — wake parked enrolments on a matching event

**Files:**
- Modify: `05_Throttle/commsops-worker/src/ingest.js` (inside `ingest`, after the existing trigger-enrol loop, still under `if (!deduped)`)
- Test: Create `05_Throttle/commsops-worker/test/journey-matcher.test.js`

- [ ] **Step 1: Write a failing unit test for the pure matcher-decision helper**

We isolate the "which instances to signal, and with what payload" decision as a pure function `pickSignals(rows)` in `ingest.js`, exported for test. Create `test/journey-matcher.test.js`:

```js
const assert = require('assert');
const { pickSignals } = require('../src/ingest.js');

// One row per instance → one signal each, payload carries kind/outcome.
{
  const rows = [
    { instance_id: 'A', kind: 'response' },
    { instance_id: 'B', kind: 'exit', outcome: 'cancelled' },
  ];
  const out = pickSignals(rows, 'order_placed', 'evt-1');
  assert.equal(out.length, 2);
  assert.deepEqual(out.find((s) => s.instanceId === 'A').payload, { kind: 'response', event: 'order_placed', event_id: 'evt-1' });
  assert.deepEqual(out.find((s) => s.instanceId === 'B').payload, { kind: 'exit', outcome: 'cancelled', event: 'order_placed', event_id: 'evt-1' });
}
// Same instance matched by BOTH a response row and an exit row → ONE signal, exit wins.
{
  const rows = [
    { instance_id: 'A', kind: 'response' },
    { instance_id: 'A', kind: 'exit', outcome: 'cancelled' },
  ];
  const out = pickSignals(rows, 'order_placed', 'evt-2');
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.kind, 'exit');
}
console.log('pickSignals ok');
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/journey-matcher.test.js`
Expected: FAIL — `pickSignals is not a function`.

- [ ] **Step 3: Implement `pickSignals` + wire the matcher into `ingest`**

Edit `src/ingest.js`. Add the pure helper near the top (after the requires):

```js
// Given the enrolment_waits rows matching (profile, event), produce ONE signal per
// instance (exit wins over response — a cancel/convert must pre-empt a nudge). The
// payload is what the parked JourneyWorkflow's #park reads.
function pickSignals(rows, eventName, eventId) {
  const byInstance = new Map();
  for (const r of rows || []) {
    const cur = byInstance.get(r.instance_id);
    if (!cur || (r.kind === 'exit' && cur.kind !== 'exit')) byInstance.set(r.instance_id, r);
  }
  return [...byInstance.values()].map((r) => ({
    instanceId: r.instance_id,
    payload: r.kind === 'exit'
      ? { kind: 'exit', outcome: r.outcome || 'exited', event: eventName, event_id: eventId }
      : { kind: 'response', event: eventName, event_id: eventId },
  }));
}
```

Inside `ingest`, after the existing trigger-enrol `for` loop (still within the `if (!deduped) { try { ... } }`), add a second block — best-effort, never fail the write:

```js
    // (J1) Wake parked enrolments: find every enrolment awaiting THIS event for THIS
    // profile (O(log n) via the enrolment_waits index) and signal each instance once.
    try {
      const wr = await A.sbComms(
        `/rest/v1/enrolment_waits?profile_id=eq.${A.enc(profileId)}&awaited_event=eq.${A.enc(name)}` +
        `&expires_at=gt.${A.enc(new Date().toISOString())}&select=instance_id,kind,outcome`, env);
      const rows = (wr.ok && wr.data) || [];
      for (const sig of pickSignals(rows, name, eventId)) {
        try {
          const inst = await env.JOURNEY_WORKFLOW.get(sig.instanceId);
          await inst.sendEvent({ type: 'signal', payload: sig.payload });
        } catch (e) { /* instance already ended / not waiting — benign; the row is swept later */ }
      }
    } catch (e) { /* matcher is best-effort; never fail the ingest write */ }
```

Update the exports: `module.exports = { ingest, deriveAttributes, pickSignals };`

- [ ] **Step 4: Run to verify it passes**

Run: `node test/journey-matcher.test.js`
Expected: PASS incl. `pickSignals ok`.

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/ingest.js commsops-worker/test/journey-matcher.test.js
git commit -m "relay(J1): ingest matcher — signal parked enrolments via enrolment_waits index (exit wins)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `max_duration` sweep + expired-wait cleanup in the `*/5` cron

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` (`runScheduled`)

- [ ] **Step 1: Read the current `runScheduled`**

Run: `grep -n "runScheduled\|checkDeliverabilitySpike\|async function runScheduled" 05_Throttle/commsops-worker/src/index.js`
Read that function so the additions slot in beside the existing due-campaign sweep + deliverability check.

- [ ] **Step 2: Add the two sweeps to `runScheduled`**

Inside `runScheduled(env)`, add (order doesn't matter; keep each in its own try so one failure doesn't block the others):

```js
  // (J1) Lifetime cap: auto-exit enrolments older than their journey's max_duration.
  // We signal the parked instance so it ends cleanly via #park → 'expired'; the
  // enrolment row is also patched defensively in case the instance isn't parked.
  try {
    const jr = await A.sbComms('/rest/v1/journeys?select=id,max_duration', env);
    for (const j of ((jr.ok && jr.data) || [])) {
      const ms = require('./journey-graph.js').durationToMs(j.max_duration || '30 days') || 2592000000;
      const cutoff = new Date(Date.now() - ms).toISOString();
      const er = await A.sbComms(
        `/rest/v1/enrolments?journey_id=eq.${A.enc(j.id)}&status=eq.active&enrolled_at=lt.${A.enc(cutoff)}&select=id&limit=200`, env);
      for (const e of ((er.ok && er.data) || [])) {
        try {
          const inst = await env.JOURNEY_WORKFLOW.get(String(e.id));
          await inst.sendEvent({ type: 'signal', payload: { kind: 'exit', outcome: 'expired', event: '__max_duration' } });
        } catch (_) { /* not parked / already gone */ }
      }
    }
  } catch (e) { console.log('j1_maxduration_sweep_error', e?.message || String(e)); }

  // (J1) Delete expired / orphaned wait-index rows (bounded write volume — R4).
  try {
    await A.sbComms(`/rest/v1/enrolment_waits?expires_at=lt.${A.enc(new Date().toISOString())}`, env, { method: 'DELETE' });
  } catch (e) { console.log('j1_wait_sweep_error', e?.message || String(e)); }
```

Ensure `A` is already required at the top of `index.js` (it is — `import * as A` / `const A = require`). If `runScheduled` is in `index.js` scope where `A` is available, no new import is needed; otherwise reuse the module's existing `A` reference.

- [ ] **Step 3: Dry-run**

Run: `cd 05_Throttle/commsops-worker && npx wrangler deploy --dry-run --outdir /tmp/j1-dry 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/index.js
git commit -m "relay(J1): cron sweeps — max_duration auto-exit + expired wait-row cleanup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Deploy + live-validate `waitForEvent` on the real binding (spike proof)

This is the "validate `step.waitForEvent` first" gate (spec §6 R1). It must run on a **deployed** instance — the local-dev `waitForEvent` bug ([workers-sdk #11740](https://github.com/cloudflare/workers-sdk/issues/11740)) makes `wrangler dev` unreliable for this.

**Files:** none (operational). Prereq: Tasks 1–8 committed.

- [ ] **Step 1: Run all worker unit tests green**

Run: `cd 05_Throttle/commsops-worker && node test/journey-graph.test.js && node test/journeys-compile.test.js && node test/journey-matcher.test.js && node test/wa.test.js`
Expected: all PASS.

- [ ] **Step 2: Push + deploy commsops**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && git push
cd 05_Throttle/commsops-worker && npx wrangler deploy
```
Expected: deploy succeeds; output lists the `commsops-journey` Workflow + the `*/5` cron + both queue consumers.

- [ ] **Step 3: Seed a throwaway 2-step escalation journey (SQL, via execute_sql)**

Insert a journey whose definition is: `entry=w` → `wait_response(awaited=['order_placed'], within='2 minutes')` → `responded`→exit `recovered` / `timeout`→exit `lapsed`. Use a real profile id that exists in `comms.profiles` (pick one: `SELECT id FROM comms.profiles LIMIT 1`).

```sql
WITH j AS (
  INSERT INTO comms.journeys (name, status, trigger, exit_rules, max_duration, active_version)
  VALUES ('J1 SMOKE', 'active', '{"type":"event","name":"__j1_smoke_never"}'::jsonb, '[]'::jsonb, '1 day', 1)
  RETURNING id)
INSERT INTO comms.journey_versions (journey_id, version, definition)
SELECT j.id, 1, jsonb_build_object(
  'entry','w',
  'steps', jsonb_build_object(
    'w', jsonb_build_object('type','wait_response','awaited', jsonb_build_array('order_placed'),
          'within','2 minutes','outcomes', jsonb_build_object('responded','er','timeout','el')),
    'er', jsonb_build_object('type','exit','outcome','recovered'),
    'el', jsonb_build_object('type','exit','outcome','lapsed')))
FROM j RETURNING journey_id;
```

- [ ] **Step 4: Create an enrolment + start the instance (the responded path)**

Insert an enrolment for that journey + a real profile, then start the Workflow with instance id = enrolment id:

```sql
INSERT INTO comms.enrolments (journey_id, journey_version, profile_id, status, context)
VALUES ('<journey_id>', 1, '<profile_id>', 'active', jsonb_build_object('enrolled_at', now()::text))
RETURNING id;
```

Start it: `cd 05_Throttle/commsops-worker && npx wrangler workflows instances create commsops-journey --id "<enrolment_id>" --params '{"enrolmentId":"<enrolment_id>","journeyId":"<journey_id>","journeyVersion":1,"profileId":"<profile_id>"}'`
Expected: instance created, status `running` (parked at `waitForEvent`).

- [ ] **Step 5: Prove EARLY WAKE — signal a response before the 2-min timeout**

Within 2 minutes, POST an `order_placed` event for that profile through `/ingest` (this exercises the matcher end-to-end). Use the `INGEST_TOKEN`:

```bash
curl -s -X POST https://commsops.afshaan.workers.dev/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"identifiers":[{"type":"email","value":"<profile_email>"}],"name":"order_placed","properties":{"total":1}}'
```

Then check the enrolment ended `recovered`:

```sql
SELECT status, current_step FROM comms.enrolments WHERE id='<enrolment_id>';
SELECT step_id, step_type, result FROM comms.enrolment_steps WHERE enrolment_id='<enrolment_id>' ORDER BY entered_at;
```
Expected: `status='recovered'`, a `wait_response` step logged, then the `er` exit — and it happened at signal time, not after 2 min. Also `SELECT count(*) FROM comms.enrolment_waits WHERE enrolment_id='<enrolment_id>'` → `0` (cleared on terminate).

- [ ] **Step 6: Prove TIMEOUT — a second enrolment with no event**

Repeat Steps 4 (new enrolment id, same journey/profile) but do NOT send an event. After ~2.5 min:

```sql
SELECT status FROM comms.enrolments WHERE id='<enrolment_id_2>';
```
Expected: `status='lapsed'` (the `timeout` handle → `el` exit). This proves the try/catch timeout path.

- [ ] **Step 7: Clean up the throwaway data**

```sql
DELETE FROM comms.enrolments WHERE journey_id='<journey_id>';
DELETE FROM comms.journeys WHERE id='<journey_id>';  -- cascades journey_versions + enrolment_waits
```
Terminate any lingering instances: `npx wrangler workflows instances terminate commsops-journey <id>` if still running.

- [ ] **Step 8: Record the result**

If both paths behaved as expected, `waitForEvent`/`sendEvent` are proven on the live binding and the single-`signal` design holds. If the early-wake path did NOT fire (event landed but instance didn't advance), STOP and investigate before proceeding — this is the R1 fork (fall back to the poll-hybrid per spec §4.1). Note the outcome in the session notes; no code change if green.

---

## Task 10: Canvas — Wait-for-response node, on_skip, exit rules panel, waterfall lint

**Files:**
- Modify: `05_Throttle/apps/relay/src/components/journey-canvas/graph.js`
- Modify: `05_Throttle/apps/relay/src/components/journey-canvas/JourneyCanvas.js`
- Modify: `05_Throttle/apps/relay/src/components/journey-canvas/NodeDrawer.js`
- Modify: `05_Throttle/apps/relay/src/app/(auth)/journeys/page.js`
- Test: `05_Throttle/apps/relay/src/components/journey-canvas/graph.test.js`

- [ ] **Step 1: Write failing tests for graph.js (handles + waterfall lint)**

Append to `graph.test.js` (reuse its runner):

```js
const G3 = require('./graph.js');
// wait_response handles present
assert.deepEqual(G3.HANDLES.wait_response, ['responded', 'timeout']);
// waterfall lint: two consecutive marketing sends within the freq window → warn
{
  const nodes = [
    { id: '__trigger', data: {} },
    { id: 's1', data: { config: { type: 'send', purpose: 'marketing', channel: 'whatsapp' } } },
    { id: 's2', data: { config: { type: 'send', purpose: 'marketing', channel: 'email' } } },
    { id: 'ex', data: { config: { type: 'exit', outcome: 'completed' } } },
  ];
  const edges = [
    { source: '__trigger', target: 's1', sourceHandle: 'entry' },
    { source: 's1', target: 's2', sourceHandle: 'next' },
    { source: 's2', target: 'ex', sourceHandle: 'next' },
  ];
  const lint = G3.localLint(nodes, edges);
  assert.ok(lint.some((m) => /waterfall|frequency|consecutive/i.test(m)), JSON.stringify(lint));
}
console.log('graph J1 ok');
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd 05_Throttle/apps/relay/src/components/journey-canvas && node graph.test.js`
Expected: FAIL — `HANDLES.wait_response` undefined.

- [ ] **Step 3: Implement graph.js changes**

In `graph.js`, extend `HANDLES`:

```js
const HANDLES = { send: ['next'], wait: ['next'], condition: ['if_true', 'if_false'],
  wait_response: ['responded', 'timeout'], exit: [] };
```

Extend `localLint` — before `return out;` add the waterfall check (consecutive marketing sends along a `next`/`timeout` chain):

```js
  // Waterfall lint (spec §4.2): a marketing send whose immediate downstream (via next
  // or a wait_response timeout) is another marketing send warns the author — the
  // frequency cap may silently kill the later leg.
  const cfg = (id) => (nodes.find((n) => n.id === id) || {}).data?.config || {};
  for (const n of stepNodes) {
    const c = n.data?.config || {};
    if (c.type !== 'send' || (c.purpose || 'marketing') !== 'marketing') continue;
    // follow next, and next→(wait_response timeout)
    const nextIds = edges.filter((e) => e.source === n.id && (e.sourceHandle === 'next')).map((e) => e.target);
    for (const nid of nextIds) {
      const nc = cfg(nid);
      let downstream = [];
      if (nc.type === 'send') downstream = [nid];
      else if (nc.type === 'wait_response')
        downstream = edges.filter((e) => e.source === nid && e.sourceHandle === 'timeout').map((e) => e.target);
      if (downstream.some((d) => cfg(d).type === 'send' && (cfg(d).purpose || 'marketing') === 'marketing'))
        out.push(`waterfall: consecutive marketing sends near "${n.id}" may hit the frequency cap`);
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node graph.test.js`
Expected: PASS incl. `graph J1 ok`.

- [ ] **Step 5: Add the node type to JourneyCanvas.js**

In `JourneyCanvas.js`: import an icon (`Timer` from lucide-react — add to the existing lucide import line). Extend `STEP_META`:

```js
  wait_response: { label: 'Wait for response', icon: Timer, color: '#7aa7ff' },
```

Extend `NEW_STEP`:

```js
  wait_response: { type: 'wait_response', awaited: ['order_placed'], within: '6 hours' },
```

In `StepNode`, extend the `sub` (subtitle) ternary to describe a `wait_response` (add a branch):

```js
    : c.type === 'wait_response' ? `awaits ${(c.awaited || []).join(', ') || '—'} · ${c.within || 'no timeout'}`
```

The palette buttons in `JourneyCanvas` render one `addStep(t)` button per `Object.keys(STEP_META)` or a hardcoded list — read the palette JSX and add `wait_response` to it (mirroring the existing `wait`/`condition` buttons). `HANDLES` drives the node's output handles automatically (it already maps over `HANDLES[c.type]`).

- [ ] **Step 6: Add config forms to NodeDrawer.js**

In `NodeDrawer.js`, add a `wait_response` block (after the `wait` block) — awaited events (comma-separated, using the existing `EVENT_SUGGEST` datalist) + a `within` duration input:

```jsx
      {t === 'wait_response' && (<>
        <Field label="Wait for any of these events (comma-separated)">
          <input className="f-inp mono" value={(config.awaited || []).join(', ')} disabled={disabled}
            list="jc-event-suggest"
            onChange={(e) => set({ awaited: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
            placeholder="order_placed, link_clicked, whatsapp_inbound" />
          <datalist id="jc-event-suggest">{EVENT_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
        </Field>
        <Field label='Timeout (e.g. "6 hours", "2 days")'>
          <input className="f-inp mono" value={config.within || ''} disabled={disabled}
            onChange={(e) => set({ within: e.target.value })} placeholder="6 hours" />
        </Field>
        <div className="tw-note" style={{ margin: 0 }}>Responded path = <span className="mono">responded</span> handle, timeout = <span className="mono">timeout</span>.</div>
      </>)}
```

Add an `on_skip` selector to the **send** block (append inside the `t === 'send'` fragment, after the Template field):

```jsx
        <Field label="If the send is skipped (gate/consent/cap)">
          <select className="f-inp" value={config.on_skip || 'continue'} disabled={disabled}
            onChange={(e) => set({ on_skip: e.target.value })}>
            <option value="continue">continue (proceed as if sent)</option>
            <option value="advance">advance (skip the next wait → go to timeout target)</option>
            <option value="exit">exit the journey</option>
          </select>
        </Field>
        {config.on_skip === 'exit' && (
          <Field label="Exit outcome on skip">
            <input className="f-inp mono" value={config.on_skip_outcome || 'skipped'} disabled={disabled}
              onChange={(e) => set({ on_skip_outcome: e.target.value })} placeholder="skipped" />
          </Field>
        )}
```

- [ ] **Step 7: Add the journey-level Exit rules + Max duration panel in page.js**

In `page.js`: the journey-header form (where trigger/reenrolment fields live, ~lines 240-260) gets a Max-duration input and an Exit-rules editor. Add to the journey state (`j`) two fields (default `maxDuration:'30 days'`, `exitRules:[]`), load them in the getJourney handler (from `journey.max_duration`/`journey.exit_rules`), render editors, and include them in the `save()` payload:

```js
// in save(): add to the saveJourney payload object
      max_duration: j.maxDuration || '30 days',
      exit_rules: j.exitRules || [],
```

Render (near the trigger field):

```jsx
          <div className="ff">
            <div className="kv-k">Max duration (auto-exit "expired" after)</div>
            <input className="f-inp mono" value={j.maxDuration || '30 days'} disabled={busy || !editable}
              onChange={(e) => setJ((s) => ({ ...s, maxDuration: e.target.value }))} placeholder="30 days" />
          </div>
          <div className="ff">
            <div className="kv-k">Exit rules (event → outcome; fire while parked in any wait)</div>
            {(j.exitRules || []).map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input className="f-inp mono" style={{ flex: 1 }} value={r.event || ''} placeholder="order_cancelled"
                  disabled={busy || !editable}
                  onChange={(e) => setJ((s) => { const x = [...s.exitRules]; x[i] = { ...x[i], event: e.target.value }; return { ...s, exitRules: x }; })} />
                <input className="f-inp mono" style={{ flex: 1 }} value={r.outcome || ''} placeholder="cancelled"
                  disabled={busy || !editable}
                  onChange={(e) => setJ((s) => { const x = [...s.exitRules]; x[i] = { ...x[i], outcome: e.target.value }; return { ...s, exitRules: x }; })} />
                <button className="btn" type="button" disabled={busy || !editable}
                  onClick={() => setJ((s) => ({ ...s, exitRules: s.exitRules.filter((_, k) => k !== i) }))}>✕</button>
              </div>
            ))}
            {editable && <button className="btn" type="button"
              onClick={() => setJ((s) => ({ ...s, exitRules: [...(s.exitRules || []), { event: '', outcome: '' }] }))}>+ Add exit rule</button>}
          </div>
```

(Match the exact state-setter names used in `page.js` — read it; if the setter is `setJ`/`set`, use that. The snippet assumes `setJ`; adapt to the file.)

- [ ] **Step 8: Build the app**

Run: `cd 05_Throttle && npx turbo build --filter=@throttle/relay 2>&1 | tail -20`
Expected: build succeeds, zero errors.

- [ ] **Step 9: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add apps/relay/src/components/journey-canvas/ apps/relay/src/app/\(auth\)/journeys/page.js
git commit -m "relay(J1): canvas — wait_response node, on_skip, exit-rules/max_duration panel, waterfall lint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Full escalation integration smoke (deployed) + ambient exit + expiry

**Files:** none (operational). Prereq: Tasks 1–10 deployed (worker) + pushed (app).

- [ ] **Step 1: Push app + confirm worker is current**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && git push
cd 05_Throttle/commsops-worker && npx wrangler deploy   # if any worker change since Task 9
```

- [ ] **Step 2: Author the escalation waterfall via the canvas OR seed via SQL**

Build (or SQL-seed, mirroring Task 9 Step 3) a journey: `entry → Send(WA template) → wait_response(awaited=['order_placed'], within='2 minutes'){responded→exit recovered · timeout→ Send(email) → wait_response(within='2 minutes'){responded→exit recovered · timeout→exit lapsed}}`, with a journey **exit rule** `order_cancelled → cancelled` and `max_duration='1 hour'`. Keep it `status='active'` with a `trigger` that won't auto-fire (`name='__j1_never'`) so only manual enrolments run. Because **TEST MODE is ON**, use a profile whose email is `@legendoftoys.com` (so the email leg actually sends in the smoke); the WA leg will gate-skip unless a live WA sender exists — that's fine and exercises `on_skip`.

- [ ] **Step 3: Timeout → escalate path**

Enrol a staff profile (Task 9 Step 4 mechanics), send NO event. Expect: WA send logged (likely `skipped:no_active_sender`/`window_closed` → with `on_skip:'continue'` it proceeds), first `wait_response` times out after 2 min → email send (delivered to the staff inbox) → second `wait_response`. Verify via `enrolment_steps`.

- [ ] **Step 4: Early responded path**

Enrol a second staff profile; within the first 2 min POST `order_placed` via `/ingest`. Expect the enrolment ends `recovered` immediately (before the WA→email escalation), `enrolment_waits` cleared.

- [ ] **Step 5: Ambient exit path**

Enrol a third; while it is parked in a `wait_response`, POST `order_cancelled` via `/ingest`. Expect the enrolment ends `cancelled` (the ambient exit rule pre-empts the wait), regardless of which wait it was parked in.

- [ ] **Step 6: Expiry path**

Temporarily set that journey's `max_duration='2 minutes'` (SQL), enrol a fourth, send nothing, and wait for one `*/5` cron tick past 2 min. Expect `status='expired'`. Restore `max_duration='1 hour'`.

- [ ] **Step 7: Clean up**

Delete the smoke journey + enrolments (Task 9 Step 7 pattern). Confirm `SELECT count(*) FROM comms.enrolment_waits` returns only rows from genuine (non-smoke) journeys (ideally 0).

- [ ] **Step 8: Confirm TEST MODE never moved**

```sql
SELECT test_mode, test_mode_allow FROM comms.settings WHERE id=1;
```
Expected: `test_mode = true`. If not, STOP — it must be ON.

---

## Task 12: Knowledge files + backlog

**Files:**
- Modify: `systems/relay.md`, `BACKLOG.md` (workspace root). Optionally `BUSINESS_RULES.md`.

- [ ] **Step 1: Update `systems/relay.md`**

Add a "J1 — escalation engine LIVE" block under the Journey authoring section: the `enrolment_waits` index, the single-`signal` design, `wait_response`/`on_skip`/`exit_rules`/`max_duration`, the sweeper, migration `0017`, the commsops commit hash, and the smoke results. Bump the `Last updated` header line.

- [ ] **Step 2: Update `BACKLOG.md`**

Move the J1 sub-item of the "Journey authoring UI" entry to done (leave J2/J3 open); note the remaining browser smoke (canvas drag/connect of a `wait_response` node) as Afshaan's (Google login).

- [ ] **Step 3: Optionally add a BUSINESS_RULE**

If Afshaan wants it codified: a `RULE-RELAY-JOURNEY-001` capturing "journey waits park on a single `signal` type; the `enrolment_waits` (profile,event) index is the sole matcher; exit wins over response; `max_duration` is swept by cron via an exit signal." Only add on his say-so.

- [ ] **Step 4: Commit (knowledge repo — root)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add systems/relay.md BACKLOG.md BUSINESS_RULES.md
git commit -m "relay(J1): knowledge — escalation engine live (enrolment_waits, wait_response, exit_rules, max_duration)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

## Self-review notes (traceability to the spec)

- **§4.1 `wait_response`** → Tasks 3 (compile), 6 (interpreter `wait_response` + `#park`), 7 (matcher), 9 (live proof). Any-of awaited list = multiple `enrolment_waits` response rows; correlation is profile-level (R6) — documented, not fixed here.
- **§4.2 send-outcome policy (`on_skip`) + waterfall lint** → Task 5 (`resolveSendNext`), 6 (send branch), 10 (drawer + lint). `#doSend` per-channel identifier already landed in J0 (`ID_TYPE_FOR_CHANNEL`).
- **§4.4 ambient exit rules + `max_duration`** → Task 1 (columns), 6 (boot registration + interruptible waits + pre-check), 8 (max_duration sweep), 9/11 (proof). Delivered via the single-`signal` race-free design (spike decision), so ambient exits are true-ambient, not on-wake.
- **§4.5 wait-index** → Task 1 (`enrolment_waits` + indexes), 7 (matcher lookup + dedupe-by-instance, exit-wins), event-id dedupe via existing ingest idempotency (documented).
- **§4.7 scale** → O(log n) index; delete-on-transition (`#terminate`, `waitclr`); expiry sweeper (Task 8); parked = native Workflow waits.
- **§4.8 compile() additions** → Task 3 (all listed rules); reserved ids extended (Task 2).
- **§3 canvas node** → Task 10 (palette + handles + drawer + panel).
- **R1 (waitForEvent fit)** → resolved by the spike + Task 9 live gate (fall back to poll-hybrid only if Task 9 Step 5 fails).
- **R5 (back-compat)** → interpreter still reads legacy shapes via `G.resolveTarget`; unchanged step types keep their code paths; old-shape pinned versions run unmodified.

**Out of scope (dependencies, per spec §5 / §6):** SMS/voice adapters (M11–M13+), segment-entry + Shiprocket/popup triggers, interactive send + Razorpay/Shopify action nodes (J3). The canvas offers SMS/voice as "not live yet" via the existing `CHANNELS` live-flag; action nodes are not added in J1.
