import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('defaults when env is empty', () => {
  const c = loadConfig({});
  assert.equal(c.cutoffHour, 14);
  assert.equal(c.cutoffMin, 0);
  assert.deepEqual(c.nonWorkingDays, [0]);
  assert.equal(c.ttlMs, 12 * 3600 * 1000);
  assert.equal(c.copy.fallback, "Delivery in 5–7 days");
  assert.equal(c.copy.unserviceable, "We don't deliver to this pincode yet");
});

test('env overrides parse correctly', () => {
  const c = loadConfig({ ORIGIN_PINCODE: '560001', CUTOFF_HHMM: '16:30', NON_WORKING_DAYS: '0,6', CACHE_TTL_HOURS: '24' });
  assert.equal(c.originPin, '560001');
  assert.equal(c.cutoffHour, 16);
  assert.equal(c.cutoffMin, 30);
  assert.deepEqual(c.nonWorkingDays, [0, 6]);
  assert.equal(c.ttlMs, 24 * 3600 * 1000);
});
