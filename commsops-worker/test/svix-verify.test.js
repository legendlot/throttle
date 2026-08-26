// S315 — svix verification: constant-time compare + replay tolerance.
// Both were flagged in the S228 coverage review (H15) and deferred; neither is observable
// from the route surface, so they are tested directly.
// Run: node test/svix-verify.test.js
const assert = require('assert');
const { verifySvix, timingSafeEqual, SVIX_TOLERANCE_S } = require('../src/webhooks.js');

const SECRET_KEY_B64 = 'c2VjcmV0LWtleS1mb3ItdGVzdGluZy0xMjM0NTY3OA==';   // arbitrary 32-ish bytes
const SECRET = `whsec_${SECRET_KEY_B64}`;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function sign(id, ts, body) {
  const key = await crypto.subtle.importKey('raw', b64ToBytes(SECRET_KEY_B64),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return bytesToB64(new Uint8Array(mac));
}
// minimal Headers stand-in — verifySvix only calls .get()
const H = (o) => ({ get: (k) => (k in o ? o[k] : null) });

(async () => {
  // ── timingSafeEqual ───────────────────────────────────────────────────────────
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false, 'different lengths must not match');
  assert.equal(timingSafeEqual('', ''), true);
  // a non-string (a missing second signature field yields undefined) must be refused, not throw
  assert.equal(timingSafeEqual(undefined, 'abc'), false);
  assert.equal(timingSafeEqual(null, 'abc'), false);
  console.log('svix timingSafeEqual ok');

  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } });
  const id = 'msg_test';

  // ── happy path: fresh timestamp + correct signature ───────────────────────────
  {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await sign(id, ts, body);
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }), body);
    assert.equal(ok, true, 'a correctly signed, fresh request must verify');
  }

  // ── REPLAY: correct signature, but the timestamp is outside tolerance ──────────
  // This is the actual defect. Before the fix `svix-timestamp` was folded into the signed
  // payload and never compared to the clock, so a captured request verified forever.
  {
    const ts = Math.floor(Date.now() / 1000) - (SVIX_TOLERANCE_S + 60);
    const sig = await sign(id, ts, body);
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }), body);
    assert.equal(ok, false, 'a stale but correctly-signed request must be refused (replay)');
  }

  // ── a timestamp far in the FUTURE is refused too ───────────────────────────────
  {
    const ts = Math.floor(Date.now() / 1000) + (SVIX_TOLERANCE_S + 60);
    const sig = await sign(id, ts, body);
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }), body);
    assert.equal(ok, false, 'a far-future timestamp must be refused');
  }

  // ── within tolerance still passes (clock skew must not break live webhooks) ────
  {
    const ts = Math.floor(Date.now() / 1000) - (SVIX_TOLERANCE_S - 30);
    const sig = await sign(id, ts, body);
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }), body);
    assert.equal(ok, true, 'inside tolerance must still verify — this is what keeps Resend working');
  }

  // ── wrong signature refused ────────────────────────────────────────────────────
  {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await sign(id, ts, body);
    const bad = `${sig.slice(0, -2)}XY`;
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${bad}` }), body);
    assert.equal(ok, false, 'a tampered signature must be refused');
  }

  // ── tampered BODY refused (signature no longer covers it) ──────────────────────
  {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await sign(id, ts, body);
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }),
      JSON.stringify({ type: 'email.bounced' }));
    assert.equal(ok, false, 'a modified body must be refused');
  }

  // ── non-numeric / missing timestamp refused rather than NaN-passing ────────────
  {
    const sig = await sign(id, 'later', body);
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': 'later', 'svix-signature': `v1,${sig}` }), body);
    assert.equal(ok, false, 'an unparseable timestamp must be refused (NaN must not slip through)');
  }
  {
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-signature': 'v1,x' }), body);
    assert.equal(ok, false, 'a missing timestamp header must be refused');
  }

  // ── multiple space-separated signatures: any one valid is enough (svix spec) ────
  {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await sign(id, ts, body);
    const ok = await verifySvix(SECRET, H({ 'svix-id': id, 'svix-timestamp': String(ts),
      'svix-signature': `v1,AAAA v1,${sig}` }), body);
    assert.equal(ok, true, 'a valid signature alongside an invalid one must verify');
  }

  console.log('svix verify: replay tolerance + tamper rejection ok');
  console.log('svix-verify.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
