// Segment AST round-trip tests. Run: node apps/relay/test/segment-ast.test.mjs
//
// THE test here is the round-trip: parseDef -> itemsToDef must return a saved definition
// UNCHANGED. Opening a segment in the builder and pressing save is a thing people do casually,
// and a bug in this pair silently rewrites a live audience with no error and no diff to look at.
// The fixtures below are REAL definitions from comms.segments.
//
// ⚠️ Count corrected 2026-08-14: this said "the 11 fixtures below", and the commit that added it
// claimed every one of the 11 live definitions round-trips. There are FIVE here, and there are 12
// segments live. So the round-trip is pinned for 5 of 12, not all of them — a real gap in the
// safety net, since this pair silently rewrites a live audience when it is wrong. Logged in
// BACKLOG [relay] rather than fixed here. Do not restate the "all live definitions" claim.
import assert from 'node:assert';
import { parseDef, itemsToDef, toLeaf, toRow, countConditions,
  opsForAttr, conditionWarning, defaultOpFor, ruleWarnings,
  eventLeafKey, eventWarning, eventLeaves,
  coverageWarning, meansNone, ATTR_COVERAGE } from '../src/lib/segmentAst.js';

// Mirrors the OPS list in the segments page. Kept as a fixture rather than imported because the
// page is a React client component and this suite runs under bare node.
const OPS_FIXTURE = [
  { id: 'eq' }, { id: 'neq' }, { id: 'in' }, { id: 'gt' }, { id: 'gte' },
  { id: 'lt' }, { id: 'lte' }, { id: 'before_days' }, { id: 'within_days' },
];

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
  catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const roundTrip = (def) => { const p = parseDef(def); return itemsToDef(p.group, p.items); };

// ── EVERY live definition, verbatim ──────────────────────────────────────────
// ⚠️ Pulled from comms.segments 2026-08-16 (S289) — ALL 15, closing the long-standing gap where
// this pinned 5 of 12 while the header claimed 11 and the commit claimed "every one". This is the
// pair that silently rewrites a live audience on save, so partial coverage was a real hole.
// Re-pull with:  SELECT jsonb_object_agg(name, definition) FROM comms.segments;
const LIVE = {
  'Test': { all: [{ op: 'eq', attr: 'city', value: 'Bangalore' }] },
  'HP Drop Test': { all: [{ count: 1, event: 'collection_viewed', where: { prop: 'collection_handle', value: 'l-o-t-build' } }] },
  'T-30 visitors': { all: [{ op: 'eq', attr: 'lifetime_orders', value: '0' }, { count: 1, event: 'collection_viewed', within: '30 days' }] },
  'T-30 purchasers': { all: [{ op: 'within_days', attr: 'last_order_at', value: '30' }, { op: 'gte', attr: 'lifetime_orders', value: '1' }] },
  'T-90 purchasers': { all: [{ op: 'within_days', attr: 'last_order_at', value: '90' }, { op: 'gte', attr: 'lifetime_orders', value: '1' }] },
  'T-180 purchasers': { all: [{ state: 'opted_in', channel: 'whatsapp', consent: true, purpose: 'marketing' }, { op: 'within_days', attr: 'last_order_at', value: '180' }, { op: 'gte', attr: 'lifetime_orders', value: '1' }] },
  'All buyers_Mishica': { all: [{ op: 'gte', attr: 'lifetime_orders', value: '1' }, { state: 'opted_in', channel: 'email', consent: true, purpose: 'marketing' }] },
  'LOT Internal Staff': { all: [{ op: 'eq', attr: 'audience', value: 'internal_staff' }] },
  'Winback 90 — Email': { all: [{ op: 'before_days', attr: 'last_order_at', value: 90 }, { state: 'opted_in', channel: 'email', consent: true, purpose: 'marketing' }] },
  'T-90 Collection Views': { all: [{ count: 1, event: 'collection_viewed', within: '90 days' }, { none: [{ op: 'gte', attr: 'lifetime_orders', value: '1' }] }] },
  'Last order within 120 days': { all: [{ op: 'within_days', attr: 'last_order_at', value: '120' }, { op: 'before_days', attr: 'last_order_at', value: '30' }] },
  'High Speed Browsers_Mishica': { all: [{ count: 1, event: 'product_viewed', where: { prop: 'product_handle', value: ['apex-4x4-rc-car', 'gazer-4x4-rc-car', 'doughty-4x4-rc-car'] } }] },
  'T-30 days purchasers, > 3000 spend': { all: [{ count: 1, event: 'order_placed', within: '30 days' }, { op: 'gte', attr: 'lifetime_value', value: '3000' }] },
  'All customers excluding T-15 purchasers': { none: [{ op: 'within_days', attr: 'last_order_at', value: '15' }, { state: 'opted_out', channel: 'whatsapp', consent: true, purpose: 'marketing' }] },
  'T-180 site visitors, excluding T-15 purchasers': { all: [{ op: 'within_days', attr: 'shopify_created_at', value: '180' }, { op: 'before_days', attr: 'last_order_at', value: '15' }] },
  'empty': {},
};

// ⚠️ KEY ORDER IS NOT A DIFFERENCE. These definitions live in a JSONB column, which does not
// preserve key order, so comparing with deepStrictEqual against the literal above reports a diff
// for every single row — a first cut of this check "found" 15 round-trip failures, all of them
// key order and none of them real. Canonicalise, then compare.
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v);

for (const [name, def] of Object.entries(LIVE)) {
  t(`round-trip is lossless: ${name}`, () => {
    // `Winback 90 — Email` stores value as a NUMBER and comes back a string — the one real
    // difference across all 15, pinned separately below and proven a no-op against the live
    // evaluator. Normalise it here so this test measures structure, not that known coercion.
    const norm = (d) => JSON.parse(JSON.stringify(canon(d), (k, v) => (k === 'value' && typeof v === 'number' ? String(v) : v)));
    assert.deepStrictEqual(norm(roundTrip(def)), norm(def));
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

// ── the shape contract the list page depends on (added 2026-08-14, after the outage) ────────
//
// The nesting commit renamed parseDef's `rows` to `items` and missed ONE reader — the segments
// LIST did `p.rows.length`, i.e. `undefined.length`, so the page threw on the first dynamic
// segment and Segments was unreachable for everyone until it was reported. These two tests pin
// the contract so the next rename fails here instead of in front of the team.
t('parseDef returns `items` and NEVER `rows` — the list page reads the parsed shape directly', () => {
  for (const [name, def] of Object.entries(LIVE)) {
    const p = parseDef(def);
    assert.ok(Array.isArray(p.items), `${name}: items must be an array`);
    assert.equal('rows' in p, false, `${name}: parseDef must not return a \`rows\` key`);
  }
});

t('countConditions counts LEAVES over every live definition, and never throws', () => {
  for (const [name, def] of Object.entries(LIVE)) {
    const n = countConditions(parseDef(def).items);
    assert.ok(Number.isInteger(n) && n >= 0, `${name}: got ${n}`);
  }
  // the empty rule is "everyone", not one blank condition
  assert.equal(countConditions(parseDef({}).items), 0);
  // "(A and B) or C" is 3 conditions, not 2 items
  const nested = { any: [{ all: [{ attr: 'city', op: 'eq', value: 'Pune' }, { attr: 'lifetime_orders', op: 'gte', value: '1' }] }, { attr: 'locale', op: 'eq', value: 'en' }] };
  assert.equal(countConditions(parseDef(nested).items), 3);
  // defensive: a group mid-edit with no rows contributes nothing rather than throwing
  assert.equal(countConditions([{ type: 'group', group: 'any' }]), 0);
});

// ── Inert-condition guard (2026-08-15) ────────────────────────────────────────
// Pinned against the LIVE evaluator's behaviour, not against a reading of it: on 2026-08-15
// `{"none":[{"op":"within_days","attr":"lifetime_orders","value":30}]}` and `{"none":[]}` both
// returned 180,713 matched / 94,585 reachable through comms.preview_segment — identical, i.e.
// the exclusion did nothing. These tests exist so the form can never offer that pairing again.

t('a date operator on a numeric attribute is flagged, not silently accepted', () => {
  const w = conditionWarning({ type: 'attr', attr: 'lifetime_orders', op: 'within_days', value: '30' });
  assert.ok(w, 'lifetime_orders + within_days must warn');
  assert.match(w, /not a date/i);
  assert.match(w, /last_order_at/, 'the warning must name the attribute that DOES work');
  // the same operator on a real date attribute is correct and must stay silent
  assert.equal(conditionWarning({ type: 'attr', attr: 'last_order_at', op: 'within_days', value: '30' }), null);
});

t('operators offered are restricted to what the attribute type can match', () => {
  const ids = (attr) => opsForAttr(attr, OPS_FIXTURE).map((o) => o.id);
  assert.deepEqual(ids('lifetime_orders').includes('within_days'), false);
  assert.deepEqual(ids('last_order_at'), ['before_days', 'within_days']);
  assert.ok(ids('city').includes('eq') && !ids('city').includes('gte'));
  // an attribute we do not know must keep EVERY operator — new ones arrive from Shopify
  // without a code change here, and blocking an unknown is worse than flagging it.
  assert.equal(ids('some_new_shopify_field').length, OPS_FIXTURE.length);
});

t('changing the attribute moves a now-invalid operator instead of leaving it inert', () => {
  // the exact sequence that produced the live fault: a date operator left behind on a number
  assert.equal(defaultOpFor('lifetime_orders', 'within_days'), 'eq');
  // a still-valid operator is never disturbed
  assert.equal(defaultOpFor('lifetime_orders', 'gte'), 'gte');
  assert.equal(defaultOpFor('last_order_at', 'within_days'), 'within_days');
  // unknown attribute: leave the author's choice alone
  assert.equal(defaultOpFor('mystery_field', 'within_days'), 'within_days');
});

t('attributes that match nobody are called out by name', () => {
  for (const dead of ['first', 'locale']) {
    const w = conditionWarning({ type: 'attr', attr: dead, op: 'eq', value: 'x' });
    assert.ok(w && /matches nobody/i.test(w), `${dead} must warn`);
  }
});

t('an inert condition under Match NONE of is marked as WIDENING', () => {
  const bad = { type: 'attr', attr: 'lifetime_orders', op: 'within_days', value: '30' };
  const none = ruleWarnings('none', [bad]);
  assert.equal(none.length, 1);
  assert.equal(none[0].widening, true, 'under `none` an inert condition excludes nobody → everyone');
  // the same condition under `all` is still wrong, but it collapses to 0 and is self-announcing
  assert.equal(ruleWarnings('all', [bad])[0].widening, false);
  // and it must be found inside a nested group too, not just at the top level
  const nested = ruleWarnings('all', [{ type: 'group', group: 'none', rows: [bad] }]);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].widening, true);
});

t('a correct rule produces no warnings at all', () => {
  const clean = [
    { type: 'attr', attr: 'last_order_at', op: 'within_days', value: '90' },
    { type: 'attr', attr: 'lifetime_orders', op: 'gte', value: '1' },
    { type: 'consent', channel: 'whatsapp', purpose: 'marketing', state: 'opted_in' },
    { type: 'event', event: 'product_viewed', count: 1 },
  ];
  assert.deepEqual(ruleWarnings('all', clean), []);
  // ⚠️ AMENDED 2026-08-16 (S289). This used to assert every live definition is warning-FREE. That
  // stopped being true the moment the undercount guard landed — and the exception is a genuine
  // finding, not a regression: `T-30 visitors` is written `lifetime_orders is exactly 0`, which is
  // precisely Mishica's "never bought" case, so it really does address a fraction of the people it
  // reads as. It is the ONLY live segment affected, which is also the evidence that the guard does
  // not cry wolf: 14 of 15 stay silent.
  //
  // What must stay true for every live definition is that none is INERT — an inert live segment
  // would mean we broke a real audience.
  for (const [name, def] of Object.entries(LIVE)) {
    const p = parseDef(def);
    const w = ruleWarnings(p.group, p.items);
    assert.deepEqual(w.filter((x) => x.kind === 'inert'), [], `${name} must have no inert condition`);
    if (name !== 'T-30 visitors') {
      assert.deepEqual(w, [], `${name} should have no warnings at all`);
    }
  }
  // pin the one exception by name, so silencing it needs a deliberate edit here
  const tv = parseDef(LIVE['T-30 visitors']);
  const tvw = ruleWarnings(tv.group, tv.items);
  assert.equal(tvw.length, 1);
  assert.equal(tvw[0].kind, 'undercount');
});

// ── event leaves: the inert class that can only be answered by counting ──────────────────────
t('an event leaf warns ONLY on a counted zero — never while unknown or in flight', () => {
  const row = { type: 'event', event: 'product_viewed', count: 1, count_op: 'gte', within: '30' };
  const key = eventLeafKey(row);
  assert.ok(key, 'a named event leaf has a key');
  // unknown (not yet counted) and a failed check both look like this — and must stay silent
  assert.equal(eventWarning(row, undefined), null);
  assert.equal(eventWarning(row, null), null);
  // a real audience is fine
  assert.equal(eventWarning(row, 4193), null);
  // a counted zero speaks, and names the event and the window
  const w = eventWarning(row, 0);
  assert.ok(w && w.includes('product_viewed'), 'names the event');
  assert.ok(w.includes('30 days'), 'names the normalised window, not the bare number');
  // an unnamed event is a half-written row, not an inert one
  assert.equal(eventLeafKey({ type: 'event', event: '' }), null);
  assert.equal(eventWarning({ type: 'event', event: '' }, 0), null);
});

t('an empty event leaf under Match NONE of is WIDENING, exactly like the attr case', () => {
  const row = { type: 'event', event: 'product_viewed', count: 1, count_op: 'gte', within: '30' };
  const counts = { [eventLeafKey(row)]: 0 };
  const none = ruleWarnings('none', [row], counts);
  assert.equal(none.length, 1);
  assert.equal(none[0].widening, true, 'excludes nobody → the audience is everyone');
  assert.equal(ruleWarnings('all', [row], counts)[0].widening, false);
  // nested one level down, same as the attr guard
  const nested = ruleWarnings('all', [{ type: 'group', group: 'none', rows: [row] }], counts);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].widening, true);
  // and with NO counts supplied at all, nothing is claimed — every existing caller is unchanged
  assert.deepEqual(ruleWarnings('none', [row]), []);
});

t('eventLeaves returns each DISTINCT event leaf once, as a storable leaf', () => {
  const a = { type: 'event', event: 'product_viewed', count: 1, count_op: 'gte', within: '30' };
  const b = { type: 'event', event: 'order_placed', count: 1, count_op: 'gte', within: '' };
  const items = [a, { ...a }, b, { type: 'attr', attr: 'city', op: 'eq', value: 'Pune' }];
  const leaves = eventLeaves('all', items);
  assert.equal(leaves.length, 2, 'the duplicate is one question, not two round trips');
  assert.deepEqual(leaves.map((l) => l.leaf.event).sort(), ['order_placed', 'product_viewed']);
  // the leaf handed back is the STORED shape, so it can go straight into { all: [leaf] }
  assert.equal(leaves.find((l) => l.leaf.event === 'product_viewed').leaf.within, '30 days');
  // rows inside a nested group are found too
  assert.equal(eventLeaves('all', [{ type: 'group', group: 'none', rows: [b] }]).length, 1);
});

// ── absent is not zero (Mishica, #bugs 1786723806.382959) ────────────────────────────────────
t('"never bought" written as lifetime_orders is exactly 0 is flagged as an UNDERCOUNT', () => {
  const row = { type: 'attr', attr: 'lifetime_orders', op: 'eq', value: '0' };
  const w = coverageWarning(row);
  assert.ok(w, 'must warn');
  assert.ok(w.includes('53%'), 'names the share with no value (100 - 47.0 coverage)');
  assert.ok(w.includes('Match NONE of'), 'gives the rule that actually works');
  // it is NOT the inert class — the condition is well-formed and matches real people
  assert.equal(conditionWarning(row), null);
  const warns = ruleWarnings('all', [row]);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].kind, 'undercount');
  assert.equal(warns[0].widening, false, 'red is reserved for "the audience is everyone"');
});

t('only the "means none" shapes warn, and only on a SPARSE attribute', () => {
  const on = (o) => coverageWarning({ type: 'attr', attr: 'lifetime_orders', ...o });
  assert.ok(on({ op: 'eq', value: '0' }));
  assert.ok(on({ op: 'lte', value: '0' }));
  assert.ok(on({ op: 'lt', value: '1' }));
  // "at least 1" also skips absent profiles, but nobody reads it as "everyone" — no warning
  assert.equal(on({ op: 'gte', value: '1' }), null);
  assert.equal(on({ op: 'eq', value: '3' }), null);
  assert.equal(on({ op: 'gt', value: '0' }), null);
  // an attribute we have no coverage figure for stays silent rather than guessing
  assert.equal(coverageWarning({ type: 'attr', attr: 'something_new', op: 'eq', value: '0' }), null);
  // non-attr rows are not this function's business
  assert.equal(coverageWarning({ type: 'event', event: 'order_placed', count: 0 }), null);
  assert.ok(meansNone({ op: 'eq', value: 0 }));
  assert.ok(!meansNone({ op: 'eq', value: 'abc' }));
});

t('an inert AND undercounting row reports BOTH — fixing one does not fix the other', () => {
  // a date operator on a numeric attr (inert) that also means "none" on a sparse attr
  const row = { type: 'attr', attr: 'lifetime_orders', op: 'eq', value: '0' };
  const dead = { type: 'attr', attr: 'lifetime_orders', op: 'within_days', value: '30' };
  const warns = ruleWarnings('none', [dead, row]);
  assert.equal(warns.length, 2);
  assert.equal(warns[0].kind, 'inert', 'the widening inert one sorts first');
  assert.equal(warns[0].widening, true);
  assert.equal(warns[1].kind, 'undercount');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
