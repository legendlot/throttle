// The China/Soft gate on the PO line export exists twice: `gatePoLines` in
// apps/snorkel/src/lib/poExport.js (the spec, tested by po-export.test.mjs — but with no
// production caller) and the worker's own copy under `PO LINES GATE` in src/index.js, which is
// the one `getPOLinesBulk` actually ENFORCES. The worker is a zero-import single file and cannot
// import the lib, so this file lifts the worker's block straight out of index.js — like
// tds-parity.test.mjs — and asserts both copies return the same lines on a grid.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gatePoLines } from '../../apps/snorkel/src/lib/poExport.js';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  // The gate calls the worker's stripChinaPOLine — lift that too, so the strip is the worker's.
  lift('function stripChinaPOLine(', '\n}\n') + '\n}',
  lift('// ⚠️⚠️ PO LINES GATE', '// ── end PO LINES GATE'),
  'return { poLinesAllowed, gatePoLinesByPo };',
].join('\n');
const { poLinesAllowed, gatePoLinesByPo } = new Function(code)();

// The worker's full path as getPOLinesBulk runs it: allowed set from the header rows, then the
// lines grouped by PO. Flattened back to one list in PO-then-line order for the comparison.
function workerGate(headers, lines, canChina) {
  return gatePoLinesByPo(poLinesAllowed(headers, canChina), lines);
}
// The lib returns a flat list in input order; group it the same way the worker does.
function libGate(headers, lines, canChina) {
  const headersByPo = Object.fromEntries(headers.map(h => [h.po_number, h]));
  const byPo = {};
  for (const l of gatePoLines({ lines, headersByPo, canChina })) (byPo[l.po_number] ||= []).push(l);
  return byPo;
}

// Every status × source × missing-field combination a header can arrive in.
const STATUSES = ['Draft', 'Approved', 'Sent', 'Soft', undefined, null, ''];
const SOURCES  = ['India', 'China', undefined, null, ''];
const headers = [];
let n = 0;
for (const status of STATUSES) for (const source of SOURCES) {
  const h = { po_number: `PO-${n++}`, vendor_name: 'V' };
  if (status !== undefined) h.status = status;
  if (source !== undefined) h.source = source;
  headers.push(h);
}

// Two lines per PO (one with money, one with a field missing), plus lines whose PO has no header
// and a line with no po_number at all — both must be dropped by both copies.
const lines = [];
for (const h of headers) {
  lines.push({ po_number: h.po_number, line_no: 1, part_code: 'SH-PB-46', qty_ordered: 10,
               unit_price: 120, total_value: 1200, gst_percent: 18 });
  lines.push({ po_number: h.po_number, line_no: 2, part_code: 'SH-PB-47', qty_ordered: 5 });
}
lines.push({ po_number: 'PO-NO-HEADER', line_no: 1, unit_price: 9, total_value: 9 });
lines.push({ line_no: 1, unit_price: 9, total_value: 9 });

test('worker PO LINES GATE === lib gatePoLines on a status × source × canChina grid', () => {
  for (const canChina of [false, true]) {
    assert.deepEqual(workerGate(headers, lines, canChina), libGate(headers, lines, canChina),
      `diverged with canChina=${canChina}`);
  }
});

test('the grid actually exercises the gate (not two empty answers agreeing)', () => {
  const restricted = workerGate(headers, lines, false);
  const full       = workerGate(headers, lines, true);
  // Soft POs vanish for a caller without po_china, whatever the source.
  const soft = headers.filter(h => h.status === 'Soft').map(h => h.po_number);
  assert.equal(soft.length, SOURCES.length);
  for (const po of soft) { assert.equal(restricted[po], undefined); assert.equal(full[po].length, 2); }
  // China lines survive without the two money fields; India keeps them.
  const cn = headers.find(h => h.source === 'China' && h.status === 'Approved').po_number;
  const inn = headers.find(h => h.source === 'India' && h.status === 'Approved').po_number;
  assert.equal(restricted[cn].length, 2);
  assert.ok(!('unit_price' in restricted[cn][0]) && !('total_value' in restricted[cn][0]));
  assert.equal(full[cn][0].unit_price, 120);
  assert.equal(restricted[inn][0].unit_price, 120);
  // Orphan and po_number-less lines are dropped by the worker copy too.
  assert.equal(restricted['PO-NO-HEADER'], undefined);
  assert.equal(full['PO-NO-HEADER'], undefined);
  assert.equal(full.undefined, undefined);
});

test('empty and absent inputs agree', () => {
  for (const canChina of [false, true]) {
    assert.deepEqual(workerGate([], lines, canChina), {});
    assert.deepEqual(workerGate(headers, [], canChina), {});
    assert.deepEqual(gatePoLinesByPo(poLinesAllowed(null, canChina), null), {});
    assert.deepEqual(libGate([], lines, canChina), {});
  }
});
