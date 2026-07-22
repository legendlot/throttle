// test/send-dedup.test.js — dedup must be on SUCCESS, not on attempt.
// Run: node test/send-dedup.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const { send } = require('../src/send.js');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok  ', name); },
  (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
const origSb = A.sbComms;

// env stub is irrelevant — everything goes through A.sbComms.
const ENV = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };

(async () => {
  await t('conflict with a SENT row → deduped', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, status: 201, data: [] };       // conflict
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, status: 200, data: [{ id: 'M1', status: 'sent', queued_at: new Date().toISOString() }] };
      throw new Error('unexpected ' + path);
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k1' });
    assert.equal(r.status, 'deduped');
  });

  await t('conflict with a SKIPPED row → takes the row over and proceeds (template lookup runs)', async () => {
    const calls = [];
    A.sbComms = async (path, env, opts = {}) => {
      calls.push(path.split('?')[0] + ':' + (opts.method || 'GET'));
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, data: [{ id: 'M2', status: 'skipped', queued_at: '2026-07-01T00:00:00Z' }] };
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };                       // template_not_found → finalize
      if (path.includes('/messages?id=eq.M2')) return { ok: true, data: [{ id: 'M2' }] };          // finalize PATCH on the ADOPTED row
      return { ok: true, data: [] };
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k2' });
    assert.notEqual(r.status, 'deduped');                       // it retried
    assert.ok(calls.some((c) => c.includes('/messages') && c.endsWith(':PATCH')), 'must PATCH the adopted row');
  });

  await t('conflict with a FRESH queued row (in-flight) → deduped', async () => {
    A.sbComms = async (path) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, data: [{ id: 'M3', status: 'queued', queued_at: new Date().toISOString() }] };
      throw new Error('unexpected ' + path);
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k3' });
    assert.equal(r.status, 'deduped');
  });

  await t('conflict with a STALE queued row (crashed run) → takes over', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, data: [{ id: 'M4', status: 'queued', queued_at: '2026-07-01T00:00:00Z' }] };
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };
      if (path.includes('/messages?id=eq.M4')) return { ok: true, data: [{ id: 'M4' }] };
      return { ok: true, data: [] };
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k4' });
    assert.notEqual(r.status, 'deduped');
  });

  await t('conflict + status-lookup FAILURE → deduped (fail-safe against double-send)', async () => {
    A.sbComms = async (path) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: false, status: 500, data: null };
      throw new Error('unexpected ' + path);
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k5' });
    assert.equal(r.status, 'deduped');
  });

  await t('finalize RELEASES the dedup key on a non-sent outcome', async () => {
    let patched = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [{ id: 'M6' }] };        // fresh reserve
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };                        // → failed
      if (path.includes('/messages?id=eq.M6') && opts.method === 'PATCH') { patched = JSON.parse(opts.body); return { ok: true, data: [{ id: 'M6' }] }; }
      return { ok: true, data: [] };
    };
    await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k6' });
    assert.strictEqual(patched.dedup_key, null, 'non-sent outcome must free the key');
  });

  A.sbComms = origSb;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
