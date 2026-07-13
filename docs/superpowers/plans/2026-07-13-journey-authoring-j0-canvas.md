# J0 — Journey Authoring: Schema Generalization + Canvas MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the journey definition schema to named outcome handles (+ layout), fix per-channel identifier resolution in the journey send path, and replace the single-shape `/journeys` form with a React Flow canvas that authors everything the engine already runs (trigger · send[email/WA] · wait · condition · exit).

**Architecture:** The canvas is a *view* over the existing `journey_versions.definition` JSON — the M7 `JourneyWorkflow` interpreter and `compile()` gain a compat shim that reads targets from `outcomes:{handle:stepId}` *or* the legacy `next/if_true/if_false` fields (in-flight enrolments finish on pinned old-shape versions). A shared pure module (`journey-graph.js`) holds the target-resolution logic so worker + validator can't drift. The app gets a pure graph↔definition mapping module (testable in plain node) and a client-only React Flow canvas. No DDL — all schema change is additive inside the definition jsonb.

**Tech Stack:** Cloudflare Worker (commsops, CJS modules, plain-node tests), Supabase/PostgREST (`comms` schema), Next.js 14 static export (`apps/relay`, npm workspaces), `@xyflow/react` v12 (React Flow), existing `@/components/ui.js` primitives.

**Spec:** `docs/superpowers/specs/2026-07-13-journey-authoring-ui-design.md` (§3 node model, §4.2 identifier fix, §4.8 compile rules, §5 J0 scope).

**Ground rules for the executor:**
- Repo: `/Users/afshaansiddiqui/Documents/Claude/05_Throttle` (npm workspaces + turbo). Pull before starting.
- Worker deploy sequence (mandatory order): edit → commit → push → `cd commsops-worker && npx wrangler deploy`.
- The relay app auto-deploys on push to `main` (GitHub Actions) — never deploy it manually.
- TEST MODE is ON and must stay ON. Nothing in J0 sends to anyone new.
- PostgREST numerics come back as strings; not relevant here but don't "fix" it if seen.
- File paths below are relative to `05_Throttle/` unless absolute.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `commsops-worker/src/journey-graph.js` | **Create** | Pure target-resolution: `resolveTarget`, `stepTargets`, `ID_TYPE_FOR_CHANNEL` |
| `commsops-worker/test/journey-graph.test.js` | **Create** | Unit tests for the above |
| `commsops-worker/src/journeys.js` | **Modify** (~lines 21–50) | `compile()` reads both shapes via journey-graph |
| `commsops-worker/src/journey-workflow.js` | **Modify** (~lines 51–96) | Interpreter compat shim + per-channel identifier resolution |
| `apps/relay/package.json` | **Modify** | + `@xyflow/react` |
| `apps/relay/src/components/journey-canvas/graph.js` | **Create** | Pure `fromDefinition` / `toDefinition` / `localLint` (CJS, node-testable) |
| `apps/relay/src/components/journey-canvas/graph.test.js` | **Create** | Plain-node tests |
| `apps/relay/src/components/journey-canvas/JourneyCanvas.js` | **Create** | React Flow canvas + custom nodes + palette ('use client') |
| `apps/relay/src/components/journey-canvas/NodeDrawer.js` | **Create** | Per-type node config drawer |
| `apps/relay/src/app/(auth)/journeys/page.js` | **Rewrite** | List view (kept) + canvas editor (replaces linear form + rawOnly) |
| (DB, no file) | **Backfill** | New-shape version of the draft "Abandoned Cart" journey |

---

### Task 1: Worker pure module — `journey-graph.js` (TDD)

**Files:**
- Create: `commsops-worker/src/journey-graph.js`
- Create: `commsops-worker/test/journey-graph.test.js`

- [ ] **Step 1: Write the failing test**

`commsops-worker/test/journey-graph.test.js`:
```js
// Unit tests for the shared step-graph helpers. Run: node test/journey-graph.test.js
const assert = require('assert');
const G = require('../src/journey-graph.js');

// resolveTarget — legacy shape
assert.equal(G.resolveTarget({ type: 'send', next: 'b' }, 'next'), 'b');
assert.equal(G.resolveTarget({ type: 'condition', if_true: 't', if_false: 'f' }, 'if_true'), 't');
assert.equal(G.resolveTarget({ type: 'condition', if_true: 't', if_false: 'f' }, 'if_false'), 'f');
assert.equal(G.resolveTarget({ type: 'exit' }, 'next'), null);

// resolveTarget — new shape wins over legacy when both exist
assert.equal(G.resolveTarget({ next: 'old', outcomes: { next: 'new' } }, 'next'), 'new');
// new shape, arbitrary handle names
assert.equal(G.resolveTarget({ outcomes: { make_payment: 'p1', no_reply: 'x1' } }, 'make_payment'), 'p1');
// declared-but-unwired handle (empty value) → null
assert.equal(G.resolveTarget({ outcomes: { next: '' } }, 'next'), null);
// unknown handle on either shape → null
assert.equal(G.resolveTarget({ outcomes: { next: 'b' } }, 'if_true'), null);
assert.equal(G.resolveTarget(null, 'next'), null);

// stepTargets — both shapes, blanks filtered
assert.deepEqual(G.stepTargets({ next: 'b' }), ['b']);
assert.deepEqual(G.stepTargets({ if_true: 't', if_false: 'f' }).sort(), ['f', 't']);
assert.deepEqual(G.stepTargets({ outcomes: { a: 'x', b: 'y', c: '' } }).sort(), ['x', 'y']);
assert.deepEqual(G.stepTargets({}), []);

// identifier type per channel
assert.equal(G.ID_TYPE_FOR_CHANNEL.email, 'email');
assert.equal(G.ID_TYPE_FOR_CHANNEL.whatsapp, 'phone');
assert.equal(G.ID_TYPE_FOR_CHANNEL.sms, 'phone');

console.log('journey-graph.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd commsops-worker && node test/journey-graph.test.js`
Expected: FAIL — `Cannot find module '../src/journey-graph.js'`

- [ ] **Step 3: Write the implementation**

`commsops-worker/src/journey-graph.js`:
```js
// Pure step-graph helpers shared by compile() (journeys.js) and the Workflow
// interpreter (journey-workflow.js) so validator and runtime can't drift.
//
// J0 schema generalization: a step's targets live EITHER in the legacy fields
// (next / if_true / if_false) OR in the generalized `outcomes: {<handle>: <stepId>}`
// map. `outcomes` wins when both exist. Interpreter must keep reading BOTH shapes
// forever — in-flight enrolments are pinned to old-shape immutable versions.

const LEGACY_HANDLES = ['next', 'if_true', 'if_false'];

// The step's target for a named outcome handle, or null.
function resolveTarget(step, handle) {
  if (!step) return null;
  if (step.outcomes && Object.prototype.hasOwnProperty.call(step.outcomes, handle))
    return step.outcomes[handle] || null;
  if (LEGACY_HANDLES.includes(handle)) return step[handle] || null;
  return null;
}

// Every non-empty target the step declares (for reachability / dangling checks).
function stepTargets(step) {
  if (!step) return [];
  if (step.outcomes) return Object.values(step.outcomes).filter(Boolean);
  return LEGACY_HANDLES.map((h) => step[h]).filter(Boolean);
}

// Which identifier type a journey send must resolve for a channel (spec §4.2 —
// #doSend previously hardcoded email; WA/SMS/voice sends need the phone identifier).
const ID_TYPE_FOR_CHANNEL = { email: 'email', whatsapp: 'phone', sms: 'phone', voice: 'phone' };

module.exports = { resolveTarget, stepTargets, ID_TYPE_FOR_CHANNEL };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd commsops-worker && node test/journey-graph.test.js`
Expected: `journey-graph.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/journey-graph.js commsops-worker/test/journey-graph.test.js
git commit -m "feat(relay): journey-graph pure helpers — outcomes/legacy target resolution (J0)"
```

---

### Task 2: `compile()` reads both shapes

**Files:**
- Modify: `commsops-worker/src/journeys.js` (top + `compile()` lines ~21–50)
- Create: `commsops-worker/test/journeys-compile.test.js`

- [ ] **Step 1: Write the failing test**

`commsops-worker/test/journeys-compile.test.js` — `compile(env, def)` only touches the DB when a send step has `templateId`, so definitions below omit it and pass `{}` as env:
```js
// compile() must accept BOTH the legacy shape and the new outcomes shape.
// Run: node test/journeys-compile.test.js
const assert = require('assert');
const { compile } = require('../src/journeys.js');

(async () => {
  // legacy shape still valid (regression)
  const legacy = { entry: 'w', steps: {
    w: { type: 'wait', duration: '1 hours', next: 'c' },
    c: { type: 'condition', check: { kind: 'event_since_enrol', event: 'x' }, if_true: 'e', if_false: 'e' },
    e: { type: 'exit', outcome: 'completed' } } };
  assert.deepEqual((await compile({}, legacy)).errors, []);

  // new outcomes shape valid
  const fresh = { entry: 'w', steps: {
    w: { type: 'wait', duration: '1 hours', outcomes: { next: 'c' } },
    c: { type: 'condition', check: { kind: 'event_since_enrol', event: 'x' },
         outcomes: { if_true: 's', if_false: 'e' } },
    s: { type: 'send', channel: 'email', outcomes: { next: 'e' } },
    e: { type: 'exit', outcome: 'completed' } } };
  assert.deepEqual((await compile({}, fresh)).errors, []);

  // dangling outcomes target caught
  const dangling = { entry: 'w', steps: {
    w: { type: 'wait', duration: '1 hours', outcomes: { next: 'GONE' } } } };
  const r1 = await compile({}, dangling);
  assert.ok(r1.errors.includes('dangling_target:w->GONE'), JSON.stringify(r1.errors));

  // condition missing a branch handle caught (new shape)
  const noBranch = { entry: 'c', steps: {
    c: { type: 'condition', check: { kind: 'event_since_enrol', event: 'x' }, outcomes: { if_true: 'e' } },
    e: { type: 'exit' } } };
  const r2 = await compile({}, noBranch);
  assert.ok(r2.errors.some((e) => e.startsWith('condition_branch_missing')), JSON.stringify(r2.errors));

  console.log('journeys-compile.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd commsops-worker && node test/journeys-compile.test.js`
Expected: FAIL — the new-outcomes-shape definition produces `dangling_target`/`condition_branch_missing` errors (current `compile()` only reads legacy fields, so `w.next` is undefined → also `no_reachable_exit`).

- [ ] **Step 3: Modify `compile()`**

In `commsops-worker/src/journeys.js`: add the require at the top (line ~2, after `const A = require('./auth.js');`):
```js
const G = require('./journey-graph.js');
```
Then in `compile()` replace the two shape-bound lines. Replace:
```js
  const targets = (s) => [s.next, s.if_true, s.if_false].filter(Boolean);
```
with:
```js
  const targets = (s) => G.stepTargets(s);
```
and replace:
```js
    if (s.type === 'condition' && (!steps[s.if_true] || !steps[s.if_false])) errors.push(`condition_branch_missing:${id}`);
```
with:
```js
    if (s.type === 'condition' &&
        (!steps[G.resolveTarget(s, 'if_true')] || !steps[G.resolveTarget(s, 'if_false')]))
      errors.push(`condition_branch_missing:${id}`);
```
Everything else in `compile()` (entry check, reserved ids, reachability walk, template-active check) already operates on `targets()`/step ids and needs no change.

- [ ] **Step 4: Run both tests**

Run: `cd commsops-worker && node test/journeys-compile.test.js && node test/journey-graph.test.js && node test/wa.test.js`
Expected: all three print their pass lines (wa.test.js is the regression canary).

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/journeys.js commsops-worker/test/journeys-compile.test.js
git commit -m "feat(relay): compile() accepts generalized outcomes shape alongside legacy (J0)"
```

---

### Task 3: Interpreter compat shim + per-channel identifier resolution

**Files:**
- Modify: `commsops-worker/src/journey-workflow.js` (lines ~6, ~56–67, ~83–96)

No new unit test file — the pure logic was tested in Task 1; this task wires it. `wa.test.js` + a wrangler dry-run are the regression checks (the Workflow class needs the CF runtime; live behavior is exercised in Task 11's backfill verification and by the existing draft journey's future smokes).

- [ ] **Step 1: Add the require**

Top of `commsops-worker/src/journey-workflow.js`, after `const { send } = require('./send.js');`:
```js
const G = require('./journey-graph.js');
```

- [ ] **Step 2: Shim the three transition reads in `run()`**

Replace (wait branch, line ~59): `cur = s.next;` → `cur = G.resolveTarget(s, 'next');`
Replace (condition branch, line ~63): `cur = branch ? s.if_true : s.if_false;` → `cur = G.resolveTarget(s, branch ? 'if_true' : 'if_false');`
Replace (send branch, line ~67): `cur = s.next;` → `cur = G.resolveTarget(s, 'next');`

- [ ] **Step 3: Per-channel identifier resolution in `#doSend`**

Replace the block (lines ~84–89):
```js
    const channel = s.channel || 'email';
    const idr = await A.sbComms(
      `/rest/v1/identifiers?profile_id=eq.${A.enc(profileId)}&type=eq.email&select=value&order=last_seen.desc&limit=1`, env);
    if (!idr.ok) throw new Error('identifier_lookup_failed:' + JSON.stringify(idr.data));
    const to = idr.data?.[0]?.value;
    if (!to) return { status: 'skipped', reason: 'no_email_identifier' };
```
with:
```js
    const channel = s.channel || 'email';
    // spec §4.2: resolve the identifier TYPE the channel needs (email→email, WA/SMS/voice→phone).
    // Previously hardcoded email — a WA journey send could never resolve a recipient.
    const idType = G.ID_TYPE_FOR_CHANNEL[channel] || 'email';
    const idr = await A.sbComms(
      `/rest/v1/identifiers?profile_id=eq.${A.enc(profileId)}&type=eq.${A.enc(idType)}&select=value&order=last_seen.desc&limit=1`, env);
    if (!idr.ok) throw new Error('identifier_lookup_failed:' + JSON.stringify(idr.data));
    const to = idr.data?.[0]?.value;
    if (!to) return { status: 'skipped', reason: `no_${idType}_identifier` };
```
Also update the now-stale comment above `#doSend` (lines ~80–82): change “we resolve the profile's primary email identifier” to “we resolve the profile's primary identifier for the step's channel (journey-graph ID_TYPE_FOR_CHANNEL)”.

- [ ] **Step 4: Verify bundle + regressions**

Run: `cd commsops-worker && node test/wa.test.js && node test/journey-graph.test.js && node test/journeys-compile.test.js && npx wrangler deploy --dry-run --outdir /tmp/j0-dryrun`
Expected: all tests pass; dry-run prints `Total Upload: … KiB` with no build errors.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/journey-workflow.js
git commit -m "feat(relay): interpreter reads outcomes shape + per-channel identifier resolution (J0)"
```

---

### Task 4: Deploy commsops + inert smoke

- [ ] **Step 1: Push then deploy (mandatory order)**

```bash
git push
cd commsops-worker && npx wrangler deploy
```
Expected: deploy succeeds, prints the new version id + `schedule: */5 * * * *` + queue consumers (unchanged bindings).

- [ ] **Step 2: Health smoke**

Run: `curl -s https://commsops.afshaan.workers.dev/ -o /dev/null -w "%{http_code}\n"`
Expected: a non-5xx (404/200 both fine — route root isn't meaningful; we're checking the worker boots). The changes are additive shims: legacy definitions resolve identically (`resolveTarget` falls through to legacy fields), and no send path changes for email (idType email → same query as before).

---

### Task 5: Add `@xyflow/react` to apps/relay

**Files:**
- Modify: `apps/relay/package.json` (+ root `package-lock.json`)

- [ ] **Step 1: Install (npm workspaces — run from `05_Throttle/`)**

```bash
npm install @xyflow/react@^12 --workspace=@throttle/relay
```
Expected: `package.json` gains `"@xyflow/react": "^12…"`, root lockfile updated.

- [ ] **Step 2: Verify the app still builds clean before any code**

Run: `npx turbo build --filter=@throttle/relay`
Expected: build completes, zero errors.

- [ ] **Step 3: Commit**

```bash
git add apps/relay/package.json package-lock.json
git commit -m "chore(relay): add @xyflow/react for the journey canvas (J0)"
```

---

### Task 6: App pure graph module (TDD)

**Files:**
- Create: `apps/relay/src/components/journey-canvas/graph.js` (CJS so plain node can test it; webpack interops fine)
- Create: `apps/relay/src/components/journey-canvas/graph.test.js`

- [ ] **Step 1: Write the failing test**

`apps/relay/src/components/journey-canvas/graph.test.js`:
```js
// Pure graph<->definition mapping tests. Run from apps/relay:
//   node src/components/journey-canvas/graph.test.js
const assert = require('assert');
const { fromDefinition, toDefinition, localLint, HANDLES, TRIGGER_ID } = require('./graph.js');

// --- fromDefinition: legacy shape normalizes to nodes/edges ---
const legacyDef = { entry: 'wait1', steps: {
  wait1: { type: 'wait', duration: '24 hours', next: 'cond1' },
  cond1: { type: 'condition', check: { kind: 'no_event_since_enrol', event: 'order_placed' },
           if_true: 'send1', if_false: 'exit1' },
  send1: { type: 'send', channel: 'email', purpose: 'marketing', templateId: 'T1', next: 'exit1' },
  exit1: { type: 'exit', outcome: 'completed' } } };
const g1 = fromDefinition({ trigger: { type: 'event', name: 'checkout_started' } }, legacyDef);
assert.equal(g1.nodes.length, 5); // 4 steps + trigger pseudo-node
assert.ok(g1.nodes.find((n) => n.id === TRIGGER_ID));
// entry edge + wait->cond + cond true/false + send->exit = 5 edges
assert.equal(g1.edges.length, 5);
const entryEdge = g1.edges.find((e) => e.source === TRIGGER_ID);
assert.equal(entryEdge.target, 'wait1');
const condTrue = g1.edges.find((e) => e.source === 'cond1' && e.sourceHandle === 'if_true');
assert.equal(condTrue.target, 'send1');
// every node got a position
assert.ok(g1.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y)));

// --- round trip: toDefinition always writes the NEW shape ---
const def2 = toDefinition(g1.nodes, g1.edges);
assert.equal(def2.entry, 'wait1');
assert.deepEqual(def2.steps.wait1.outcomes, { next: 'cond1' });
assert.deepEqual(def2.steps.cond1.outcomes, { if_true: 'send1', if_false: 'exit1' });
assert.equal(def2.steps.send1.templateId, 'T1');
assert.equal(def2.steps.wait1.next, undefined);          // legacy fields not re-emitted
assert.ok(def2.steps.wait1.layout && Number.isFinite(def2.steps.wait1.layout.x));
assert.ok(def2.trigger_layout);

// --- fromDefinition: new shape + stored layout respected ---
const g2 = fromDefinition({ trigger: {} }, def2);
assert.equal(g2.nodes.find((n) => n.id === 'wait1').position.x, def2.steps.wait1.layout.x);

// --- localLint ---
assert.deepEqual(localLint(g1.nodes, g1.edges), []); // valid graph → no findings
// unwired handle: drop the cond1 if_false edge
const cut = g1.edges.filter((e) => !(e.source === 'cond1' && e.sourceHandle === 'if_false'));
assert.ok(localLint(g1.nodes, cut).some((m) => m.includes('cond1') && m.includes('if_false')));
// no trigger edge
const noEntry = g1.edges.filter((e) => e.source !== TRIGGER_ID);
assert.ok(localLint(g1.nodes, noEntry).some((m) => m.includes('trigger')));
// no exit node
const noExit = g1.nodes.filter((n) => n.data?.config?.type !== 'exit');
assert.ok(localLint(noExit, g1.edges).some((m) => m.includes('exit')));

// HANDLES map sanity
assert.deepEqual(HANDLES.condition, ['if_true', 'if_false']);
assert.deepEqual(HANDLES.exit, []);

console.log('graph.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/relay && node src/components/journey-canvas/graph.test.js`
Expected: FAIL — `Cannot find module './graph.js'`

- [ ] **Step 3: Write the implementation**

`apps/relay/src/components/journey-canvas/graph.js`:
```js
// Pure mapping between the canvas graph (React Flow nodes/edges) and the engine
// definition ({entry, steps:{id:{type,...,outcomes,layout}}}). CJS on purpose —
// plain `node graph.test.js` runs it; webpack interops require/module.exports fine.
//
// Reads BOTH shapes (legacy next/if_true/if_false or outcomes); ALWAYS writes the
// new outcomes shape + per-step layout + trigger_layout. The interpreter ignores
// layout keys entirely.

const TRIGGER_ID = '__trigger';

// outcome handles each J0 step type declares (spec §3 palette)
const HANDLES = { send: ['next'], wait: ['next'], condition: ['if_true', 'if_false'], exit: [] };

function targetsOf(step) {
  if (step.outcomes) return Object.entries(step.outcomes).filter(([, t]) => t);
  return ['next', 'if_true', 'if_false']
    .filter((h) => step[h])
    .map((h) => [h, step[h]]);
}

// BFS depth from entry → column; discovery order within a column → row.
function autoPositions(def) {
  const pos = { [TRIGGER_ID]: { x: 40, y: 160 } };
  const colCount = {};
  const seen = new Set();
  const q = def.entry ? [[def.entry, 1]] : [];
  while (q.length) {
    const [id, col] = q.shift();
    if (seen.has(id) || !def.steps[id]) continue;
    seen.add(id);
    const row = (colCount[col] = (colCount[col] || 0) + 1);
    pos[id] = { x: 40 + col * 290, y: 40 + row * 130 };
    targetsOf(def.steps[id]).forEach(([, t]) => q.push([t, col + 1]));
  }
  // orphans (unreachable steps) — park them in a bottom row so they're visible
  let orphan = 0;
  for (const id of Object.keys(def.steps || {}))
    if (!pos[id]) pos[id] = { x: 40 + ++orphan * 290, y: 560 };
  return pos;
}

// (journey, definition|null) → { nodes, edges } for React Flow.
function fromDefinition(journey, def) {
  const d = def && def.steps ? def : { entry: null, steps: {} };
  const auto = autoPositions(d);
  const nodes = [{
    id: TRIGGER_ID, type: 'trigger',
    position: d.trigger_layout || auto[TRIGGER_ID],
    data: { trigger: (journey && journey.trigger) || {} },
  }];
  const edges = [];
  if (d.entry && d.steps[d.entry]) {
    edges.push({ id: `e:${TRIGGER_ID}->${d.entry}`, source: TRIGGER_ID, sourceHandle: 'entry', target: d.entry });
  }
  for (const [id, s] of Object.entries(d.steps)) {
    const { outcomes, layout, next, if_true, if_false, ...config } = s;
    nodes.push({ id, type: 'step', position: layout || auto[id], data: { config } });
    for (const [handle, target] of targetsOf(s)) {
      edges.push({ id: `e:${id}:${handle}`, source: id, sourceHandle: handle, target });
    }
  }
  return { nodes, edges };
}

// (nodes, edges) → definition in the NEW shape. Throws on structural impossibilities
// the lint should have caught (no entry edge) so callers can't save garbage.
function toDefinition(nodes, edges) {
  const entryEdge = edges.find((e) => e.source === TRIGGER_ID);
  if (!entryEdge) throw new Error('no_entry_edge');
  const steps = {};
  let trigger_layout = null;
  for (const n of nodes) {
    if (n.id === TRIGGER_ID) { trigger_layout = { x: Math.round(n.position.x), y: Math.round(n.position.y) }; continue; }
    const outcomes = {};
    for (const e of edges) if (e.source === n.id && e.sourceHandle) outcomes[e.sourceHandle] = e.target;
    steps[n.id] = {
      ...n.data.config,
      ...(Object.keys(outcomes).length ? { outcomes } : {}),
      layout: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    };
  }
  return { entry: entryEdge.target, steps, ...(trigger_layout ? { trigger_layout } : {}) };
}

// Cheap client-side lint (spec §3 canvas UX) — compile() on the worker stays the
// authority; this catches the obvious while the author drags things around.
function localLint(nodes, edges) {
  const out = [];
  if (!edges.some((e) => e.source === TRIGGER_ID)) out.push('trigger is not connected to an entry step');
  const stepNodes = nodes.filter((n) => n.id !== TRIGGER_ID);
  if (!stepNodes.some((n) => n.data?.config?.type === 'exit')) out.push('no exit node — every journey needs at least one');
  for (const n of stepNodes) {
    const declared = HANDLES[n.data?.config?.type] || [];
    for (const h of declared)
      if (!edges.some((e) => e.source === n.id && e.sourceHandle === h))
        out.push(`${n.id}: outcome "${h}" is not wired`);
  }
  return out;
}

module.exports = { fromDefinition, toDefinition, localLint, HANDLES, TRIGGER_ID };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/relay && node src/components/journey-canvas/graph.test.js`
Expected: `graph.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/components/journey-canvas/graph.js apps/relay/src/components/journey-canvas/graph.test.js
git commit -m "feat(relay): journey canvas graph<->definition mapping + local lint (J0)"
```

---

### Task 7: Canvas component + custom nodes

**Files:**
- Create: `apps/relay/src/components/journey-canvas/JourneyCanvas.js`

- [ ] **Step 1: Write the component**

`apps/relay/src/components/journey-canvas/JourneyCanvas.js`:
```jsx
'use client';
// The React Flow canvas. Controlled: the PAGE owns nodes/edges state; this renders
// them + palette + lint strip and reports changes up. Client-only (page imports it
// via next/dynamic ssr:false — React Flow touches window).
import { useCallback } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position,
  applyNodeChanges, applyEdgeChanges, addEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Zap, Mail, MessageCircle, Clock, GitBranch, LogOut, Plus } from 'lucide-react';
import { HANDLES, TRIGGER_ID, localLint } from './graph.js';

const STEP_META = {
  send:      { label: 'Send',      icon: null,      color: 'var(--accent, #F2CD1A)' },
  wait:      { label: 'Wait',      icon: Clock,     color: '#9aa0a6' },
  condition: { label: 'Condition', icon: GitBranch, color: '#e8b93c' },
  exit:      { label: 'Exit',      icon: LogOut,    color: '#57b56b' },
};

const nodeBox = (selected, color) => ({
  background: 'var(--surface, #fff)', border: `1.5px solid ${selected ? color : 'var(--bd, #d8d8d8)'}`,
  borderRadius: 10, padding: '10px 12px', minWidth: 190, fontSize: 13,
  boxShadow: selected ? `0 0 0 2px ${color}33` : '0 1px 3px rgba(0,0,0,.08)',
});

function TriggerNode({ data, selected }) {
  const t = data.trigger || {};
  return (
    <div style={nodeBox(selected, '#DE2A2A')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#DE2A2A' }}>
        <Zap size={13} /> Trigger
      </div>
      <div className="mono" style={{ marginTop: 4, color: 'var(--text-2, #555)' }}>
        {t.type === 'event' ? `event: ${t.name || '?'}` : (t.type || 'not set')}
      </div>
      <Handle type="source" position={Position.Right} id="entry" />
    </div>
  );
}

function StepNode({ data, selected }) {
  const c = data.config || {};
  const meta = STEP_META[c.type] || STEP_META.wait;
  const Icon = c.type === 'send' ? (c.channel === 'whatsapp' ? MessageCircle : Mail) : meta.icon;
  const handles = HANDLES[c.type] || [];
  const sub = c.type === 'send' ? `${c.channel || 'email'} · ${c.purpose || 'marketing'}`
    : c.type === 'wait' ? (c.duration || 'duration not set')
    : c.type === 'condition' ? (c.check?.kind ? `${c.check.kind}${c.check.event ? `: ${c.check.event}` : ''}` : 'check not set')
    : (c.outcome || 'completed');
  return (
    <div style={nodeBox(selected, meta.color)}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        {Icon && <Icon size={13} style={{ color: meta.color }} />} {meta.label}
      </div>
      <div className="mono" style={{ marginTop: 4, color: 'var(--text-2, #555)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
      {handles.map((h, i) => (
        <div key={h}>
          <Handle type="source" position={Position.Right} id={h} style={{ top: 24 + i * 20 }} />
          {handles.length > 1 && (
            <span style={{ position: 'absolute', right: 10, top: 16 + i * 20, fontSize: 10, color: 'var(--text-3, #888)' }}>{h}</span>
          )}
        </div>
      ))}
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, step: StepNode };

const NEW_STEP = {
  send:      { type: 'send', channel: 'email', purpose: 'marketing', templateId: '' },
  wait:      { type: 'wait', duration: '24 hours' },
  condition: { type: 'condition', check: { kind: 'no_event_since_enrol', event: 'order_placed' } },
  exit:      { type: 'exit', outcome: 'completed' },
};

let seq = 0;
const newId = (t) => `${t}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export default function JourneyCanvas({ nodes, edges, setNodes, setEdges, onSelect, readOnly }) {
  const onNodesChange = useCallback((ch) => setNodes((ns) => applyNodeChanges(ch, ns)), [setNodes]);
  const onEdgesChange = useCallback((ch) => setEdges((es) => applyEdgeChanges(ch, es)), [setEdges]);
  // one edge per source handle: connecting an already-wired handle rewires it
  const onConnect = useCallback((conn) => setEdges((es) =>
    addEdge(conn, es.filter((e) => !(e.source === conn.source && e.sourceHandle === conn.sourceHandle)))), [setEdges]);

  const addStep = (t) => setNodes((ns) => [...ns, {
    id: newId(t), type: 'step',
    position: { x: 120 + Math.random() * 80, y: 60 + Math.random() * 60 },
    data: { config: { ...NEW_STEP[t], ...(t === 'condition' ? { check: { ...NEW_STEP.condition.check } } : {}) } },
  }]);

  const lint = localLint(nodes, edges);

  return (
    <div>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          {Object.keys(NEW_STEP).map((t) => (
            <button key={t} className="btn" type="button" onClick={() => addStep(t)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Plus size={12} /> {STEP_META[t].label}
            </button>
          ))}
          <span className="dim" style={{ fontSize: 12 }}>Click a node to configure · drag from a right-side dot to connect · ⌫ deletes</span>
        </div>
      )}
      {lint.length > 0 && (
        <div className="info-bar" style={{ background: 'rgba(222,42,42,.06)', borderColor: 'rgba(222,42,42,.3)', marginBottom: 8 }}>
          <span>{lint.join(' · ')}</span>
        </div>
      )}
      <div style={{ height: 480, border: '1px solid var(--bd, #ddd)', borderRadius: 10 }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          onNodeClick={(_, n) => onSelect && onSelect(n.id)}
          onPaneClick={() => onSelect && onSelect(null)}
          nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
          deleteKeyCode={readOnly ? null : 'Backspace'} fitView proOptions={{ hideAttribution: true }}>
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
```

Note: deleting the trigger node must be impossible — React Flow deletes selected nodes on Backspace; guard it in the page's `setNodes` wrapper (Task 9 filters `TRIGGER_ID` back in). Simpler: the page-level `setNodes` never allows a state without the trigger node (see Task 9 code).

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=@throttle/relay`
Expected: build passes (component not yet imported anywhere — this catches syntax/import errors only).

- [ ] **Step 3: Commit**

```bash
git add apps/relay/src/components/journey-canvas/JourneyCanvas.js
git commit -m "feat(relay): React Flow journey canvas — palette, custom nodes, lint strip (J0)"
```

---

### Task 8: Node config drawer

**Files:**
- Create: `apps/relay/src/components/journey-canvas/NodeDrawer.js`

- [ ] **Step 1: Write the component**

`apps/relay/src/components/journey-canvas/NodeDrawer.js`:
```jsx
'use client';
// Config form for the selected canvas node. Pure controlled component:
// receives the node's config + templates list, calls onChange(partial) / onDelete().
import { Trash2 } from 'lucide-react';

const COND_KINDS = [
  { id: 'no_event_since_enrol', label: "Hasn't done event since enrol" },
  { id: 'event_since_enrol', label: 'Has done event since enrol' },
  { id: 'attribute', label: 'Profile attribute compare' },
];
const CHANNELS = [
  { id: 'email', label: 'Email', live: true },
  { id: 'whatsapp', label: 'WhatsApp', live: true },
  { id: 'sms', label: 'SMS (not live yet)', live: false },
];
const EVENT_SUGGEST = ['checkout_started', 'order_placed', 'order_fulfilled', 'order_cancelled',
  'add_to_cart', 'link_clicked', 'whatsapp_inbound'];

function Field({ label, children }) {
  return <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">{label}</div>{children}</div>;
}

export default function NodeDrawer({ nodeId, config, templates, onChange, onDelete, disabled }) {
  if (!nodeId || !config) return null;
  const set = (patch) => onChange({ ...config, ...patch });
  const t = config.type;
  const channelTemplates = (templates || []).filter((x) => x.channel === (config.channel || 'email'));

  return (
    <div style={{ border: '1px solid var(--bd, #ddd)', borderRadius: 10, padding: 14, marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ textTransform: 'capitalize' }}>{t} · <span className="mono dim" style={{ fontSize: 11 }}>{nodeId}</span></strong>
        {!disabled && (
          <button className="btn" type="button" onClick={onDelete} style={{ color: '#DE2A2A' }}>
            <Trash2 size={13} /> Delete node
          </button>
        )}
      </div>

      {t === 'send' && (<>
        <Field label="Channel">
          <select className="f-inp" value={config.channel || 'email'} disabled={disabled}
            onChange={(e) => set({ channel: e.target.value, templateId: '' })}>
            {CHANNELS.map((c) => <option key={c.id} value={c.id} disabled={!c.live}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Purpose">
          <select className="f-inp" value={config.purpose || 'marketing'} disabled={disabled}
            onChange={(e) => set({ purpose: e.target.value })}>
            <option value="marketing">marketing</option>
            <option value="transactional">transactional</option>
            <option value="utility">utility</option>
          </select>
        </Field>
        <Field label="Template (must be active)">
          <select className="f-inp" value={config.templateId || ''} disabled={disabled}
            onChange={(e) => set({ templateId: e.target.value })}>
            <option value="">— pick a template —</option>
            {channelTemplates.map((x) => <option key={x.id} value={x.id}>{x.name} · v{x.version} ({x.status})</option>)}
          </select>
        </Field>
      </>)}

      {t === 'wait' && (
        <Field label='Duration (e.g. "24 hours", "30 minutes")'>
          <input className="f-inp mono" value={config.duration || ''} disabled={disabled}
            onChange={(e) => set({ duration: e.target.value })} placeholder="24 hours" />
        </Field>
      )}

      {t === 'condition' && (<>
        <Field label="Check">
          <select className="f-inp" value={config.check?.kind || 'no_event_since_enrol'} disabled={disabled}
            onChange={(e) => set({ check: { ...config.check, kind: e.target.value } })}>
            {COND_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </Field>
        {config.check?.kind !== 'attribute' ? (
          <Field label="Event">
            <input className="f-inp mono" list="jc-event-suggest" value={config.check?.event || ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, event: e.target.value } })} placeholder="order_placed" />
            <datalist id="jc-event-suggest">{EVENT_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
          </Field>
        ) : (<>
          <Field label="Attribute">
            <input className="f-inp mono" value={config.check?.attr || ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, attr: e.target.value } })} placeholder="lifetime_orders" />
          </Field>
          <Field label="Operator">
            <select className="f-inp" value={config.check?.op || 'eq'} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, op: e.target.value } })}>
              <option value="eq">=</option><option value="gt">&gt;</option><option value="lt">&lt;</option>
            </select>
          </Field>
          <Field label="Value">
            <input className="f-inp mono" value={config.check?.value ?? ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, value: e.target.value } })} />
          </Field>
        </>)}
        <div className="tw-note" style={{ margin: 0 }}>True path = <span className="mono">if_true</span> handle, false = <span className="mono">if_false</span>.</div>
      </>)}

      {t === 'exit' && (
        <Field label="Outcome label">
          <select className="f-inp" value={config.outcome || 'completed'} disabled={disabled}
            onChange={(e) => set({ outcome: e.target.value })}>
            <option value="completed">completed</option>
            <option value="exited">exited</option>
          </select>
        </Field>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npx turbo build --filter=@throttle/relay`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/relay/src/components/journey-canvas/NodeDrawer.js
git commit -m "feat(relay): journey node config drawer (J0)"
```

---

### Task 9: Rewrite `/journeys` page — list + canvas editor

**Files:**
- Rewrite: `apps/relay/src/app/(auth)/journeys/page.js`

Keeps: list view, gate banner, Trigger & enrolment panel, lifecycle buttons, Funnel panel, compile-pre-validate + `saveJourney` flow, 4s polling absence (n/a here). Removes: `isLinearShape`, `fromDefinition`(old), `buildDefinition`, `emptyDefaults`, the Steps panel, the rawOnly read-only view.

- [ ] **Step 1: Write the new page**

Replace the entire contents of `apps/relay/src/app/(auth)/journeys/page.js` with:
```jsx
'use client';
import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Play, Pause, AlertTriangle, GitBranch } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Pipeline } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';
import { fromDefinition, toDefinition, TRIGGER_ID } from '@/components/journey-canvas/graph.js';
import NodeDrawer from '@/components/journey-canvas/NodeDrawer.js';

// React Flow touches window — client-only.
const JourneyCanvas = dynamic(() => import('@/components/journey-canvas/JourneyCanvas.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });

const STEP_TONE = { wait: 'gray', condition: 'yellow', send: 'blue', exit: 'green' };
const STATUS_TONE = { draft: 'gray', active: 'green', paused: 'yellow', archived: 'gray' };
const REENROL = [
  { id: 'once_while_active', label: 'Once while active' },
  { id: 'once_ever', label: 'Once ever' },
  { id: 'cooldown', label: 'Cooldown (hours)' },
];
const EVENT_SUGGEST = ['checkout_started', 'order_placed', 'order_fulfilled', 'order_delivered',
  'add_to_cart', 'checkout_abandoned', 'return_created'];

function emptyJourney() {
  return { id: null, name: '', status: 'draft', active_version: null,
    triggerEvent: 'checkout_started', reenrolment: 'once_while_active', reenrolCooldown: 24, versions: [] };
}

function triggerSummary(t) {
  if (!t || !t.type) return '—';
  if (t.type === 'event') return `event: ${t.name || '?'}`;
  return t.type;
}

export default function JourneysPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [j, setJ] = useState(emptyJourney());
  const [busy, setBusy] = useState(false);
  const [compileErrors, setCompileErrors] = useState(null);
  const [funnel, setFunnel] = useState(null);
  // canvas state — page-owned so save/drawer/canvas share one source of truth
  const [nodes, setNodesRaw] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);

  const canBuild = !perms || perms.campaign_build;

  // the trigger node must survive any change set (Backspace-delete guard)
  const setNodes = useCallback((updater) => setNodesRaw((prev) => {
    const next = typeof updater === 'function' ? updater(prev) : updater;
    return next.some((n) => n.id === TRIGGER_ID)
      ? next
      : [...next, prev.find((n) => n.id === TRIGGER_ID)].filter(Boolean);
  }), []);

  const loadFunnel = useCallback(async (id) => {
    if (!id) { setFunnel(null); return; }
    try { const f = await garageFetch('getJourneyFunnel', { id }, session); setFunnel(f || null); }
    catch { /* non-fatal */ }
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [js, tp] = await Promise.all([
        garageFetch('getJourneys', {}, session),
        garageFetch('getTemplates', {}, session),
      ]);
      setRows(Array.isArray(js) ? js : []);
      setTemplates(Array.isArray(tp) ? tp : []);
    } catch (e) { showToast(e.message || 'Failed to load journeys', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function set(k, v) { setJ((p) => ({ ...p, [k]: v })); }

  function seedCanvas(journey, def) {
    const g = fromDefinition(journey || {}, def);
    setNodesRaw(g.nodes);
    setEdges(g.edges);
    setSelected(null);
  }

  function startNew() {
    setJ(emptyJourney()); setCompileErrors(null); setFunnel(null);
    seedCanvas({ trigger: { type: 'event', name: 'checkout_started' } }, null);
    setView('form');
  }

  async function open(r) {
    setCompileErrors(null); setFunnel(null);
    seed(r, null);
    setView('form');
    loadFunnel(r.id);
    try {
      const fresh = await garageFetch('getJourney', { id: r.id }, session);
      if (fresh?.id) {
        const activeVer = (fresh.versions || []).find((v) => v.version === fresh.active_version)
          || (fresh.versions || [])[0];
        seed(fresh, activeVer?.definition || null);
      }
    } catch { /* non-fatal */ }
  }

  function seed(r, def) {
    const t = r.trigger || {};
    setJ({
      id: r.id, name: r.name || '', status: r.status || 'draft', active_version: r.active_version ?? null,
      triggerEvent: t.name || 'checkout_started',
      reenrolment: r.reenrolment || 'once_while_active',
      reenrolCooldown: r.reenrol_cooldown_hours || 24,
      versions: r.versions || [],
    });
    seedCanvas(r, def);
  }

  async function refresh() {
    if (!j.id) return;
    try {
      const fresh = await garageFetch('getJourney', { id: j.id }, session);
      if (fresh?.id) {
        const activeVer = (fresh.versions || []).find((v) => v.version === fresh.active_version)
          || (fresh.versions || [])[0];
        seed(fresh, activeVer?.definition || null);
      }
      loadFunnel(j.id);
      load();
    } catch { /* non-fatal */ }
  }

  // keep the canvas trigger node's summary in sync with the trigger form
  useEffect(() => {
    setNodesRaw((ns) => ns.map((n) => n.id === TRIGGER_ID
      ? { ...n, data: { trigger: { type: 'event', name: j.triggerEvent } } } : n));
  }, [j.triggerEvent]);

  const selectedNode = nodes.find((n) => n.id === selected && n.id !== TRIGGER_ID) || null;

  function updateSelectedConfig(cfg) {
    setNodesRaw((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, config: cfg } } : n)));
  }
  function deleteSelected() {
    setNodesRaw((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  }

  async function save() {
    if (!j.name.trim()) { showToast('Name required', 'error'); return; }
    if (!j.triggerEvent.trim()) { showToast('Trigger event name required', 'error'); return; }
    setBusy(true);
    setCompileErrors(null);
    try {
      let definition;
      try { definition = toDefinition(nodes, edges); }
      catch { showToast('Connect the trigger to an entry step first', 'error'); setBusy(false); return; }
      // pre-validate so per-step compile errors surface (saveJourney's error drops details)
      const comp = await workerFetch('compileJourney', { definition }, session);
      if (comp?.data && comp.data.ok === false) {
        setCompileErrors(comp.data.errors || []);
        showToast('Journey has validation errors', 'error');
        setBusy(false);
        return;
      }
      const payload = {
        name: j.name.trim(),
        trigger: { type: 'event', name: j.triggerEvent.trim() },
        reenrolment: j.reenrolment,
        reenrol_cooldown_hours: j.reenrolment === 'cooldown' ? (Number(j.reenrolCooldown) || null) : null,
        definition,
      };
      if (j.id) payload.id = j.id;
      const r = await workerFetch('saveJourney', payload, session);
      const jid = r?.data?.journey_id;
      if (jid && !j.id) set('id', jid);
      showToast(j.id ? 'Journey saved' : 'Journey created', 'success');
      refresh();
      load();
    } catch (e) {
      if (String(e.message) === 'invalid_definition') showToast('Journey has validation errors — check the nodes', 'error');
      else showToast(e.message || 'Save failed', 'error');
    } finally { setBusy(false); }
  }

  async function setStatus(status) {
    if (!j.id) { showToast('Save the journey first', 'error'); return; }
    if (status === 'active' && !j.active_version) { showToast('Save a version before activating', 'error'); return; }
    setBusy(true);
    try {
      await workerFetch('setJourneyStatus', { id: j.id, status }, session);
      showToast(status === 'active' ? 'Journey activated' : `Journey ${status}`, 'success');
      refresh();
    } catch (e) {
      if (String(e.message) === 'no_published_version') showToast("Can't activate — no published version yet", 'error');
      else showToast(e.message || 'Status change failed', 'error');
    } finally { setBusy(false); }
  }

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  const gateBanner = (
    <div className="info-bar" style={{ background: 'rgba(242,205,26,.07)', borderColor: 'var(--accent-bd)' }}>
      <AlertTriangle size={16} style={{ color: 'var(--accent)' }} />
      <span><strong>Internal testing only.</strong> Relay must not send to real customers until sign-off. Validate with an internal-staff segment first.</span>
    </div>
  );

  if (view === 'form') {
    const editable = canBuild;
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to journeys</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{j.id ? (j.name || 'Journey') : 'New Journey'}</span>
            <Badge label={(j.status || 'draft')} tone={STATUS_TONE[j.status] || 'gray'} />
            {j.active_version != null && <Badge label={`v${j.active_version}`} tone="blue" dot />}
          </div>
          <div className="po-head-r">
            {editable && <Btn kind="primary" onClick={save} disabled={busy}><Check size={14} /> {busy ? 'Saving…' : 'Save'}</Btn>}
          </div>
        </div>

        {gateBanner}

        {compileErrors && compileErrors.length > 0 && (
          <div className="info-bar" style={{ background: 'rgba(222,42,42,.07)', borderColor: 'var(--red-bd, rgba(222,42,42,.3))' }}>
            <AlertTriangle size={16} style={{ color: 'var(--red, #DE2A2A)' }} />
            <span><strong>Validation errors:</strong> {compileErrors.join(', ')}</span>
          </div>
        )}

        <Panel title="Trigger & enrolment" pad>
          <div className="form-grid">
            <div className="ff"><div className="kv-k">Name</div>
              <input className="f-inp" value={j.name} onChange={(e) => set('name', e.target.value)} placeholder="Abandoned cart" disabled={busy || !editable} />
            </div>
            <div className="ff"><div className="kv-k">Trigger event</div>
              <input className="f-inp mono" list="journey-event-suggest" value={j.triggerEvent} onChange={(e) => set('triggerEvent', e.target.value)} placeholder="checkout_started" disabled={busy || !editable} />
            </div>
            <div className="ff"><div className="kv-k">Re-enrolment</div>
              <select className="f-inp" value={j.reenrolment} onChange={(e) => set('reenrolment', e.target.value)} disabled={busy || !editable}>
                {REENROL.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </div>
            {j.reenrolment === 'cooldown' && (
              <div className="ff"><div className="kv-k">Cooldown (hours)</div>
                <input className="f-inp mono" type="number" min="1" value={j.reenrolCooldown} onChange={(e) => set('reenrolCooldown', e.target.value)} disabled={busy || !editable} />
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Flow" pad>
          <JourneyCanvas nodes={nodes} edges={edges} setNodes={setNodes} setEdges={setEdges}
            onSelect={setSelected} readOnly={busy || !editable} />
          <NodeDrawer nodeId={selectedNode?.id} config={selectedNode?.data?.config} templates={templates}
            onChange={updateSelectedConfig} onDelete={deleteSelected} disabled={busy || !editable} />
        </Panel>

        <Panel title="Lifecycle" pad>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {!j.id && <span className="dim" style={{ fontSize: 13 }}>Save the journey to enable activate.</span>}
            {j.id && j.status !== 'active' && canBuild && (
              <Btn kind="primary" onClick={() => setStatus('active')} disabled={busy}><Play size={14} /> Activate</Btn>
            )}
            {j.id && j.status === 'active' && canBuild && (
              <Btn onClick={() => setStatus('paused')} disabled={busy}><Pause size={14} /> Pause</Btn>
            )}
            {j.id && (j.status === 'draft' || j.status === 'paused') && j.active_version == null && (
              <span className="dim" style={{ fontSize: 13 }}>No published version yet — save first to enable activation.</span>
            )}
          </div>
          <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
            Triggers only fire while a journey is <strong>active</strong>. Editing republishes a new version; in-flight enrolments finish on their pinned version.
          </div>
        </Panel>

        {j.id && (
          <Panel title="Funnel" count={funnel?.total_enrolments ?? 0} pad>
            {!funnel || funnel.total_enrolments === 0 ? (
              <EmptyState icon="git-branch" title="No enrolments yet" hint="Once profiles enrol, each step's entered count and branch/send/exit results appear here (across all versions)." />
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                  {Object.entries(funnel.enrolments || {}).map(([st, n]) => (
                    <Badge key={st} label={`${st}: ${n}`} tone={st === 'completed' ? 'green' : st === 'active' ? 'blue' : st === 'exited' ? 'gray' : 'yellow'} dot />
                  ))}
                </div>
                <Pipeline stages={(funnel.steps || []).map((s) => ({ stage: `${s.step_id} · ${s.step_type}`, count: s.entered, tone: STEP_TONE[s.step_type] || 'gray' }))} />
                <div className="tw-note" style={{ marginBottom: 0, marginTop: 14 }}>
                  {(funnel.steps || []).map((s) => {
                    const res = Object.entries(s.results || {}).map(([k, v]) => `${k} ${v}`).join(', ');
                    return <div key={s.step_id} style={{ marginBottom: 2 }}><strong className="mono">{s.step_id}</strong>: {res || '—'}</div>;
                  })}
                </div>
              </>
            )}
          </Panel>
        )}

        <datalist id="journey-event-suggest">{EVENT_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Journeys" sub="Multi-step automated flows triggered by customer events."
        actions={canBuild ? <Btn kind="primary" onClick={startNew}><Plus size={14} /> New journey</Btn> : null} />
      {gateBanner}
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="arrow-right" title="No journeys yet" hint="Create a journey — pick a trigger event, then build the flow on the canvas." /></Panel>
          : (
            <Panel title="Journeys" count={rows.length}>
              <table className="dt">
                <thead><tr><th>Name</th><th>Status</th><th className="num">Version</th><th>Trigger</th><th>Re-enrolment</th><th>Updated</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="row-click" onClick={() => open(r)}>
                      <td><GitBranch size={13} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--text-4)' }} />{r.name}</td>
                      <td><Badge label={r.status || 'draft'} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      <td className="num mono dim">{r.active_version ?? '—'}</td>
                      <td className="dim">{triggerSummary(r.trigger)}</td>
                      <td className="dim">{r.reenrolment || '—'}</td>
                      <td className="mono dim">{fmtDate(r.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `npx turbo build --filter=@throttle/relay`
Expected: zero errors. If the build complains about CSS import (`@xyflow/react/dist/style.css`) from a client component, move that import line from `JourneyCanvas.js` into `apps/relay/src/app/globals.css` as `@import '@xyflow/react/dist/style.css';` and rebuild.

- [ ] **Step 3: Run all app-side tests once more (mapping unchanged but be sure)**

Run: `cd apps/relay && node src/components/journey-canvas/graph.test.js`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/relay/src/app/\(auth\)/journeys/page.js
git commit -m "feat(relay): /journeys canvas editor replaces linear form + rawOnly fallback (J0)"
```

---

### Task 10: Push (auto-deploys the app)

- [ ] **Step 1: Push**

```bash
git push
```
Expected: GitHub Actions builds + deploys relay to `relay.legendoftoys.com` (~3–4 min). No manual deploy.

- [ ] **Step 2: Verify deploy landed (static check, no auth needed)**

Run (after ~5 min): `curl -s https://relay.legendoftoys.com/journeys/ -o /dev/null -w "%{http_code}\n"`
Expected: `200`. (Authenticated browser smoke — open the canvas, drag nodes, save — is Afshaan's; note it in the handoff.)

---

### Task 11: Backfill the "Abandoned Cart" journey to the new shape

The only existing journey. It is **draft** (never activated for customers), so publishing a new-shape version is risk-free; in-flight enrolments: none (S178 test data was cleaned). The new version reuses version 1's `templateId` + condition check verbatim.

- [ ] **Step 1: Inspect current state (via Supabase `execute_sql`)**

```sql
SELECT j.id, j.name, j.status, j.active_version,
       (SELECT max(version) FROM comms.journey_versions v WHERE v.journey_id = j.id) AS max_version
FROM comms.journeys j WHERE j.name = 'Abandoned Cart';
```
Expected: one row, `status='draft'`. Note `active_version`/`max_version` (likely 1 — if higher, the INSERT below still works: it appends max+1).

- [ ] **Step 2: Insert the new-shape version + point active_version at it**

```sql
WITH j AS (SELECT id FROM comms.journeys WHERE name = 'Abandoned Cart' LIMIT 1),
v1 AS (SELECT jv.definition FROM comms.journey_versions jv, j
       WHERE jv.journey_id = j.id ORDER BY jv.version ASC LIMIT 1),
ins AS (
  INSERT INTO comms.journey_versions (journey_id, version, definition, created_by)
  SELECT j.id,
         (SELECT COALESCE(max(version),0)+1 FROM comms.journey_versions WHERE journey_id = j.id),
         jsonb_build_object(
           'entry','wait1',
           'trigger_layout', jsonb_build_object('x',40,'y',160),
           'steps', jsonb_build_object(
             'wait1', jsonb_build_object('type','wait','duration','24 hours',
               'outcomes', jsonb_build_object('next','cond1'),
               'layout', jsonb_build_object('x',330,'y',160)),
             'cond1', jsonb_build_object('type','condition',
               'check', (v1.definition->'steps'->'cond1'->'check'),
               'outcomes', jsonb_build_object('if_true','send1','if_false','exit1'),
               'layout', jsonb_build_object('x',620,'y',160)),
             'send1', jsonb_build_object('type','send','channel','email','purpose','marketing',
               'templateId', (v1.definition->'steps'->'send1'->'templateId'),
               'outcomes', jsonb_build_object('next','exit1'),
               'layout', jsonb_build_object('x',910,'y',80)),
             'exit1', jsonb_build_object('type','exit','outcome','completed',
               'layout', jsonb_build_object('x',1200,'y',160)))),
         'j0_backfill'
  FROM j, v1
  RETURNING journey_id, version)
UPDATE comms.journeys SET active_version = ins.version, updated_at = now()
FROM ins WHERE comms.journeys.id = ins.journey_id;
```

- [ ] **Step 3: Verify the new version round-trips**

```sql
SELECT jv.version,
       jv.definition->'steps'->'wait1'->'outcomes'->>'next'      AS wait_next,
       jv.definition->'steps'->'cond1'->'outcomes'->>'if_false'  AS cond_false,
       jv.definition->'steps'->'send1'->>'templateId'            AS tpl,
       jv.definition->'steps'->'send1'->'layout'->>'x'           AS send_x
FROM comms.journey_versions jv
JOIN comms.journeys j ON j.id = jv.journey_id AND j.name = 'Abandoned Cart'
WHERE jv.version = j.active_version;
```
Expected: `wait_next='cond1'`, `cond_false='exit1'`, `tpl` = a uuid (same as v1's), `send_x='910'`.

- [ ] **Step 4: (No commit — DB-only step.)** Record the version number for the handoff notes.

---

### Task 12: Knowledge files + wrap

- [ ] **Step 1: Update `systems/relay.md` (workspace root)**

In the "Journey authoring UI" section added S210, append one line to the first paragraph:
```
**J0 SHIPPED (S210):** definition generalized to `outcomes:{handle:target}` + `layout` (interpreter/compile
compat-read both shapes; journey-graph.js shared helpers); `#doSend` resolves identifiers per channel
(WA→phone — was email-hardcoded); `/journeys` is now a React Flow canvas (palette · config drawer ·
local lint · versioned save; linear form + rawOnly retired); Abandoned Cart backfilled to the new shape.
Browser smoke (canvas drag/save) = Afshaan's.
```

- [ ] **Step 2: Commit knowledge + confirm clean state**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add systems/relay.md && git commit -m "relay: J0 journey canvas shipped (S210)" && git push
git -C 05_Throttle status   # expect: clean, up to date
```

---

## Acceptance (J0 done means)

1. `node test/journey-graph.test.js`, `node test/journeys-compile.test.js`, `node test/wa.test.js` all green in `commsops-worker`; `node src/components/journey-canvas/graph.test.js` green in `apps/relay`.
2. commsops deployed; legacy definitions still interpret identically (compat shim), and a `send` step with `channel:'whatsapp'` resolves a phone identifier.
3. `relay.legendoftoys.com/journeys` serves the canvas build (HTTP 200); authenticated smoke (open, drag, connect, configure, save → new version; compile errors surface) is Afshaan's checklist item.
4. "Abandoned Cart" active version is the outcomes-shape definition and renders on the canvas with stored layout.
5. TEST MODE untouched (ON); no customer-facing behavior change anywhere.
