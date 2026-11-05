import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { buildPartnerMime, encodeSubject, PARTNER_MAILBOX } from './partner-email.js';
import { gmailAccessToken, gmailFetch, gmailFetchFor, gmailMailbox } from './index.js';

const mail = { to: 'a@b.in', subject: 'Hello', text: 'plain', html: '<b>x</b>' };
const B = 'BOUND';
const headersOf = (raw) => raw.split('\r\n\r\n')[0];

test('the sender is the constant, whatever the caller sends', () => {
  const { raw } = buildPartnerMime({ ...mail, from: 'evil@x.com' }, B);
  assert.match(headersOf(raw), /^From: Legend of Toys <partners@legendoftoys\.com>$/m);
  assert.doesNotMatch(raw, /evil/);
  assert.equal(PARTNER_MAILBOX, 'partners@legendoftoys.com');
});

test('CR and LF cannot add a header through the subject', () => {
  const { raw } = buildPartnerMime({ ...mail, subject: 'Hi\r\nBcc: evil@x.com' }, B);
  assert.doesNotMatch(headersOf(raw), /^Bcc:/m);
  assert.match(headersOf(raw), /^Subject: Hi Bcc: evil@x\.com$/m);
});

test('the recipient is one bare address: injection, lists and blanks are refused', () => {
  for (const to of ['a@b.in\r\nBcc: evil@x.com', 'a@b.in, c@d.in', 'A <a@b.in>', '', null, 'nope']) {
    assert.ok(buildPartnerMime({ ...mail, to }, B).error, String(to));
  }
});

test('multipart text + html, both base64 UTF-8 and decodable', () => {
  const { raw } = buildPartnerMime({ ...mail, text: 'राम ₹500', html: '<p>₹500</p>' }, B);
  assert.match(raw, /multipart\/alternative; boundary="BOUND"/);
  const parts = raw.split('--BOUND').slice(1, 3).map(p => Buffer.from(p.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8'));
  assert.deepEqual(parts, ['राम ₹500', '<p>₹500</p>']);
  assert.ok(raw.endsWith('--BOUND--'));
});

test('subject: ASCII is left alone, anything else is RFC 2047 in words of 75 or fewer', () => {
  assert.equal(encodeSubject('Plain subject'), 'Plain subject');
  const long = 'सहयोग '.repeat(20);
  const enc = encodeSubject(long);
  const words = enc.split('\r\n ');
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, w);
  const back = words.map(w => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
  assert.equal(back, long.trim());
});

test('a missing subject or body is refused', () => {
  assert.ok(buildPartnerMime({ ...mail, subject: ' \r\n ' }, B).error);
  assert.ok(buildPartnerMime({ ...mail, text: '' }, B).error);
  assert.ok(buildPartnerMime({ ...mail, html: null }, B).error);
});

// ── Pitstop mail must not move: carecrew's behaviour with the token cache now per mailbox ───────
function saEnv() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { GOOGLE_SA_JSON: JSON.stringify({ client_email: 'sa@x.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
}
function stubFetch() {
  const subs = []; const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      const assertion = decodeURIComponent(String(init.body).split('assertion=')[1]);
      const claim = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
      subs.push(claim.sub);
      return new Response(JSON.stringify({ access_token: `tok-${claim.sub}`, expires_in: 3600 }));
    }
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    return new Response('{}');
  };
  return { subs, calls, restore: () => { globalThis.fetch = orig; } };
}

test('tokens are cached per mailbox, and carecrew stays the default of every old call', async () => {
  const env = saEnv();
  const s = stubFetch();
  try {
    assert.equal(gmailMailbox(env), 'carecrew@legendoftoys.com');
    assert.equal(await gmailAccessToken(env), 'tok-carecrew@legendoftoys.com');
    assert.equal(await gmailAccessToken(env, PARTNER_MAILBOX), 'tok-partners@legendoftoys.com');
    // A second carecrew call after the partners mint must NOT get the partners token.
    assert.equal(await gmailAccessToken(env), 'tok-carecrew@legendoftoys.com');
    assert.equal(await gmailAccessToken(env, PARTNER_MAILBOX), 'tok-partners@legendoftoys.com');
    assert.deepEqual(s.subs, ['carecrew@legendoftoys.com', 'partners@legendoftoys.com']);

    await gmailFetch(env, '/messages');
    await gmailFetchFor(env, PARTNER_MAILBOX, '/profile');
    assert.deepEqual(s.calls, [
      { url: 'https://gmail.googleapis.com/gmail/v1/users/carecrew%40legendoftoys.com/messages', auth: 'Bearer tok-carecrew@legendoftoys.com' },
      { url: 'https://gmail.googleapis.com/gmail/v1/users/partners%40legendoftoys.com/profile', auth: 'Bearer tok-partners@legendoftoys.com' },
    ]);
  } finally { s.restore(); }
});
