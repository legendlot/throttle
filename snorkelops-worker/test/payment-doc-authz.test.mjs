// recordPaymentDocument had no ownership check: any user with payment_request could attach a
// document to ANY request by id (only the UI hid the button), and could record another
// request's storage path on their own request to read that file back. And role writes took
// arbitrary keys, so an admin could put payment_approve/execute/super_admin on a role and
// bypass store.payment_grants (named-individual authority). Source-level assertions, same
// arrangement as payment-view-all.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/index.js'), 'utf8');
const caseBody = name => {
  const i = src.indexOf(`case '${name}': {`);
  assert.ok(i > 0, `case ${name} not found`);
  const j = src.indexOf("\n          case '", i + 10);
  return src.slice(i, j);
};

test('recordPaymentDocument + its upload URL: requester or Finance only, never on a dead request', () => {
  const g = src.slice(src.indexOf('async function paymentDocAttachRefusal'), src.indexOf('\n}\n', src.indexOf('async function paymentDocAttachRefusal')));
  assert.match(g, /requested_by_user_id !== userId && !canPayExecute\(P\)\) return err\('Not found', 404\)/);
  assert.match(g, /\['cancelled', 'rejected'\]\.includes\(pr\.data\[0\]\.status\)/);
  const b = caseBody('recordPaymentDocument');
  const ins = b.indexOf("insert('payment_request_documents'");
  const gate = b.indexOf('await paymentDocAttachRefusal(d.request_id, userId, P)');
  const path = b.indexOf('!paymentDocPathOk(d.storage_path, d.request_id, kind)');
  assert.ok(gate > 0 && path > 0 && gate < ins && path < ins, 'both checks run before the insert');
  const u = caseBody('createPaymentDocUploadUrl');
  assert.ok(u.indexOf('await paymentDocAttachRefusal(d.request_id, userId, P)') > 0
    && u.indexOf('await paymentDocAttachRefusal') < u.indexOf('/object/upload/sign/'), 'upload URL gated before signing');
});

// Pull the path helper out of the source and exercise it for real.
const pathSrc = src.slice(src.indexOf('function assetSafeSeg'), src.indexOf('\n}\n', src.indexOf('function paymentDocPathOk')) + 2);
const paymentDocPathOk = new Function(`${pathSrc}; return paymentDocPathOk;`)();

test('paymentDocPathOk accepts only the minted shape for this request and kind', () => {
  assert.equal(paymentDocPathOk('5/invoice/1790000000000_bill.pdf', 5, 'invoice'), true);
  assert.equal(paymentDocPathOk('5/invoice/1790000000000_bill..v2.pdf', '5', 'invoice'), true, 'double dot inside a name is fine');
  assert.equal(paymentDocPathOk('5/payment_proof/1790000000000_utr.png', 5, 'payment_proof'), true);
  for (const bad of [
    '7/invoice/1790000000000_bill.pdf',                         // another request
    '5/payment_proof/1790000000000_bill.pdf',                   // another kind
    '5/invoice/%2e%2e/%2e%2e/7/invoice/1790000000000_x.pdf',    // encoded traversal
    '5/invoice/.%2E/7/invoice/1790000000000_x.pdf',
    '5/invoice/../../7/invoice/1790000000000_x.pdf',
    '5/invoice/1790000000000_x.pdf/../../7/invoice/1_y.pdf',
    '5/invoice/1790000000000_x\\..\\7.pdf',
    '55/invoice/1790000000000_x.pdf',
    '5/invoice/bill.pdf',                                       // no timestamp
    '', null,
  ]) assert.equal(paymentDocPathOk(bad, 5, 'invoice'), false, String(bad));
  assert.equal(paymentDocPathOk('5Xinvoice/1_x.pdf', '5.', 'invoice'), false, 'dots in segments are escaped');
});

// Pull stripGrantKeys out of the source and exercise it for real.
const fnSrc = src.slice(src.indexOf('const PAYMENT_GRANT_KEYS'), src.indexOf('async function getSnorkelPerms'));
const stripGrantKeys = new Function(`${fnSrc}; return stripGrantKeys;`)();

test('stripGrantKeys removes money authority and keeps everything else', () => {
  assert.deepEqual(
    stripGrantKeys({ payment_approve: true, payment_execute: true, payment_super_admin: true, payment_view_all: true, payment_request: true }),
    { payment_view_all: true, payment_request: true });
  assert.deepEqual(stripGrantKeys(null), {});
  assert.deepEqual(stripGrantKeys(undefined), {});
  assert.deepEqual(stripGrantKeys(['payment_approve']), {});
  const input = { payment_execute: true };
  stripGrantKeys(input);
  assert.deepEqual(input, { payment_execute: true }, 'does not mutate its input');
});

test('role writes and role reads both strip grant keys', () => {
  assert.match(caseBody('createSnorkelRole'), /permissions: stripGrantKeys\(d\.permissions\)/);
  assert.match(caseBody('updateSnorkelRole'), /updates\.permissions = stripGrantKeys\(d\.permissions\)/);
  assert.match(src, /perms: \{ \.\.\.stripGrantKeys\(r\.ok && r\.data\[0\]\?\.permissions\), \.\.\.grants \}/);
});
