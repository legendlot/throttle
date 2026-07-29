// Send-time media ids — the 131053 fix.
// Run: node test/wa-media.test.js
//
// CONTEXT: a media header sent as {link} makes Meta fetch the asset on EVERY send, and that
// fetch fails ASYNCHRONOUSLY (131053) — the API returns 200 + a wamid, then the status webhook
// flips the message to failed. Measured 2026-07-29: 4 of 113 Order Placed sends, i.e. real order
// confirmations lost, with nothing to retry synchronously.
//
// THE INVARIANT UNDER TEST is the safety one: every failure path must leave the rendered
// components untouched so the send degrades to exactly today's link behaviour. This module can
// make sending better or leave it unchanged — never worse. That is what makes it safe to run on
// a live transactional path.

const assert = require('assert');
const A = require('../src/auth.js');
const WAM = require('../src/wa-media.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const ENV = { WA_TOKEN: 'tok' };
const URL = 'https://cdn.example.com/banner.png';
const HEADER = (link) => ([{ type: 'header', parameters: [{ type: 'image', image: { link } }] },
                           { type: 'body', parameters: [{ type: 'text', text: 'hi' }] }]);

// ── stubs ───────────────────────────────────────────────────────────────────────────────
const origSb = A.sbComms;
const origFetch = global.fetch;
function stub({ cacheRow = null, cacheOk = true, assetOk = true, mime = 'image/png',
                bytes = 1024, uploadOk = true, uploadId = 'MEDIA-1' } = {}) {
  const calls = { uploads: 0, stores: 0, deletes: 0 };
  A.sbComms = async (url, env, opts) => {
    if (url.startsWith('/rest/v1/wa_media_cache')) {
      if (opts?.method === 'POST') { calls.stores++; return { ok: true, data: [] }; }
      if (opts?.method === 'DELETE') { calls.deletes++; return { ok: true, data: [] }; }
      if (!cacheOk) return { ok: false, status: 500 };
      return { ok: true, data: cacheRow ? [cacheRow] : [] };
    }
    return { ok: true, data: [] };
  };
  global.fetch = async (url, opts) => {
    if (String(url).includes('/media')) {
      calls.uploads++;
      return uploadOk
        ? { ok: true, json: async () => ({ id: uploadId }) }
        : { ok: false, json: async () => ({ error: { message: 'nope' } }) };
    }
    // asset fetch
    if (!assetOk) return { ok: false, json: async () => ({}) };
    return {
      ok: true,
      headers: { get: () => mime },
      arrayBuffer: async () => new ArrayBuffer(bytes),
    };
  };
  return { calls, restore: () => { A.sbComms = origSb; global.fetch = origFetch; } };
}

(async () => {
  await t('cache HIT reuses the media id, no upload', async () => {
    const s = stub({ cacheRow: { media_id: 'CACHED-9', uploaded_at: new Date().toISOString() } });
    const out = await WAM.applyMediaIds(ENV, HEADER(URL), 'PN1');
    s.restore();
    assert.deepEqual(out[0].parameters[0].image, { id: 'CACHED-9' });
    assert.equal(s.calls.uploads, 0);
    assert.deepEqual(out[1], HEADER(URL)[1], 'non-header components untouched');
  });

  await t('cache MISS uploads once, then swaps link → id', async () => {
    const s = stub({ cacheRow: null });
    const out = await WAM.applyMediaIds(ENV, HEADER(URL), 'PN1');
    s.restore();
    assert.deepEqual(out[0].parameters[0].image, { id: 'MEDIA-1' });
    assert.equal(s.calls.uploads, 1);
    assert.equal(s.calls.stores, 1, 'result is cached');
  });

  await t('EXPIRED cache row re-uploads rather than replaying a dead id', async () => {
    const old = new Date(Date.now() - 25 * 86400000).toISOString();
    const s = stub({ cacheRow: { media_id: 'STALE', uploaded_at: old } });
    const out = await WAM.applyMediaIds(ENV, HEADER(URL), 'PN1');
    s.restore();
    assert.deepEqual(out[0].parameters[0].image, { id: 'MEDIA-1' });
    assert.equal(s.calls.uploads, 1);
  });

  // ── every failure path must FALL BACK TO THE LINK ────────────────────────────────────
  const fallback = (name, opts) => t(`FALLBACK: ${name} → link left intact`, async () => {
    const s = stub(opts);
    const before = HEADER(URL);
    const out = await WAM.applyMediaIds(ENV, before, 'PN1');
    s.restore();
    assert.deepEqual(out[0].parameters[0].image, { link: URL },
      'header must still carry the original link');
  });

  await fallback('asset fetch fails', { assetOk: false });
  await fallback('Meta upload fails', { uploadOk: false });
  await fallback('unsupported mime (webp)', { mime: 'image/webp' });
  await fallback('asset over the 5MB cap', { bytes: 6 * 1024 * 1024 });
  await fallback('zero-byte asset', { bytes: 0 });
  await fallback('cache read errors', { cacheOk: false, uploadOk: false });

  await t('FALLBACK: no WA_TOKEN → link left intact, nothing attempted', async () => {
    const s = stub({});
    const out = await WAM.applyMediaIds({}, HEADER(URL), 'PN1');
    s.restore();
    assert.deepEqual(out[0].parameters[0].image, { link: URL });
    assert.equal(s.calls.uploads, 0);
  });

  await t('FALLBACK: no phone_number_id → link left intact', async () => {
    const s = stub({});
    const out = await WAM.applyMediaIds(ENV, HEADER(URL), null);
    s.restore();
    assert.deepEqual(out[0].parameters[0].image, { link: URL });
  });

  await t('non-https asset url is refused (never upload from http)', async () => {
    const s = stub({});
    const id = await WAM.resolveMediaId(ENV, 'http://cdn.example.com/x.png', 'PN1');
    s.restore();
    assert.equal(id, null);
    assert.equal(s.calls.uploads, 0);
  });

  // ── shape guards ────────────────────────────────────────────────────────────────────
  await t('a TEXT header is not touched', async () => {
    const s = stub({});
    const comps = [{ type: 'header', parameters: [{ type: 'text', text: 'Hi' }] }];
    const out = await WAM.applyMediaIds(ENV, comps, 'PN1');
    s.restore();
    assert.deepEqual(out, comps);
    assert.equal(s.calls.uploads, 0);
  });

  await t('a header already carrying an id is not re-uploaded', async () => {
    const s = stub({});
    const comps = [{ type: 'header', parameters: [{ type: 'image', image: { id: 'X' } }] }];
    const out = await WAM.applyMediaIds(ENV, comps, 'PN1');
    s.restore();
    assert.deepEqual(out, comps);
    assert.equal(s.calls.uploads, 0);
  });

  await t('empty / non-array components are returned as-is', async () => {
    const s = stub({});
    assert.deepEqual(await WAM.applyMediaIds(ENV, [], 'PN1'), []);
    assert.equal(await WAM.applyMediaIds(ENV, undefined, 'PN1'), undefined);
    s.restore();
  });

  await t('invalidate() DELETEs that number\'s cache', async () => {
    const s = stub({});
    await WAM.invalidate(ENV, 'PN1');
    s.restore();
    assert.equal(s.calls.deletes, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
