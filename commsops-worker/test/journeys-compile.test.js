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

  // wait_response: valid awaited list + within, both handles wired
  {
    const def = { entry: 'w', steps: {
      w: { type: 'wait_response', awaited: ['order_placed'], within: '6 hours',
           outcomes: { responded: 'ex', timeout: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' },
    } };
    const r = await compile({}, def);
    assert.ok(r.ok, 'valid wait_response should compile: ' + JSON.stringify(r.errors));
  }
  // wait_response: empty awaited → error
  {
    const def = { entry: 'w', steps: {
      w: { type: 'wait_response', awaited: [], within: '6 hours', outcomes: { responded: 'ex', timeout: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('wait_response_no_awaited:w'), JSON.stringify(r.errors));
  }
  // wait_response: bad within → error
  {
    const def = { entry: 'w', steps: {
      w: { type: 'wait_response', awaited: ['x'], within: 'soon', outcomes: { responded: 'ex', timeout: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('wait_response_bad_within:w'), JSON.stringify(r.errors));
  }
  // wait_response: an unwired declared handle → error
  {
    const def = { entry: 'w', steps: {
      w: { type: 'wait_response', awaited: ['x'], within: '6 hours', outcomes: { responded: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('wait_response_handle_missing:w'), JSON.stringify(r.errors));
  }
  // on_skip: bad value on a send → error
  {
    const def = { entry: 's', steps: {
      s: { type: 'send', channel: 'email', on_skip: 'teleport', outcomes: { next: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('bad_on_skip:s'), JSON.stringify(r.errors));
  }
  // journey-level: bad max_duration + malformed exit rule (compile third arg = journey)
  {
    const def = { entry: 'ex', steps: { ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def, { max_duration: 'whenever', exit_rules: [{ event: 'x' }] });
    assert.ok(r.errors.includes('bad_max_duration'), JSON.stringify(r.errors));
    assert.ok(r.errors.includes('exit_rule_no_outcome:0'), JSON.stringify(r.errors));
  }
  console.log('compile J1 ok');

  console.log('journeys-compile.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
