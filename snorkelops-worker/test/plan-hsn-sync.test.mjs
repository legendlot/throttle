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

// ── Part side (PO lines → material_master), S358 hostile-review finding 9 ────────────
const partMaster = new Map([['HW-SC-23-8', { hsn: '73181500', gst: 18 }], ['UNV-AU-GLUE-01', { hsn: '3506', gst: null }]]);
const partOpts = new Function(lift('const PART_HSN_OPTS = ', ';') + '; return PART_HSN_OPTS;')();   // lifted, not retyped

test('parts: create by a buyer with a stale code → master wins on the line, no push, blocked(role)', () => {
  const r = planHsnSync([{ part_code: 'HW-SC-23-8', hsn_code: '7318', gst_percent: 18 }], partMaster, null, false, partOpts);
  assert.equal(r.pushes.size, 0); assert.equal(r.blocked.length, 1); assert.equal(r.lines[0].hsn_code, '73181500');
});
test('parts: create by admin with a new code → pushes for that part_code only', () => {
  const r = planHsnSync([{ part_code: 'HW-SC-23-8', hsn_code: '73181600' }, { part_code: 'UNV-AU-GLUE-01', hsn_code: '3506' }], partMaster, null, true, partOpts);
  assert.equal(r.pushes.size, 1); assert.equal(r.pushes.get('HW-SC-23-8').to, '73181600'); assert.equal(r.realign.length, 0);
});
test('parts: amend-replace by admin, line unchanged vs the existing line but stale vs master → re-aligned, NOT pushed', () => {
  const r = planHsnSync([{ part_code: 'HW-SC-23-8', hsn_code: '7318', gst_percent: 18 }], partMaster, prev(['HW-SC-23-8', '7318']), true, partOpts);
  assert.equal(r.pushes.size, 0); assert.equal(r.realign.length, 1); assert.equal(r.lines[0].hsn_code, '73181500'); assert.equal(r.lines[0].gst_percent, 18);
});
test('parts: line with no part_code (description-only) is ignored', () => {
  const r = planHsnSync([{ part_code: null, hsn_code: '9999' }], partMaster, null, true, partOpts);
  assert.equal(r.pushes.size, 0); assert.equal(r.realign.length, 0); assert.equal(r.lines[0].hsn_code, '9999');
});
test('parts: master hsn with no rate re-aligns the code and leaves gst_percent alone', () => {
  const r = planHsnSync([{ part_code: 'UNV-AU-GLUE-01', hsn_code: '35061000', gst_percent: 12 }], partMaster, prev(['UNV-AU-GLUE-01', '35061000']), false, partOpts);
  assert.equal(r.lines[0].hsn_code, '3506'); assert.equal(r.lines[0].gst_percent, 12);
});

test('parts: divergent rate — line gst_percent 12 vs master 18 moves to 18 on re-align (guards the gst field name)', () => {
  const r = planHsnSync([{ part_code: 'HW-SC-23-8', hsn_code: '7318', gst_percent: 12 }], partMaster, prev(['HW-SC-23-8', '7318']), false, partOpts);
  assert.equal(r.lines[0].hsn_code, '73181500'); assert.equal(r.lines[0].gst_percent, 18); assert.equal(r.lines[0].gst_pct, undefined);
});

// S376: a GST HSN is 4, 6 or 8 digits — never 5 or 7. `4411140` (a 7-digit truncation) passed the old
// \d{4,8} check and was pushed onto two part masters from IN-CMP-0494.
test('isPlausibleHsn accepts only 4/6/8-digit codes', () => {
  const plausible = new Function(lift('const normHsn = ', '\n// ') + '\nreturn isPlausibleHsn;')();
  for (const ok of ['4411', '441114', '44111400', ' 4411 14 00 ']) assert.equal(plausible(ok), true, ok);
  for (const bad of ['4411140', '44111', '441', '441114000', '4411-14', '', null, 'URP']) assert.equal(plausible(bad), false, String(bad));
});
