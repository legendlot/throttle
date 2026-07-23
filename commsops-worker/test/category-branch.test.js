// Category-voice branching (S232): classifyTitles (event enrichment) + evalEventProperty
// (the event_property condition node). Both pure — no DB, no interpreter.
const assert = require('assert');
const { classifyTitles } = require('../src/product-category.js');
const { evalEventProperty } = require('../src/journey-graph.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

// Taxonomy rows as loadTaxonomy() shapes them (product lowercased).
const TAX = [
  { product: 'shadow', category: 'L.O.T Cars' },
  { product: 'flare 2.0', category: 'L.O.T Cars' },
  { product: 'wisp', category: 'L.O.T Cars' },
  { product: 'colosseum', category: 'L.O.T Build' },
  { product: 'taj mahal', category: 'L.O.T Build' },
  { product: 'diy drone', category: 'L.O.T Build' },
];

t('RC title → L.O.T Cars', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow - RC Drift Car', TAX), 'L.O.T Cars'));

t('Build title → L.O.T Build', () =>
  assert.equal(classifyTitles('The Colosseum — Wooden Puzzle Kit', TAX), 'L.O.T Build'));

t('mixed cart → Build wins', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow - RC Drift Car, Taj Mahal Kit', TAX), 'L.O.T Build'));

t('add-on only ("Gift Wrapping") → null, not a wrong guess', () =>
  assert.equal(classifyTitles('Gift Wrapping', TAX), null));

t('aviation title matches by product name, not brand prefix', () =>
  assert.equal(classifyTitles('L.O.T Aviation Wisp', TAX), 'L.O.T Cars'));

t('array input + case-insensitive', () =>
  assert.equal(classifyTitles(['THE COLOSSEUM'], TAX), 'L.O.T Build'));

t('empty taxonomy → null (never throws)', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow', []), null));

// ── evalEventProperty ──
const P = { primary_category: 'L.O.T Build', total: '2199', financial_status: 'pending' };

t('eq matches case-insensitively', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'eq', value: 'l.o.t build' }, P), true));

t('eq mismatch → false', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'eq', value: 'L.O.T Cars' }, P), false));

t('neq', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'neq', value: 'L.O.T Cars' }, P), true));

t('contains', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'contains', value: 'build' }, P), true));

t('in (comma list, spaces tolerated)', () =>
  assert.equal(evalEventProperty({ field: 'financial_status', op: 'in', value: 'pending, authorized' }, P), true));

t('missing property compares as empty string — eq "" is TRUE, eq value is FALSE', () => {
  assert.equal(evalEventProperty({ field: 'nope', op: 'eq', value: '' }, P), true);
  assert.equal(evalEventProperty({ field: 'nope', op: 'eq', value: 'x' }, P), false);
});

t('contains with empty value → false (never a match-everything)', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'contains', value: '' }, P), false));

t('null props / null check → safe false', () => {
  assert.equal(evalEventProperty({ field: 'a', op: 'eq', value: 'x' }, null), false);
  assert.equal(evalEventProperty(null, P), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
