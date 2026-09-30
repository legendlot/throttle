// Joseph #bugs 1790765093 (2026-09-30): a payment request typed from the printed PO
// (LOT/PO/202609/533) was refused — only the Snorkel number (IN-PKG-0533) resolved.
// Behavioural test on the extracted resolver with a stubbed query().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/index.js'), 'utf8');
const POS = [
  { po_number: 'IN-PKG-0533', raised_date: '2026-09-18' },
  { po_number: 'IN-CMP-0379', raised_date: '2026-08-02' },
  { po_number: 'CN-PRD-1533', raised_date: '2026-09-20' },
];
function load(rows = POS, ok = true) {
  const a = src.indexOf('const PRINTED_PO_RE');
  const b = src.indexOf('function poFormatNumber(');
  const seen = [];
  const query = async (table, params) => {
    seen.push(params);
    const re = new RegExp(decodeURIComponent(params.match(/po_number=match\.([^&]*)/)[1]));
    return ok ? { ok: true, data: rows.filter(r => re.test(r.po_number)) } : { ok: false, data: 'x' };
  };
  const fn = new Function('query', `${src.slice(a, b)}; return resolvePrintedPoNumber;`)(query);
  return { fn, seen };
}

test('printed number resolves to the Snorkel number (month must match)', async () => {
  const { fn } = load();
  assert.deepEqual(await fn('LOT/PO/202609/533'), { po_number: 'IN-PKG-0533' });
  assert.deepEqual(await fn(' lot/po/202608/379 '), { po_number: 'IN-CMP-0379' });
  assert.deepEqual(await fn('LOT / PO / 202609 / 533'), { po_number: 'IN-PKG-0533' });
});

test('-0*533$ does not match 1533; wrong month is not found', async () => {
  const { fn } = load();
  assert.deepEqual(await fn('LOT/PO/202609/533'), { po_number: 'IN-PKG-0533' }); // not CN-PRD-1533
  assert.match((await fn('LOT/PO/202607/533')).error, /not found/);
});

test('Snorkel numbers and free text pass through untouched, with no lookup', async () => {
  const { fn, seen } = load();
  assert.deepEqual(await fn('IN-PKG-0533'), { po_number: 'IN-PKG-0533' });
  assert.deepEqual(await fn('  IN-CMP-0379 '), { po_number: 'IN-CMP-0379' });
  assert.equal(seen.length, 0);
});

test('ambiguous or failed lookup is refused, never guessed', async () => {
  const dup = [...POS, { po_number: 'IN-OTH-0533', raised_date: '2026-09-02' }];
  assert.match((await load(dup).fn('LOT/PO/202609/533')).error, /more than one/);
  const failed = await load(POS, false).fn('LOT/PO/202609/533');
  assert.match(failed.error, /try again/);
  assert.equal(failed.status, 502);
});

test('createPaymentRequest resolves before the PO gate', () => {
  const i = src.indexOf("case 'createPaymentRequest': {");
  const body = src.slice(i, src.indexOf("\n          case '", i + 10));
  const r = body.indexOf('resolvePrintedPoNumber(d.linked_po_number)');
  assert.ok(r > 0 && r < body.indexOf('const poRef = encodeURIComponent(d.linked_po_number)'));
  // refuses only when the category requires a PO; otherwise a miss keeps the typed value
  assert.match(body, /if \(rp\.error && cat\.data\[0\]\.po_required && type === 'payment'\) return err\(rp\.error, rp\.status \|\| 400\);/);
  assert.match(body, /if \(!rp\.error\) d\.linked_po_number = rp\.po_number;/);
});
