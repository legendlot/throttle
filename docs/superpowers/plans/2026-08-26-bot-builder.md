# Bot Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Relay bot builder (scripted decision-tree flows on the journey canvas) with the staff-gated web widget as its first consumer.

**Architecture:** commsops owns flow storage/versions/turn-engine/public web ingress; csops owns the conversation record + inbox (turns forwarded over the existing `CSOPS` service binding); the Relay app hosts one canvas with a Journey|Bot mode toggle. Synchronous turn loop — no Workflow, no queue.

**Tech Stack:** Cloudflare Workers (CommonJS), PostgREST via `A.sbComms`/`A.sbStore`, Next.js + @xyflow/react (Relay app), plain-`assert` tests run as `node test/<file>.test.js`.

**Spec:** `05_Throttle/docs/superpowers/specs/2026-08-26-bot-builder-design.md`

## Global Constraints

- Repo: everything below lives in `05_Throttle` (worker `commsops-worker/`, worker `csops-worker/`, app `apps/relay/`). **Path-scoped `git add` always** — parallel lanes share this repo (CORE.md).
- Deploy sequence per worker: edit → commit → **push (must succeed)** → `cd <worker-dir> && npx wrangler deploy` (PATTERN-220).
- Migrations to Supabase project `jkxcnjabmrkteanzoofj` via the `apply_migration` MCP tool; **every migration creating a table ends with `NOTIFY pgrst, 'reload schema';`** (S239 silent-cache trap). RLS ON + `GRANT ALL ... TO service_role` on every new table.
- Never loop `await` per row; batch (CORE.md).
- All timestamps stored UTC; anything user-facing renders IST.
- Do NOT touch `comms.journeys` / `journey_versions` / `enrolments` — bots are separate tables.
- `csops` is customer-facing: no behaviour change to any existing WhatsApp/IG path; additions only.
- Worker tests: create file under `test/`, run with `node test/<name>.test.js` (exit 0 = pass). No test runner exists; follow `test/journey-graph.test.js` style (`require('assert')`).

## Definition shape (used by every task)

```json
{
  "entry": "welcome",
  "steps": {
    "welcome":  { "type": "message", "text": "Hi! I'm the LOT assistant.", "outcomes": { "next": "ident" } },
    "ident":    { "type": "collect", "field": "phone_or_email", "prompt": "Your phone or email?", "outcomes": { "next": "menu1" } },
    "menu1":    { "type": "menu", "text": "How can I help?", "buttons": [ { "id": "b_track", "label": "Track my order" }, { "id": "b_agent", "label": "Chat with an agent" } ], "outcomes": { "b_track": "collect_order", "b_agent": "handoff1", "fallback": "handoff1" } },
    "collect_order": { "type": "collect", "field": "order_number", "prompt": "Your order number? (e.g. #12345)", "outcomes": { "next": "status1" } },
    "status1":  { "type": "action", "kind": "order_status", "outcomes": { "found": "done", "not_found": "handoff1" } },
    "handoff1": { "type": "handoff", "outcomes": {} },
    "done":     { "type": "end", "text": "Anything else, just say hi!", "outcomes": {} }
  }
}
```

Session state (persisted on `comms.bot_sessions`): `current_step text`, `status active|handed_off|ended`, `context jsonb` (holds `identity`, `order_number`, `menu_misses`, `order_attempts`).

---

### Task 1: Migration `0058_comms_bots`

**Files:**
- Create: `05_Throttle/commsops-worker/migrations/0058_comms_bots.sql`

**Interfaces:**
- Produces: tables `comms.bots`, `comms.bot_versions`, `comms.bot_sessions`, `comms.bot_session_steps` exactly as below — every later task reads these column names.

- [ ] **Step 1: Write the migration file**

```sql
-- 0058 — Bot builder: scripted decision-tree bots (spec 2026-08-26-bot-builder-design.md).
-- Separate from journeys/enrolments ON PURPOSE: enrolments.profile_id is NOT NULL (web
-- visitors are anonymous until collect), and journey re-enrolment/dedup semantics are wrong
-- for chat (five sessions a day is legitimate). Shared step VOCABULARY, separate tables.

CREATE TABLE comms.bots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  channel        text NOT NULL DEFAULT 'web' CHECK (channel IN ('web')),
  active_version integer,
  draft_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- widget copy, offhours message
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Immutable once written (same rule as journey_versions): a running session is pinned to
-- the version it started on; editing a live bot never rewrites a conversation mid-flight.
CREATE TABLE comms.bot_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id     uuid NOT NULL REFERENCES comms.bots(id),
  version    integer NOT NULL,
  definition jsonb NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, version)
);

CREATE TABLE comms.bot_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id           uuid NOT NULL REFERENCES comms.bots(id),
  bot_version      integer NOT NULL,
  profile_id       uuid,                          -- NULLABLE: anonymous until collect resolves one
  visitor_key      text NOT NULL,
  thread_id        uuid,                          -- loose ref -> store.cs_wa_threads.id (ignition.connects precedent; no FK)
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','handed_off','ended')),
  current_step     text,
  context          jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE INDEX bot_sessions_bot_started_idx ON comms.bot_sessions (bot_id, started_at DESC);
CREATE INDEX bot_sessions_visitor_idx     ON comms.bot_sessions (visitor_key, started_at DESC);

-- Append-only. THE analytics substrate: handled/drop-off/handoff/conversion derive from
-- here, never from a separate counter that can drift. Also carries agent replies after
-- handoff (step_type='agent_reply') so /web/poll has one ordered stream to read.
CREATE TABLE comms.bot_session_steps (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES comms.bot_sessions(id),
  step_id    text NOT NULL,
  step_type  text NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  result     jsonb
);
CREATE INDEX bot_session_steps_session_idx ON comms.bot_session_steps (session_id, id);

ALTER TABLE comms.bots              ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.bot_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.bot_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.bot_session_steps ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.bots, comms.bot_versions, comms.bot_sessions, comms.bot_session_steps TO service_role;
GRANT USAGE, SELECT ON SEQUENCE comms.bot_session_steps_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply** via MCP `apply_migration` (project `jkxcnjabmrkteanzoofj`, name `comms_bots_v1`, query = file contents).

- [ ] **Step 3: Verify** via MCP `execute_sql`:

```sql
SELECT table_name, count(*) cols FROM information_schema.columns
WHERE table_schema='comms' AND table_name LIKE 'bot%' GROUP BY 1 ORDER BY 1;
```
Expected: 4 rows (`bot_session_steps` 6, `bot_sessions` 12, `bot_versions` 6, `bots` 10).

- [ ] **Step 4: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && git add commsops-worker/migrations/0058_comms_bots.sql && git commit -m "S312 [relay]: bots schema — flows, immutable versions, sessions, append-only steps"
```

---

### Task 2: Turn engine `bot-engine.js` (pure) + tests

**Files:**
- Create: `05_Throttle/commsops-worker/src/bot-engine.js`
- Test: `05_Throttle/commsops-worker/test/bot-engine.test.js`

**Interfaces:**
- Consumes: `require('./journey-graph.js')` → `resolveTarget(step, handle)`.
- Produces: `advance(def, state, input) -> { state, replies, effects }` where
  `state = { current_step, status, context }` (mutated copy returned),
  `input = { kind: 'open'|'text'|'button'|'action_result', text?, buttonId?, ok?, data? }`,
  `replies = [{ text, buttons?: [{id,label}] }]`,
  `effects = [{ type: 'order_lookup', orderNumber, identity } | { type: 'handoff' }]`.
  Also `validateBotDef(def) -> [ {code, stepId} ]` (empty = valid), `MAX_MENU_MISSES = 2`, `MAX_ORDER_ATTEMPTS = 5`.
  **Async I/O is an effect:** the engine never fetches; the caller executes effects and re-enters with `kind:'action_result'`.

- [ ] **Step 1: Write the failing tests**

```js
// test/bot-engine.test.js — run: node test/bot-engine.test.js
const assert = require('assert');
const E = require('../src/bot-engine.js');

const DEF = { entry: 'welcome', steps: {
  welcome: { type: 'message', text: 'Hi!', outcomes: { next: 'ident' } },
  ident:   { type: 'collect', field: 'phone_or_email', prompt: 'Phone or email?', outcomes: { next: 'menu1' } },
  menu1:   { type: 'menu', text: 'Pick one', buttons: [{ id: 'b_track', label: 'Track my order' }, { id: 'b_agent', label: 'Agent' }],
             outcomes: { b_track: 'collect_order', b_agent: 'handoff1', fallback: 'handoff1' } },
  collect_order: { type: 'collect', field: 'order_number', prompt: 'Order number?', outcomes: { next: 'status1' } },
  status1: { type: 'action', kind: 'order_status', outcomes: { found: 'done', not_found: 'handoff1' } },
  handoff1:{ type: 'handoff', outcomes: {} },
  done:    { type: 'end', text: 'Bye!', outcomes: {} },
} };
const fresh = () => ({ current_step: null, status: 'active', context: {} });

// open: walks message -> stops at collect, both prompts returned in order
let r = E.advance(DEF, fresh(), { kind: 'open' });
assert.equal(r.state.current_step, 'ident');
assert.deepEqual(r.replies.map(x => x.text), ['Hi!', 'Phone or email?']);

// collect valid phone -> lands on menu with buttons; identity normalized to last-10 digits
r = E.advance(DEF, r.state, { kind: 'text', text: '+91 98765-43210' });
assert.equal(r.state.current_step, 'menu1');
assert.equal(r.state.context.identity.phone, '9876543210');
assert.deepEqual(r.replies[0].buttons.map(b => b.id), ['b_track', 'b_agent']);

// collect invalid -> re-prompts, stays put
let bad = E.advance(DEF, { current_step: 'ident', status: 'active', context: {} }, { kind: 'text', text: 'zzz' });
assert.equal(bad.state.current_step, 'ident');
assert.match(bad.replies[0].text, /valid phone|email/i);

// menu: free text matching a label (case-insensitive) counts as that button
let m = E.advance(DEF, r.state, { kind: 'text', text: 'track MY order' });
assert.equal(m.state.current_step, 'collect_order');

// menu: 1-based index also matches
let mi = E.advance(DEF, { current_step: 'menu1', status: 'active', context: {} }, { kind: 'text', text: '2' });
assert.equal(mi.state.current_step, 'handoff1');
assert.equal(mi.effects[0].type, 'handoff');
assert.equal(mi.state.status, 'handed_off');

// menu: miss re-shows menu; second miss fires fallback (MAX_MENU_MISSES = 2)
let x1 = E.advance(DEF, { current_step: 'menu1', status: 'active', context: {} }, { kind: 'text', text: 'weather?' });
assert.equal(x1.state.current_step, 'menu1');
assert.equal(x1.state.context.menu_misses, 1);
let x2 = E.advance(DEF, x1.state, { kind: 'text', text: 'still weather' });
assert.equal(x2.state.current_step, 'handoff1');

// order number collect -> action emits order_lookup effect and waits
let o = E.advance(DEF, { current_step: 'collect_order', status: 'active', context: { identity: { phone: '9876543210' } } }, { kind: 'text', text: '#12345' });
assert.equal(o.state.current_step, 'status1');
assert.deepEqual(o.effects[0], { type: 'order_lookup', orderNumber: '#12345', identity: { phone: '9876543210' } });
assert.equal(o.replies.length, 0);

// action_result found -> renders status text, walks to end
let f = E.advance(DEF, o.state, { kind: 'action_result', ok: true, data: { statusText: 'Out for delivery' } });
assert.equal(f.state.status, 'ended');
assert.deepEqual(f.replies.map(x => x.text), ['Out for delivery', 'Bye!']);

// action_result not ok -> not_found branch -> handoff
let nf = E.advance(DEF, { current_step: 'status1', status: 'active', context: { order_attempts: 4 } }, { kind: 'action_result', ok: false });
assert.equal(nf.state.current_step, 'handoff1');

// handed_off session: bot NEVER replies (agent supremacy)
let h = E.advance(DEF, { current_step: 'menu1', status: 'handed_off', context: {} }, { kind: 'text', text: 'hello?' });
assert.equal(h.replies.length, 0);
assert.equal(h.effects.length, 0);

// validator: dangling target + menu without fallback wiring
assert.deepEqual(E.validateBotDef(DEF), []);
const badDef = { entry: 'a', steps: { a: { type: 'menu', text: 'x', buttons: [{ id: 'b1', label: 'One' }], outcomes: { b1: 'ghost' } } } };
const errs = E.validateBotDef(badDef).map(e => e.code).sort();
assert.deepEqual(errs, ['dangling_target', 'fallback_unwired']);

console.log('bot-engine tests OK');
```

- [ ] **Step 2: Run to verify failure** — `cd 05_Throttle/commsops-worker && node test/bot-engine.test.js` → `Cannot find module '../src/bot-engine.js'`.

- [ ] **Step 3: Implement `src/bot-engine.js`**

```js
// Pure bot turn engine (spec 2026-08-26-bot-builder-design.md). NO I/O in this file —
// async work (order lookup, handoff forward) is returned as an EFFECT; the route executes
// it and re-enters with input {kind:'action_result'}. That is what makes this testable
// exactly like journey-graph.js, and what keeps validator and runtime from drifting.
const G = require('./journey-graph.js');

const MAX_MENU_MISSES = 2;     // Afshaan: free text re-shows the menu; 2 misses -> fallback
const MAX_ORDER_ATTEMPTS = 5;  // enumeration guard: sequential order numbers, public surface

const PHONE_RE = /(?:\+?91[\s-]?)?([0-9][\s-]?){10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORDER_RE = /^#?\d{3,10}$/;

function normPhone(s) { const d = String(s).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; }

function renderStep(step) {
  if (step.type === 'menu') return { text: step.text, buttons: step.buttons.map((b) => ({ id: b.id, label: b.label })) };
  return { text: step.text || step.prompt || '' };
}

// Walk forward from stepId, emitting replies, until a step that WAITS (collect, menu,
// action pending I/O, handoff/end terminal). Returns {state, replies, effects}.
function walk(def, state, stepId, replies, effects) {
  let id = stepId;
  for (let hops = 0; hops < 50 && id; hops++) {          // hop cap: authoring loops end the walk, never the worker
    const step = def.steps[id];
    if (!step) break;
    state.current_step = id;
    if (step.type === 'message') { replies.push(renderStep(step)); id = G.resolveTarget(step, 'next'); continue; }
    if (step.type === 'collect') { replies.push({ text: step.prompt }); return { state, replies, effects }; }
    if (step.type === 'menu')    { state.context.menu_misses = 0; replies.push(renderStep(step)); return { state, replies, effects }; }
    if (step.type === 'action' && step.kind === 'order_status') {
      effects.push({ type: 'order_lookup', orderNumber: state.context.order_number, identity: state.context.identity || {} });
      return { state, replies, effects };                 // wait for action_result
    }
    if (step.type === 'handoff') { state.status = 'handed_off'; effects.push({ type: 'handoff' }); return { state, replies, effects }; }
    if (step.type === 'end')     { if (step.text) replies.push({ text: step.text }); state.status = 'ended'; return { state, replies, effects }; }
    break;
  }
  return { state, replies, effects };
}

function advance(def, prev, input) {
  const state = { current_step: prev.current_step, status: prev.status, context: { ...(prev.context || {}) } };
  const replies = []; const effects = [];
  if (state.status !== 'active' && input.kind !== 'agent') return { state, replies, effects };  // agent supremacy: handed_off/ended bot is silent

  if (input.kind === 'open') return walk(def, state, def.entry, replies, effects);

  const step = def.steps[state.current_step];
  if (!step) return walk(def, state, def.entry, replies, effects);

  if (step.type === 'collect' && (input.kind === 'text' || input.kind === 'button')) {
    const raw = String(input.text || '').trim();
    if (step.field === 'phone_or_email') {
      const phone = PHONE_RE.test(raw) ? normPhone(raw) : null;
      const email = EMAIL_RE.test(raw) ? raw.toLowerCase() : null;
      if (!phone && !email) { replies.push({ text: 'Please share a valid phone number or email so we can help.' }); return { state, replies, effects }; }
      state.context.identity = phone ? { phone } : { email };
    } else if (step.field === 'order_number') {
      if (!ORDER_RE.test(raw)) { replies.push({ text: 'That does not look like an order number — it is on your confirmation, like #12345.' }); return { state, replies, effects }; }
      state.context.order_number = raw.startsWith('#') ? raw : `#${raw}`;
    } else { state.context[step.field] = raw; }
    return walk(def, state, G.resolveTarget(step, 'next'), replies, effects);
  }

  if (step.type === 'menu') {
    let handle = null;
    if (input.kind === 'button' && step.buttons.some((b) => b.id === input.buttonId)) handle = input.buttonId;
    else if (input.kind === 'text') {
      const t = String(input.text || '').trim().toLowerCase();
      const byLabel = step.buttons.find((b) => b.label.toLowerCase() === t);
      const byIndex = /^\d+$/.test(t) ? step.buttons[Number(t) - 1] : null;
      handle = (byLabel || byIndex || {}).id || null;
    }
    if (!handle) {
      const misses = (state.context.menu_misses || 0) + 1;
      if (misses >= MAX_MENU_MISSES) return walk(def, state, G.resolveTarget(step, 'fallback'), replies, effects);
      state.context.menu_misses = misses;
      replies.push({ text: 'Sorry, I did not catch that — please pick an option below.' });
      replies.push(renderStep(step));
      return { state, replies, effects };
    }
    return walk(def, state, G.resolveTarget(step, handle), replies, effects);
  }

  if (step.type === 'action' && input.kind === 'action_result') {
    if (input.ok) { replies.push({ text: input.data.statusText }); return walk(def, state, G.resolveTarget(step, 'found'), replies, effects); }
    const attempts = (state.context.order_attempts || 0) + 1;
    state.context.order_attempts = attempts;
    if (attempts >= MAX_ORDER_ATTEMPTS) { state.status = 'ended'; replies.push({ text: 'We could not verify those details. Please write to support@legendoftoys.com.' }); return { state, replies, effects }; }
    return walk(def, state, G.resolveTarget(step, 'not_found'), replies, effects);
  }

  // Anything else (text at an action/terminal): restate where we are.
  replies.push(renderStep(step));
  return { state, replies, effects };
}

// Canvas + publish lint. Same discipline as journeys compile(): validator reads targets
// through the SAME resolveTarget the runtime uses.
function validateBotDef(def) {
  const errs = [];
  if (!def || !def.entry || !def.steps || !def.steps[def.entry]) return [{ code: 'no_entry', stepId: def && def.entry }];
  for (const [id, step] of Object.entries(def.steps)) {
    const handles = step.type === 'menu'
      ? [...(step.buttons || []).map((b) => b.id), 'fallback']
      : step.type === 'action' ? ['found', 'not_found']
      : (step.type === 'handoff' || step.type === 'end') ? []
      : ['next'];
    for (const h of handles) {
      const t = G.resolveTarget(step, h);
      if (!t && (step.type !== 'menu' || h === 'fallback')) {
        if (step.type === 'menu' && h === 'fallback') errs.push({ code: 'fallback_unwired', stepId: id });
        else if (handles.length) errs.push({ code: 'dangling_target', stepId: id });
        continue;
      }
      if (t && !def.steps[t]) errs.push({ code: 'dangling_target', stepId: id });
    }
    if (step.type === 'menu' && !(step.buttons || []).length) errs.push({ code: 'menu_no_buttons', stepId: id });
  }
  return errs;
}

module.exports = { advance, walk, validateBotDef, MAX_MENU_MISSES, MAX_ORDER_ATTEMPTS, normPhone };
```

- [ ] **Step 4: Run tests** — `node test/bot-engine.test.js` → `bot-engine tests OK`. Iterate on mismatches (the test file is the contract; fix the engine, not the test, unless a test contradicts the spec).

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/bot-engine.js commsops-worker/test/bot-engine.test.js && git commit -m "S312 [relay]: bot turn engine — pure, effect-based, agent-supremacy enforced"
```

---

### Task 3: Order-status lookup `bot-order-status.js` + tests

**Files:**
- Create: `05_Throttle/commsops-worker/src/bot-order-status.js`
- Test: `05_Throttle/commsops-worker/test/bot-order-status.test.js`

**Interfaces:**
- Consumes: `SHOP.shopifyGraphQL(env, query)` (exists in `src/shopify.js`); `A.sbProfile('public')` for `public.ecom_shipments`.
- Produces: `lookupOrderStatus(env, { orderNumber, identity }, deps?) -> { ok:true, statusText } | { ok:false, reason }` where `deps = { fetchOrder, fetchShipment }` is injectable for tests. `reason ∈ order_not_found | identity_mismatch | no_identity`.

- [ ] **Step 1: Write the failing tests**

```js
// test/bot-order-status.test.js — run: node test/bot-order-status.test.js
const assert = require('assert');
const { lookupOrderStatus, statusTextFor, identityMatches } = require('../src/bot-order-status.js');

// identityMatches: last-10 phone digits, case-insensitive email
assert.equal(identityMatches({ phone: '9876543210' }, { phone: '+919876543210', email: null }), true);
assert.equal(identityMatches({ email: 'A@B.com' }, { phone: null, email: 'a@b.com' }), true);
assert.equal(identityMatches({ phone: '9876543210' }, { phone: '+919999999999', email: 'x@y.z' }), false);
assert.equal(identityMatches({}, { phone: '+919876543210' }), false);   // no identity NEVER matches

// statusTextFor: lifecycle -> human copy, tracking link appended when present
assert.match(statusTextFor({ lifecycle: 'out_for_delivery', courier: 'Delhivery', tracking_link: 'https://t.example/x' }),
  /out for delivery today.*Delhivery.*https:\/\/t\.example\/x/is);
assert.match(statusTextFor({ lifecycle: 'delivered', delivered_at: '2026-08-25T10:00:00Z' }), /delivered/i);
assert.match(statusTextFor({ lifecycle: 'pending' }), /being prepared|packed/i);
assert.match(statusTextFor(null), /being processed/i);   // order exists, no shipment row yet

(async () => {
  const deps = {
    fetchOrder: async () => ({ name: '#12345', phone: '+919876543210', email: 'a@b.com' }),
    fetchShipment: async () => ({ lifecycle: 'in_transit', courier: 'Delhivery', tracking_link: null }),
  };
  let r = await lookupOrderStatus({}, { orderNumber: '#12345', identity: { phone: '9876543210' } }, deps);
  assert.equal(r.ok, true); assert.match(r.statusText, /on its way/i);

  r = await lookupOrderStatus({}, { orderNumber: '#12345', identity: { phone: '1112223334' } }, deps);
  assert.deepEqual(r, { ok: false, reason: 'identity_mismatch' });

  r = await lookupOrderStatus({}, { orderNumber: '#404', identity: { phone: '9876543210' } },
    { ...deps, fetchOrder: async () => null });
  assert.deepEqual(r, { ok: false, reason: 'order_not_found' });

  r = await lookupOrderStatus({}, { orderNumber: '#12345', identity: {} }, deps);
  assert.deepEqual(r, { ok: false, reason: 'no_identity' });
  console.log('bot-order-status tests OK');
})();
```

- [ ] **Step 2: Run to verify failure** — `node test/bot-order-status.test.js` → module not found.

- [ ] **Step 3: Implement `src/bot-order-status.js`**

```js
// Verified order-status lookup for the web bot (spec §guards). The ingress is PUBLIC and
// LOT order numbers are SEQUENTIAL: an unverified lookup is an enumeration hole over
// names/addresses/purchases. So: the collected identity must match the order's own
// phone/email, server-side, before ANY status is revealed. order_not_found and
// identity_mismatch return the SAME customer-facing branch (not_found) upstream —
// distinguishing them would confirm which order numbers exist.
const SHOP = require('./shopify.js');
const A = require('./auth.js');
const sbPublic = A.sbProfile('public');

function identityMatches(given, order) {
  if (given?.phone && order?.phone) return String(order.phone).replace(/\D/g, '').slice(-10) === given.phone;
  if (given?.email && order?.email) return String(order.email).toLowerCase() === given.email;
  return false;   // no overlap of kinds, or nothing collected -> NEVER a match
}

function statusTextFor(sh) {
  if (!sh) return 'Your order is confirmed and being processed — we will message you as soon as it ships.';
  const trk = sh.tracking_link ? `\nTrack it live: ${sh.tracking_link}` : '';
  switch (sh.lifecycle) {
    case 'delivered':        return `Your order was delivered${sh.delivered_at ? ` on ${new Date(sh.delivered_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}. Enjoy!`;
    case 'out_for_delivery': return `Great news — your order is out for delivery today with ${sh.courier || 'our courier'}.${trk}`;
    case 'in_transit':       return `Your order is on its way with ${sh.courier || 'our courier'}.${trk}`;
    case 'manifested':       return `Your order is packed and ready for pickup by ${sh.courier || 'our courier'}.${trk}`;
    case 'rto':              return 'This shipment is returning to us. Our support team can help — pick "Chat with an agent".';
    case 'cancelled':        return 'This order shows as cancelled. If that is unexpected, pick "Chat with an agent".';
    default:                 return 'Your order is confirmed and being prepared for dispatch.';
  }
}

async function defaultFetchOrder(env, orderName) {
  const q = `{ orders(first: 1, query: "name:${orderName.replace(/"/g, '')}") { nodes { name email phone customer { phone email } } } }`;
  const d = await SHOP.shopifyGraphQL(env, q).catch(() => null);
  const o = d?.orders?.nodes?.[0];
  if (!o) return null;
  return { name: o.name, phone: o.phone || o.customer?.phone || null, email: o.email || o.customer?.email || null };
}

async function defaultFetchShipment(env, orderName) {
  const r = await sbPublic(`/rest/v1/ecom_shipments?shopify_order_name=eq.${A.enc(orderName)}&select=lifecycle,courier,tracking_link,delivered_at&order=updated_at.desc&limit=1`, env)
    .catch(() => ({ ok: false }));
  return (r.ok && r.data?.[0]) || null;
}

async function lookupOrderStatus(env, { orderNumber, identity }, deps = {}) {
  if (!identity || (!identity.phone && !identity.email)) return { ok: false, reason: 'no_identity' };
  const fetchOrder = deps.fetchOrder || ((n) => defaultFetchOrder(env, n));
  const fetchShipment = deps.fetchShipment || ((n) => defaultFetchShipment(env, n));
  const order = await fetchOrder(orderNumber);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (!identityMatches(identity, order)) return { ok: false, reason: 'identity_mismatch' };
  const sh = await fetchShipment(orderNumber);
  return { ok: true, statusText: statusTextFor(sh) };
}

module.exports = { lookupOrderStatus, statusTextFor, identityMatches };
```

- [ ] **Step 4: Run tests** — `node test/bot-order-status.test.js` → OK.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/bot-order-status.js commsops-worker/test/bot-order-status.test.js && git commit -m "S312 [relay]: verified order-status lookup — identity must match, not_found never confirms existence"
```

---

### Task 4: Bot CRUD actions (JWT-gated, commsops)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` (add cases to `handleGet`'s switch and `handlePost`'s switch — follow the `createLink`/`updateLink` pattern at `~:978`)
- Create: `05_Throttle/commsops-worker/src/bots.js`

**Interfaces:**
- Consumes: `A.sbComms`, `A.canBuild`, `A.canActivate`, `E.validateBotDef` (Task 2).
- Produces (worker actions the Relay app calls): GET `listBots` → `{bots:[{id,name,status,channel,active_version,updated_at,sessions_7d}]}`; GET `getBot&id=` → `{bot}` (incl. `draft_definition`); POST `saveBot {id?, name, draft_definition, config}` (canBuild) → `{bot}`; POST `publishBot {id}` (canActivate) → freezes `draft_definition` into `bot_versions` as `active_version+1`, sets `status='active'`; POST `pauseBot {id}` (canActivate); POST `testBotTurn {id, state, input}` (canBuild) → runs `advance` against the DRAFT definition, executes NO effects, returns `{state, replies, effects}` — this powers the canvas Test panel with zero side effects.

- [ ] **Step 1: Implement `src/bots.js`**

```js
// Bot CRUD (JWT side). Publish freezes the draft into an immutable bot_versions row —
// the same discipline as journeys: sessions pin the version they started on.
const A = require('./auth.js');
const E = require('./bot-engine.js');

async function listBots(env) {
  const r = await A.sbComms('/rest/v1/bots?select=id,name,status,channel,active_version,updated_at&order=updated_at.desc', env);
  return r.ok ? { ok: true, bots: r.data } : { ok: false, error: 'list_failed' };
}

async function getBot(env, id) {
  const r = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  const bot = r.ok && r.data?.[0];
  return bot ? { ok: true, bot } : { ok: false, error: 'not_found' };
}

async function saveBot(env, { id, name, draft_definition, config }, userId) {
  const body = { name, draft_definition: draft_definition || {}, config: config || {}, updated_at: new Date().toISOString() };
  const r = id
    ? await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH', body: JSON.stringify(body) })
    : await A.sbComms('/rest/v1/bots', env, { method: 'POST', body: JSON.stringify({ ...body, created_by: userId || null }) });
  const bot = r.ok && (Array.isArray(r.data) ? r.data[0] : r.data);
  return bot ? { ok: true, bot } : { ok: false, error: 'save_failed', detail: r.data };
}

async function publishBot(env, id, userId) {
  const cur = await getBot(env, id);
  if (!cur.ok) return cur;
  const errs = E.validateBotDef(cur.bot.draft_definition);
  if (errs.length) return { ok: false, error: 'invalid_definition', errors: errs };
  const version = (cur.bot.active_version || 0) + 1;
  const v = await A.sbComms('/rest/v1/bot_versions', env, { method: 'POST',
    body: JSON.stringify({ bot_id: id, version, definition: cur.bot.draft_definition, created_by: userId || null }) });
  if (!v.ok) return { ok: false, error: 'version_write_failed', detail: v.data };
  const u = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH',
    body: JSON.stringify({ active_version: version, status: 'active', updated_at: new Date().toISOString() }) });
  return u.ok ? { ok: true, bot: u.data?.[0], version } : { ok: false, error: 'publish_failed' };
}

async function setBotStatus(env, id, status) {
  const u = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(id)}`, env, { method: 'PATCH',
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
  return u.ok && u.data?.[0] ? { ok: true, bot: u.data[0] } : { ok: false, error: 'update_failed' };
}

module.exports = { listBots, getBot, saveBot, publishBot, setBotStatus };
```

- [ ] **Step 2: Wire actions into `index.js`.** Add `const BOTS = require('./bots.js');` beside the other requires. In `handleGet`'s switch add:

```js
    case 'listBots': {
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const r = await BOTS.listBots(env);
      return r.ok ? ok(r) : err(r.error, 500);
    }
    case 'getBot': {
      if (!A.canView(auth.permissions)) return err('forbidden', 403);
      const r = await BOTS.getBot(env, url.searchParams.get('id'));
      return r.ok ? ok(r) : err(r.error, 404);
    }
```

In `handlePost`'s switch (near `createLink`) add:

```js
    // ── Bots (S312) — gated like campaign assets: build to author, activate to publish.
    case 'saveBot': {
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const r = await BOTS.saveBot(env, body, auth.userId);
      return r.ok ? ok(r) : err(r.error, 400);
    }
    case 'publishBot': {
      if (!A.canActivate(auth.permissions)) return err('forbidden', 403);
      const r = await BOTS.publishBot(env, body.id, auth.userId);
      return r.ok ? ok(r) : err(r.error, r.error === 'invalid_definition' ? 422 : 400, r.errors ? { errors: r.errors } : undefined);
    }
    case 'pauseBot': case 'resumeBot': {
      if (!A.canActivate(auth.permissions)) return err('forbidden', 403);
      const r = await BOTS.setBotStatus(env, body.id, body.action === 'pauseBot' ? 'paused' : 'active');
      return r.ok ? ok(r) : err(r.error, 400);
    }
    case 'testBotTurn': {   // canvas Test panel: draft definition, NO effects executed, no rows written
      if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const g = await BOTS.getBot(env, body.id);
      if (!g.ok) return err('not_found', 404);
      const EB = require('./bot-engine.js');
      return ok(EB.advance(body.definition || g.bot.draft_definition, body.state || { current_step: null, status: 'active', context: {} }, body.input || { kind: 'open' }));
    }
```

(`pauseBot`/`resumeBot` share a case: `body.action` is present on every POST body in this worker.)

- [ ] **Step 3: Syntax check** — `cp src/index.js /tmp/ci.mjs && node --check /tmp/ci.mjs && rm /tmp/ci.mjs` (the file is ESM at top; direct `node --check` on `.js` fails for module reasons, not syntax).

- [ ] **Step 4: Run ALL existing tests** — `for f in test/*.test.js; do node "$f" > /dev/null || echo "FAIL $f"; done` → no FAIL lines.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/bots.js commsops-worker/src/index.js && git commit -m "S312 [relay]: bot CRUD + publish (immutable versions) + side-effect-free testBotTurn"
```

---

### Task 5: `store.cs_wa_threads` web marker + csops forward route + agent-reply routing

**Files:**
- Create (migration via MCP `apply_migration`, name `pitstop_relay_web_threads_v1`)
- Modify: `05_Throttle/csops-worker/src/index.js`

**Interfaces:**
- Consumes: csops `sb()` helper, `err/ok` helpers, `CSOPS_WA_FORWARD_TOKEN` (already set on both workers), commsops `INGEST_TOKEN`.
- Produces: csops route `POST /webhooks/relay-web` (Bearer `CSOPS_WA_FORWARD_TOKEN`) with body `{ session_id, identity: {phone?,email?}, messages: [{direction:'inbound'|'outbound', text}], handoff: bool }` → `{ok, thread_id}`. Amended `isRelayThread`. Agent replies on `relay_web` threads POST commsops `/internal/web-reply` (Task 6 provides that route).

- [ ] **Step 1: Migration** (MCP `apply_migration`, project `jkxcnjabmrkteanzoofj`):

```sql
-- Web-bot threads (S312). POSITIVE marker per isRelayThread's own recorded rule: never
-- discriminate on the absence of a Chatwoot ref. channel='web' rows WITHOUT this flag are
-- the 1,084 dead Chatwoot threads and stay exactly as they are.
ALTER TABLE store.cs_wa_threads
  ADD COLUMN IF NOT EXISTS relay_web boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS relay_web_session_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS cs_wa_threads_relay_web_session_idx
  ON store.cs_wa_threads (relay_web_session_id) WHERE relay_web_session_id IS NOT NULL;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: csops — add the forward route.** In `src/index.js` beside `/webhooks/relay-wa` (`:659`):

```js
    // Web-bot turns forwarded from commsops (S312). Same token as relay-wa. Thread is
    // find-or-create on relay_web_session_id; every bot/customer line lands in
    // cs_wa_messages so the inbox transcript is THE transcript (spec: one transcript).
    if (url.pathname === '/webhooks/relay-web' && request.method === 'POST') {
      if (!verifyRelayWaAuth(request, env)) return err('unauthorised', 401);
      const b = await request.json().catch(() => ({}));
      if (!b.session_id || !Array.isArray(b.messages)) return err('bad_request', 400);
      return handleRelayWebForward(b, env);
    }
```

And near `relayWaFindOrCreateThread` (`~:5620`) add:

```js
async function handleRelayWebForward(b, env) {
  let thread = (await sb(`/rest/v1/cs_wa_threads?relay_web_session_id=eq.${encodeURIComponent(b.session_id)}&select=id,status&limit=1`, env)).data?.[0];
  if (!thread) {
    const ins = await sb('/rest/v1/cs_wa_threads', env, { method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({
        channel: 'web', relay_web: true, relay_web_session_id: b.session_id,
        customer_phone: b.identity?.phone ? `+91${b.identity.phone}` : null,
        customer_name: b.identity?.email || null, status: 'open',
      }) });
    thread = ins.data?.[0];
    if (!thread) return err('thread_create_failed', 500);
  }
  const rows = b.messages.map((m) => ({
    thread_id: thread.id, direction: m.direction, kind: 'text', body: m.text,
    is_internal: false, sent_by_user_id: null,
    sent_by_name: m.direction === 'outbound' ? 'Relay (bot)' : null,
  }));
  if (rows.length) await sb('/rest/v1/cs_wa_messages', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
  return ok({ thread_id: thread.id });
}
```

⚠️ Before writing this, read the actual `cs_wa_threads`/`cs_wa_messages` insert sites in `relayWaFindOrCreateThread` and mirror the exact column set used there (e.g. `last_message_at` stamping) — the snippet above is the minimum contract, the file is the authority on required columns.

- [ ] **Step 3: csops — amend `isRelayThread` (`:5561`)** so web-bot threads route to Relay, dead-Chatwoot web threads stay untouched:

```js
function isRelayThread(thread, env) {
  if (thread?.relay_web) return true;   // web-bot thread (S312): replies go to commsops, NEVER Chatwoot
  if ((thread?.channel || 'whatsapp') !== 'whatsapp') return false;   // legacy web stays on (dead) Chatwoot
  return waTransport(env) === 'relay' || !!(thread?.waba_phone_number_id && !thread?.provider_thread_ref);
}
```

Then find the agent-reply send site that `isRelayThread` gates (grep `isRelayThread(` call sites; the reply branch posts to commsops `/send`). Add a `relay_web` branch ABOVE the WhatsApp send:

```js
      if (thread.relay_web) {
        // Web-bot thread: no WhatsApp send. Hand the reply to commsops for the widget poll;
        // commsops also flips the session handed_off (agent supremacy) if the bot still held it.
        const resp = await callWorker(env.COMMSOPS, env, '/internal/web-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_TOKEN}` },
          body: JSON.stringify({ session_id: thread.relay_web_session_id, text, agent_name: agentName || 'LOT Support' }),
        });
        const d = await resp.json().catch(() => ({}));
        if (!resp.ok || d.ok === false) return err(`web_reply_failed:${d.error || resp.status}`, 502);
        // fall through to the existing cs_wa_messages outbound insert so the transcript records it
      }
```

⚠️ The reply handler's local variable names (`text`, `agentName`) must be read from the actual function — adjust to what is in scope there. Ensure the thread select feeding that handler includes `relay_web, relay_web_session_id` (grep the `select=` list it uses and extend it).

- [ ] **Step 4: Verify csops tests/existing behaviour** — `cd csops-worker && cp src/index.js /tmp/cs.mjs && node --check /tmp/cs.mjs && rm /tmp/cs.mjs`. Grep proof that no existing branch changed: `git diff` shows only additions + the one `isRelayThread` guard line prepended.

- [ ] **Step 5: Commit (csops only — do NOT deploy yet; commsops routes land in Task 6, deploy both together there)**

```bash
git add csops-worker/src/index.js && git commit -m "S312 [pitstop]: relay_web thread marker + web forward route + agent replies to commsops, never Chatwoot"
```

---

### Task 6: Public web ingress + `/internal/web-reply` (commsops) + deploy both workers

**Files:**
- Create: `05_Throttle/commsops-worker/src/bot-web.js`
- Modify: `05_Throttle/commsops-worker/src/index.js` (public routes, above the JWT gate, beside `/r/`)

**Interfaces:**
- Consumes: Tasks 1–3 modules; `env.CSOPS` service binding + `CSOPS_WA_FORWARD_TOKEN` (mirror `wa-webhooks.js:59-71`).
- Produces public routes: `POST /web/session {botId}` → `{session_id, replies}` (runs `kind:'open'`); `POST /web/message {session_id, text?, buttonId?}` → `{replies, status}`; `GET /web/poll?session_id=&after=` → `{messages:[{id,text,agent_name}], status}`; `POST /internal/web-reply` (Bearer INGEST_TOKEN) → `{ok}`. CORS: `Access-Control-Allow-Origin` echoed only for `https://www.legendoftoys.com` / `https://legendoftoys.com`; OPTIONS preflight handled.

- [ ] **Step 1: Implement `src/bot-web.js`**

```js
// Public web-bot surface (S312) — the first unauthenticated write surface in this fleet,
// so it is deliberately tiny: three routes, hard caps, no free-form writes anywhere.
const A = require('./auth.js');
const E = require('./bot-engine.js');
const OS = require('./bot-order-status.js');

const ALLOWED_ORIGINS = new Set(['https://www.legendoftoys.com', 'https://legendoftoys.com']);
const MAX_TEXT = 500;              // message length cap
const MAX_TURNS_PER_MIN = 20;      // per-session flood cap

function corsHeaders(origin) {
  return ALLOWED_ORIGINS.has(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
    : {};
}

async function loadSession(env, id) {
  const r = await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

async function loadDefinition(env, botId, version) {
  const r = await A.sbComms(`/rest/v1/bot_versions?bot_id=eq.${A.enc(botId)}&version=eq.${version}&select=definition&limit=1`, env);
  return (r.ok && r.data?.[0]?.definition) || null;
}

async function persist(env, session, out, stepRows) {
  await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(session.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ current_step: out.state.current_step, status: out.state.status, context: out.state.context,
      profile_id: session.profile_id || out.state.context.profile_id || null,
      last_activity_at: new Date().toISOString(), ended_at: out.state.status === 'ended' ? new Date().toISOString() : null }) });
  if (stepRows.length)
    await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(stepRows) });
}

// Forward the turn's lines to the csops thread (fire-and-forget shape but awaited: the
// inbox transcript IS the transcript). Mirrors wa-webhooks.js's CSOPS binding call.
async function forwardToCsops(env, session, inboundText, replies, handoff) {
  if (!env.CSOPS || !env.CSOPS_WA_FORWARD_TOKEN) return;
  const messages = [];
  if (inboundText) messages.push({ direction: 'inbound', text: inboundText });
  for (const r of replies) messages.push({ direction: 'outbound', text: r.text + (r.buttons ? '\n' + r.buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n') : '') });
  const init = { method: 'POST', headers: { Authorization: `Bearer ${env.CSOPS_WA_FORWARD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: session.id, identity: session.context?.identity || {}, messages, handoff: !!handoff }) };
  await env.CSOPS.fetch(new Request('https://internal/webhooks/relay-web', init)).catch((e) => console.log('web_forward_error', String(e?.message || e)));
}

// One turn: engine -> execute effects (order lookup loops back in; handoff forwards) -> persist.
async function runTurn(env, session, def, input, inboundText) {
  let out = E.advance(def, session, input);
  const stepRows = [{ session_id: session.id, step_id: out.state.current_step || 'entry', step_type: inboundText ? 'customer_message' : 'open', result: inboundText ? { text: inboundText } : null }];
  let handoff = false;
  for (let guard = 0; guard < 3; guard++) {           // an order_lookup re-enters at most once; handoff is terminal
    const fx = out.effects || [];
    out.effects = [];
    let reentered = false;
    for (const e of fx) {
      if (e.type === 'order_lookup') {
        const r = await OS.lookupOrderStatus(env, e);
        stepRows.push({ session_id: session.id, step_id: out.state.current_step, step_type: 'order_lookup', result: { ok: r.ok, reason: r.reason || null } });
        const next = E.advance(def, out.state, { kind: 'action_result', ok: r.ok, data: r.ok ? { statusText: r.statusText } : {} });
        out = { state: next.state, replies: [...out.replies, ...next.replies], effects: next.effects };
        reentered = true;
      }
      if (e.type === 'handoff') { handoff = true; stepRows.push({ session_id: session.id, step_id: out.state.current_step, step_type: 'handoff', result: null }); }
    }
    if (!reentered) break;
  }
  for (const r of out.replies) stepRows.push({ session_id: session.id, step_id: out.state.current_step || 'entry', step_type: 'bot_message', result: { text: r.text, buttons: r.buttons || null } });
  // Resolve a profile the moment identity lands — this is what makes the 24h conversion join possible.
  const ident = out.state.context.identity;
  if (ident && !session.profile_id && !out.state.context.profile_id) {
    const rp = await A.sbComms('/rest/v1/rpc/resolve_identity', env, { method: 'POST',
      body: JSON.stringify({ p: { identifiers: ident.phone ? [{ type: 'phone', value: `+91${ident.phone}` }] : [{ type: 'email', value: ident.email }], source: 'web_bot' } }) })
      .catch(() => ({ ok: false }));
    if (rp.ok && rp.data) out.state.context.profile_id = rp.data.profile_id || rp.data;
  }
  await persist(env, session, out, stepRows);
  await forwardToCsops(env, session, inboundText, out.replies, handoff);
  return out;
}

async function floodCheck(env, sessionId) {
  const since = new Date(Date.now() - 60000).toISOString();
  const r = await A.sbComms(`/rest/v1/bot_session_steps?session_id=eq.${A.enc(sessionId)}&step_type=eq.customer_message&entered_at=gte.${A.enc(since)}&select=id&limit=${MAX_TURNS_PER_MIN + 1}`, env);
  return (r.ok ? r.data.length : 0) <= MAX_TURNS_PER_MIN;
}

module.exports = { corsHeaders, loadSession, loadDefinition, runTurn, floodCheck, MAX_TEXT, ALLOWED_ORIGINS };
```

⚠️ Check the real `resolve_identity` RPC call shape first: `grep -n "resolve_identity" src/*.js` and copy an existing call's body exactly.

- [ ] **Step 2: Routes in `index.js`** — above the JWT gate, beside `/r/` (public block), add `const BW = require('./bot-web.js');` at top and:

```js
    // ── Web bot (S312) — PUBLIC by nature (storefront widget). CORS-scoped, capped, tiny.
    if (url.pathname.startsWith('/web/')) {
      const origin = request.headers.get('Origin') || '';
      const cors = BW.corsHeaders(origin);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const withCors = (resp) => { for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v); return resp; };

      if (url.pathname === '/web/session' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const bot = (await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(b.botId || '')}&status=eq.active&select=id,active_version,config&limit=1`, env)).data?.[0];
        if (!bot || !bot.active_version) return withCors(err('bot_unavailable', 503));
        const def = await BW.loadDefinition(env, bot.id, bot.active_version);
        if (!def) return withCors(err('bot_unavailable', 503));
        const ins = await A.sbComms('/rest/v1/bot_sessions', env, { method: 'POST',
          body: JSON.stringify({ bot_id: bot.id, bot_version: bot.active_version, visitor_key: crypto.randomUUID() }) });
        const session = Array.isArray(ins.data) ? ins.data[0] : ins.data;
        if (!ins.ok || !session) return withCors(err('session_failed', 500));
        const out = await BW.runTurn(env, session, def, { kind: 'open' }, null);
        return withCors(ok({ session_id: session.id, replies: out.replies, status: out.state.status }));
      }

      if (url.pathname === '/web/message' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const text = String(b.text || '').slice(0, BW.MAX_TEXT);
        const session = await BW.loadSession(env, b.session_id || '');
        if (!session) return withCors(err('no_session', 404));
        if (!(await BW.floodCheck(env, session.id))) return withCors(err('too_many_messages', 429));
        const def = await BW.loadDefinition(env, session.bot_id, session.bot_version);
        if (!def) return withCors(err('bot_unavailable', 503));
        const input = b.buttonId ? { kind: 'button', buttonId: b.buttonId, text } : { kind: 'text', text };
        const out = await BW.runTurn(env, session, def, input, text);
        return withCors(ok({ replies: out.replies, status: out.state.status }));
      }

      if (url.pathname === '/web/poll' && request.method === 'GET') {
        const sid = url.searchParams.get('session_id') || '';
        const after = Number(url.searchParams.get('after') || 0);
        const r = await A.sbComms(`/rest/v1/bot_session_steps?session_id=eq.${A.enc(sid)}&step_type=eq.agent_reply&id=gt.${after}&select=id,result&order=id.asc&limit=50`, env);
        const session = await BW.loadSession(env, sid);
        return withCors(ok({ messages: (r.ok ? r.data : []).map((x) => ({ id: x.id, text: x.result?.text, agent_name: x.result?.agent_name })), status: session?.status || 'ended' }));
      }
      return withCors(err('not_found', 404));
    }

    // Agent reply from Pitstop -> widget (S312). INGEST_TOKEN like its /internal siblings.
    if (url.pathname === '/internal/web-reply' && request.method === 'POST') {
      const hdr = request.headers.get('Authorization') || '';
      const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
      if (!env.INGEST_TOKEN || tok !== env.INGEST_TOKEN) return err('unauthorised', 401);
      const b = await request.json().catch(() => ({}));
      const session = await BW.loadSession(env, b.session_id || '');
      if (!session) return err('no_session', 404);
      // Agent supremacy: the first agent word flips the session; the bot never speaks again.
      if (session.status === 'active')
        await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(session.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'handed_off' }) });
      const w = await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ session_id: session.id, step_id: 'agent', step_type: 'agent_reply', result: { text: String(b.text || ''), agent_name: b.agent_name || 'LOT Support' } }) });
      return w.ok ? ok({}) : err('write_failed', 500);
    }
```

- [ ] **Step 3: Syntax + full test sweep** — `cp src/index.js /tmp/ci.mjs && node --check /tmp/ci.mjs && rm /tmp/ci.mjs; for f in test/*.test.js; do node "$f" > /dev/null || echo "FAIL $f"; done`.

- [ ] **Step 4: Commit, push, deploy BOTH workers** (push must succeed first — PATTERN-220):

```bash
git add commsops-worker/src/bot-web.js commsops-worker/src/index.js && git commit -m "S312 [relay]: public web-bot ingress (CORS-scoped, capped) + agent web-reply seam" && git push
cd commsops-worker && npx wrangler deploy && cd ../csops-worker && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Live smoke (no bot exists yet — negative paths only)**

```bash
curl -s -X POST https://commsops.afshaan.workers.dev/web/session -H 'Content-Type: application/json' -d '{"botId":"00000000-0000-0000-0000-000000000000"}'
```
Expected: `{"ok":false,"error":"bot_unavailable"}` 503. And `/internal/web-reply` with no token → 401.

---

### Task 7: Canvas — Journey|Bot mode toggle + bot palette

**Files:**
- Modify: `05_Throttle/apps/relay/src/app/(auth)/journeys/page.js` (mode state, save/publish wiring)
- Modify: `05_Throttle/apps/relay/src/components/journey-canvas/graph.js` (bot HANDLES), `labels.js` (bot labels), `NodeDrawer.js` (bot step config forms), `JourneyCanvas.js` (palette prop)

**Interfaces:**
- Consumes: worker actions from Task 4 (`listBots`/`getBot`/`saveBot`/`publishBot`/`pauseBot`/`testBotTurn`) via the existing `workerFetch`/`garageFetch` helpers the page already uses for journey actions.
- Produces: `/journeys?mode=bot` renders the bot list; opening a bot renders the same canvas with the bot palette. Definition round-trips through the SAME `{entry, steps:{id:{type,...,outcomes}}}` shape Task 2 consumes.

- [ ] **Step 1: Read before writing.** `journeys/page.js` (981 lines) owns node palette + save; `graph.js` exports `HANDLES`-style metadata the canvas uses. Identify: (a) where the node-type list the "+ Add step" UI offers is defined, (b) how `definition` is serialized on save, (c) how publish calls the worker. Mirror all three for bot mode — do not fork the canvas components.

- [ ] **Step 2: Add bot handle metadata to `graph.js`:**

```js
// Bot-mode steps (S312). Same handle discipline as journeys: canvas edges are DATA-driven
// from these, so the drawer, lint and runtime cannot drift.
export const BOT_HANDLES = {
  message: ['next'], collect: ['next'],
  menu: (step) => [...(step.buttons || []).map((b) => b.id), 'fallback'],
  action: ['found', 'not_found'], handoff: [], end: [],
};
```

- [ ] **Step 3: Mode toggle in `page.js`.** Top-of-page segmented control `Journey (default) | Bot` (persist in the URL as `?mode=bot` so refresh keeps it — reuse `useNewParam`-style param handling already in `src/lib/`). Mode switches: list source (`listJourneys` vs `listBots`), palette (`HANDLES` vs `BOT_HANDLES` step types), save target (`saveJourney` vs `saveBot`), publish (`publishBot` gated on `canActivate` perm like journey activate), status chips (draft/active/paused).

- [ ] **Step 4: NodeDrawer forms for bot steps.** `message`: textarea. `collect`: field select (`phone_or_email` | `order_number`) + prompt textarea. `menu`: text + button list editor (label per button; id auto-minted `b_<slug>`; add/remove re-renders handles). `action`: kind select (only `order_status`). `handoff`/`end`: text only. Follow the existing drawer form patterns (controlled inputs writing to the step object).

- [ ] **Step 5: Test panel.** Side pane (bot mode only): "Test this draft" — maintains `{state, transcript}` in React state, each send POSTs `testBotTurn {id, definition: currentDraft, state, input}` and appends replies. A `handoff` effect renders as "→ would hand off to an agent here". Zero rows written (Task 4 guarantees it).

- [ ] **Step 6: Build + verify** — `cd 05_Throttle && npx turbo run build --filter=relay` (or the repo's standard `npm run build` for the app). **Read the output for "Attempted import error"** — exit 0 is not enough (CORE.md).

- [ ] **Step 7: Commit + push** (deploy is the app's normal GH-Pages pipeline on push):

```bash
git add apps/relay/src && git commit -m "S312 [relay]: canvas Journey|Bot mode toggle, bot palette, side-effect-free Test panel" && git push
```

- [ ] **Step 8: Browser smoke (self-serve check).** In the Relay app: toggle to Bot → create "Web Assistant v1" → author exactly the Definition-shape example from this plan's header on the canvas → Test panel: run open → identity → menu → track → order number → verify the transcript matches the engine tests → Publish (expect lint to block if fallback unwired — wire it, publish clean).

---

### Task 8: Widget (staff-gated) + theme embed + end-to-end smoke

**Files:**
- Create: `05_Throttle/commsops-worker/src/bot-widget.js` (serves the widget JS)
- Modify: `05_Throttle/commsops-worker/src/index.js` (route `GET /web/widget.js`)

**Interfaces:**
- Consumes: `/web/session`, `/web/message`, `/web/poll` (Task 6).
- Produces: `GET /web/widget.js?bot=<botId>` → self-contained JS. **Staff gate:** the script renders NOTHING unless `location.search` contains `lotchat=1` or `localStorage.lot_chat_staff === '1'` (set once by visiting any page with `?lotchat=1`). Going public later = deleting that one guard.

- [ ] **Step 1: Implement `src/bot-widget.js`** — exports `widgetJs(botId, workerBase)` returning a JS string: floating button → panel (vanilla DOM, inline styles, LOT yellow `#f5c518` accent); on open, POST `/web/session`; renders `replies` (text + buttons as tappable chips posting `buttonId`); input box posts `/web/message`; when `status === 'handed_off'`, starts 5s `/web/poll` loop with `after=<last id>` and renders agent messages with the agent name; `status === 'ended'` stops polling and disables input with a "Say hi to start again" restart link (new session). Gate check is the FIRST statement:

```js
if (!/[?&]lotchat=1/.test(location.search) && localStorage.getItem('lot_chat_staff') !== '1') { /* no-op */ }
else { if (/[?&]lotchat=1/.test(location.search)) try { localStorage.setItem('lot_chat_staff', '1'); } catch {} /* ...render... */ }
```

Route: `GET /web/widget.js` returns `new Response(widgetJs(url.searchParams.get('bot'), 'https://commsops.afshaan.workers.dev'), { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300' } })` — public block, no auth (it is a script tag).

- [ ] **Step 2: Commit, push, deploy commsops.**

```bash
git add commsops-worker/src/bot-widget.js commsops-worker/src/index.js && git commit -m "S312 [relay]: staff-gated web widget served from commsops" && git push && cd commsops-worker && npx wrangler deploy && cd ..
```

- [ ] **Step 3: Theme embed (manual, in-app browser).** Shopify admin → Online Store → Themes → Edit code → `layout/theme.liquid` → before `</body>`:

```html
<script src="https://commsops.afshaan.workers.dev/web/widget.js?bot=<BOT_ID>" defer></script>
```

(`<BOT_ID>` = the published bot from Task 7. The gate means this is invisible to customers.)

- [ ] **Step 4: End-to-end smoke (browser, `?lotchat=1`).** On `https://www.legendoftoys.com/?lotchat=1`: open widget → greeting arrives → give a REAL order's phone → menu → Track my order → real order number → status text matches that order's `ecom_shipments.lifecycle` → separately run the not-my-order case (valid order number + wrong phone) → generic not-found copy (must NOT reveal the order exists) → "Chat with an agent" → in Pitstop inbox find the web thread → reply as agent → reply appears in the widget within one poll; confirm the bot says nothing further in that session. Verify in SQL: `SELECT status, current_step FROM comms.bot_sessions ORDER BY started_at DESC LIMIT 1;` → `handed_off`.

- [ ] **Step 5: Confirm no customer exposure** — load the storefront WITHOUT `?lotchat=1` in a fresh private window: no widget element in the DOM.

---

### Task 9: Analytics RPC + stats strip

**Files:**
- Create migration via MCP `apply_migration` (name `comms_bot_stats_v1`)
- Modify: `05_Throttle/apps/relay/src/app/(auth)/journeys/page.js` (bot list rows show the stats), `05_Throttle/commsops-worker/src/index.js` (GET `botStats` action)

**Interfaces:**
- Produces: RPC `comms.bot_stats(p_bot_id uuid, p_from date, p_to date)` returning one row: `sessions int, handled int, handoffs int, dropoffs int, conversions int`; worker GET action `botStats&id=&from=&to=` (canView) → `{stats}`.

- [ ] **Step 1: Migration**

```sql
-- Bot analytics (S312). Derived ONLY from bot_sessions + bot_session_steps + comms.events —
-- no counter columns to drift. Conversion (Afshaan 2026-08-26): the session's profile
-- placed an order within 24h of session start.
CREATE OR REPLACE FUNCTION comms.bot_stats(p_bot_id uuid, p_from date, p_to date)
RETURNS TABLE (sessions int, handled int, handoffs int, dropoffs int, conversions int)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT id, profile_id, status, started_at FROM comms.bot_sessions
    WHERE bot_id = p_bot_id
      AND started_at >= p_from::timestamptz
      AND started_at <  (p_to + 1)::timestamptz
  )
  SELECT
    count(*)::int,
    count(*) FILTER (WHERE status = 'ended')::int,
    count(*) FILTER (WHERE status = 'handed_off')::int,
    count(*) FILTER (WHERE status = 'active' AND started_at < now() - interval '30 minutes')::int,
    (SELECT count(DISTINCT s2.id) FROM s s2 JOIN comms.events e
       ON e.profile_id = s2.profile_id
      AND e.name = 'order_placed'
      AND e.occurred_at BETWEEN s2.started_at AND s2.started_at + interval '24 hours'
     WHERE s2.profile_id IS NOT NULL)::int
  FROM s;
$$;
GRANT EXECUTE ON FUNCTION comms.bot_stats(uuid, date, date) TO service_role;
NOTIFY pgrst, 'reload schema';
```

⚠️ Before applying, verify the events columns: `SELECT column_name FROM information_schema.columns WHERE table_schema='comms' AND table_name='events' AND column_name IN ('profile_id','name','occurred_at');` — adjust names to what is live (db-schema.md may lag).

- [ ] **Step 2: Worker action** (GET switch, canView): call the RPC via `A.sbComms('/rest/v1/rpc/bot_stats', env, { method: 'POST', body: JSON.stringify({ p_bot_id: id, p_from: from, p_to: to }) })`, return `{ stats: r.data?.[0] }`.

- [ ] **Step 3: Bot list rows** get `sessions · handled · handoffs · conversions` for the last 7 days (default range), fetched per-listed-bot in ONE Promise.all (few bots; no N+1 concern at this scale).

- [ ] **Step 4: Build, commit, push, deploy commsops; verify** the strip shows the smoke session from Task 8 (sessions ≥ 1, handoffs ≥ 1).

```bash
git add commsops-worker/migrations apps/relay/src commsops-worker/src/index.js && git commit -m "S312 [relay]: bot_stats RPC (24h conversion definition) + list stats strip" && git push && cd commsops-worker && npx wrangler deploy && cd ..
```

---

### Task 10: Knowledge layer + wrap

**Files:**
- Modify: `BACKLOG.md` (root repo), `systems/relay.md`, `systems/pitstop.md`, `reference/decisions.md`, `reference/db-schema.md`

- [ ] **Step 1: `reference/decisions.md`** — amend the 2026-08-26 "web bot parked" scope call: superseded same day in the Relay lane; the web bot (staff-gated) is the builder's first consumer, public un-gating remains Afshaan's flip.
- [ ] **Step 2: `systems/relay.md`** — new section "Bot builder (S312+)": tables, engine, palette, the three guards, the effect pattern, the staff gate, `bot_stats` + the conversion definition, pointer to spec + this plan.
- [ ] **Step 3: `systems/pitstop.md`** — the `relay_web` thread marker, the amended `isRelayThread`, the agent-reply → `/internal/web-reply` path; note legacy `channel='web'` threads are untouched.
- [ ] **Step 4: `BACKLOG.md`** — update the `[pitstop]/[relay]` bot-builder item to shipped-with-residuals; list residuals honestly (e.g. WhatsApp/IG entry points, cancel/reorder actions, public un-gating). Update the parked web-bot item to point here.
- [ ] **Step 5: `/schema-sync`** (or note the 6 new objects in `reference/db-schema.md` manually).
- [ ] **Step 6: Commit + push root repo; verify all repos clean** (`git status --porcelain` ×2 repos).
- [ ] **Step 7: Run `/hostile-review`** over the session's diff before wrap (session shipped code + DB DDL — the skill's own trigger condition).

---

## Self-review notes (done at write time)

- **Spec coverage:** tables→T1; palette/fallback/collect/order-status/handoff→T2/T3; turn engine + ingress + caps→T6; CRUD/versions→T4; `channel='web'` trap + agent replies→T5; toggle/canvas/Test panel→T7; widget + staff gate + theme embed→T8; analytics + 24h conversion→T9; knowledge layer→T10. Out-of-scope list respected (no WA entry points, no LLM, no auto-tickets — forward route never creates tickets).
- **Type consistency:** `advance` signature identical in T2 (definition+tests), T4 (`testBotTurn`), T6 (`runTurn`); `{entry, steps}` shape identical in header, T2, T7; forward body `{session_id, identity, messages, handoff}` identical in T5/T6; `agent_reply` step rows written in T6 are what T6's `/web/poll` reads.
- **Known live-code caveats are marked ⚠️ in place** (mirror real insert columns in T5; real `resolve_identity` body shape in T6; live `comms.events` column names in T9) — each is a read-before-write instruction, not a placeholder.
