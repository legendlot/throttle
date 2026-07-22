// Node unit tests for the BSP→own-WABA number-migration flow (cutover runbook, /internal/wa-migrate-number).
// Run: node test/wa-migrate.test.js   (Node 18+ — global fetch stubbed per-case)

const assert = require('assert');
const WATPL = require('../src/wa-templates.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ', name); },
    (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
}
const realFetch = global.fetch;
function stubFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = realFetch; }

const ENV = { WA_TOKEN: 'tok', WA_GRAPH_VERSION: 'v21.0' };

(async () => {
  await t('start builds the migrate-in URL + body, returns Meta id on 2xx', async () => {
    let captured;
    stubFetch(async (u, opts) => {
      captured = { u, method: opts.method, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
      return { ok: true, status: 200, json: async () => ({ id: 'NEW_PID_123' }) };
    });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'start', destWabaId: 'DEST_WABA', cc: '91', phoneNumber: '9880212323' });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.equal(r.id, 'NEW_PID_123');
    assert.ok(captured.u.includes('/DEST_WABA/phone_numbers'));
    assert.equal(captured.method, 'POST');
    assert.equal(captured.auth, 'Bearer tok');
    assert.deepEqual(captured.body, { cc: '91', phone_number: '9880212323', migrate_phone_number: true });
  });

  await t('start with missing params → missing_params, no fetch made', async () => {
    let called = false;
    stubFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
    const r1 = await WATPL.waMigrateNumber(ENV, { op: 'start', cc: '91', phoneNumber: '9880212323' });
    const r2 = await WATPL.waMigrateNumber(ENV, { op: 'start', destWabaId: 'D', phoneNumber: '9880212323' });
    const r3 = await WATPL.waMigrateNumber(ENV, { op: 'start', destWabaId: 'D', cc: '91' });
    restoreFetch();
    assert.equal(r1.ok, false); assert.equal(r1.error, 'missing_params');
    assert.equal(r2.ok, false); assert.equal(r2.error, 'missing_params');
    assert.equal(r3.ok, false); assert.equal(r3.error, 'missing_params');
    assert.equal(called, false, 'must not hit Graph with missing params');
  });

  await t('request_code voice → code_method VOICE', async () => {
    let captured;
    stubFetch(async (u, opts) => {
      captured = { u, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'request_code', phoneNumberId: 'PID', method: 'voice' });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.ok(captured.u.includes('/PID/request_code'));
    assert.equal(captured.body.code_method, 'VOICE');
    assert.equal(captured.body.language, 'en_US');
  });

  await t('request_code default (no method / sms) → code_method SMS', async () => {
    let captured;
    stubFetch(async (u, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ success: true }) }; });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'request_code', phoneNumberId: 'PID' });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.equal(captured.code_method, 'SMS');
  });

  await t('verify passes the code through as a string', async () => {
    let captured;
    stubFetch(async (u, opts) => { captured = { u, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ success: true }) }; });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'verify', phoneNumberId: 'PID', code: 123456 });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.ok(captured.u.includes('/PID/verify_code'));
    assert.strictEqual(captured.body.code, '123456');
  });

  await t('register defaults pin to 000000 and sets messaging_product', async () => {
    let captured;
    stubFetch(async (u, opts) => { captured = { u, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ success: true }) }; });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'register', phoneNumberId: 'PID' });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.ok(captured.u.includes('/PID/register'));
    assert.equal(captured.body.messaging_product, 'whatsapp');
    assert.strictEqual(captured.body.pin, '000000');
  });

  await t('register with a supplied pin passes it through as a string', async () => {
    let captured;
    stubFetch(async (u, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ success: true }) }; });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'register', phoneNumberId: 'PID', pin: 224466 });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.strictEqual(captured.pin, '224466');
  });

  await t('a 400 Graph error surfaces error.message + code', async () => {
    stubFetch(async () => ({ ok: false, status: 400,
      json: async () => ({ error: { message: 'Two step verification is enabled', code: 133005 } }) }));
    const r = await WATPL.waMigrateNumber(ENV, { op: 'register', phoneNumberId: 'PID', pin: '000000' });
    restoreFetch();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Two step verification is enabled');
    assert.equal(r.code, 133005);
    assert.deepEqual(r.details, { message: 'Two step verification is enabled', code: 133005 });
  });

  await t('a network throw is caught → graph_network:*, never escapes', async () => {
    stubFetch(async () => { throw new Error('fetch failed: ECONNRESET'); });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'verify', phoneNumberId: 'PID', code: '111111' });
    restoreFetch();
    assert.equal(r.ok, false);
    assert.ok(r.error.startsWith('graph_network:'), r.error);
    assert.ok(r.error.includes('ECONNRESET'));
  });

  await t('missing WA_TOKEN short-circuits with wa_not_configured, no fetch', async () => {
    let called = false;
    stubFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
    const r = await WATPL.waMigrateNumber({}, { op: 'start', destWabaId: 'D', cc: '91', phoneNumber: '123' });
    restoreFetch();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'wa_not_configured');
    assert.equal(called, false);
  });

  await t('unknown op → unknown_op, no fetch', async () => {
    let called = false;
    stubFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
    const r = await WATPL.waMigrateNumber(ENV, { op: 'nope' });
    restoreFetch();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unknown_op');
    assert.equal(called, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
