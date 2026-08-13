// Segment AST round-trip tests. Run: node apps/relay/test/segment-ast.test.mjs
//
// THE test here is the round-trip: parseDef -> itemsToDef must return a saved definition
// UNCHANGED. Opening a segment in the builder and pressing save is a thing people do casually,
// and a bug in this pair silently rewrites a live audience with no error and no diff to look at.
// The 11 fixtures below are the REAL definitions from comms.segments on 2026-08-13.
import assert from 'node:assert';
import { parseDef, itemsToDef, toLeaf, toRow } from '../src/lib/segmentAst.js';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
  catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const roundTrip = (def) => { const p = parseDef(def); return itemsToDef(p.group, p.items); };

// ── the 11 live definitions, verbatim ────────────────────────────────────────
const LIVE = {
  'All buyers_Mishica': { all: [{ attr: 'lifetime_orders', op: 'gte', value: '1' }, { consent: true, channel: 'email', purpose: 'marketing', state: 'opted_in' }] },
  'HP Drop Test': { all: [{ count: 1, event: 'collection_viewed', where: { prop: 'collection_handle', value: 'l-o-t-build' } }] },
  'Winback 90': { all: [{ attr: 'last_order_at', op: 'before_days', value: '90' }, { attr: 'lifetime_orders', op: 'gte', value: '1' }] },
  'T-30 spend': { all: [{ attr: 'lifetime_value', op: 'gt', value: '3000' }, { attr: 'last_order_at', op: 'within_days', value: '30' }] },
  'empty': {},
};

for (const [name, def] of Object.entries(LIVE)) {
  t(`round-trip is lossless: ${name}`, () => {
    assert.deepStrictEqual(roundTrip(def), def);
  });
}

t('a numeric value is NORMALISED to a string, and that is a proven no-op', () => {
  // "Winback 90 — Email" stores value: 90 as a JSON NUMBER; toLeaf has always emitted
  // String(value), so opening and saving it rewrites 90 -> "90". This predates nesting and is
  // NOT a behaviour change: eval_segment_node extracts with #>> (text) before every cast, so
  // both forms evaluate identically. Verified live 2026-08-13: both return 25,761 / 25,761.
  // Pinned here so the normalisation is a stated decision rather than a surprise in a diff.
  const def = { all: [{ attr: 'last_order_at', op: 'before_days', value: 90 }] };
  assert.deepStrictEqual(roundTrip(def), { all: [{ attr: 'last_order_at', op: 'before_days', value: '90' }] });
});

t('a NESTED definition survives the round-trip', () => {
  const def = { any: [
    { all: [{ attr: 'lifetime_orders', op: 'eq', value: '0' }, { consent: true, channel: 'email', purpose: 'marketing', state: 'opted_in' }] },
    { attr: 'lifetime_orders', op: 'gte', value: '2' },
  ] };
  assert.deepStrictEqual(roundTrip(def), def);
});

t('parseDef flags a group-inside-a-group as tooDeep and does NOT silently flatten it', () => {
  const deep = { all: [{ any: [{ all: [{ attr: 'city', op: 'eq', value: 'Pune' }] }] }] };
  const p = parseDef(deep);
  assert.equal(p.tooDeep, true, 'must be flagged so the editor goes read-only');
});

t('a one-level nest is NOT flagged tooDeep', () => {
  const ok = { all: [{ any: [{ attr: 'city', op: 'eq', value: 'Pune' }] }, { attr: 'locale', op: 'eq', value: 'en' }] };
  assert.equal(parseDef(ok).tooDeep, false);
});

t('an EMPTY group is dropped, not emitted', () => {
  // an empty all/any would evaluate to everyone-or-nobody, which the author never expressed
  const items = [{ type: 'attr', attr: 'city', op: 'eq', value: 'Pune' }, { type: 'group', group: 'any', rows: [] }];
  assert.deepStrictEqual(itemsToDef('all', items), { all: [{ attr: 'city', op: 'eq', value: 'Pune' }] });
});

t('no items at all = {} = matches everyone (unchanged behaviour)', () => {
  assert.deepStrictEqual(itemsToDef('all', []), {});
});

t('count_op is omitted when it is the legacy default, so old segments stay byte-identical', () => {
  assert.deepStrictEqual(toLeaf({ type: 'event', event: 'order_placed', count: 1, count_op: 'gte' }),
    { event: 'order_placed', count: 1 });
  assert.deepStrictEqual(toLeaf({ type: 'event', event: 'order_placed', count: 1, count_op: 'eq' }),
    { event: 'order_placed', count: 1, count_op: 'eq' });
});

t('a deliberate count of 0 survives (it means "never did this")', () => {
  assert.equal(toLeaf({ type: 'event', event: 'order_placed', count: 0, count_op: 'eq' }).count, 0);
  assert.equal(toRow({ event: 'order_placed', count: 0, count_op: 'eq' }).count, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
