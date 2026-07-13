import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAppProxySignature } from '../src/proxy-auth.js';

const SECRET = 'hush';

// Build the exact message Shopify signs, then sign it, to produce a valid URL.
async function signedUrl(params, secret = SECRET) {
  const sorted = Object.keys(params).sort();
  const message = sorted.map(k => `${k}=${[].concat(params[k]).join(',')}`).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  const u = new URL('https://shop.example/apps/delivery-check');
  for (const k of sorted) u.searchParams.set(k, [].concat(params[k]).join(','));
  u.searchParams.set('signature', hex);
  return u;
}

test('accepts a correctly signed request', async () => {
  const u = await signedUrl({ pincode: '560001', shop: 'lot.myshopify.com', path_prefix: '/apps/delivery-check' });
  assert.equal(await verifyAppProxySignature(SECRET, u), true);
});

test('rejects a tampered param', async () => {
  const u = await signedUrl({ pincode: '560001', shop: 'lot.myshopify.com' });
  u.searchParams.set('pincode', '110001'); // tamper after signing
  assert.equal(await verifyAppProxySignature(SECRET, u), false);
});

test('rejects a missing signature', async () => {
  const u = new URL('https://shop.example/apps/delivery-check?pincode=560001');
  assert.equal(await verifyAppProxySignature(SECRET, u), false);
});

test('rejects the wrong secret', async () => {
  const u = await signedUrl({ pincode: '560001' });
  assert.equal(await verifyAppProxySignature('wrong', u), false);
});

test('accepts a correctly signed request with a repeated (multi-value) query key', async () => {
  // Build message as Shopify would for multi-value params: sorted keys, values joined by ","
  const message = 'a=1,2shop=x';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  // Build URL with genuine duplicate key (appended twice, not pre-joined)
  const u = new URL('https://shop.example/apps/delivery-check');
  u.searchParams.append('a', '1');
  u.searchParams.append('a', '2');
  u.searchParams.set('shop', 'x');
  u.searchParams.set('signature', hex);

  assert.equal(await verifyAppProxySignature(SECRET, u), true);
});
