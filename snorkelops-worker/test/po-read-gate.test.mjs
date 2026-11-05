// getPO / getPrintPOData were ungated: any Snorkel login could walk the sequential PO numbers and
// read every price and line. Both now require procurement_view, matching the PO pages' own
// on-screen guard (PODetailClient 'Access restricted', since 2026-06-02).
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/index.js'), 'utf8');
const route = c => { const i = src.indexOf(c); assert.ok(i >= 0, c); return src.slice(i, src.indexOf("case '", i + c.length)); };

test("case 'getPO': { refuses without procurement_view, before reading the PO", () => {
  const body = route("case 'getPO': {");
  const g = body.indexOf("if (!canView(P)) return err('No permission', 403);");
  const h = body.indexOf("query('purchase_orders'");
  assert.ok(g > 0, 'gate present');
  assert.ok(h > g, 'gate runs before the PO read');
});

test("getPrintPOData refuses before reading the PO, unless it is the caller's own request's PO", () => {
  const body = route("case 'getPrintPOData': {");
  const g = body.indexOf("if (viaOwnRequest && !(await ownsRequestForPO(po, userId))) return err('No permission', 403);");
  const h = body.indexOf("query('purchase_orders'");
  assert.ok(body.indexOf('const viaOwnRequest = !canView(P);') > 0);
  assert.ok(g > 0, 'gate present');
  assert.ok(h > g, 'gate runs before the PO read');
  assert.ok(body.indexOf("viaOwnRequest && headerR.data[0].status === 'Cancelled'") > h, 'cancelled refused');
  assert.ok(body.indexOf('viaOwnRequest ? stripPoForRequester(headerR.data[0])') > h, 'payment fields stripped');
});

test('the requester copy drops who paid and how it was routed, and keeps payment_terms', () => {
  const i = src.indexOf('function stripPoForRequester');
  const strip = new Function(`${src.slice(i, src.indexOf('\n}\n', i) + 3)}; return stripPoForRequester;`)();
  const out = strip({
    po_number: 'X', payment_terms: '30 days', payment_status: 'paid', payment_routed_to: 'finance',
    payment_note: 'n', payment_requested_by: 'a', paid_by: 'b', paid_at: 't', cancellation_reason: 'r',
  });
  assert.deepEqual(out, { po_number: 'X', payment_terms: '30 days' });
  assert.deepEqual(strip(null), {});
});

test('ownsRequestForPO matches on BOTH the PO and the caller, and refuses a blank caller', () => {
  const i = src.indexOf('async function ownsRequestForPO');
  const fn = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(fn.includes('if (!poNumber || !userId) return false;'));
  assert.ok(fn.includes('linked_po_number=eq.'));
  assert.ok(fn.includes('requested_by_user_id=eq.'));
});

test('the PO detail page guards on the same key the worker does', () => {
  const page = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/procurement/pos/[poNumber]/PODetailClient.js'), 'utf8');
  assert.ok(page.includes('perms && !perms.procurement_view'));
});

test('a request only offers "Open PO" to someone who can open it', () => {
  const page = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/requests/detail/page.js'), 'utf8');
  const btn = page.indexOf('Open PO');
  assert.ok(btn > 0);
  assert.ok(page.lastIndexOf('perms?.procurement_view', btn) > page.lastIndexOf('{linked && (', btn));
});
