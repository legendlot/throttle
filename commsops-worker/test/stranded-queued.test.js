// Stranded-queued sweep (S340).
// Run: node test/stranded-queued.test.js
//
// THE DEFECT: send.js reserves a messages row at status='queued' and finalize() closes it. If the
// worker dies between the two, the row stays 'queued' forever and is invisible to every rate that
// filters on real outcomes. 35 such rows were found by hand on 2026-09-03, spanning 2026-08-09 →
// 09-01 across email/campaign, whatsapp/campaign and whatsapp/journey.
//
// THE HAZARD THE SWEEP ITSELF INTRODUCES, and the reason for the first test below: sweeping too
// eagerly would mark LIVE in-flight sends as abandoned. The threshold MUST stay clear of
// send.js's in-flight window.
const assert = require('assert');
const SQ = require('../src/stranded-queued.js');
const SEND = require('../src/send.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const enc = encodeURIComponent;

// ── the safety invariant ─────────────────────────────────────────────────────────────────────
t('THE INVARIANT: the sweep waits strictly longer than send.js IN_FLIGHT_MS', () => {
  assert.ok(SQ.STRANDED_AFTER_MS > SEND.IN_FLIGHT_MS,
    `sweep threshold ${SQ.STRANDED_AFTER_MS} must exceed in-flight ${SEND.IN_FLIGHT_MS}`);
});

t('the threshold binds to the REAL exported value, not a local copy that could drift', () => {
  assert.strictEqual(SQ.IN_FLIGHT_MS, SEND.IN_FLIGHT_MS,
    'stranded-queued must read IN_FLIGHT_MS from send.js');
});

t('there is real headroom, not a one-millisecond pass', () => {
  assert.ok(SQ.STRANDED_AFTER_MS >= SEND.IN_FLIGHT_MS * 2,
    'threshold should sit well clear of the in-flight window, not just above it');
});

// ── the query ────────────────────────────────────────────────────────────────────────────────
t('only queued rows older than the threshold are selected', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const q = SQ.buildSweepQuery(now, enc);
  assert.ok(q.includes('status=eq.queued'), 'must target queued rows only');
  const cutoff = enc(new Date(now - SQ.STRANDED_AFTER_MS).toISOString());
  assert.ok(q.includes(`queued_at=lt.${cutoff}`), `wrong cutoff: ${q}`);
});

t('a row queued 5 minutes ago is NOT in range (it is still in flight)', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const cutoffIso = new Date(now - SQ.STRANDED_AFTER_MS).toISOString();
  const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
  assert.ok(fiveMinAgo > cutoffIso, 'a 5-minute-old row must fall outside the sweep');
});

t('a row queued 8 days ago IS in range (the observed incident shape)', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const cutoffIso = new Date(now - SQ.STRANDED_AFTER_MS).toISOString();
  assert.ok(new Date(now - 8 * 86400 * 1000).toISOString() < cutoffIso);
});

t('the sweep is bounded so one tick cannot run away', () => {
  assert.ok(/limit=\d+/.test(SQ.buildSweepQuery(Date.now(), enc)), 'no limit on the sweep query');
});

// ── what it writes ───────────────────────────────────────────────────────────────────────────
t('swept rows are skipped, NOT failed — a non-send must not become a delivery failure', () => {
  assert.strictEqual(SQ.patchBody().status, 'skipped');
  assert.notStrictEqual(SQ.patchBody().status, 'failed');
});

t('the reason records the ambiguity and forbids auto-resend', () => {
  const reason = SQ.patchBody().reason;
  assert.ok(/stranded_queued/.test(reason), 'reason must be greppable');
  assert.ok(/never auto-resend/i.test(reason),
    'reason must carry the no-auto-resend rule — a later reader may be tempted to replay these');
});

// ── the log summary ──────────────────────────────────────────────────────────────────────────
t('summarize groups by channel/source so the failing surface is named', () => {
  const s = SQ.summarize([
    { id: 1, channel: 'email',    source: 'campaign:abc', queued_at: '2026-08-26T13:04:00Z' },
    { id: 2, channel: 'whatsapp', source: 'campaign:def', queued_at: '2026-08-27T10:00:00Z' },
    { id: 3, channel: 'whatsapp', source: 'journey:ghi',  queued_at: '2026-09-01T01:00:00Z' },
    { id: 4, channel: 'whatsapp', source: 'journey:jkl',  queued_at: '2026-09-01T02:00:00Z' },
  ]);
  assert.strictEqual(s.swept, 4);
  assert.deepStrictEqual(s.by, { 'email/campaign': 1, 'whatsapp/campaign': 1, 'whatsapp/journey': 2 });
  assert.strictEqual(s.oldest, '2026-08-26T13:04:00Z', 'oldest must be the first (asc) row');
});

t('summarize survives empty, null and malformed rows', () => {
  assert.strictEqual(SQ.summarize([]).swept, 0);
  assert.strictEqual(SQ.summarize(null).swept, 0);
  const s = SQ.summarize([null, {}, { channel: 'sms' }]);
  assert.strictEqual(s.swept, 3);
  assert.ok(s.by['unknown/unknown'] >= 1 || s.by['sms/unknown'] >= 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
