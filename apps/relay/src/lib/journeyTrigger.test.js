// Journey trigger round-trip tests. Run from apps/relay:
//   node src/lib/journeyTrigger.test.js
//
// The property under test: opening a journey in the canvas and pressing Save must not CHANGE
// its trigger. `buildTrigger` replaces the whole jsonb, so any key it forgets is deleted, not
// left stale — that has silently widened a staged rollout (S241) and silently removed a
// reachability gate (S242). TRIGGER_FIXTURES is the guard: add a trigger key without
// round-tripping it and these fail.
const assert = require('assert');
const T = require('./journeyTrigger.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
}

// Every trigger shape that exists in production, plus the combinations.
const TRIGGER_FIXTURES = [
  ['plain event', { type: 'event', name: 'order_placed' }],
  ['event + single filter', { type: 'event', name: 'order_placed', filter: { is_cod: 'true' } }],
  ['event + multi filter (staged rollout)',
    { type: 'event', name: 'order_placed', filter: { is_cod: 'true', variant_ids: '47424955744308' } }],
  ['event + requires_identifier string (the S242 gate)',
    { type: 'event', name: 'product_viewed', requires_identifier: 'phone' }],
  ['event + requires_identifier ARRAY (any-of)',
    { type: 'event', name: 'add_to_cart', requires_identifier: ['phone', 'email'] }],
  ['event + filter + requires_identifier together',
    { type: 'event', name: 'order_placed', filter: { is_cod: 'true' }, requires_identifier: 'phone' }],
  // S273 — negated filter. The double-enrol fix stores exactly this shape on the general
  // browse journey, and it is out-of-band-fragile in precisely the way S241/S242 were.
  ['event + NEGATED filter (S273 exclusion)',
    { type: 'event', name: 'product_viewed', filter: { primary_category: { not: 'L.O.T Build' } } }],
  ['event + negated AND equality filters mixed',
    { type: 'event', name: 'product_viewed',
      filter: { primary_category: { not: 'L.O.T Build' }, is_cod: 'true' } }],
  ['event + negated filter + requires_identifier (the live shape)',
    { type: 'event', name: 'product_viewed',
      filter: { primary_category: { not: 'L.O.T Build' } }, requires_identifier: 'phone' }],
  ['segment entry', { type: 'segment_entry', segment_id: 'seg-123' }],
];

for (const [label, trigger] of TRIGGER_FIXTURES) {
  t(`round-trips unchanged: ${label}`, () => {
    const after = T.buildTrigger(T.triggerToForm(trigger));
    assert.deepStrictEqual(after, trigger,
      `open→save MUTATED the trigger\n  before: ${JSON.stringify(trigger)}\n  after:  ${JSON.stringify(after)}`);
    assert.ok(T.roundTrips(trigger));
  });
}

// ── the two historical regressions, pinned individually ──
t('S242 REGRESSION: a canvas save must not strip requires_identifier', () => {
  const gated = { type: 'event', name: 'product_viewed', requires_identifier: 'phone' };
  const saved = T.buildTrigger(T.triggerToForm(gated));
  assert.strictEqual(saved.requires_identifier, 'phone',
    'the reachability gate was dropped — anonymous enrolment silently resumes');
});

t('S241 REGRESSION: a canvas save must not strip a trigger filter', () => {
  const staged = { type: 'event', name: 'order_placed', filter: { variant_ids: '47424955744308' } };
  const saved = T.buildTrigger(T.triggerToForm(staged));
  assert.deepStrictEqual(saved.filter, { variant_ids: '47424955744308' },
    'the staged-rollout filter was dropped — the journey would go full-audience');
});

// ── identifier shape symmetry (a string "phone,email" matches NOBODY in the worker) ──
t('multi-type requires_identifier stays an ARRAY, never a comma string', () => {
  const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x', triggerRequiresIdentifier: 'phone,email' });
  assert.ok(Array.isArray(out.requires_identifier), 'must be an array — the worker treats a string as ONE type');
  assert.deepStrictEqual(out.requires_identifier, ['phone', 'email']);
});

t('single-type stays a plain string (matches how the engine and existing rows store it)', () => {
  const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x', triggerRequiresIdentifier: 'phone' });
  assert.strictEqual(out.requires_identifier, 'phone');
});

t('blank / whitespace requires_identifier OMITS the key rather than writing a falsy one', () => {
  for (const v of ['', '   ', ',', undefined, null]) {
    const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x', triggerRequiresIdentifier: v });
    assert.ok(!('requires_identifier' in out), `${JSON.stringify(v)} should omit the key entirely`);
  }
});

t('identifier types are normalised to lowercase and trimmed', () => {
  const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x', triggerRequiresIdentifier: ' Phone , EMAIL ' });
  assert.deepStrictEqual(out.requires_identifier, ['phone', 'email']);
});

// ── filter behaviour ──
t('an empty filter omits the key (a bare {} would be a meaningless stored no-op)', () => {
  const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x', triggerFilter: [{ prop: '', value: 'y' }] });
  assert.ok(!('filter' in out));
});

t('segment_entry never carries event-only keys', () => {
  const out = T.buildTrigger({ triggerType: 'segment_entry', triggerSegmentId: 's1',
    triggerFilter: [{ prop: 'is_cod', value: 'true' }], triggerRequiresIdentifier: 'phone' });
  assert.deepStrictEqual(out, { type: 'segment_entry', segment_id: 's1' });
});

// ── summary line (what the journey list shows) ──
t('summary surfaces the reachability gate so the list shows gated vs ungated', () => {
  assert.strictEqual(
    T.triggerSummary({ type: 'event', name: 'product_viewed', requires_identifier: 'phone' }),
    'event: product_viewed · needs phone');
  assert.strictEqual(
    T.triggerSummary({ type: 'event', name: 'add_to_cart', requires_identifier: ['phone', 'email'] }),
    'event: add_to_cart · needs phone/email');
  // ungated stays exactly as before (no phantom suffix)
  assert.strictEqual(T.triggerSummary({ type: 'event', name: 'order_placed' }), 'event: order_placed');
});

t('summary still renders filters, and both together', () => {
  assert.strictEqual(
    T.triggerSummary({ type: 'event', name: 'order_placed', filter: { is_cod: 'true' }, requires_identifier: 'phone' }),
    'event: order_placed where is_cod=true · needs phone');
});

t('summary resolves a segment name, falling back to the id', () => {
  assert.strictEqual(T.triggerSummary({ type: 'segment_entry', segment_id: 's1' }, [{ id: 's1', name: 'Winback' }]),
    'enters: Winback');
  assert.strictEqual(T.triggerSummary({ type: 'segment_entry', segment_id: 's9' }, []), 'enters: s9');
  assert.strictEqual(T.triggerSummary(null), '—');
});

// ── S273: negation semantics. These pin the DECISION, not just the plumbing. ──
t('S273: an equality filter still stores a bare scalar (pre-S273 rows unchanged)', () => {
  const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x',
    triggerFilter: [{ prop: 'is_cod', value: 'true', op: 'eq' }] });
  assert.deepStrictEqual(out.filter, { is_cod: 'true' }, 'equality must NOT become {not:…} or an object');
});

t('S273: a row with NO op defaults to equality (rows built before the op existed)', () => {
  const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x',
    triggerFilter: [{ prop: 'is_cod', value: 'true' }] });
  assert.deepStrictEqual(out.filter, { is_cod: 'true' });
});

t('S273: an ne row stores {not: value}', () => {
  const out = T.buildTrigger({ triggerType: 'event', triggerEvent: 'x',
    triggerFilter: [{ prop: 'primary_category', value: 'L.O.T Build', op: 'ne' }] });
  assert.deepStrictEqual(out.filter, { primary_category: { not: 'L.O.T Build' } });
});

t('S273: the summary renders ≠ for a negation, never = (it would read as its own opposite)', () => {
  assert.strictEqual(
    T.triggerSummary({ type: 'event', name: 'product_viewed', filter: { primary_category: { not: 'L.O.T Build' } } }),
    'event: product_viewed where primary_category≠L.O.T Build');
});

// The worker-side rule, asserted here too because it is the SEMANTIC decision the whole fix
// rests on: an ABSENT property satisfies a negation. If this ever flips, the general browse
// journey silently stops enrolling the 42% of product_viewed events that carry no category.
t('S273 SEMANTICS: absent property SATISFIES a negation (fail-open, the 42% guard)', () => {
  const norm = (x) => String(x ?? '').trim().toLowerCase();
  const matches = (v, actual) => (v && typeof v === 'object' && !Array.isArray(v) && 'not' in v)
    ? norm(actual) !== norm(v.not)
    : norm(actual) === norm(v);
  const rule = { not: 'L.O.T Build' };
  assert.strictEqual(matches(rule, undefined), true,  'ABSENT must pass — this is the whole point');
  assert.strictEqual(matches(rule, ''), true,         'empty must pass');
  assert.strictEqual(matches(rule, 'L.O.T Cars'), true);
  assert.strictEqual(matches(rule, 'L.O.T Build'), false, 'the excluded value must NOT pass');
  assert.strictEqual(matches(rule, '  l.o.t build  '), false, 'case + whitespace insensitive, like equality');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
