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
// trigger node must be excluded from React Flow's delete computation (edge-cascade guard)
assert.equal(g1.nodes.find((n) => n.id === TRIGGER_ID).deletable, false);
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

// mixed-shape step (outcomes for one handle + legacy field for another) — BOTH edges created
// (defense-in-depth: mirrors the worker's stepTargets union so no transition is dropped on load)
const mixedDef = { entry: 'c', steps: {
  c: { type: 'condition', check: {}, outcomes: { if_true: 's' }, if_false: 'e' },
  s: { type: 'exit', outcome: 'completed' },
  e: { type: 'exit', outcome: 'completed' } } };
const gm = fromDefinition({ trigger: {} }, mixedDef);
assert.ok(gm.edges.find((x) => x.source === 'c' && x.sourceHandle === 'if_true' && x.target === 's'));
assert.ok(gm.edges.find((x) => x.source === 'c' && x.sourceHandle === 'if_false' && x.target === 'e'));
// pure-outcomes step still yields exactly its declared edge (no legacy leakage)
const gp = fromDefinition({ trigger: {} }, { entry: 'w', steps: {
  w: { type: 'wait', duration: '1 hours', outcomes: { next: 'x' } }, x: { type: 'exit' } } });
assert.equal(gp.edges.filter((x) => x.source === 'w').length, 1);

console.log('graph.test.js: all assertions passed');
