import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRefresh, shouldApply, identityOf, JOIN_MAX_MS } from '../../../packages/db/useCachedQuery.js';

// The hook's two decisions, without a DOM. The React wiring itself is not unit-tested.

test('identity needs both a user and a key', () => {
  assert.equal(identityOf('u1', 'k'), 'u1\u0000k');
  assert.equal(identityOf(null, 'k'), null);
  assert.equal(identityOf('u1', ''), null);
  assert.notEqual(identityOf('u1', 'k'), identityOf('u2', 'k'));
});

test('a refresh joins the request in flight for the same identity (a slow call still lands)', () => {
  const id = identityOf('u1', 'kpis');
  assert.equal(planRefresh(null, id), 'start');
  assert.equal(planRefresh({ id, seq: 1 }, id), 'join');
});

test('a different identity never joins the old request', () => {
  assert.equal(planRefresh({ id: identityOf('u1', 'kpis'), seq: 1 }, identityOf('u2', 'kpis')), 'start');
  assert.equal(planRefresh({ id: identityOf('u1', 'kpis'), seq: 1 }, identityOf('u1', 'runs')), 'start');
});

test('only the latest request, while mounted, may apply its response', () => {
  assert.equal(shouldApply(3, 3, true), true);
  assert.equal(shouldApply(2, 3, true), false, 'superseded (identity changed)');
  assert.equal(shouldApply(3, 3, false), false, 'unmounted');
});

test('a request in flight past JOIN_MAX_MS is hung — a new one starts instead of joining it forever', () => {
  const id = identityOf('u1', 'kpis');
  const t0 = 1_000_000;
  assert.equal(planRefresh({ id, seq: 1, startedAt: t0 }, id, t0 + 61_000), 'join', 'slower than the 60 s loop still lands');
  assert.equal(planRefresh({ id, seq: 1, startedAt: t0 }, id, t0 + JOIN_MAX_MS), 'join');
  assert.equal(planRefresh({ id, seq: 1, startedAt: t0 }, id, t0 + JOIN_MAX_MS + 1), 'start');
});
