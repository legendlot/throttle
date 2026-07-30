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

  // journey-level: exit_rules === null is treated as "not provided" (no error)
  {
    const def = { entry: 'ex', steps: { ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def, { max_duration: null, exit_rules: null });
    assert.ok(r.ok, 'null exit_rules/max_duration should compile clean: ' + JSON.stringify(r.errors));
  }
  // journey-level: exit_rules present but not an array → bad_exit_rules
  {
    const def = { entry: 'ex', steps: { ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def, { exit_rules: 'nope' });
    assert.ok(r.errors.includes('bad_exit_rules'), JSON.stringify(r.errors));
  }
  console.log('compile J1 null-handling ok');

  // cyclic definition → cycle_detected
  {
    const def = { entry: 'a', steps: {
      a: { type: 'wait', duration: '1 hour', outcomes: { next: 'b' } },
      b: { type: 'condition', check: { kind: 'attribute', attr: 'x', op: 'eq', value: '1' }, outcomes: { if_true: 'a', if_false: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('cycle_detected'), JSON.stringify(r.errors));
  }
  // exit step with reserved terminal outcome 'active' → reserved_outcome:<id>
  {
    const def = { entry: 'ex', steps: { ex: { type: 'exit', outcome: 'active' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('reserved_outcome:ex'), JSON.stringify(r.errors));
  }
  console.log('compile J1 cycle + reserved-outcome ok');

  // J3 action nodes — valid set_attr + payment_link (both handles wired)
  {
    const def = { entry: 'a', steps: {
      a: { type: 'action', kind: 'set_attr', attr: 'converted', value: true, outcomes: { next: 'p' } },
      p: { type: 'action', kind: 'payment_link', purpose: 'Pay', outcomes: { next: 'ex', failed: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    assert.deepEqual((await compile({}, def)).errors, []);
  }
  // bad action kind
  {
    const def = { entry: 'a', steps: {
      a: { type: 'action', kind: 'wat', outcomes: { next: 'ex' } }, ex: { type: 'exit' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('bad_action_kind:a:wat'), JSON.stringify(r.errors));
  }
  // set_attr missing attr
  {
    const def = { entry: 'a', steps: {
      a: { type: 'action', kind: 'set_attr', outcomes: { next: 'ex' } }, ex: { type: 'exit' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('set_attr_no_attr:a'), JSON.stringify(r.errors));
  }
  // payment_link missing the 'failed' branch → action_handle_missing
  {
    const def = { entry: 'p', steps: {
      p: { type: 'action', kind: 'payment_link', outcomes: { next: 'ex' } }, ex: { type: 'exit' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.some((e) => e.startsWith('action_handle_missing:p:failed')), JSON.stringify(r.errors));
  }
  console.log('compile J3 action ok');

  // order_modify — valid op + handles
  {
    const def = { entry: 'm', steps: {
      m: { type: 'action', kind: 'order_modify', op: 'convert_to_prepaid', outcomes: { done: 'ex', not_done: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    assert.deepEqual((await compile({}, def)).errors, []);
  }
  {
    const def = { entry: 'm', steps: {
      m: { type: 'action', kind: 'order_modify', op: 'wat', outcomes: { done: 'ex', not_done: 'ex' } },
      ex: { type: 'exit' } } };
    assert.ok((await compile({}, def)).errors.includes('bad_order_op:m:wat'));
  }
  // interactive send — valid (buttons + within + all handles wired)
  {
    const def = { entry: 's', steps: {
      s: { type: 'send', channel: 'whatsapp', interactive: true, within: '6 hours',
           buttons: [{ id: 'pay', label: 'Pay' }, { id: 'cancel', label: 'Cancel' }],
           outcomes: { pay: 'ex', cancel: 'ex', no_reply: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    assert.deepEqual((await compile({}, def)).errors, []);
  }
  // interactive send — `send_failed` is OPTIONAL (above compiles clean without it) and ACCEPTED
  // when wired. It must never be required: doing so would fail compilation for every interactive
  // journey already live, C2P included. Unwired, the interpreter terminates with that outcome
  // rather than falling through to no_reply (which would tag a No-Response we never earned).
  {
    const def = { entry: 's', steps: {
      s: { type: 'send', channel: 'whatsapp', interactive: true, within: '6 hours',
           buttons: [{ id: 'pay', label: 'Pay' }],
           outcomes: { pay: 'ex', no_reply: 'ex', send_failed: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    assert.deepEqual((await compile({}, def)).errors, []);
    console.log('interactive send_failed handle optional + wireable ok');
  }
  // interactive send — no buttons
  {
    const def = { entry: 's', steps: {
      s: { type: 'send', interactive: true, within: '6 hours', buttons: [], outcomes: { no_reply: 'ex' } },
      ex: { type: 'exit' } } };
    assert.ok((await compile({}, def)).errors.includes('interactive_send_no_buttons:s'));
  }
  // interactive send — a button handle not wired
  {
    const def = { entry: 's', steps: {
      s: { type: 'send', interactive: true, within: '6 hours', buttons: [{ id: 'pay' }], outcomes: { no_reply: 'ex' } },
      ex: { type: 'exit' } } };
    assert.ok((await compile({}, def)).errors.some((e) => e.startsWith('interactive_handle_missing:s:pay')));
  }
  console.log('compile order_modify + interactive ok');

  // H14 — wait step with an unparseable duration ("3 dayz" typo) → compile rejects
  {
    const def = { entry: 'w', steps: {
      w: { type: 'wait', duration: '3 dayz', outcomes: { next: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def);
    assert.ok(r.errors.includes('wait_bad_duration:w'), JSON.stringify(r.errors));
  }
  // H14 — a valid duration still compiles clean
  {
    const def = { entry: 'w', steps: {
      w: { type: 'wait', duration: '30 minutes', outcomes: { next: 'ex' } },
      ex: { type: 'exit', outcome: 'completed' } } };
    const r = await compile({}, def);
    assert.ok(r.ok, 'valid wait duration should compile: ' + JSON.stringify(r.errors));
  }
  console.log('compile H14 wait-duration-validation ok');

  console.log('journeys-compile.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
