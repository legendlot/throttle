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
  const list = caseBody('getPaymentRequests');
  // S404 (Prarthi #bugs 1790749240): the ONE list use is the read-only scope=all, refused (not
  // degraded to 'mine') without the key. Approvals / Finance queues still key off `privileged`,
  // which is grant-only.
  assert.doesNotMatch(list, /canPayViewAll/);
  assert.equal((list.match(/canReadAnyPaymentRequest\(P\)/g) || []).length, 1, 'only the scope=all gate');
  assert.match(list, /if \(scope === 'all' && !canReadAnyPaymentRequest\(P\)\) return err\('No permission', 403\);/);
  assert.match(list, /const privileged = canPayApprove\(P\) \|\| canPayExecute\(P\) \|\| canPaySuperAdmin\(P\);/);
  assert.match(list, /if \(scope === 'mine' \|\| \(scope !== 'all' && !privileged\)\) q \+= `&requested_by_user_id=eq\.\$\{userId\}`;/);
  assert.doesNotMatch(caseBody('getPaidPaymentsExport'), /canPayViewAll|canReadAnyPaymentRequest/);
  const uses = src.match(/canPayViewAll\(/g) || [];
  assert.equal(uses.length, 1, 'canPayViewAll is used only inside canReadAnyPaymentRequest');
  assert.equal((src.match(/canReadAnyPaymentRequest\(P\)/g) || []).length, 3, 'the two single-request reads + the scope=all list');
});

test('the role editor offers the key', () => {
  assert.match(roles, /key: 'payment_view_all'/);
});
