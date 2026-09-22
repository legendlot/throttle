// payment_view_all (Suman, #bugs 1790068793): a Finance user opening the paid export's
// 'Open in Snorkel' link on a request they did not raise got "Not found — not yours".
// The fix is a READ-ONLY role key: it may open any request + its documents, and must NOT
// widen the queues, the paid export, or any money action (those stay grant-only).
// Source-level assertions, same arrangement as payment-ref.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/index.js'), 'utf8');
const roles = readFileSync(join(here, '../../apps/snorkel/src/app/(auth)/admin/roles/page.js'), 'utf8');
const caseBody = name => {
  const i = src.indexOf(`case '${name}': {`);
  assert.ok(i > 0, `case ${name} not found`);
  const j = src.indexOf("\n          case '", i + 10);
  return src.slice(i, j);
};

test('payment_view_all opens any request and its documents', () => {
  assert.match(src, /const canPayViewAll\s*=\s*p => !!p\.payment_view_all;/);
  assert.match(src, /canReadAnyPaymentRequest = p => canPayApprove\(p\) \|\| canPayExecute\(p\) \|\| canPaySuperAdmin\(p\) \|\| canPayViewAll\(p\)/);
  for (const c of ['getPaymentRequest', 'getPaymentDocUrl'])
    assert.match(caseBody(c), /requested_by_user_id !== userId && !canReadAnyPaymentRequest\(P\)\) return err\('Not found', 404\)/, c);
});

test('payment_view_all does not widen the queues, the paid export, or money actions', () => {
  assert.doesNotMatch(caseBody('getPaymentRequests'), /canPayViewAll|canReadAnyPaymentRequest/);
  assert.doesNotMatch(caseBody('getPaidPaymentsExport'), /canPayViewAll|canReadAnyPaymentRequest/);
  const uses = src.match(/canPayViewAll\(/g) || [];
  assert.equal(uses.length, 1, 'canPayViewAll is used only inside canReadAnyPaymentRequest');
  assert.equal((src.match(/canReadAnyPaymentRequest\(P\)/g) || []).length, 2, 'only the two read paths');
});

test('the role editor offers the key', () => {
  assert.match(roles, /key: 'payment_view_all'/);
});
