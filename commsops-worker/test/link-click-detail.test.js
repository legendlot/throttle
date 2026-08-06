// Per-click detail classification for /r/<code> (migration 0042).
// These decide what gets WRITTEN about a click. They are pure so the whole rule set is testable
// without a request, a database or a Worker runtime.
// Run: node test/link-click-detail.test.js
const assert = require('node:assert');
const { clickSource, refererHost, parseUa, istDayOf, visitorKey } = require('../src/links.js');

// ── clickSource: a whitelist, because ?s= is caller-controllable ──────────────
// The whole risk here is that anyone can hand-craft a URL. If this accepted free text, the
// analytics table would accept arbitrary strings from strangers.
assert.equal(clickSource('qr'), 'qr');
assert.equal(clickSource('QR'), 'qr');          // case-folded
assert.equal(clickSource('  qr  '), 'qr');      // trimmed
assert.equal(clickSource('link'), 'link');
assert.equal(clickSource('email'), null);       // not on the whitelist → dropped, not stored
assert.equal(clickSource('<script>'), null);
assert.equal(clickSource(''), null);
assert.equal(clickSource(null), null);
assert.equal(clickSource(undefined), null);

// ── refererHost: host only, never the full URL ───────────────────────────────
// A full referrer can carry search terms or a private path; we only ever want "which site".
assert.equal(refererHost('https://www.google.com/search?q=secret+thing'), 'www.google.com');
assert.equal(refererHost('https://m.facebook.com/'), 'm.facebook.com');
assert.equal(refererHost('not a url'), null);
assert.equal(refererHost(''), null);
assert.equal(refererHost(null), null);

// ── parseUa ──────────────────────────────────────────────────────────────────
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1';
const ANDROID_TAB = 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36';

assert.deepEqual(parseUa(IPHONE), { device: 'mobile', os: 'iOS', browser: 'Safari' });
assert.deepEqual(parseUa(ANDROID), { device: 'mobile', os: 'Android', browser: 'Chrome' });
assert.deepEqual(parseUa(MAC), { device: 'desktop', os: 'macOS', browser: 'Chrome' });

// Tablets: iPad is explicit, Android tablets are identified by the ABSENCE of "Mobile".
assert.equal(parseUa(IPAD).device, 'tablet');
assert.equal(parseUa(ANDROID_TAB).device, 'tablet');

// The browser ladder must test specific engines BEFORE generic ones — every one of these UAs
// also contains "Safari", and most contain "Chrome". Getting the order wrong silently labels
// every Edge and Samsung user as Chrome, which is the kind of wrong nobody notices.
assert.equal(parseUa(WIN_EDGE).browser, 'Edge');
assert.equal(parseUa(SAMSUNG).browser, 'Samsung Internet');
assert.equal(parseUa(MAC).browser, 'Chrome');
assert.equal(parseUa(IPHONE).browser, 'Safari');

// An absent UA yields nulls, never a bogus 'desktop' default — plenty of real clients send none,
// and guessing would quietly inflate whichever bucket we guessed.
assert.deepEqual(parseUa(''), { device: null, os: null, browser: null });
assert.deepEqual(parseUa(null), { device: null, os: null, browser: null });

// ── istDayOf: shared by the rollup and the visitor hash ──────────────────────
// They MUST agree on the day or they drift apart at the midnight boundary.
assert.equal(istDayOf(Date.parse('2026-08-06T10:00:00Z')), '2026-08-06');  // 15:30 IST
// 19:00 UTC is already the NEXT day in IST (00:30). This is the case a naive UTC slice gets wrong.
assert.equal(istDayOf(Date.parse('2026-08-06T19:00:00Z')), '2026-08-07');
assert.equal(istDayOf(new Date('2026-08-06T18:29:00Z')), '2026-08-06');   // 23:59 IST — still today
assert.equal(istDayOf(new Date('2026-08-06T18:31:00Z')), '2026-08-07');   // 00:01 IST — tomorrow

// ── visitorKey: per-day, non-linkable, never an identity ─────────────────────
(async () => {
  const ip = '203.0.113.7';
  const ua = ANDROID;
  const a = await visitorKey({ code: 'abc', ip, ua, istDay: '2026-08-06' });
  const same = await visitorKey({ code: 'abc', ip, ua, istDay: '2026-08-06' });
  const nextDay = await visitorKey({ code: 'abc', ip, ua, istDay: '2026-08-07' });
  const otherCode = await visitorKey({ code: 'xyz', ip, ua, istDay: '2026-08-06' });
  const otherIp = await visitorKey({ code: 'abc', ip: '198.51.100.9', ua, istDay: '2026-08-06' });

  // Stable within a day → the same person counts once.
  assert.equal(a, same);
  // THE PRIVACY PROPERTY: the same person is a different key tomorrow, so these keys can never be
  // joined across days to reconstruct one person's history. If this assertion ever fails, the
  // table has quietly become a tracking log.
  assert.notEqual(a, nextDay);
  // Different link → different key, so one person on two links does not collide.
  assert.notEqual(a, otherCode);
  assert.notEqual(a, otherIp);
  // A digest, not the input: the IP must not be recoverable by reading the column.
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.ok(!a.includes(ip));

  // Nothing to hash → null rather than a constant. A shared constant would collapse every
  // anonymous click into ONE "unique visitor", which reads as a real number and is a lie.
  assert.equal(await visitorKey({ code: 'abc', istDay: '2026-08-06' }), null);
  assert.equal(await visitorKey({ ip, ua, istDay: '2026-08-06' }), null);

  console.log('link-click-detail: all assertions passed');
})();
