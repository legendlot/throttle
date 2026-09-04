// Support Analytics pure-derivation tests (S344, 2026-09-04).
//
// These two functions decide what the /analytics page COUNTS, so a silent change here
// changes numbers Pruthvi reads every morning without anything failing. Real imports,
// not a mirror — see the header of analytics.js for why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsDims, ANALYTICS_DIM_KEYS, trendBucket } from './analytics.js';

// ── analyticsDims ───────────────────────────────────────────────────────────

test('every dimension key is produced — the option list and the filter read the SAME object', () => {
  const d = analyticsDims({}, {});
  for (const k of ANALYTICS_DIM_KEYS) {
    assert.ok(k in d, `missing dimension ${k}`);
  }
  assert.deepEqual(Object.keys(d).sort(), [...ANALYTICS_DIM_KEYS].sort());
});

test('an empty row yields labels, never undefined — an undefined key would silently drop a row from a cut', () => {
  const d = analyticsDims({}, {});
  for (const [k, v] of Object.entries(d)) {
    assert.equal(typeof v, 'string', `${k} should be a string`);
    assert.notEqual(v, '', `${k} should not be empty`);
  }
});

test('unassigned complaints get their own bucket rather than being dropped', () => {
  assert.equal(analyticsDims({}, {}).agent, '— unassigned —');
  assert.equal(analyticsDims({ assigned_agent_name: 'Maria' }, {}).agent, 'Maria');
});

test('product_line comes from the lineOf map, and an unmapped product is Unclassified not blank', () => {
  const lineOf = { Shadow: 'Drift' };
  assert.equal(analyticsDims({ product: 'Shadow' }, lineOf).product_line, 'Drift');
  assert.equal(analyticsDims({ product: 'Otto' }, lineOf).product_line, 'Unclassified');
});

// support_channel is the derived one, and the one most likely to be broken by a change.
test('support_channel: auto_created is Calls whatever the intake_channel says', () => {
  assert.equal(analyticsDims({ auto_created: true, intake_channel: 'whatsapp' }, {}).support_channel, 'Calls');
});

test('support_channel: both phone spellings map to Calls', () => {
  assert.equal(analyticsDims({ intake_channel: 'phone' }, {}).support_channel, 'Calls');
  assert.equal(analyticsDims({ intake_channel: 'call' }, {}).support_channel, 'Calls');
});

test('support_channel: known channels get their display label', () => {
  assert.equal(analyticsDims({ intake_channel: 'whatsapp' }, {}).support_channel, 'WhatsApp');
  assert.equal(analyticsDims({ intake_channel: 'email' }, {}).support_channel, 'Email');
  assert.equal(analyticsDims({ intake_channel: 'sheet' }, {}).support_channel, 'Imported');
});

test('support_channel: an UNKNOWN channel passes through as itself, and only a missing one is Unknown', () => {
  // Passing an unrecognised value through (rather than bucketing it as Unknown) is what
  // makes a new intake_channel visible in the UI instead of hiding inside Unknown.
  assert.equal(analyticsDims({ intake_channel: 'carrier_pigeon' }, {}).support_channel, 'carrier_pigeon');
  assert.equal(analyticsDims({}, {}).support_channel, 'Unknown');
});

// ── trendBucket ─────────────────────────────────────────────────────────────

test('month grain truncates to YYYY-MM', () => {
  assert.equal(trendBucket('2026-09-04', 'month'), '2026-09');
  assert.equal(trendBucket('2026-09-04', undefined), '2026-09');
  assert.equal(trendBucket('2026-09-04', 'anything-not-week'), '2026-09');
});

test('week grain returns the week-commencing MONDAY', () => {
  // 2026-09-04 is a Friday; its Monday is 2026-08-31.
  assert.equal(trendBucket('2026-09-04', 'week'), '2026-08-31');
});

test('a Monday is its own week bucket', () => {
  assert.equal(trendBucket('2026-08-31', 'week'), '2026-08-31');
});

test('a Sunday belongs to the week that STARTED, not the one about to start', () => {
  // The floor works Mon–Sat (RULE-ATT-001), so a Sunday-start week would split every
  // working week in two. 2026-09-06 is a Sunday -> Monday 2026-08-31.
  assert.equal(trendBucket('2026-09-06', 'week'), '2026-08-31');
  // and the following Monday starts a new bucket
  assert.equal(trendBucket('2026-09-07', 'week'), '2026-09-07');
});

test('a week spanning a month boundary keeps ONE bucket', () => {
  // Both sides of 1 Sep fall in the week commencing Mon 2026-08-31.
  assert.equal(trendBucket('2026-08-31', 'week'), trendBucket('2026-09-01', 'week'));
});

test('the date is parsed as UTC, so no local timezone can shift the bucket a day', () => {
  // The input is ALREADY an IST calendar date. Re-interpreting it in another zone would
  // move dates across the Monday boundary — this asserts the boundary day itself.
  assert.equal(trendBucket('2026-08-31', 'week'), '2026-08-31'); // Monday stays Monday
  assert.equal(trendBucket('2026-08-30', 'week'), '2026-08-24'); // Sunday -> prior Monday
});

test('null and malformed input return null rather than throwing or bucketing wrongly', () => {
  assert.equal(trendBucket(null, 'week'), null);
  assert.equal(trendBucket('', 'week'), null);
  assert.equal(trendBucket('not-a-date', 'week'), null);
});

// ── daily grain (S347) ──────────────────────────────────────────────────────
// Pruthvi asked for a daily/weekly/MTD/monthly switch; only month and week existed.

test('day grain returns the whole IST date, so a day is never folded into its month', () => {
  assert.equal(trendBucket('2026-09-04', 'day'), '2026-09-04');
  assert.equal(trendBucket('2026-01-01', 'day'), '2026-01-01');
});

test('every grain sorts correctly as a plain string — the trend rows are ordered by bucket', () => {
  const days = ['2026-09-10', '2026-09-02', '2026-09-04'].map(d => trendBucket(d, 'day'));
  assert.deepEqual([...days].sort(), ['2026-09-02', '2026-09-04', '2026-09-10']);
});

test('an unknown grain still falls back to month rather than throwing or returning null', () => {
  assert.equal(trendBucket('2026-09-04', 'fortnight'), '2026-09');
  assert.equal(trendBucket('2026-09-04', undefined), '2026-09');
});

test('day grain keeps the empty-input contract', () => {
  assert.equal(trendBucket(null, 'day'), null);
  assert.equal(trendBucket('', 'day'), null);
});

// ── rollingAverage (S347) ───────────────────────────────────────────────────
import { rollingAverage } from './analytics.js';

test('the trailing mean is over the buckets PRESENT, not over the window width', () => {
  // If early rows divided by the window, this would print a fake rising ramp: 1.0, 1.5, 2.0.
  const out = rollingAverage([{ bucket: 'a', total: 3 }, { bucket: 'b', total: 3 }, { bucket: 'c', total: 3 }], 7);
  assert.deepEqual(out.map(r => r.avg), [3, 3, 3]);
  assert.deepEqual(out.map(r => r.window), [1, 2, 3]);
});

test('the window slides once the series is longer than it', () => {
  const s = [1, 2, 3, 4, 5].map((n, i) => ({ bucket: `d${i}`, total: n }));
  const out = rollingAverage(s, 3);
  assert.deepEqual(out.map(r => r.avg), [1, 1.5, 2, 3, 4]);   // last = (3+4+5)/3
  assert.deepEqual(out.map(r => r.window), [1, 2, 3, 3, 3]);
});

test('count is carried alongside avg, so the chart can draw bars and the line from one series', () => {
  const out = rollingAverage([{ bucket: 'a', total: 10 }, { bucket: 'b', total: 20 }], 2);
  assert.deepEqual(out, [
    { bucket: 'a', count: 10, avg: 10, window: 1 },
    { bucket: 'b', count: 20, avg: 15, window: 2 },
  ]);
});

test('an empty or malformed series yields [] rather than throwing', () => {
  assert.deepEqual(rollingAverage([], 7), []);
  assert.deepEqual(rollingAverage(null, 7), []);
  assert.deepEqual(rollingAverage(undefined, 7), []);
});

test('a missing or zero window degrades to a window of 1, never a divide-by-zero', () => {
  const out = rollingAverage([{ bucket: 'a', total: 4 }, { bucket: 'b', total: 6 }], 0);
  assert.deepEqual(out.map(r => r.avg), [4, 6]);
  assert.ok(out.every(r => Number.isFinite(r.avg)));
});

test('a non-numeric total counts as zero rather than poisoning the mean with NaN', () => {
  const out = rollingAverage([{ bucket: 'a', total: 2 }, { bucket: 'b' }, { bucket: 'c', total: 4 }], 3);
  assert.ok(out.every(r => Number.isFinite(r.avg)));
  assert.equal(out[2].avg, 2);   // (2 + 0 + 4) / 3
});

// ── Row-level export helpers (S349) ──────────────────────────────────────────

import { formatTicketNotes, maskPhoneForExport } from './analytics.js';

test('formatTicketNotes: one cell, IST-stamped, author named, newlines flattened, empties dropped', () => {
  const s = formatTicketNotes([
    { created_at: '2026-09-04T18:00:00Z', created_by_name: 'Pruthvi', body: 'Customer sent\nvideo' },
    { created_at: '2026-09-05T02:00:00Z', created_by_name: null, body: '   ' },
    { created_at: null, created_by_name: 'Maria', body: 'Replaced' },
  ]);
  // 18:00Z is 23:30 IST on the SAME day — a UTC stamp would have put it on the 4th at 18:00.
  assert.equal(s, '[2026-09-04 23:30 IST, Pruthvi] Customer sent / video | [, Maria] Replaced');
});

test('formatTicketNotes: no notes yields an empty string, never "null" or "undefined"', () => {
  assert.equal(formatTicketNotes([]), '');
  assert.equal(formatTicketNotes(), '');
  assert.equal(formatTicketNotes([{ body: null }]), '');
});

test('maskPhoneForExport matches the Queue export mask: all but the last three digits', () => {
  assert.equal(maskPhoneForExport('+917709991011'), '+917709991***');
  assert.equal(maskPhoneForExport('123'), '123');
  assert.equal(maskPhoneForExport(null), '');
});

test('formatTicketNotes survives a numeric body and a garbage timestamp — one cell, not a thrown export', () => {
  assert.equal(formatTicketNotes([{ body: 5, created_at: 'garbage', created_by_name: 'X' }]), '[, X] 5');
});
