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

// mixed shape: outcomes for one handle + legacy field for another — BOTH targets returned
assert.deepEqual(G.stepTargets({ outcomes: { if_true: 's' }, if_false: 'e' }).sort(), ['e', 's']);
// mixed shape: outcomes key overriding the same-name legacy field must not duplicate
assert.deepEqual(G.stepTargets({ next: 'old', outcomes: { next: 'new' } }), ['new']);

// identifier type per channel
assert.equal(G.ID_TYPE_FOR_CHANNEL.email, 'email');
assert.equal(G.ID_TYPE_FOR_CHANNEL.whatsapp, 'phone');
assert.equal(G.ID_TYPE_FOR_CHANNEL.sms, 'phone');

console.log('journey-graph.test.js: all assertions passed');

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
assert.ok(G2.RESERVED_STEP_IDS.includes('load-journey-cfg'));
// sendWentOut classifier
assert.equal(G2.sendWentOut({ status: 'sent' }), true);
assert.equal(G2.sendWentOut({ status: 'delivered' }), true);
assert.equal(G2.sendWentOut({ status: 'deduped' }), true);
assert.equal(G2.sendWentOut({ status: 'skipped', reason: 'freq_cap' }), false);
assert.equal(G2.sendWentOut({ status: 'suppressed' }), false);
console.log('journey-graph J1 helpers ok');

// resolveSendNext(step, sendRes, def) → { next } | { next, skippedWait } | { terminate }
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
