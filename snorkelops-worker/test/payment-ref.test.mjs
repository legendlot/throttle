// parseUtr / parsePaidAmount are pure and live only in the single-file worker (no named exports),
// so — like prior-tds.test.mjs — the test lifts their source text straight out of index.js.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  lift('function parseUtr(', '\n// ⚠️⚠️ REQUESTER NOTE'),
  'return { parseUtr, parsePaidAmount };',
].join('\n');
const { parseUtr, parsePaidAmount } = new Function(code)();

test('parseUtr: empty, whitespace-only and null are all "UTR is required"', () => {
  assert.equal(parseUtr('').error, 'UTR is required');
  assert.equal(parseUtr('   ').error, 'UTR is required');
  assert.equal(parseUtr(null).error, 'UTR must be text');
});

test('parseUtr: trims and collapses internal whitespace', () => {
  assert.deepEqual(parseUtr(' UTR 123 '), { value: 'UTR 123', error: null });
  assert.equal(parseUtr(' UTR    123 ').value, 'UTR 123');
});

test('parseUtr: over 64 characters is an error', () => {
  const r = parseUtr('X'.repeat(65));
  assert.equal(r.value, null);
  assert.ok(r.error);
});

test('parseUtr: non-scalar / non-string input is an error, never coerced', () => {
  assert.ok(parseUtr([]).error);
  assert.ok(parseUtr(5).error);
});

test('parsePaidAmount: absent (blank/whitespace/undefined) → value null, no error', () => {
  assert.deepEqual(parsePaidAmount(''), { value: null, error: null });
  assert.deepEqual(parsePaidAmount('  '), { value: null, error: null });
  assert.deepEqual(parsePaidAmount(undefined), { value: null, error: null });
  assert.deepEqual(parsePaidAmount(null), { value: null, error: null });
});

test('parsePaidAmount: a numeric string parses to a number', () => {
  assert.deepEqual(parsePaidAmount('4484'), { value: 4484, error: null });
});

test('parsePaidAmount: unparseable, negative and non-scalar inputs are errors', () => {
  assert.ok(parsePaidAmount('12x').error);
  assert.ok(parsePaidAmount(-1).error);
  assert.ok(parsePaidAmount([5]).error);
  assert.ok(parsePaidAmount(true).error);
});
