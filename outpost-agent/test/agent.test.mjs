import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchLabel, ctnLabel, eanLabel, stickerRows, clean, istDate, build, DEFAULTS } from '../lib/tspl.mjs';
import { makeClient, canonicalString as agentCanonical } from '../lib/client.mjs';
import { openPrinter, PrintError } from '../lib/printers.mjs';
import { makeAgent } from '../agent.mjs';
import { canonicalString, importVerifyKey, verifySignature, sha256Hex } from '../../outpostops-worker/src/auth.js';

test('batch label matches the line print server layout', () => {
  const t = batchLabel({ batch_label: 'LOT-00000001-E', product: 'Gator', model: 'Hydro', color: 'Red', channel: 'ecom',
    packed_at: '2026-10-15T20:00:00Z' });
  assert.match(t, /BARCODE 24,3,"128",52,1,0,2,2,"LOT-00000001-E"/);
  assert.match(t, /TEXT 24,82,"1",0,1,1,"Gator Hydro Red"/);
  assert.match(t, /ECOM  16-Oct-2026/);                       // IST date: 20:00 UTC is the next day in India
  assert.ok(t.endsWith('PRINT 1,1\r\n'));
});

test('text cannot break out of a TSPL string', () => {
  assert.equal(clean('Gator "Pro"\r\nPRINT 9'), "Gator 'Pro' PRINT 9");
  const t = ctnLabel({ ctn_no: 'CTN-0000042', product: 'Ga"tor', unit_count: 18, channel: 'ecom', manifest_version: 2 });
  assert.equal((t.match(/"/g) || []).length % 2, 0);
  assert.match(t, /"CTN-0000042  v2"/);
  assert.throws(() => ctnLabel({ ctn_no: 'CTN-1"\r\nPRINT 99' }), /ctn_no/);
});

test('EAN label: 13 digits in, 12 to the printer, never a blank label', () => {
  assert.match(eanLabel({ ean: '8908012345671', product: 'Gator' }), /"EAN13",110,1,0,3,3,"890801234567"/);
  assert.throws(() => eanLabel({ ean: '12345', product: 'Gator' }), /13 digits/);
});

test('sticker sheet: rows of N across, one QR + id per sticker, bad ids refused', () => {
  const upcs = ['LOT-00000001', 'LOT-00000002', 'LOT-00000003', 'LOT-00000004'];
  const t = stickerRows({ upcs }, DEFAULTS.stickers);
  assert.equal((t.match(/^PRINT 1,1$/gm) || []).length, 2);  // 3 + 1
  assert.equal((t.match(/^QRCODE /gm) || []).length, 4);
  assert.match(t, /SIZE 44 mm, 13 mm/);                     // 1 + 3×13 + 2×2
  for (const u of upcs) assert.ok(t.includes(`,"${u}"`));
  assert.throws(() => stickerRows({ upcs: ['LOT-1"'] }), /bad sticker/);
  assert.throws(() => stickerRows({ upcs: [] }), /no stickers/);
  assert.throws(() => build({ kind: 'mystery', payload: {} }), /unknown job kind/);
});

test('istDate falls back to today on a bad date', () => assert.match(istDate('nope'), /^\d{2}-[A-Z][a-z]{2}-\d{4}$/));

test('agent signatures verify with the worker’s own verifier', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const verifyKey = await importVerifyKey({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y });
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, data: [] })); };
  const c = makeClient({ deviceId: 7, baseUrl: 'https://x', key: kp.privateKey, fetchImpl });
  await c.call('POST', '/v/agent/claim', { stickers: true, limit: 3 });
  const h = seen.init.headers;
  const canon = canonicalString({ method: 'POST', path: '/v/agent/claim', ts: h['X-Outpost-Ts'], nonce: h['X-Outpost-Nonce'],
    bodyHash: await sha256Hex(seen.init.body) });
  assert.equal(canon, agentCanonical({ method: 'POST', path: '/v/agent/claim', ts: h['X-Outpost-Ts'], nonce: h['X-Outpost-Nonce'],
    bodyHash: await sha256Hex(seen.init.body) }));
  assert.ok(await verifySignature(verifyKey, h['X-Outpost-Sig'], canon));
  assert.equal(h['X-Outpost-Device'], '7');
});

// A fake outpostops: hands out jobs once, records reports; `down` makes reports fail with 503.
function fakeServer(jobs) {
  const state = { reports: [], down: false, claims: 0 };
  const client = {
    deviceId: 1, now: () => Date.now(),
    async call(method, path, body) {
      if (path === '/v/agent/claim') { state.claims++; const j = jobs.splice(0); return { ok: true, status: 200, data: j }; }
      if (path === '/v/agent/report') {
        if (state.down) return { ok: false, status: 503, error: 'outpost_unavailable' };
        state.reports.push(body); return { ok: true, status: 200, data: { status: body.outcome } };
      }
      return { ok: true, status: 200, data: {} };
    },
  };
  return { state, client };
}
function memStore() { let list = []; return { read: () => list.slice(), write: l => { list = l.slice(); }, peek: () => list }; }
const lease = () => new Date(Date.now() + 60_000).toISOString();

test('agent prints each claimed job and reports it once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oa-'));
  const { state, client } = fakeServer([
    { id: 1, kind: 'batch_label', ref: 'LOT-00000001', attempt: 1, lease_until: lease(),
      payload: { batch_label: 'LOT-00000001-E', product: 'Gator' } },
    { id: 2, kind: 'upc_stickers', ref: 'B-1', attempt: 1, lease_until: lease(), payload: { upcs: ['LOT-00000009'] } }]);
  const store = memStore();
  const agent = makeAgent({ client, cfg: DEFAULTS, printers: { labels: openPrinter(`file:${dir}`), stickers: null }, pendingStore: store });
  await agent.tick();
  assert.deepEqual(state.reports.map(r => [r.job_id, r.outcome]), [[1, 'printed'], [2, 'not_printed']]);
  assert.match(state.reports[1].error, /no printer/);
  assert.deepEqual(readdirSync(dir), ['1-batch_label-a1.prn']);
  assert.match(readFileSync(join(dir, '1-batch_label-a1.prn'), 'latin1'), /LOT-00000001-E/);
  assert.equal(store.peek().length, 0);
});

test('an undelivered report is kept, retried before any new claim, and never re-prints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oa-'));
  const { state, client } = fakeServer([{ id: 5, kind: 'ean_label', ref: 'LOT-1', attempt: 2, lease_until: lease(),
    payload: { ean: '8908012345671', product: 'Gator' } }]);
  const store = memStore();
  const agent = makeAgent({ client, cfg: DEFAULTS, printers: { labels: openPrinter(`file:${dir}`) }, pendingStore: store });
  state.down = true;
  await agent.tick();
  assert.equal(store.peek().length, 1);
  assert.equal(state.claims, 1);
  await agent.tick();                                       // still down: no new claim while a report is owed
  assert.equal(state.claims, 1);
  state.down = false;
  await agent.tick();
  assert.deepEqual(state.reports, [{ job_id: 5, attempt: 2, outcome: 'printed', error: null }]);
  assert.equal(readdirSync(dir).length, 1);
});

test('a printer error after bytes were sent is reported unknown, before any byte not_printed', async () => {
  for (const [sent, want] of [[true, 'unknown'], [false, 'not_printed']]) {
    const { state, client } = fakeServer([{ id: 9, kind: 'ctn_label', ref: 'CTN-0000001', attempt: 1, lease_until: lease(),
      payload: { ctn_no: 'CTN-0000001', unit_count: 1 } }]);
    const printer = { name: 'x', send: async () => { throw new PrintError('jam', sent); }, status: async () => ({ ok: false }) };
    await makeAgent({ client, cfg: DEFAULTS, printers: { labels: printer }, pendingStore: memStore() }).tick();
    assert.equal(state.reports[0].outcome, want);
  }
});

test('a job whose lease is about to run out is handed back unprinted', async () => {
  const { state, client } = fakeServer([{ id: 3, kind: 'ctn_label', ref: 'CTN-0000001', attempt: 1,
    lease_until: new Date(Date.now() + 1000).toISOString(), payload: { ctn_no: 'CTN-0000001' } }]);
  let sent = 0;
  const printer = { name: 'x', send: async () => { sent++; }, status: async () => ({ ok: true }) };
  await makeAgent({ client, cfg: DEFAULTS, printers: { labels: printer }, pendingStore: memStore() }).tick();
  assert.equal(sent, 0);
  assert.equal(state.reports[0].outcome, 'not_printed');
});

test('a corrupt report outbox stops claiming instead of being overwritten', async () => {
  const { state, client } = fakeServer([{ id: 1, kind: 'ctn_label', ref: 'CTN-0000001', attempt: 1, lease_until: lease(),
    payload: { ctn_no: 'CTN-0000001' } }]);
  let writes = 0;
  const store = { read: () => { throw new Error('bad json'); }, write: () => { writes++; } };
  await makeAgent({ client, cfg: DEFAULTS, printers: { labels: { name: 'x', send: async () => {}, status: async () => ({}) } },
    pendingStore: store }).tick();
  assert.equal(state.claims, 0);
  assert.equal(writes, 0);
});

test('tcp driver: a refused connection sent nothing; a good one delivers the bytes', async () => {
  const net = await import('node:net');
  const got = [];
  const srv = net.createServer(sock => sock.on('data', d => got.push(d))).listen(0);
  await new Promise(r => srv.once('listening', r));
  const p = openPrinter(`tcp:127.0.0.1:${srv.address().port}`);
  await p.send('PRINT 1,1\r\n');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(Buffer.concat(got).toString(), 'PRINT 1,1\r\n');
  assert.equal((await p.status()).ok, true);
  srv.close();
  const dead = openPrinter('tcp:127.0.0.1:1');
  await assert.rejects(dead.send('x'), e => e instanceof PrintError && e.sent === false);
});
