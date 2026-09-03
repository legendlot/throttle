// Deliverability alert windowing + threshold (S340).
// Run: node test/deliverability-window.test.js
//
// THE REGRESSION THESE GUARD: the alert query had no time filter, so once email sending went
// quiet the same 100 rows were re-scored every hour forever. Relay last sent on 2026-08-26 and
// was still paging on 2026-09-03 with an identical "23/100 ... (23%)" — seven pages in one day,
// all describing a 72-second slice of an 8-day-old campaign.
const assert = require('assert');
const DW = require('../src/deliverability-window.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const enc = encodeURIComponent;
const SQ_MIN = DW.MIN_SIGNAL;
const rows = (spec) => Object.entries(spec).flatMap(([status, n]) =>
  Array.from({ length: n }, () => ({ status, provider_status: null })));

// ── the window itself ────────────────────────────────────────────────────────────────────────
t('the query carries a queued_at lower bound — THE missing filter that caused the incident', () => {
  const q = DW.buildQuery(Date.parse('2026-09-03T10:00:00Z'), enc);
  assert.ok(q.includes('queued_at=gte.'), 'no recency filter in the query');
});

t('the bound is exactly DELIVERABILITY_WINDOW_H hours back', () => {
  const now = Date.parse('2026-09-03T10:00:00Z');
  const q = DW.buildQuery(now, enc);
  const expected = enc(new Date(now - DW.DELIVERABILITY_WINDOW_H * 3600 * 1000).toISOString());
  assert.ok(q.includes(`queued_at=gte.${expected}`), `window bound wrong: ${q}`);
});

t('the window moves with the clock (it is not a frozen constant)', () => {
  const a = DW.buildQuery(Date.parse('2026-09-03T10:00:00Z'), enc);
  const b = DW.buildQuery(Date.parse('2026-09-04T10:00:00Z'), enc);
  assert.notStrictEqual(a, b, 'query did not change a day later — the window is not time-relative');
});

t('suppressed/skipped/queued are still excluded — a suppression is the gate working', () => {
  // assert against the status LIST, not the whole query: the path legitimately contains the
  // substring "queued" inside the `queued_at=gte.` window filter this fix added.
  const statuses = DW.OUTCOME_STATUSES.split(',');
  for (const bad of ['skipped', 'suppressed', 'queued'])
    assert.ok(!statuses.includes(bad), `${bad} must not count as a deliverability outcome`);
  assert.ok(DW.buildQuery(Date.now(), enc).includes(`status=in.(${DW.OUTCOME_STATUSES})`),
    'query no longer filters on the outcome status list');
});

// ── an idle channel is SILENCE ───────────────────────────────────────────────────────────────
t('THE INCIDENT: an idle channel produces NO alert (empty window)', () => {
  assert.strictEqual(DW.evaluate([]).alert, false, 'alerted on an empty window');
});

t('the exact 23/100 shape alerts when RECENT, so the fix did not just mute the check', () => {
  const ev = DW.evaluate(rows({ delivered: 77, bounced: 23 }));
  assert.strictEqual(ev.alert, true, 'a real 23% failure rate must still alert');
  assert.strictEqual(ev.failed, 23);
  assert.strictEqual(ev.total, 100);
});

t('a thin window stays quiet — 19 rows is not enough signal even if all failed', () => {
  const ev = DW.evaluate(rows({ bounced: 19 }));
  assert.strictEqual(ev.alert, false, 'alerted on 19 rows; MIN_SIGNAL is 20');
  assert.strictEqual(ev.total, 19);
});

t('at exactly MIN_SIGNAL the check engages', () => {
  assert.strictEqual(DW.evaluate(rows({ bounced: 20 })).alert, true);
});

// ── threshold behaviour, unchanged by the fix ────────────────────────────────────────────────
t('a healthy window does not alert', () => {
  assert.strictEqual(DW.evaluate(rows({ delivered: 95, bounced: 5 })).alert, false);
});

t('the 10% threshold is exclusive — exactly 10% is not a spike', () => {
  const ev = DW.evaluate(rows({ delivered: 90, bounced: 10 }));
  assert.strictEqual(ev.rate, 0.10);
  assert.strictEqual(ev.alert, false, '10% must not alert; >10% must');
  assert.strictEqual(DW.evaluate(rows({ delivered: 89, bounced: 11 })).alert, true);
});

t('a single spam complaint alerts regardless of rate', () => {
  const list = rows({ delivered: 99 });
  list.push({ status: 'delivered', provider_status: 'email.complained' });
  const ev = DW.evaluate(list);
  assert.strictEqual(ev.complaints, 1);
  assert.strictEqual(ev.alert, true, 'a complaint must alert even at a healthy failure rate');
});

t('failed and bounced both count as failures', () => {
  assert.strictEqual(DW.evaluate(rows({ delivered: 80, failed: 11, bounced: 9 })).failed, 20);
});

t('garbage rows never throw', () => {
  assert.strictEqual(DW.evaluate(null).alert, false);
  assert.strictEqual(DW.evaluate([null, undefined, {}]).alert, false);
  // ⚠️ The line above returns at the MIN_SIGNAL guard and never reaches the row-level `m &&`
  // checks — it passed vacuously and would still pass with those guards deleted (S340 hostile
  // review). This one has enough rows to actually walk them.
  const many = Array(SQ_MIN + 5).fill(null);
  assert.strictEqual(DW.evaluate(many).alert, false, 'null rows must not throw or count as failures');
  const mixed = Array(SQ_MIN + 5).fill(null).map((_, i) => (i % 2 ? null : { status: 'bounced' }));
  assert.ok(DW.evaluate(mixed).failed > 0, 'real rows among nulls must still be counted');
});

// ── the message ──────────────────────────────────────────────────────────────────────────────
t('alert text names the window — the old wording said "recent" for 8-day-old rows', () => {
  const text = DW.alertText(DW.evaluate(rows({ delivered: 77, bounced: 23 })));
  assert.ok(text.includes(`last ${DW.DELIVERABILITY_WINDOW_H}h`), `window not named: ${text}`);
  assert.ok(!/recent email sends/.test(text), 'reverted to the misleading "recent" wording');
  assert.ok(text.includes('23/100'), 'counts missing from the alert');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
