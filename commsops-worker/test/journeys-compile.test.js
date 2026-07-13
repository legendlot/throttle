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
