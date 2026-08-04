// Prefetch filtering for /r/<code>.
// WhatsApp, Slack, Telegram and every mail client fetch a URL to build a preview card. Counting
// those as clicks makes CTR read high and the number quietly useless — worse than having no
// number at all. This filter decides COUNTING ONLY; a filtered hit still gets its 302.
// Run: node test/link-prefetch.test.js
const assert = require('node:assert');
const { countsAsClick } = require('../src/links.js');

const PHONE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
const now = Date.parse('2026-08-04T10:00:30.000Z');
const sentAt = '2026-08-04T10:00:00.000Z';   // 30s earlier — a plausible human tap

// ── the happy path ───────────────────────────────────────────────────────────
assert.equal(countsAsClick({ method: 'GET', ua: PHONE, sentAt, now }), true);
// No send timestamp known (a link minted outside a message) still counts.
assert.equal(countsAsClick({ method: 'GET', ua: PHONE }), true);
// Missing method defaults to GET rather than dropping a real click.
assert.equal(countsAsClick({ ua: PHONE, sentAt, now }), true);
// No UA at all is NOT treated as a bot — plenty of real clients send none, and silently
// discarding them would under-count in a way nobody would notice.
assert.equal(countsAsClick({ method: 'GET', sentAt, now }), true);

// ── HEAD is a probe by definition ────────────────────────────────────────────
assert.equal(countsAsClick({ method: 'HEAD', ua: PHONE, sentAt, now }), false);
assert.equal(countsAsClick({ method: 'head', ua: PHONE, sentAt, now }), false);
assert.equal(countsAsClick({ method: 'OPTIONS', ua: PHONE, sentAt, now }), false);

// ── known preview fetchers ───────────────────────────────────────────────────
for (const ua of [
  'WhatsApp/2.23.20.0 A',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'TelegramBot (like TwitterBot)',
  'Twitterbot/1.0',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'curl/8.4.0',
  'python-requests/2.31.0',
  'Mozilla/5.0 HeadlessChrome/126.0.0.0',
]) {
  assert.equal(countsAsClick({ method: 'GET', ua, sentAt, now }), false, `should filter: ${ua}`);
}

// ── the sub-second rule ──────────────────────────────────────────────────────
// No human taps within a second of delivery, so a hit that fast is the platform building its own
// preview even when the UA looks ordinary (they are not all honest about it).
const t0 = Date.parse(sentAt);
assert.equal(countsAsClick({ method: 'GET', ua: PHONE, sentAt, now: t0 + 200 }), false);
assert.equal(countsAsClick({ method: 'GET', ua: PHONE, sentAt, now: t0 + 999 }), false);
// The boundary opens at exactly 1s.
assert.equal(countsAsClick({ method: 'GET', ua: PHONE, sentAt, now: t0 + 1000 }), true);
assert.equal(countsAsClick({ method: 'GET', ua: PHONE, sentAt, now: t0 + 5000 }), true);
// An unparseable sentAt must not silently swallow every click.
assert.equal(countsAsClick({ method: 'GET', ua: PHONE, sentAt: 'not-a-date', now }), true);

// ── a real customer's phone is never mistaken for a bot ──────────────────────
// Guards against widening BOT_UA later: these substrings live inside ordinary UA strings.
for (const ua of [
  PHONE,
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
]) {
  assert.equal(countsAsClick({ method: 'GET', ua, sentAt, now }), true, `false positive: ${ua}`);
}

console.log('link-prefetch.test.js: all assertions passed');
