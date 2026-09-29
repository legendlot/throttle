// Plain-English Funnel tests. Run from apps/relay:  node src/components/journey-canvas/funnel.test.js
const assert = require('assert');
const { stepConfigMap, describeStep, orderSteps, humanReason, reasonRows, exitRuleEvents, stopLabel, statusChipLabel, dropInto } = require('./funnel.js');

// The live L.O.T Build browse-abandonment definition (v5), trimmed to what naming reads.
const def = {
  entry: 'wait_msllpui40',
  steps: {
    exit_msllrhgb3: { type: 'exit', outcome: 'completed' },
    send_msllqxfh2: { type: 'send', channel: 'whatsapp', templateId: 't1', outcomes: { next: 'wait_muf73f5h0' } },
    send_muf746w32: { type: 'send', channel: 'whatsapp', templateId: 't2', outcomes: { next: 'exit_msllrhgb3' } },
    wait_msllpui40: { type: 'wait', duration: '30 minutes', outcomes: { next: 'condition_msllqe271' } },
    wait_muf73f5h0: { type: 'wait', duration: '6 hours', outcomes: { next: 'condition_muf73tln1' } },
    condition_msllqe271: { type: 'condition', check: { kind: 'no_event_since_enrol', event: 'order_placed' }, outcomes: { if_true: 'send_msllqxfh2', if_false: 'exit_msllrhgb3' } },
    condition_muf73tln1: { type: 'condition', check: { kind: 'no_event_since_enrol', event: 'order_placed' }, outcomes: { if_true: 'send_muf746w32', if_false: 'exit_msllrhgb3' } },
  },
};
const names = { t1: 'Browse v3', t2: 'browse_abandonment_6hrs_build' };

// --- naming from config, never the random id ---
assert.strictEqual(describeStep('wait_msllpui40', def.steps.wait_msllpui40), 'Wait 30 minutes');
assert.strictEqual(describeStep('condition_msllqe271', def.steps.condition_msllqe271), 'Still no order placed since they entered?');
assert.strictEqual(describeStep('send_muf746w32', def.steps.send_muf746w32, names), 'Send WhatsApp: browse_abandonment_6hrs_build');
assert.strictEqual(describeStep('send_x', { type: 'send', channel: 'whatsapp', templateId: 'gone' }, names), 'Send WhatsApp');
assert.strictEqual(describeStep('exit_msllrhgb3', def.steps.exit_msllrhgb3), 'End of journey');
assert.strictEqual(describeStep('pay_notdone_msg', undefined), 'Payment not completed message'); // old-version step: id fallback

// --- active version wins; an old-only step still resolves ---
const m = stepConfigMap([
  { version: 5, definition: def },
  { version: 4, definition: { entry: 'old', steps: { wait_msllpui40: { type: 'wait', duration: '5 minutes' }, old_step: { type: 'wait', duration: '1 hour' } } } },
], 5);
assert.strictEqual(m.steps.wait_msllpui40.duration, '30 minutes');
assert.strictEqual(m.steps.old_step.duration, '1 hour');
assert.strictEqual(m.entry, 'wait_msllpui40');

// --- path order, Exit last (was: sorted by count, Exit third) ---
const byCount = [
  ['wait_msllpui40', 'wait', 6510], ['condition_msllqe271', 'condition', 5516], ['send_msllqxfh2', 'send', 5493],
  ['exit_msllrhgb3', 'exit', 5409], ['wait_muf73f5h0', 'wait', 1192], ['condition_muf73tln1', 'condition', 1110],
  ['send_muf746w32', 'send', 1108], ['legacy_step', 'wait', 50],
].map(([step_id, step_type, entered]) => ({ step_id, step_type, entered }));
assert.deepStrictEqual(orderSteps(byCount, def.entry, def.steps).map((s) => s.step_id), [
  'wait_msllpui40', 'condition_msllqe271', 'send_msllqxfh2', 'wait_muf73f5h0', 'condition_muf73tln1',
  'send_muf746w32', 'legacy_step', 'exit_msllrhgb3']);
// No definition → unchanged volume order (exits still last).
assert.strictEqual(orderSteps(byCount, null, null).slice(-1)[0].step_id, 'exit_msllrhgb3');

// --- reasons ---
assert.strictEqual(humanReason('no_consent'), 'No marketing consent on this channel');
assert.strictEqual(humanReason('wa_999'), 'WhatsApp error (code 999)');
assert.strictEqual(humanReason('some_new_reason'), 'Some new reason');
assert.strictEqual(humanReason(''), 'No reason recorded');
const rows = reasonRows({ skipped: { freq_cap: 13, no_consent: 3991, no_phone_identifier: 1 }, suppressed: { suppressed: 13 } });
assert.deepStrictEqual(rows.map((r) => [r.status, r.reason, r.n]), [
  ['skipped', 'no_consent', 3991], ['skipped', 'freq_cap', 13], ['suppressed', 'suppressed', 13], ['skipped', 'no_phone_identifier', 1]]);
assert.deepStrictEqual(reasonRows(undefined), []);

// --- stopped-here + chips name this journey's exit-rule events ---
const ev = exitRuleEvents([
  { event: 'add_to_cart', outcome: 'progressed' }, { event: 'checkout_started', outcome: 'progressed' },
  { event: 'order_placed', outcome: 'purchased' }, { event: '', outcome: 'x' }]);
assert.strictEqual(stopLabel('progressed', ev), 'left — add to cart / checkout started');
assert.strictEqual(stopLabel('purchased', ev), 'left — order placed');
assert.strictEqual(stopLabel('active', ev), 'still waiting here');
assert.strictEqual(statusChipLabel('progressed', ev), 'Moved on (add to cart / checkout started)');
assert.strictEqual(statusChipLabel('active', ev), 'In flight');

// --- branching graph (C2P-shaped): no invented drops between SIBLINGS (hostile review S403) ---
const c2p = {
  ask: { type: 'send', interactive: true, outcomes: { no_reply: 'noresp_tag', 'Cancel Order': 'cancel_ask', 'Make Payment': 'pay_link', 'Confirm COD Order': 'confirm_tag' } },
  noresp_tag: { type: 'action', kind: 'order_modify', op: 'add_tag', tags: ['relay-c2p-no-response'], outcomes: { next: 'exit' } },
  cancel_ask: { type: 'send', outcomes: { next: 'cancel_do' } },
  cancel_do: { type: 'action', kind: 'order_modify', op: 'cancel', outcomes: { done: 'cancel_done_msg', not_done: 'exit' } },
  cancel_done_msg: { type: 'send', outcomes: { next: 'exit' } },
  pay_link: { type: 'action', kind: 'payment_link', outcomes: { done: 'pay_wait', not_done: 'exit' } },
  pay_wait: { type: 'wait_response', within: '60 minutes', awaited: ['payment_link_paid'], outcomes: { responded: 'exit', timeout: 'exit' } },
  confirm_tag: { type: 'action', kind: 'order_modify', op: 'add_tag', tags: ['relay-c2p-confirmed'], outcomes: { next: 'confirm_msg' } },
  confirm_msg: { type: 'send', outcomes: { next: 'exit' } },
  exit: { type: 'exit', outcome: 'completed' },
};
const ent = { ask: 2085, noresp_tag: 661, cancel_ask: 237, cancel_do: 197, cancel_done_msg: 195, pay_link: 41, pay_wait: 36, confirm_tag: 1119, confirm_msg: 1119, exit: 2000 };
assert.strictEqual(dropInto('noresp_tag', c2p, ent), null, 'parent ask branches — its chips explain the split');
assert.strictEqual(dropInto('cancel_ask', c2p, ent), null);
assert.deepStrictEqual(dropInto('cancel_do', c2p, ent), { parent: 'cancel_ask', lost: 40, pct: 17 }, 'linear send → action');
assert.strictEqual(dropInto('cancel_done_msg', c2p, ent), null, 'cancel_do branches done / not_done');
assert.deepStrictEqual(dropInto('confirm_msg', c2p, ent), { parent: 'confirm_tag', lost: 0, pct: 0 });
assert.strictEqual(dropInto('exit', c2p, ent), null, 'many parents');
assert.strictEqual(dropInto('nope', c2p, ent), null);
// Build: wait → condition is linear, so its drop shows; condition → send branches, so it does not.
assert.deepStrictEqual(dropInto('condition_msllqe271', def.steps, { wait_msllpui40: 6514, condition_msllqe271: 5521 }), { parent: 'wait_msllpui40', lost: 993, pct: 15 });
assert.strictEqual(dropInto('send_msllqxfh2', def.steps, { condition_msllqe271: 5521, send_msllqxfh2: 5498 }), null);

// --- names that say what the step does ---
assert.strictEqual(describeStep('pay_wait', c2p.pay_wait), 'Wait up to 60 minutes for payment link paid');
assert.strictEqual(describeStep('w', { type: 'wait_response', within: '2 hours' }), 'Wait up to 2 hours for a reply');
assert.strictEqual(describeStep('noresp_tag', c2p.noresp_tag), 'Tag the order "relay-c2p-no-response"');
assert.strictEqual(describeStep('confirm_tag', c2p.confirm_tag), 'Tag the order "relay-c2p-confirmed"');
assert.strictEqual(describeStep('c', { type: 'condition', check: { kind: 'attribute', attr: 'tier', op: 'in', value: 'gold,silver' } }), 'Check: tier is one of gold,silver');
assert.strictEqual(describeStep('c', { type: 'condition', check: { kind: 'event_property', field: 'tags', op: 'contains', value: 'vip' } }), 'Check: tags contains "vip"');

// --- free-text keys never hit Object.prototype ---
assert.strictEqual(stopLabel('constructor', {}), 'constructor');
assert.strictEqual(statusChipLabel('toString', {}), 'ToString');
assert.strictEqual(typeof humanReason('toString'), 'string');
assert.strictEqual(describeStep('s', { type: 'send', channel: 'whatsapp', templateId: '__proto__' }, {}), 'Send WhatsApp');

console.log('funnel.test.js: all passed');
