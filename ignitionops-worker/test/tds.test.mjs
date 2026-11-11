import test from 'node:test';
import assert from 'node:assert/strict';
import { fyStartOf, fyLabel, tdsSummary, TDS_THRESHOLD } from '../src/tds.js';

test('the financial year turns on 1 April', () => {
  assert.equal(fyStartOf('2026-03-31'), '2025-04-01');
  assert.equal(fyStartOf('2026-04-01'), '2026-04-01');
  assert.equal(fyStartOf('2026-11-11'), '2026-04-01');
  assert.equal(fyStartOf('2027-01-05'), '2026-04-01');
  for (const v of [null, undefined, '', 'nope']) assert.equal(fyStartOf(v), null);
});

test('labels read FY 2026-27, and FY 2099-00 across a century', () => {
  assert.equal(fyLabel('2026-04-01'), 'FY 2026-27');
  assert.equal(fyLabel('2099-04-01'), 'FY 2099-00');
  assert.equal(fyLabel(null), null);
});

const row = (fy, value, extra = {}) => ({ fy_start: fy, value: String(value), deals: '2', lines: '3', unpriced_lines: '0', ...extra });

test('over means MORE than ₹20,000; exactly ₹20,000 is near, not over', () => {
  assert.equal(TDS_THRESHOLD, 20000);
  assert.equal(tdsSummary([row('2026-04-01', '20000.01')], '2026-11-11').status, 'over');
  assert.equal(tdsSummary([row('2026-04-01', '20000.00')], '2026-11-11').status, 'near');
  assert.equal(tdsSummary([row('2026-04-01', 15000)], '2026-11-11').status, 'near');
  assert.equal(tdsSummary([row('2026-04-01', 14999.99)], '2026-11-11').status, 'clear');
});

test('only the current FY counts toward the flag; an earlier year that crossed is listed apart', () => {
  const s = tdsSummary([row('2026-04-01', 900), row('2025-04-01', 25000), row('2024-04-01', 3000)], '2026-11-11');
  assert.equal(s.status, 'clear');
  assert.equal(s.value, 900);
  assert.equal(s.fy_label, 'FY 2026-27');
  assert.deepEqual(s.earlier_over, [{ fy_label: 'FY 2025-26', value: 25000 }]);
});

test('no row this year reads as ₹0 clear, numbers arrive as strings and are read as numbers', () => {
  const s = tdsSummary([row('2025-04-01', 100)], '2026-11-11');
  assert.deepEqual([s.value, s.deals, s.status, s.fy_start], [0, 0, 'clear', '2026-04-01']);
  const t = tdsSummary([row('2026-04-01', '1234.567', { unpriced_lines: '2' })], '2026-11-11');
  assert.equal(t.value, 1234.57);
  assert.equal(t.unpriced_lines, 2);
});

test('hostile rows do not throw', () => {
  for (const r of [null, undefined, {}, [null], [{}], 'x']) {
    const s = tdsSummary(r, '2026-11-11');
    assert.equal(s.status, 'clear');
  }
});
