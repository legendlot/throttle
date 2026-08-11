// Deterministic arm assignment (S272). Pure — no DB, no network.
const assert = require('assert');
const { pickVariant, fnv1a } = require('../src/variants.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = { id: 'var-a', label: 'A', weight: 50 };
const B = { id: 'var-b', label: 'B', weight: 50 };
const CAMP1 = 'camp-1111', CAMP2 = 'camp-2222';

t('returns null when there are no variants', () => {
  assert.equal(pickVariant(CAMP1, uuid(1), []), null);
  assert.equal(pickVariant(CAMP1, uuid(1), null), null);
});

t('a single variant always wins', () => {
  for (let i = 0; i < 50; i++) assert.equal(pickVariant(CAMP1, uuid(i), [A]).id, 'var-a');
});

t('deterministic — same inputs, same arm, every time', () => {
  const first = pickVariant(CAMP1, uuid(7), [A, B]).id;
  for (let i = 0; i < 20; i++) assert.equal(pickVariant(CAMP1, uuid(7), [A, B]).id, first);
});

t('50/50 splits within tolerance over 10k profiles', () => {
  let a = 0;
  for (let i = 0; i < 10000; i++) if (pickVariant(CAMP1, uuid(i), [A, B]).id === 'var-a') a++;
  assert.ok(a > 4700 && a < 5300, `arm A got ${a}/10000, expected ~5000`);
});

t('80/20 is respected', () => {
  const big = { id: 'big', label: 'A', weight: 80 }, small = { id: 'small', label: 'B', weight: 20 };
  let b = 0;
  for (let i = 0; i < 10000; i++) if (pickVariant(CAMP1, uuid(i), [big, small]).id === 'big') b++;
  assert.ok(b > 7700 && b < 8300, `80-weight arm got ${b}/10000, expected ~8000`);
});

// ⚠️ THE FOOTGUN TEST (spec §5.1). Salting with campaign_id is what stops one cohort
// permanently living in arm A of every campaign. State the assertion precisely: two independent
// 50/50 splits agree ~50% of the time BY CHANCE. Asserting ~0% overlap would be demanding
// anti-correlation and would fail against correct code.
t('campaign salt re-shuffles: ~50% overlap between two campaigns, not ~100% and not ~0%', () => {
  let same = 0;
  for (let i = 0; i < 10000; i++) {
    if (pickVariant(CAMP1, uuid(i), [A, B]).id === pickVariant(CAMP2, uuid(i), [A, B]).id) same++;
  }
  assert.ok(same > 4500 && same < 5500, `${same}/10000 landed in the same arm; expected ~5000`);
});

// ⚠️ Assignment must be a function of the SET of arms, not of the array order they arrive in.
t('assignment is independent of the order the arms are passed in', () => {
  for (let i = 0; i < 200; i++) {
    assert.equal(pickVariant(CAMP1, uuid(i), [A, B]).id, pickVariant(CAMP1, uuid(i), [B, A]).id,
      `profile ${i} flipped arm when the array order changed`);
  }
});

t('fnv1a is stable and unsigned', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.notEqual(fnv1a('abc'), fnv1a('abd'));
  assert.ok(fnv1a('anything') >= 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
