// partnerGstinGate — the GSTIN-or-"not registered" gate on createSalesPartner / updateSalesPartner.
// Pure, and lives only in the single-file worker (no named exports), so — like prior-tds.test.mjs —
// the test lifts its source text straight out of index.js.
// ⛔ decisions §S335: the tick must leave gstin NULL and put the marker in notes (a sentinel in gstin
// prints on live GST documents); the gap check keys on notes ilike '%GST: not registered%'.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  lift('const GSTIN_RE =', '\n// Recompute an order'),
  'return { partnerGstinGate, GST_UNREGISTERED_MARKER };',
].join('\n');
const { partnerGstinGate: gate, GST_UNREGISTERED_MARKER } = new Function(code)();

const STAMP = 'ticked by Tanya on 2026-09-11';
// The live pass check, verbatim: notes ilike '%GST: not registered%'.
const passesGapCheck = notes => String(notes || '').toLowerCase().includes('gst: not registered');

test('the marker phrase is the one the live gap check keys on', () => {
  assert.equal(GST_UNREGISTERED_MARKER, 'GST: not registered');
});

// ── create ──
test('create: a valid GSTIN is trimmed + uppercased', () => {
  assert.deepEqual(gate({ gstin: ' 29aaxfd3493p1z8 ' }, null, STAMP), { gstin: '29AAXFD3493P1Z8' });
});

test('create: neither a GSTIN nor the tick → refused', () => {
  assert.match(gate({}, null, STAMP).error, /GSTIN required/);
  assert.match(gate({ gstin: '' }, null, STAMP).error, /GSTIN required/);
  assert.match(gate({ gstin: '   ' }, null, STAMP).error, /GSTIN required/);
  assert.match(gate({ gstin: null, unregistered: 'yes' }, null, STAMP).error, /GSTIN required/); // only literal true ticks
});

test('create: malformed GSTINs are refused — the live sentinels included', () => {
  for (const bad of ['URP', 'NA', 'Unregistered', 'T33AAVCS1691R2ZB', '29AAXFD3493P1Z', '29AAXFD3493P1Y8', '2XAAXFD3493P1Z8'])
    assert.match(gate({ gstin: bad }, null, STAMP).error || '', /not a valid GSTIN/, bad);
});

test('create: the tick leaves gstin NULL and writes the marker to notes', () => {
  const r = gate({ gstin: '', unregistered: true }, null, STAMP);
  assert.equal(r.gstin, null);
  assert.ok(r.notes.startsWith('GST: not registered — ticked by Tanya on 2026-09-11.'));
  assert.ok(passesGapCheck(r.notes));
});

test('create: the tick appends to existing notes with the " | " separator', () => {
  const r = gate({ unregistered: true, notes: 'Bengaluru retailer ' }, null, STAMP);
  assert.ok(r.notes.startsWith('Bengaluru retailer | GST: not registered'));
});

test('create: a GSTIN AND the tick → refused (ambiguous)', () => {
  assert.match(gate({ gstin: '29AAXFD3493P1Z8', unregistered: true }, null, STAMP).error, /not both/);
});

// ── edit ──
const withG = { gstin: '36AAXFD3493P1ZD', notes: null };
const blank = { gstin: null, notes: 'Created from Tally backfill' };

test('edit: leaves a legacy blank row alone (not blocked)', () => {
  assert.deepEqual(gate({ gstin: null }, blank, STAMP), { gstin: null });
  assert.deepEqual(gate({ gstin: '' }, blank, STAMP), { gstin: null });
  assert.deepEqual(gate({}, blank, STAMP), {});
});

test('edit: clearing an existing GSTIN without the tick → refused', () => {
  assert.match(gate({ gstin: '' }, withG, STAMP).error, /to clear it/);
  assert.match(gate({ gstin: null }, withG, STAMP).error, /to clear it/);
});

test('edit: clearing an existing GSTIN WITH the tick → NULL + marker', () => {
  const r = gate({ gstin: null, unregistered: true }, withG, STAMP);
  assert.equal(r.gstin, null);
  assert.ok(passesGapCheck(r.notes));
});

test('edit: the tick with notes omitted appends to the stored notes', () => {
  const r = gate({ unregistered: true }, blank, STAMP);
  assert.ok(r.notes.startsWith('Created from Tally backfill | GST: not registered'));
});

test('edit: an already-marked row is not marked twice', () => {
  const notes = 'GST: not registered — confirmed by finance (Prarthi) 2026-09-02, #finance-all. Blank GSTIN is correct; do not re-flag as a gap.';
  assert.deepEqual(gate({ gstin: null, unregistered: true, notes }, { gstin: null, notes }, STAMP), { gstin: null, notes });
});

test('edit: changing to a malformed GSTIN → refused; a legacy odd value re-saved unchanged → allowed', () => {
  assert.match(gate({ gstin: 'NA' }, withG, STAMP).error, /not a valid GSTIN/);
  assert.deepEqual(gate({ gstin: 'URP' }, { gstin: 'URP', notes: null }, STAMP), { gstin: 'URP' });
});

test('edit: changing to a valid GSTIN is normalised', () => {
  assert.deepEqual(gate({ gstin: '29aaxfd3493p1z8' }, blank, STAMP), { gstin: '29AAXFD3493P1Z8' });
});

// S376 review: unticking "Not GST-registered" (or entering a real GSTIN) removes the marker from notes,
// so the gap check stops excluding a partner the user just un-marked. Other note segments survive.
test('edit: explicit untick strips the marker, keeps other notes', () => {
  const marked = { gstin: null, notes: `Retail | ${GST_UNREGISTERED_MARKER} — ticked by X on 2026-09-11. Blank GSTIN is correct; do not re-flag as a gap.` };
  assert.deepEqual(gate({ gstin: null, unregistered: false }, marked, STAMP), { gstin: null, notes: 'Retail' });
  assert.deepEqual(gate({ gstin: '29aaxfd3493p1z8', unregistered: false }, marked, STAMP), { gstin: '29AAXFD3493P1Z8', notes: 'Retail' });
  const only = { gstin: null, notes: `${GST_UNREGISTERED_MARKER} — x` };
  assert.deepEqual(gate({ unregistered: false }, only, STAMP), { notes: null });
});
test('edit: untick on a partner with no marker changes no notes', () => {
  assert.deepEqual(gate({ gstin: null, unregistered: false }, { gstin: null, notes: 'Retail' }, STAMP), { gstin: null });
});
test('edit: tick still kept on a marked partner (form restores it) leaves notes alone', () => {
  const marked = { gstin: null, notes: `${GST_UNREGISTERED_MARKER} — x` };
  assert.deepEqual(gate({ gstin: null, unregistered: true }, marked, STAMP), { gstin: null, notes: marked.notes });
});
