// PO tax parity — the printed PO and the Slack-DM'd PDF must agree to the paisa.
//
// computeTax lives in apps/snorkel/src/lib/poTax.js (screen) and is VERBATIM-PORTED as
// computePoTax in snorkelops-worker/src/index.js (PDF). Two implementations of the same
// tax math is a correctness hazard, so this asserts they cannot drift.
//
// It does NOT test a copy: the worker's function is extracted from the shipped source
// file and evaluated, so editing one side without the other fails here.
//
//   node scripts/test-po-tax-parity.mjs
//
// Fixtures are real shapes pulled from store.po_lines on 2026-09-04 (INR intra-state,
// zero-value RMB import lines, null gst_percent, total_value present and absent) plus a
// synthetic inter-state vendor, which live data had none of.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { computeTax } = await import(join(here, '../apps/snorkel/src/lib/poTax.js'));

// Pull computePoTax (and its helper + constant) straight out of the worker source.
const src = readFileSync(join(here, '../snorkelops-worker/src/index.js'), 'utf8');
function grab(name, kind = 'function') {
  const start = src.indexOf(kind === 'function' ? `function ${name}(` : `const ${name} =`);
  if (start < 0) throw new Error(`could not find ${name} in the worker source`);
  if (kind !== 'function') return src.slice(start, src.indexOf('\n', start) + 1);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}
const workerComputePoTax = new Function(
  `${grab('PO_DEFAULT_COMPANY_GSTIN', 'const')}\n${grab('poLineAmount')}\n${grab('computePoTax')}\nreturn computePoTax;`
)();

const KA = '29AAFCF7834H1ZA';   // LOT, Karnataka
const MH = '27AAAAA0000A1Z5';   // synthetic inter-state vendor

const cases = [
  ['IN-CMP-0027 single 18% line, no vendor GSTIN (intra)',
    [{ qty_ordered: 200, unit_price: 6, total_value: 1200, gst_percent: 18 }], 'INR', null],
  ['IN-CMP-0057 two 18% lines',
    [{ qty_ordered: 132, unit_price: 36, total_value: 4752, gst_percent: 18 },
     { qty_ordered: 428, unit_price: 36, total_value: 15408, gst_percent: 18 }], 'INR', null],
  ['inter-state vendor -> IGST',
    [{ qty_ordered: 10, unit_price: 100, total_value: 1000, gst_percent: 18 }], 'INR', MH],
  ['same-state vendor -> CGST/SGST',
    [{ qty_ordered: 10, unit_price: 100, total_value: 1000, gst_percent: 18 }], 'INR', KA],
  ['CN-CMP-0040 zero-value import lines, null gst',
    [{ qty_ordered: 6000, unit_price: null, total_value: 0, gst_percent: null },
     { qty_ordered: 6000, unit_price: null, total_value: 0, gst_percent: null }], 'INR', null],
  ['RMB currency -> no GST at all',
    [{ qty_ordered: 500, unit_price: 2.5, total_value: 1250, gst_percent: 18 }], 'RMB', null],
  ['USD currency -> no GST',
    [{ qty_ordered: 5, unit_price: 20, total_value: 100, gst_percent: 18 }], 'USD', null],
  ['total_value absent -> derived from qty x price',
    [{ qty_ordered: 7, unit_price: 13.5, total_value: null, gst_percent: 12 }], 'INR', null],
  ['mixed rates -> blended half/full rate',
    [{ qty_ordered: 1, unit_price: 100, total_value: 100, gst_percent: 18 },
     { qty_ordered: 1, unit_price: 100, total_value: 100, gst_percent: 5 }], 'INR', null],
  ['empty PO', [], 'INR', null],
  ['strings from PostgREST (numerics arrive as text)',
    [{ qty_ordered: '25', unit_price: '4.40', total_value: '110.00', gst_percent: '18' }], 'INR', null],
];

let failed = 0;
for (const [name, lines, currency, vendorGstin] of cases) {
  const a = computeTax(lines, currency, vendorGstin, KA);
  const b = workerComputePoTax(lines, currency, vendorGstin, KA);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const diffs = keys.filter(k => (typeof a[k] === 'number' && typeof b[k] === 'number')
    ? Math.abs(a[k] - b[k]) > 1e-9 : a[k] !== b[k]);
  if (diffs.length) {
    failed++;
    console.log(`FAIL  ${name}`);
    for (const k of diffs) console.log(`        ${k}: app=${a[k]}  worker=${b[k]}`);
  } else {
    console.log(`PASS  ${name}  (grand ${a.grand.toFixed(2)}${a.showGst ? a.isCgstSgst ? ' cgst+sgst' : ' igst' : ' no-gst'})`);
  }
}
console.log(failed ? `\n${failed} of ${cases.length} FAILED — the PDF and the printed PO disagree`
                   : `\nall ${cases.length} passed — PDF and printed PO agree`);
process.exit(failed ? 1 : 0);
