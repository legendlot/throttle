// Ram #bugs 1790768468 (2026-09-30): the unfiltered Sales Orders list (682 orders) showed every
// order "not submitted" — loadFulfilment sent all 682 uuids in ONE `in.()` GET, the read failed,
// and the failure fell back to "no request". queryPublicIn chunks the list; getSalesOrders refuses
// on a failed read. Behavioural test on the extracted helper + source checks on the call sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/index.js'), 'utf8');

function loadHelper(queryPublic) {
  const a = src.indexOf('const IN_CHUNK = ');
  const b = src.indexOf('async function loadFulfilment(');
  assert.ok(a > 0 && b > a, 'helper block not found');
  return new Function('queryPublic', `${src.slice(a, b)}; return { queryPublicIn, IN_CHUNK };`)(queryPublic);
}

test('682 ids → 5 GETs of at most 150, every row returned, each URL well under 8 KB', async () => {
  const urls = [];
  const { queryPublicIn, IN_CHUNK } = loadHelper(async (table, params) => {
    urls.push(`/rest/v1/${table}${params}`);
    const ids = params.match(/in\.\(([^)]*)\)/)[1].split(',');
    return { ok: true, data: ids.map(id => ({ sales_order_id: id })) };
  });
  const ids = Array.from({ length: 682 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const r = await queryPublicIn('dispatch_fulfilment_requests', 'sales_order_id', [...ids, ids[0], null], 'select=*');
  assert.equal(IN_CHUNK, 150);
  assert.equal(urls.length, 5);
  assert.ok(urls.every(u => u.length < 8000), 'every chunk URL fits');
  assert.ok(r.ok);
  assert.deepEqual(r.data.map(x => x.sales_order_id).sort(), [...ids].sort(), 'deduped, nothing lost');
});

test('one failed chunk → ok:false (never a silent partial read)', async () => {
  let n = 0;
  const { queryPublicIn } = loadHelper(async () => (++n === 2 ? { ok: false, data: 'boom' } : { ok: true, data: [{}] }));
  const ids = Array.from({ length: 400 }, (_, i) => `id${i}`);
  const r = await queryPublicIn('t', 'c', ids, 'select=*');
  assert.equal(r.ok, false);
});

test('empty list → no request', async () => {
  const { queryPublicIn } = loadHelper(async () => { throw new Error('should not call'); });
  assert.deepEqual(await queryPublicIn('t', 'c', [], 'select=*'), { ok: true, data: [] });
});

test('loadFulfilment uses the chunked read for all four in-lists; getSalesOrders refuses a failed read', () => {
  const a = src.indexOf('async function loadFulfilment(');
  const body = src.slice(a, src.indexOf('\nfunction resolveFulfilment', a));
  assert.equal((body.match(/queryPublicIn\(/g) || []).length, 4);
  assert.doesNotMatch(body, /=in\.\(\$\{/, 'no hand-built in.() left in loadFulfilment');
  assert.match(src, /if \(ful\?\._ok === false\) return err\('Could not load fulfilment status — please refresh', 502\);/);
});

test('Collections, Party Balances and cancelOrder refuse a failed fulfilment read', () => {
  const body = name => {
    const i = src.indexOf(`case '${name}': {`);
    return src.slice(i, src.indexOf("\n          case '", i + 10));
  };
  for (const c of ['getSalesCollections', 'getSalesPartyBalances'])
    assert.match(body(c), /if \(ful\?\._ok === false\) return err\(/, c);
  const cancel = body('cancelOrder');
  const guard = cancel.indexOf("if (ful?._ok === false) return err('Could not check dispatch status");
  assert.ok(guard > 0, 'cancelOrder guard present');
  assert.ok(guard < cancel.indexOf('sbPublic('), 'guard runs before the first write');
  assert.match(cancel, /if \(!shR\.ok\) return err\('Could not check dispatch status/);
});
