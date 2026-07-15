import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('GET /healthz returns ok', async () => {
  const res = await worker.fetch(new Request('https://x/healthz'), { }, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('unknown path returns 404', async () => {
  const res = await worker.fetch(new Request('https://x/nope'), {}, {});
  assert.equal(res.status, 404);
});
