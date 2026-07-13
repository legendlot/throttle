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
