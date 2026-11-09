import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_GROUPS, filterNavByPerms } from '../src/lib/nav.js';

// Reann #3 S3: Commission shows for D2C (commission_verify) or reports access — `requires` as any-of.
const ids = perms => filterNavByPerms(NAV_GROUPS, perms).flatMap(g => (g.items || []).map(i => i.id));

test('nav: Commission needs commission_verify OR reports_view', () => {
  assert.equal(ids({ ignition_view: true }).includes('commission'), false);
  assert.equal(ids({ ignition_view: true, ignition_commission_verify: true }).includes('commission'), true);
  assert.equal(ids({ ignition_view: true, ignition_reports_view: true }).includes('commission'), true);
  assert.equal(ids({ ignition_view: true }).includes('reports'), false);
});
