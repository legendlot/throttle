import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from './measure.js';

const NOW = Date.parse('2026-11-12T10:00:00+05:30');
const METRICS = [{ key: 'odo.net_revenue', label: 'Net revenue (ex-GST)', unit: '₹' }, { key: 'redline.first_pass_yield', label: 'QC first-pass yield', unit: '%' },
  { key: 'redline.units_packed', label: 'Units packed (PKG)', unit: 'units' }];

test('values: ₹ in L / cr, % as is, counts grouped', () => {
  assert.equal(m.fmtMeasureValue(15900000, '₹'), '₹1.59 cr');
  assert.equal(m.fmtMeasureValue(10000000, '₹'), '₹1 cr');
  assert.equal(m.fmtMeasureValue(250000, '₹'), '₹2.5 L');
  assert.equal(m.fmtMeasureValue(98765, '₹'), '₹98,765');
  assert.equal(m.fmtMeasureValue('98.25', '%'), '98.3%');
  assert.equal(m.fmtMeasureValue(98, '%'), '98%');
  assert.equal(m.fmtMeasureValue(1234567, 'units'), '12,34,567 units');
  assert.equal(m.fmtMeasureValue(2.5, null), '2.5');
  assert.equal(m.fmtMeasureValue(93.456789, null), '93.5');
  assert.equal(m.fmtMeasureValue(null, '₹'), '—');
});

test('chip: value + window end, reached flag; no reading → null; a null value says no data', () => {
  const c = m.readingChip({ metric: 'redline.units_packed', reading: { value: 12340, window_from: '2026-10-14', window_to: '2026-11-12', reached: true, target_parsed: true } }, METRICS, NOW);
  assert.equal(c.text, '12,340 units · 30d to Thu 12 Nov');
  assert.equal(c.reached, true);
  assert.match(c.title, /14 Oct 2026 – 12 Nov 2026/);
  assert.equal(m.readingChip({ metric: 'x' }, METRICS, NOW), null);
  assert.equal(m.readingChip({ metric: 'odo.net_revenue', reading: { value: null, window_to: '2026-11-12', reached: null } }, METRICS, NOW).text, 'no data · 30d to Thu 12 Nov');
  assert.match(m.readingChip({ metric: 'x', reading: { value: 1, window_from: '2026-10-14', window_to: '2026-11-12', target_parsed: false } }, METRICS, NOW).title, /isn’t a number/);
});

test('evidence prefill: the contract sentence', () => {
  const row = { metric_label: 'Net revenue (ex-GST)', reading: 16000000, window_from: '2026-10-14', window_to: '2026-11-12', target: '≥ 1.5 cr' };
  assert.equal(m.reachedEvidence(row, METRICS), 'Measured ₹1.6 cr (Net revenue (ex-GST)) over 14 Oct – 12 Nov 2026, target ≥ 1.5 cr');
  assert.equal(m.fmtRange('2026-12-20', '2027-01-18'), '20 Dec 2026 – 18 Jan 2027');
  assert.equal(m.reachedEvidence({ reading: 5 }), 'Measured 5');
});

test('reached null (ceiling before due, or target changed) → reading shown, no mark; FPY rounds to one decimal', () => {
  const ceil = m.readingChip({ metric: 'redline.first_pass_yield', reading: { value: 97.84615384615384, window_from: '2026-10-14', window_to: '2026-11-12', reached: null, target_parsed: true } }, METRICS, NOW);
  assert.equal(ceil.text, '97.8% · 30d to Thu 12 Nov');
  assert.equal(ceil.reached, false);
  assert.equal(m.readingChip({ metric: 'redline.units_packed', reading: { value: 500, window_to: '2026-11-12', reached: null } }, METRICS, NOW).reached, false);
  assert.equal(m.readingChip({ metric: 'redline.first_pass_yield', reading: { value: 97.84615384615384, window_to: '2026-11-12', reached: true } }, [], NOW).text, '97.8 · 30d to Thu 12 Nov');
});
