import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDate, addTransit, formatEdd } from '../src/edd.js';

const CFG = { cutoffHour: 14, cutoffMin: 0, nonWorkingDays: [0] }; // Sunday off

// Helper: an instant that is a given IST wall-clock time. IST = UTC+5:30.
const istInstant = (y, mo, d, hh, mm) => new Date(Date.UTC(y, mo, d, hh, mm) - 330 * 60000);

test('before cut-off on a working day dispatches today', () => {
  // Wed 2026-07-15 11:00 IST
  const day = dispatchDate(istInstant(2026, 6, 15, 11, 0), CFG);
  assert.equal(day.getUTCFullYear(), 2026);
  assert.equal(day.getUTCMonth(), 6);
  assert.equal(day.getUTCDate(), 15);
});

test('after cut-off rolls to the next working day', () => {
  // Wed 2026-07-15 15:00 IST → Thu 16th
  const day = dispatchDate(istInstant(2026, 6, 15, 15, 0), CFG);
  assert.equal(day.getUTCDate(), 16);
});

test('Saturday after cut-off skips Sunday to Monday', () => {
  // Sat 2026-07-18 18:00 IST → Sun 19th is off → Mon 20th
  const day = dispatchDate(istInstant(2026, 6, 18, 18, 0), CFG);
  assert.equal(day.getUTCDate(), 20);
});

test('Sunday (a non-working day) even before cut-off rolls to Monday', () => {
  // Sun 2026-07-19 09:00 IST → Mon 20th
  const day = dispatchDate(istInstant(2026, 6, 19, 9, 0), CFG);
  assert.equal(day.getUTCDate(), 20);
});

test('addTransit adds calendar days', () => {
  const base = new Date(Date.UTC(2026, 6, 15));
  assert.equal(addTransit(base, 3).getUTCDate(), 18);
});

test('formatEdd renders weekday + day + short month', () => {
  assert.equal(formatEdd(new Date(Date.UTC(2026, 6, 15))), 'Wed, 15 Jul');
});
