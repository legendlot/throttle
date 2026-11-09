import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCidrs, ipAllowed, parseList, redirectAllowed, registrationAllowed,
  checkGoogleClaims, decodeJwtPayload, gateDecision, originAllowed, hmacHex, timingSafeEqualHex, esc,
} from '../src/checks.js';

const CIDRS = parseCidrs('160.79.104.0/21,153.61.208.0/20');

test('ip: Anthropic ranges in, everything else out', () => {
  assert.equal(ipAllowed('160.79.104.1', CIDRS), true);
  assert.equal(ipAllowed('160.79.111.255', CIDRS), true);
  assert.equal(ipAllowed('160.79.112.0', CIDRS), false);
  assert.equal(ipAllowed('153.61.208.0', CIDRS), true);
  assert.equal(ipAllowed('153.61.223.255', CIDRS), true);
  assert.equal(ipAllowed('153.61.224.0', CIDRS), false);
  assert.equal(ipAllowed('34.162.46.92', CIDRS), false); // phased-out Anthropic IP
  assert.equal(ipAllowed('2607:6bc0::1', CIDRS), false); // IPv6 refused
  assert.equal(ipAllowed('', CIDRS), false);
  assert.equal(ipAllowed('160.79.104.1.5', CIDRS), false);
  assert.equal(ipAllowed('160.79.104.999', CIDRS), false);
  assert.throws(() => parseCidrs('1.2.3.4/33'));
});

const ALLOWED = parseList('https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback');

test('redirect: exact match only', () => {
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback', ALLOWED), true);
  for (const bad of [
    'https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://claude.ai.evil.com/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback',
    'https://evil.com/cb', 'http://localhost:3000/callback', 'HTTPS://CLAUDE.AI/api/mcp/auth_callback', undefined, null,
  ]) assert.equal(redirectAllowed(bad, ALLOWED), false, String(bad));
});

test('registration: every redirect must be allowlisted', () => {
  assert.equal(registrationAllowed({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, ALLOWED), true);
  assert.equal(registrationAllowed({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://evil.com/cb'] }, ALLOWED), false);
  assert.equal(registrationAllowed({ redirect_uris: [] }, ALLOWED), false);
  assert.equal(registrationAllowed({}, ALLOWED), false);
});

const now = 1_800_000_000;
const good = {
  iss: 'https://accounts.google.com', aud: 'cid', azp: 'cid', exp: now + 3000, iat: now - 5,
  nonce: 'n1', email: 'Pruthvi@LegendOfToys.com', email_verified: true, hd: 'legendoftoys.com',
};
const opts = { clientId: 'cid', nonce: 'n1', nowSec: now };

test('google claims: good token passes, email lowercased', () => {
  assert.deepEqual(checkGoogleClaims(good, opts), { ok: true, email: 'pruthvi@legendoftoys.com' });
});
test('google claims: each bad field is refused', () => {
  const cases = {
    'wrong issuer': { iss: 'https://evil.com' },
    'wrong audience': { aud: 'other' },
    expired: { exp: now - 1 },
    'stale iat': { iat: now - 10_000 },
    'nonce mismatch': { nonce: 'n2' },
    'email not verified': { email_verified: 'true' },
    'not a LOT Workspace account': { hd: undefined },
    'not a LOT email': { email: 'someone@gmail.com' },
  };
  for (const [reason, patch] of Object.entries(cases)) {
    const r = checkGoogleClaims({ ...good, ...patch }, opts);
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason);
  }
  assert.equal(checkGoogleClaims({ ...good, hd: 'solvefactory.com' }, opts).ok, false);
  assert.equal(checkGoogleClaims({ ...good, email: 'a@legendoftoys.com.evil.com' }, opts).ok, false);
  assert.equal(checkGoogleClaims({ ...good, email: 'a@b@legendoftoys.com' }, opts).ok, false);
  assert.equal(checkGoogleClaims(good, { ...opts, nonce: '' }).ok, false);
  assert.equal(checkGoogleClaims({ ...good, aud: undefined }, { ...opts, clientId: undefined }).reason, 'gateway not configured');
  assert.equal(checkGoogleClaims({ ...good, aud: 'PENDING' }, { ...opts, clientId: 'PENDING' }).ok, false);
  assert.equal(checkGoogleClaims({ ...good, aud: ['cid', 'x'], azp: 'x' }, opts).ok, false);
});
test('jwt payload decode', () => {
  const p = Buffer.from(JSON.stringify({ a: 1 })).toString('base64url');
  assert.deepEqual(decodeJwtPayload(`x.${p}.y`), { a: 1 });
  assert.throws(() => decodeJwtPayload('nope'));
});

const okGate = { enabled: true, lot_domain: true, active: true, systems: ['odo'], calls_per_hour: 60, calls_last_hour: 3 };
test('gate: fails closed on every missing layer', () => {
  assert.deepEqual(gateDecision(okGate), { ok: true, overLimit: false });
  assert.equal(gateDecision({ ...okGate, calls_last_hour: 60 }).overLimit, true);
  assert.equal(gateDecision(null).ok, false);
  assert.equal(gateDecision({ ...okGate, enabled: false }).status, 503);
  assert.equal(gateDecision({ ...okGate, enabled: null }).ok, false);
  assert.equal(gateDecision({ ...okGate, lot_domain: false }).reason, 'not a LOT account');
  assert.equal(gateDecision({ ...okGate, active: false }).reason, 'account deactivated');
  assert.equal(gateDecision({ ...okGate, systems: [] }).reason, 'no gateway grant');
  assert.equal(gateDecision({ ...okGate, systems: undefined }).ok, false);
  assert.equal(gateDecision({ ...okGate, calls_per_hour: undefined }).ok, false);
});

test('origin', () => {
  const o = ['https://claude.ai'];
  assert.equal(originAllowed(null, o), true);
  assert.equal(originAllowed('https://claude.ai', o), true);
  assert.equal(originAllowed('https://evil.com', o), false);
});

test('hmac + compare', async () => {
  const a = await hmacHex('k'.repeat(32), 'revoke|u|1');
  assert.equal(a.length, 64);
  assert.equal(timingSafeEqualHex(a, a), true);
  assert.equal(timingSafeEqualHex(a, a.slice(0, 63) + (a[63] === '0' ? '1' : '0')), false);
  assert.equal(timingSafeEqualHex(a, undefined), false);
  assert.notEqual(await hmacHex('k'.repeat(32), 'revoke|u|2'), a);
});

test('escape', () => {
  assert.equal(esc(`<script>"x"&'y'</script>`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
});
