// Segment rule-shape warnings. Run from apps/relay:
//   node src/lib/segmentAst.test.mjs
//
// The property under test: a `Match NONE of` group directly inside a `Match ANY of` root must
// warn, and must warn as WIDENING. That shape does not exclude — `A OR B OR NOT C` matches
// everyone who is merely not C, so the group meant to remove people adds nearly all of them.
// Mishica hit it on 2026-09-09 and the segment matched 227,067 instead of ~1,992, with nothing on
// screen to say so: an over-large count has no tell, which is the whole reason this warning
// exists rather than trusting Preview's single number.
//
// `widening: true` is load-bearing, not cosmetic. The page reserves the red banner and the
// headline "This rule excludes nobody — the audience is currently everyone" for it; downgrading
// it to amber would file this alongside undercounts, which are the harmless direction.

import assert from 'node:assert/strict';
import { structuralWarnings, ruleWarnings } from './segmentAst.js';

let pass = 0;
const t = (name, fn) => { fn(); pass += 1; console.log('  ok  ' + name); };

const noneGroup = { type: 'group', group: 'none', rows: [] };
const anyGroup = { type: 'group', group: 'any', rows: [] };
const row = { type: 'attr', attr: 'city', op: 'eq', value: 'Pune' };

t('NONE directly inside ANY warns, and warns as widening', () => {
  const w = structuralWarnings('any', [row, noneGroup]);
  assert.equal(w.length, 1);
  assert.equal(w[0].widening, true, 'must be the red/everyone class, not an undercount');
  assert.equal(w[0].kind, 'structure');
  assert.match(w[0].text, /Match ALL of/, 'must name the fix, not just the fault');
});

t('the correct shape — NONE under an ALL root — says nothing', () => {
  assert.deepEqual(structuralWarnings('all', [anyGroup, noneGroup]), []);
});

t('ANY with no NONE child says nothing', () => {
  assert.deepEqual(structuralWarnings('any', [row, anyGroup]), []);
});

t('a NONE root is not the fault — that is a plain exclusion rule', () => {
  assert.deepEqual(structuralWarnings('none', [row]), []);
});

t('two offending groups produce ONE warning that counts them, not two identical lines', () => {
  const w = structuralWarnings('any', [noneGroup, row, { ...noneGroup }]);
  assert.equal(w.length, 1);
  assert.match(w[0].text, /^2 /);
});

t('empty and missing items are not a throw', () => {
  assert.deepEqual(structuralWarnings('any', []), []);
  assert.deepEqual(structuralWarnings('any', undefined), []);
});

t('ruleWarnings surfaces it, and sorts it above per-row warnings', () => {
  const all = ruleWarnings('any', [row, noneGroup], {});
  assert.ok(all.length >= 1);
  assert.equal(all[0].kind, 'structure', 'the shape fault must lead — every row warning below it describes a rule that does not mean what it says');
  assert.equal(all[0].widening, true);
});

console.log(`\n${pass} passed`);
