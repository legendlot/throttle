import test from 'node:test';
import assert from 'node:assert/strict';
import { actorIds } from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('approver, history actors and note authors, deduped', () => {
  const ids = actorIds({ approved_by: A }, [{ actor: B }, { actor: A }, { actor: null }], [{ actor: C }, { actor: B }]);
  assert.deepEqual(ids.sort(), [A, B, C].sort());
});

test('unlocker only while the window is open', () => {
  assert.deepEqual(actorIds({ unlocked_by: A }), []);
  assert.deepEqual(actorIds({ unlocked_by: A }, [], [], { unlockOpen: true }), [A]);
});

test('non-uuid values never reach the in.() filter', () => {
  assert.deepEqual(actorIds({ approved_by: 'system' }, [{ actor: 'x,y)' }, { actor: 42 }], []), []);
});

test('empty engagement → no lookup', () => {
  assert.deepEqual(actorIds({}, [], []), []);
  assert.deepEqual(actorIds(null), []);
});
