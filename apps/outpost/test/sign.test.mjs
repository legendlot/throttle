import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeviceKey, signedHeaders, sha256Hex as appSha } from '../src/op/sign.mjs';
import { canonicalString, importVerifyKey, verifySignature, sha256Hex, nonceOk, normaliseJwk } from '../../../outpostops-worker/src/auth.js';
import { buildPackingNote } from '../src/op/packingNote.mjs';

test('a bench signature verifies with the worker’s own verifier', async () => {
  const { privateKey, publicJwk } = await newDeviceKey();
  assert.ok(normaliseJwk(publicJwk), 'the public key is the shape /v/enrol accepts');
  const verifyKey = await importVerifyKey(publicJwk);
  for (const [method, path, raw] of [['GET', '/v/carton?ctn_no=CTN-0000001', ''],
    ['POST', '/v/pack', JSON.stringify({ work_order_id: 1, car_upc: 'LOT-00000001', remote_upc: 'LOT-00000002', idempotency_key: 'k' })]]) {
    const ts = Date.now();
    const h = await signedHeaders({ deviceId: 42, key: privateKey, method, path, raw, ts });
    assert.equal(h['X-Outpost-Device'], '42');
    assert.ok(nonceOk(h['X-Outpost-Nonce']));
    assert.equal(await appSha(raw), await sha256Hex(raw));
    const canon = canonicalString({ method, path, ts: h['X-Outpost-Ts'], nonce: h['X-Outpost-Nonce'], bodyHash: await sha256Hex(raw) });
    assert.ok(await verifySignature(verifyKey, h['X-Outpost-Sig'], canon));
    // any change to the signed parts fails
    const tampered = canonicalString({ method, path: path + 'x', ts: h['X-Outpost-Ts'], nonce: h['X-Outpost-Nonce'], bodyHash: await sha256Hex(raw) });
    assert.equal(await verifySignature(verifyKey, h['X-Outpost-Sig'], tampered), false);
  }
});

test('the device key cannot be exported', async () => {
  const { privateKey } = await newDeviceKey();
  assert.equal(privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', privateKey));
});

test('packing note: escapes every field, totals and one row per carton', () => {
  const html = buildPackingNote({
    csg_no: 'CSG-00001', status: 'dispatched', challan_no: 'DC/12<script>', challan_date: '2026-10-15', vehicle_no: 'MH15AB1234',
    eway_bill_no: null, transporter: 'Self', dispatched_at: '2026-10-15T10:00:00Z', notes: null,
    consignor: { vendor_name: 'Satish & Co', address: 'Nashik', gstin: '27ABCDE1234F1Z5' },
    lines: [{ sku: 'GOHR', channel: 'Amazon - Flex', cartons: 2, units: 36, product: 'Gator', model: 'Hydro', color: 'Red', ean: '8908012345671', hsn_code: '9503' }],
    cartons: [{ ctn_no: 'CTN-0000002', sku: 'GOHR', channel: 'Amazon - Flex', unit_count: 18, manifest_version: 1 },
              { ctn_no: 'CTN-0000001', sku: 'GOHR', channel: 'Amazon - Flex', unit_count: 18, manifest_version: 2 }],
    total_cartons: 2, total_units: 36,
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('DC/12&lt;script&gt;'));
  assert.ok(html.includes('Satish &amp; Co'));
  assert.equal((html.match(/class="ctn"/g) || []).length, 2);
  assert.match(html, /CTN-0000001 · v2/);
  assert.match(html, />36</);
});

test('scan classification: only a LOT sticker passes; labels and EANs are named, never fixed up', async () => {
  const { classify, clean } = await import('../src/op/scan.mjs');
  assert.equal(classify(clean(' lot-00000123 ')), 'upc');
  assert.equal(classify('LOT-00000123-E'), 'batch');
  assert.equal(classify('LOT-00000123-X'), 'batch');
  assert.equal(classify('CTN-0000001'), 'ctn');
  assert.equal(classify('8908012345671'), 'ean');
  for (const v of ['123', 'LOT-123', 'LOT-000001234', 'LOT00000123', '']) assert.equal(classify(clean(v)), 'other');
});
