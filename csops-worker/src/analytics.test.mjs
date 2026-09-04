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
