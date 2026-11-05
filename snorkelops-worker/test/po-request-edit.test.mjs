// Edit a pending PO request (Kirti, #bugs 1793862584.463369). postRequest and updateRequest share
// the line helpers, so these run the real functions lifted out of the source.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/index.js'), 'utf8');
const start = src.indexOf('function normaliseRequestLines(raw)');
const end = src.indexOf('// End of the shared request-line block.');
assert.ok(start > 0 && end > start);
const { normaliseRequestLines, requestEstimatedCost, requestLineRow } = new Function(
  `${src.slice(start, end)}; return { normaliseRequestLines, requestEstimatedCost, requestLineRow };`,
)();
const route = c => { const i = src.indexOf(c); assert.ok(i >= 0, c); return src.slice(i, src.indexOf("case '", i + c.length)); };

test('normaliseRequestLines drops empty rows and non-objects, trims, defaults unit', () => {
  const { lines, error } = normaliseRequestLines([null, 'x', { qty: 5 }, { part_code: ' AB-01 ', qty: '2', unit: ' ' }]);
  assert.equal(error, null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].part_code, 'AB-01');
  assert.equal(lines[0].unit, 'pcs');
  assert.equal(lines[0].qty, 2);
});

test('normaliseRequestLines treats a non-array as no lines', () => {
  assert.deepEqual(normaliseRequestLines(undefined), { lines: [], error: null });
  assert.deepEqual(normaliseRequestLines('x'), { lines: [], error: null });
});

for (const qty of [0, -1, 'abc', '', null, Infinity]) {
  test(`normaliseRequestLines refuses qty ${String(qty)}`, () => {
    assert.match(normaliseRequestLines([{ description: 'x', qty }]).error, /quantity/);
  });
}

test('normaliseRequestLines refuses a negative or non-numeric price, allows a blank one', () => {
  assert.match(normaliseRequestLines([{ description: 'x', qty: 1, unit_price: -1 }]).error, /price/);
  assert.match(normaliseRequestLines([{ description: 'x', qty: 1, unit_price: 'abc' }]).error, /price/);
  assert.equal(normaliseRequestLines([{ description: 'x', qty: 1, unit_price: '' }]).lines[0].unit_price, null);
});

test('requestEstimatedCost: derived from lines, NULL not 0 when unpriced, typed only without lines', () => {
  assert.equal(requestEstimatedCost([{ qty: 2, unit_price: 5 }], 999), 10);
  assert.equal(requestEstimatedCost([{ qty: 2, unit_price: null }], 999), null);
  assert.equal(requestEstimatedCost([], '40'), 40);
  assert.equal(requestEstimatedCost([], ''), null);
  assert.equal(requestEstimatedCost([], null), null);
});

test('requestLineRow numbers from 1 and turns a blank part code into NULL', () => {
  const row = requestLineRow({ part_code: '', description: 'x', qty: 1, unit: 'pcs', unit_price: null, hsn_code: null, gst_percent: null, needs_hsn_review: true }, 0);
  assert.equal(row.line_no, 1);
  assert.equal(row.part_code, null);
});

test('updateRequest: same owner gate as cancel, refuses missing lines, writes through the atomic function', () => {
  const body = route("case 'updateRequest': {");
  assert.ok(body.includes("if (!Array.isArray(d.lines)) return err('lines required');"));
  assert.ok(body.includes('req.requested_by_user_id !== userId && !canSnorkelAdmin(P)'));
  assert.ok(body.includes("req.status !== 'pending'"));
  assert.ok(body.includes("rpc('update_po_request'"));
  assert.ok(!body.includes("insert('po_request_lines'"), 'no second write path');
});

test('postPO refuses a form older than the request, and the form sends its copy of updated_at', () => {
  const body = route("case 'postPO': {");
  const g = body.indexOf('srcR.data[0].updated_at !== d.source_request_updated_at');
  assert.ok(g > 0);
  assert.ok(g < body.indexOf("nextSeq("), 'refuses before burning a PO number');
  const form = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/procurement/pos/new/page.js'), 'utf8');
  assert.ok(form.includes('source_request_updated_at: linkedRequest?.updated_at || null'));
});

test('the form remounts per request, and keeps a line type on save', () => {
  const form = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/requests/new/page.js'), 'utf8');
  assert.ok(form.includes("<RequestForm key={editNo || 'new'} editNo={editNo} />"));
  assert.equal(form.match(/item_type: l\.item_type \|\| 'Part'/g).length, 2);
});

test('postRequest and updateRequest share the helpers', () => {
  const post = route("case 'postRequest': {");
  for (const h of ['normaliseRequestLines(d.lines)', 'requestEstimatedCost(reqLines, d.estimated_cost)', 'requestLineRow']) {
    assert.ok(post.includes(h), h);
  }
});

test('the request page offers Edit to the owner while pending, and Download to the owner', () => {
  const page = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/requests/detail/page.js'), 'utf8');
  const edit = page.indexOf('Edit request');
  assert.ok(page.lastIndexOf('isPending && isOwner', edit) > 0);
  const dl = page.indexOf('Download PO');
  assert.ok(page.lastIndexOf("(perms?.procurement_view || isOwner) && linked.status !== 'Cancelled'", dl) > 0);
});
