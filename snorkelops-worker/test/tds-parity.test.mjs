// The worker holds an INLINE copy of computeTds (search `TDS — VERBATIM PORT` in src/index.js) —
// it is a zero-import single file and cannot import apps/snorkel/src/lib/tds.js. Finance sees the
// app copy's number before clicking Mark paid and the worker STORES its own, so the two must agree
// to the paisa. tds.test.mjs is the spec (run against the app copy); this file lifts the worker's
// block straight out of index.js — like prior-tds.test.mjs — and asserts it returns the same
// thing as the app copy on a grid, errors included. Also covers poGstRateByPo (worker-only).
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTds as appComputeTds, GST_RATES } from '../../apps/snorkel/src/lib/tds.js';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  lift('// ⚠️⚠️ TDS — VERBATIM PORT', '\n// ── Prior TDS on the same invoice'),
  'return { computeTds, poGstRateByPo, TDS_GST_RATES };',
].join('\n');
const { computeTds: workerComputeTds, poGstRateByPo, TDS_GST_RATES } = new Function(code)();

test('the worker and the app agree on the GST rate list', () => {
  assert.deepEqual(TDS_GST_RATES, GST_RATES);
});

test('worker computeTds === app computeTds on a grid (amounts, bases AND error strings)', () => {
  const totals = [0, 1, 1000, 1000.05, 1234.56, 12345.67, 99999.99, 105000, 118000, '118000.00',
                  '42180.38', 1e7 + 0.01, -1, null, undefined, '', 'abc'];
  const rates  = [null, undefined, '', '  ', 0, '0', 0.1, 1, 2, '2', ' 5 ', 7.5, 10, 100, 100.01,
                  -1, '12x', NaN, Infinity, true, false, [], [5], {}];
  const gsts   = [null, undefined, '', ' ', 0, 5, 12, 18, 28, '18', ' 18 ', '5.00', 7, 18.5, -5,
                  '12x', true, [18], {}];
  let n = 0;
  for (const invoiceTotal of totals) for (const rate of rates) for (const gstRate of gsts) {
    const args = { invoiceTotal, rate, gstRate };
    assert.deepEqual(workerComputeTds(args), appComputeTds(args),
      `diverged on ${JSON.stringify(args)} (rate ${String(rate)}, gst ${String(gstRate)})`);
    n++;
  }
  assert.ok(n > 7000, `grid too small: ${n}`);
});

test('the worker stores the taxable base: 118000 @ 18% GST, 2% TDS → base 100000, TDS 2000', () => {
  assert.deepEqual(workerComputeTds({ invoiceTotal: '118000.00', rate: 2, gstRate: 18 }),
                   { tdsAmount: 2000, tdsBase: 100000, error: null });
});

test('poGstRateByPo: one distinct rate per PO, null when mixed or absent', () => {
  const m = poGstRateByPo([
    { po_number: 'IN-RM-0042', gst_percent: '18.00' },
    { po_number: 'IN-RM-0042', gst_percent: '18' },      // same rate, different text
    { po_number: 'IN-PK-0007', gst_percent: '5.00' },
    { po_number: 'IN-MX-0001', gst_percent: '5.00' },
    { po_number: 'IN-MX-0001', gst_percent: '18.00' },   // mixed → no single rate
    { po_number: 'IN-NL-0003', gst_percent: null },       // no rate on the line
    { po_number: 'IN-HN-0004', gst_percent: '12.00' },
    { po_number: 'IN-HN-0004', gst_percent: null },       // a rate and a blank → not single
    { po_number: null, gst_percent: '28' },               // no PO → ignored
    null,
  ]);
  assert.deepEqual(m, {
    'IN-RM-0042': 18, 'IN-PK-0007': 5, 'IN-MX-0001': null, 'IN-NL-0003': null, 'IN-HN-0004': null,
  });
  assert.deepEqual(poGstRateByPo([]), {});
  assert.deepEqual(poGstRateByPo(null), {});
  // A PO with no lines is simply absent — callers read `?? null`.
  assert.equal(m['IN-XX-9999'] ?? null, null);
});
