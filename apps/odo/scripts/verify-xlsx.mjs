// Verifies src/lib/xlsx.js produces a workbook a real spreadsheet parser accepts.
//
// Writing an .xlsx by hand is only defensible if it is actually validated — a
// subtly malformed ZIP or a bad cell ref opens as "file is corrupt" for whoever
// asked for the export. This generates a workbook covering the cases that matter
// and writes it to /tmp for the Python side (openpyxl) to read back.
//
//   node apps/odo/scripts/verify-xlsx.mjs            # writes /tmp/odo-xlsx-verify.xlsx
//   python3 apps/odo/scripts/verify_xlsx.py          # asserts openpyxl round-trip
//
// Node 18+ (needs Blob + TextEncoder, both global).

import { writeFileSync } from 'node:fs';
import { buildXlsx } from '../src/lib/xlsx.js';

const rows = [
  // plain strings + a real number
  { channel: 'Website', product_code: 'NIRJ', units: 12, net_revenue: 24990.5 },
  // ⚠️ the case that matters most: a 13-digit EAN must stay TEXT, not become
  // 5.94999e+12 with its identity destroyed
  { channel: 'Amazon - FBA', product_code: 'NITJ', ean: '5949998565748', units: 3, net_revenue: 6250 },
  // numeric-looking strings (PostgREST returns numerics as strings) should become numbers
  { channel: 'Zepto', product_code: 'BMBB', units: '364', net_revenue: '48120.75' },
  // leading zero => identifier, must stay text
  { channel: 'Blinkit', product_code: '007', units: 1, net_revenue: 0 },
  // XML-hostile characters must survive escaping
  { channel: 'Q&C <test> "quoted"', product_code: 'X&Y', units: 0, net_revenue: -5.25 },
  // sparse row — must not drop the column, and must not shift cells
  { channel: 'Firstcry', units: 7 },
  // control character must be stripped, not emitted raw
  { channel: `Cred${String.fromCharCode(7)}bell`, product_code: 'ZZZZ', units: 2, net_revenue: 100 },
];

const blob = buildXlsx(rows, 'Odo Export');
const buf = Buffer.from(await blob.arrayBuffer());
writeFileSync('/tmp/odo-xlsx-verify.xlsx', buf);

// Sanity checks that don't need Python.
const sig = buf.subarray(0, 4);
if (!(sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04)) {
  throw new Error('not a ZIP: bad local-file-header signature');
}
if (buf.length < 1000) throw new Error(`suspiciously small: ${buf.length} bytes`);

// Byte-for-byte determinism — two builds of identical data must match, or the
// output can never be diffed or golden-tested.
const again = Buffer.from(await buildXlsx(rows, 'Odo Export').arrayBuffer());
if (!buf.equals(again)) throw new Error('output is not deterministic');

console.log(`OK  ${buf.length} bytes, ZIP signature valid, deterministic`);
console.log(`     wrote /tmp/odo-xlsx-verify.xlsx (${rows.length} rows)`);
