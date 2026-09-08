// planHsnSync is a pure planner inside the single-file worker (no named exports), so the
// test lifts its source text — plus normHsn / isPlausibleHsn — straight out of index.js.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); return src.slice(i, j); };
const code = lift('const normHsn = ', '\n// ') + '\n' + lift('function planHsnSync(', '\n// Apply a plan') + '\nreturn planHsnSync;';
const planHsnSync = new Function(code)();

const master = new Map([['Wooden Garage', { hsn: '95030010', gst: 5 }], ['NoRate', { hsn: '4819', gst: null }]]);
const prev = (...pairs) => new Map(pairs);

test('edit by a viewer: untouched stale line re-aligned, master untouched', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: '9503 6010', gst_pct: 18 }], master, prev(['a', '95036010']), false);
  assert.equal(r.realign.length, 1); assert.equal(r.lines[0].hsn_code, '95030010'); assert.equal(r.lines[0].gst_pct, 5);
  assert.equal(r.pushes.size, 0); assert.equal(r.blocked.length, 0);
});
test('edit by a viewer who TYPES a new code: blocked (role) + line reset to master', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: '9503' }], master, prev(['a', '95030010']), false);
  assert.equal(r.blocked.length, 1); assert.equal(r.blocked[0].reason, 'role'); assert.equal(r.realign.length, 1);
  assert.equal(r.lines[0].hsn_code, '95030010'); assert.equal(r.pushes.size, 0);
});
test('edit by finance who types a new code: pushes, line kept', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: '9503' }], master, prev(['a', '95030010']), true);
  assert.equal(r.pushes.get('Wooden Garage').to, '9503'); assert.equal(r.realign.length, 0); assert.equal(r.lines[0].hsn_code, '9503');
});
test('admin, untouched stale line: re-aligned, NOT pushed (the Vinay case)', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: '9503' }], master, prev(['a', '9503']), true);
  assert.equal(r.pushes.size, 0); assert.equal(r.realign.length, 1); assert.equal(r.lines[0].hsn_code, '95030010');
});
test('line agreeing with master (spaces ignored) is untouched', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: '9503 0010', gst_pct: 5 }], master, prev(['a', '95030010']), false);
  assert.equal(r.realign.length, 0); assert.equal(r.pushes.size, 0); assert.equal(r.lines[0].hsn_code, '9503 0010');
});
test('create: viewer foreign code re-aligned + blocked; admin foreign code pushes', () => {
  let r = planHsnSync([{ product: 'Wooden Garage', hsn_code: '9503' }], master, null, false);
  assert.equal(r.realign.length, 1); assert.equal(r.lines[0].hsn_code, '95030010'); assert.equal(r.blocked.length, 1);
  r = planHsnSync([{ product: 'Wooden Garage', hsn_code: '9503' }], master, null, true);
  assert.equal(r.pushes.size, 1); assert.equal(r.realign.length, 0);
});
test('product the master has no code for is left alone', () => {
  const r = planHsnSync([{ product: 'Unknown', hsn_code: '9999' }], master, null, false);
  assert.equal(r.realign.length, 0); assert.equal(r.blocked.length, 0); assert.equal(r.lines[0].hsn_code, '9999');
});
test('admin types junk: master wins on the line, no push', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: 'abc' }], master, prev(['a', '95030010']), true);
  assert.equal(r.pushes.size, 0); assert.equal(r.realign.length, 1); assert.equal(r.lines[0].hsn_code, '95030010');
});
test('master has hsn but no rate: hsn re-aligned, gst_pct left as-is', () => {
  const r = planHsnSync([{ id: 'a', product: 'NoRate', hsn_code: '4820', gst_pct: 12 }], master, prev(['a', '4820']), false);
  assert.equal(r.lines[0].hsn_code, '4819'); assert.equal(r.lines[0].gst_pct, 12);
});
test('blank hsn on an EXISTING line is filled AND reported (SO-0310 case); blank on CREATE is a silent default', () => {
  let r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: null, gst_pct: 5 }], master, prev(['a', '']), false);
  assert.equal(r.realign.length, 1); assert.equal(r.realign[0].from, null); assert.equal(r.lines[0].hsn_code, '95030010');
  r = planHsnSync([{ product: 'Wooden Garage', hsn_code: '' }], master, null, false);
  assert.equal(r.realign.length, 0); assert.equal(r.lines[0].hsn_code, '95030010'); assert.equal(r.lines[0].gst_pct, 5);
});
test('admin types TWO different codes for one product: conflict — no push, both lines reset to master', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: '9503' }, { id: 'b', product: 'Wooden Garage', hsn_code: '95030030' }],
    master, prev(['a', '95030010'], ['b', '95030010']), true);
  assert.equal(r.pushes.size, 0); assert.equal(r.blocked.length, 2); assert.ok(r.blocked.every(b => b.reason === 'conflict'));
  assert.ok(r.lines.every(l => l.hsn_code === '95030010'));
});
test('numeric hsn_code does not throw and normalises', () => {
  const r = planHsnSync([{ id: 'a', product: 'Wooden Garage', hsn_code: 95030010 }], master, prev(['a', '95030010']), false);
  assert.equal(r.realign.length, 0);
});
