import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64urlDecode, b64urlEncode, canonicalString, clockOk, codeHash, corsHeaders, hashPin, importVerifyKey,
  ipBucket, isDigits, jwkThumbprint, killVerdict, mintDigits, nextOpCode, nonceOk, normaliseJwk, sessionLive,
  sha256Hex, tokenHash, verifyPin, verifySignature, MAX_CLOCK_SKEW_MS,
} from '../src/auth.js';

const enc = new TextEncoder();

async function deviceKey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { kp, jwk };
}
async function sign(kp, s) {
  return b64urlEncode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(s)));
}

test('b64url round-trips and rejects non-alphabet input', () => {
  const bytes = new Uint8Array([0, 255, 62, 63, 1, 2, 3]);
  assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
  assert.equal(b64urlDecode('ab+/'), null);
  assert.equal(b64urlDecode(42), null);
});

test('a request signed by the device verifies; any change to method/path/body/ts/nonce does not', async () => {
  const { kp, jwk } = await deviceKey();
  const key = await importVerifyKey(normaliseJwk(jwk));
  const base = { method: 'POST', path: '/v/login', ts: 1_700_000_000_000, nonce: 'abcdefghijklmnop',
                 bodyHash: await sha256Hex('{"op_code":"001","pin":"123456"}') };
  const sig = await sign(kp, canonicalString(base));
  assert.equal(await verifySignature(key, sig, canonicalString(base)), true);
  for (const [k, v] of [['method', 'GET'], ['path', '/v/stepup'], ['ts', base.ts + 1], ['nonce', 'abcdefghijklmnoq'],
                        ['bodyHash', await sha256Hex('{}')]]) {
    assert.equal(await verifySignature(key, sig, canonicalString({ ...base, [k]: v })), false, k);
  }
});

test('a signature from another device key is refused', async () => {
  const a = await deviceKey(), b = await deviceKey();
  const keyA = await importVerifyKey(normaliseJwk(a.jwk));
  const s = canonicalString({ method: 'GET', path: '/v/me', ts: 1, nonce: 'n'.repeat(16), bodyHash: 'x' });
  assert.equal(await verifySignature(keyA, await sign(b.kp, s), s), false);
});

test('malformed signatures are refused, not thrown', async () => {
  const { jwk } = await deviceKey();
  const key = await importVerifyKey(normaliseJwk(jwk));
  for (const bad of ['', 'not+base64', b64urlEncode(new Uint8Array(63)), b64urlEncode(new Uint8Array(64))]) {
    assert.equal(await verifySignature(key, bad, 'x'), false);
  }
});

test('normaliseJwk keeps only a public P-256 key', async () => {
  const { jwk } = await deviceKey();
  const n = normaliseJwk({ ...jwk, key_ops: ['verify'], ext: true, extra: 'x' });
  assert.deepEqual(Object.keys(n).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(normaliseJwk({ ...jwk, d: 'secret' }), null);           // a private key is refused
  assert.equal(normaliseJwk({ ...jwk, crv: 'P-384' }), null);
  assert.equal(normaliseJwk({ ...jwk, x: 'short' }), null);
  assert.equal(normaliseJwk(null), null);
  assert.equal(normaliseJwk([jwk]), null);
});

test('jwk thumbprint is stable and independent of member order', async () => {
  const { jwk } = await deviceKey();
  const n = normaliseJwk(jwk);
  const t1 = await jwkThumbprint(n);
  const t2 = await jwkThumbprint({ y: n.y, x: n.x, kty: 'EC', crv: 'P-256' });
  assert.equal(t1, t2);
  assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
});

test('clock window is ±150 s', () => {
  const now = 1_000_000_000;
  assert.equal(clockOk(now - MAX_CLOCK_SKEW_MS, now), true);
  assert.equal(clockOk(now + MAX_CLOCK_SKEW_MS + 1, now), false);
  assert.equal(clockOk('abc', now), false);
  assert.equal(clockOk(String(now), now), true);
});

test('nonce shape', () => {
  assert.equal(nonceOk('a'.repeat(16)), true);
  assert.equal(nonceOk('a'.repeat(15)), false);
  assert.equal(nonceOk('a'.repeat(65)), false);
  assert.equal(nonceOk('abc def ghi jklmno'), false);
  assert.equal(nonceOk(undefined), false);
});

test('PIN hash verifies the right PIN only, and needs the pepper', async () => {
  const stored = await hashPin('482910', 'pepper-1', { iterations: 1000 });
  assert.match(stored, /^pbkdf2_sha256\$1000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPin('482910', 'pepper-1', stored), true);
  assert.equal(await verifyPin('482911', 'pepper-1', stored), false);
  assert.equal(await verifyPin('482910', 'pepper-2', stored), false);
  assert.notEqual(await hashPin('482910', 'pepper-1', { iterations: 1000 }), stored);   // salted
});

test('verifyPin refuses malformed or over-budget hashes without throwing', async () => {
  assert.equal(await verifyPin('1', 'p', null), false);
  assert.equal(await verifyPin('1', 'p', 'md5$x'), false);
  assert.equal(await verifyPin('1', 'p', 'pbkdf2_sha256$999999999$AAAA$AAAA'), false);
  assert.equal(await verifyPin('1', 'p', 'pbkdf2_sha256$1000$!!$AAAA'), false);
});

test('mintDigits gives n digits and skips the biased tail', () => {
  assert.match(mintDigits(8), /^[0-9]{8}$/);
  const seq = [4_294_967_295, 4_294_967_290, 7, 13];
  assert.equal(mintDigits(2, () => seq.shift()), '73');
});

test('isDigits', () => {
  assert.equal(isDigits('001', 3), true);
  assert.equal(isDigits('01', 3), false);
  assert.equal(isDigits('0a1', 3), false);
  assert.equal(isDigits(123, 3), false);
});

test('code hashes are keyed by kind and pepper; token hashes are stable', async () => {
  const a = await codeHash('p', 'enrol', '12345678');
  assert.notEqual(a, await codeHash('p', 'login', '12345678'));
  assert.notEqual(a, await codeHash('q', 'enrol', '12345678'));
  assert.equal(await tokenHash('t'), await tokenHash('t'));
});

test('sessionLive: revoked, used, expired and idle sessions are dead', () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const live = { expires_at: '2026-10-14T20:00:00Z', last_seen_at: '2026-10-14T09:30:00Z', idle_mins: 60 };
  assert.equal(sessionLive(live, now), true);
  assert.equal(sessionLive({ ...live, revoked_at: '2026-10-14T09:59:00Z' }, now), false);
  assert.equal(sessionLive({ ...live, used_at: '2026-10-14T09:59:00Z' }, now), false);
  assert.equal(sessionLive({ ...live, expires_at: '2026-10-14T09:59:59Z' }, now), false);
  assert.equal(sessionLive({ ...live, last_seen_at: '2026-10-14T08:59:59Z' }, now), false);
  assert.equal(sessionLive({ ...live, idle_mins: null }, now), false);
  assert.equal(sessionLive(null, now), false);
});

test('kill switches fail closed', () => {
  const cfg = { active: true, killed: false };
  assert.equal(killVerdict({ killAll: 'off', cfg }), null);
  assert.equal(killVerdict({ killAll: 'on', cfg }), 'outpost_paused');
  assert.equal(killVerdict({ killAll: null, cfg }), 'outpost_paused');        // unreadable → refuse
  assert.equal(killVerdict({ killAll: 'off', cfg: undefined }), 'vendor_unknown');
  assert.equal(killVerdict({ killAll: 'off', cfg: { active: true, killed: true } }), 'vendor_paused');
  assert.equal(killVerdict({ killAll: 'off', cfg: { active: false, killed: false } }), 'vendor_inactive');
  assert.equal(killVerdict({ killAll: 'off', cfg: { active: 'true', killed: false } }), 'vendor_inactive');
});

test('CORS allows only the Outpost and Depot origins', () => {
  assert.equal(corsHeaders('https://outpost.legendoftoys.com')['Access-Control-Allow-Origin'], 'https://outpost.legendoftoys.com');
  assert.equal(corsHeaders('https://depot.legendoftoys.com')['Access-Control-Allow-Origin'], 'https://depot.legendoftoys.com');
  assert.equal(corsHeaders('https://evil.example')['Access-Control-Allow-Origin'], undefined);
  assert.equal(corsHeaders(null)['Access-Control-Allow-Origin'], undefined);
});

test('nextOpCode fills the first gap', () => {
  assert.equal(nextOpCode([]), '001');
  assert.equal(nextOpCode(['001', '002', '004']), '003');
  assert.equal(nextOpCode(Array.from({ length: 999 }, (_, i) => String(i + 1).padStart(3, '0'))), null);
});

test('ipBucket: IPv4 as-is, IPv6 by /64, blank → shared noip bucket', () => {
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(ipBucket('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:db8:aa:bb::9'), '2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:0db8:00aa:00bb:ffff::1'), '2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipBucket(''), 'noip');
  assert.equal(ipBucket(null), 'noip');
});

test('normaliseJwk canonicalises alternative base64url spellings of the same key', async () => {
  const { jwk } = await deviceKey();
  // flip the 2 spare low bits of the 43rd character: same 32 bytes, different string
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = jwk.x[42], idx = alpha.indexOf(last);
  const alt = jwk.x.slice(0, 42) + alpha[(idx & ~3) | ((idx & 3) ^ 1)];
  assert.notEqual(alt, jwk.x);
  const a = normaliseJwk(jwk), b = normaliseJwk({ ...jwk, x: alt });
  assert.deepEqual(a, b);
  assert.equal(await jwkThumbprint(a), await jwkThumbprint(b));
});
