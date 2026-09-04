// Node unit tests for the LimeChat voice webhook receiver (Phase 0, capture-first).
// Run: node test/limechat-webhook.test.js
//
// ⚠️ WHAT THESE TESTS CAN AND CANNOT PROVE. We have never seen a real LimeChat payload — the
// flow is still being designed and the disposition is fully custom. So these do NOT prove we
// parse the real wire shape. They prove the properties that must hold FOR ANY shape:
//   - 100% of authenticated requests are captured raw, mapped or not
//   - an unrecognised / empty / non-JSON payload still returns 200, never 5xx
//   - extraction prefers a top-level field over a nested one, and survives absence
//   - the endpoint is inert without a token and rejects a wrong one
// That is the contract the vendor integration actually depends on.
const assert = require('assert');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
async function run() {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ', name); }
    catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
  }
}

// ── stub the DB + ingest seams before requiring the module under test ──
const A = require('../src/auth.js');
const ingestMod = require('../src/ingest.js');
const realSb = A.sbComms;
const realIngest = ingestMod.ingest;

let captures = [];
let ingested = [];
let ingestImpl = async () => ({ ok: true, profile_id: 'p-1', deduped: false });

A.sbComms = async (path, env, opts) => {
  if (path.startsWith('/rest/v1/webhook_captures')) {
    captures.push(JSON.parse(opts.body));
    return { ok: true, data: [] };
  }
  return { ok: true, data: [] };
};
ingestMod.ingest = async (env, envelope) => { ingested.push(envelope); return ingestImpl(env, envelope); };

const LC = require('../src/limechat-webhooks.js');

const ENV = { LIMECHAT_WEBHOOK_TOKEN: 'tok-abc' };
function req(body, { token = 'tok-abc', header = 'Authorization', raw = null } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-vendor': 'limechat' });
  if (token) headers.set(header, header === 'Authorization' ? `Bearer ${token}` : token);
  return new Request('https://commsops.example/webhooks/limechat', {
    method: 'POST', headers, body: raw !== null ? raw : JSON.stringify(body),
  });
}
function reset() { captures = []; ingested = []; ingestImpl = async () => ({ ok: true, profile_id: 'p-1', deduped: false }); }

// ── config gate + auth ──
t('inert 503 until LIMECHAT_WEBHOOK_TOKEN is set', async () => {
  reset();
  const r = await LC.handleLimechatWebhook({}, req({ phone: '9876543210' }));
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.error, 'limechat_not_configured');
  assert.strictEqual(captures.length, 0, 'must not write anything while unconfigured');
});

t('wrong token → 401, and the rejection is captured truncated', async () => {
  reset();
  const r = await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210' }, { token: 'nope' }));
  assert.strictEqual(r.status, 401);
  assert.strictEqual(captures.length, 1, 'a rejection must leave a trace — silence must not be ambiguous');
  assert.strictEqual(captures[0].headers._reason, 'bad_token');
  assert.strictEqual(captures[0].body._rejected, true);
  assert.ok(!('phone' in captures[0].body), 'rejected bodies are stored as an excerpt, not parsed');
});

t('empty token is not a wildcard', async () => {
  reset();
  assert.strictEqual(LC.tokenOk(ENV, req({}, { token: '' })), false);
  assert.strictEqual(LC.tokenOk({}, req({}, { token: '' })), false);
});

t('X-LimeChat-Token header is accepted as well as Bearer', async () => {
  reset();
  assert.strictEqual(LC.tokenOk(ENV, req({}, { header: 'X-LimeChat-Token' })), true);
});

t('auth headers are never persisted into the capture', async () => {
  reset();
  await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210' }));
  const h = captures[0].headers;
  assert.ok(!('authorization' in h) && !('Authorization' in h), 'Authorization must be stripped');
  assert.strictEqual(h['x-vendor'], 'limechat', 'other headers are kept');
});

// ── capture-first: the Phase 0 deliverable ──
t('a MAPPED request is still captured raw (not only unmapped ones)', async () => {
  reset();
  const body = { call_id: 'c-1', phone: '9876543210', call_status: 'completed' };
  const r = await LC.handleLimechatWebhook(ENV, req(body));
  assert.strictEqual(r.mapped, true);
  assert.strictEqual(captures.length, 1, 'the successful path must capture too — the guess needs checking');
  assert.deepStrictEqual(captures[0].body, body, 'the raw body is stored verbatim');
  assert.strictEqual(captures[0].source, 'limechat');
});

t('a payload with NO recognisable identity is captured and ack\'d 200', async () => {
  reset();
  const body = { some_future_field: 'x', nested: { totally: 'unknown' } };
  const r = await LC.handleLimechatWebhook(ENV, req(body));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mapped, false);
  assert.strictEqual(r.reason, 'no_identity');
  assert.strictEqual(captures.length, 1);
  assert.deepStrictEqual(captures[0].body, body);
  assert.strictEqual(ingested.length, 0, 'nothing to attach → no event');
});

t('non-JSON body does not throw; it is captured as _unparsed', async () => {
  reset();
  const r = await LC.handleLimechatWebhook(ENV, req(null, { raw: 'not json at all' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(captures.length, 1);
  assert.strictEqual(captures[0].body._unparsed, 'not json at all');
});

t('an ingest failure still returns 200 — the vendor must not retry-storm', async () => {
  reset();
  ingestImpl = async () => ({ ok: false, error: 'boom' });
  const r = await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210', call_id: 'c-9' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mapped, false);
  assert.ok(String(r.reason).startsWith('ingest_error'));
  assert.strictEqual(captures.length, 1, 'captured before ingest was attempted');
});

t('an ingest THROW is caught and still returns 200', async () => {
  reset();
  ingestImpl = async () => { throw new Error('network down'); };
  const r = await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'ingest_error');
});

// ── schema-agnostic extraction ──
t('extract finds fields under several plausible spellings', () => {
  assert.strictEqual(LC.extract({ phone_number: '9876543210' }).phone, '+919876543210');
  assert.strictEqual(LC.extract({ 'Call Status': 'busy' }).status, 'busy');
  assert.strictEqual(LC.extract({ callStatus: 'busy' }).status, 'busy');
  assert.strictEqual(LC.extract({ 'call-status': 'busy' }).status, 'busy');
  assert.strictEqual(LC.extract({ msisdn: '+919876543210' }).phone, '+919876543210');
});

t('extract digs into nested objects and arrays', () => {
  const got = LC.extract({ data: { call: { customer: { mobile: '9876543210' }, disposition: 'no answer' } } });
  assert.strictEqual(got.phone, '+919876543210');
  assert.strictEqual(got.status, 'no answer');
});

t('a TOP-LEVEL field beats a nested one of the same name', () => {
  // Breadth-first matters: a provider blob nested inside must not shadow the real status.
  const got = LC.extract({ status: 'completed', provider: { status: 'ok' } });
  assert.strictEqual(got.status, 'completed');
});

t('preference order wins within one level', () => {
  // `call_status` is listed ahead of the generic `status`.
  const got = LC.extract({ status: 'ok', call_status: 'unanswered' });
  assert.strictEqual(got.status, 'unanswered');
});

t('missing fields come back null rather than throwing', () => {
  const got = LC.extract({});
  assert.strictEqual(got.phone, null);
  assert.strictEqual(got.call_id, null);
  assert.strictEqual(got.status, null);
  assert.strictEqual(got.occurred_at, null);
});

t('empty strings and nulls are not treated as values', () => {
  const got = LC.extract({ phone: '', call_status: null, status: 'busy' });
  assert.strictEqual(got.phone, null);
  assert.strictEqual(got.status, 'busy');
});

t('timestamps accept ISO, epoch seconds and epoch millis', () => {
  assert.strictEqual(LC.extract({ updated_at: '2026-09-04T10:00:00Z' }).occurred_at, '2026-09-04T10:00:00.000Z');
  assert.strictEqual(LC.extract({ updated_at: 1788528000 }).occurred_at, new Date(1788528000 * 1000).toISOString());
  assert.strictEqual(LC.extract({ updated_at: 1788528000000 }).occurred_at, new Date(1788528000000).toISOString());
});

t('an unparseable timestamp is dropped, not propagated as Invalid Date', () => {
  assert.strictEqual(LC.extract({ updated_at: 'sometime tuesday' }).occurred_at, null);
});

t('findField is bounded on depth — it does not hang on a deep payload', () => {
  let deep = { phone: '9876543210' };
  for (let i = 0; i < 400; i++) deep = { nest: deep };
  const got = LC.extract(deep);           // beyond MAX_DEPTH → simply not found
  assert.strictEqual(got.phone, null);
});

t('findField terminates on a self-referencing payload', () => {
  const cyclic = { a: { phone: '9876543210' } };
  cyclic.a.self = cyclic;                 // node cap must stop the walk
  const got = LC.extract(cyclic);
  assert.strictEqual(got.phone, '+919876543210');
});

// ── the emitted envelope ──
t('idempotency prefers the vendor call id', async () => {
  reset();
  await LC.handleLimechatWebhook(ENV, req({ call_id: 'c-42', phone: '9876543210' }));
  assert.strictEqual(ingested[0].idempotency_key, 'limechat:call:c-42');
});

t('without a call id the fallback key hashes the BODY, not phone + time', async () => {
  reset();
  await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210', updated_at: '2026-09-04T10:00:00Z' }));
  assert.ok(/^limechat:call:\+919876543210:b[0-9a-f]{8}$/.test(ingested[0].idempotency_key),
    'got ' + ingested[0].idempotency_key);
});

t('TWO DIFFERENT calls with no id and no timestamp do NOT collide', async () => {
  // The regression this replaces: a phone+occurred_at key collapsed to "<phone>:unknown" for that
  // customer forever, so the second real call deduped away and its outcome vanished — the raw
  // capture would still land, so the loss was invisible. Found by hostile review.
  reset();
  await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210', disposition: 'no answer' }));
  await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210', disposition: 'answered and confirmed' }));
  assert.strictEqual(ingested.length, 2);
  assert.notStrictEqual(ingested[0].idempotency_key, ingested[1].idempotency_key,
    'two distinct call outcomes for one customer must not share a dedupe key');
});

t('a byte-identical REDELIVERY still dedupes to the same key', async () => {
  reset();
  const body = { phone: '9876543210', disposition: 'busy' };
  await LC.handleLimechatWebhook(ENV, req(body));
  await LC.handleLimechatWebhook(ENV, req(body));
  assert.strictEqual(ingested[0].idempotency_key, ingested[1].idempotency_key,
    'the same delivery twice must collapse — that is what idempotency is for');
});

t('bodyHash is stable and differs on differing input', () => {
  assert.strictEqual(LC.bodyHash('abc'), LC.bodyHash('abc'));
  assert.notStrictEqual(LC.bodyHash('abc'), LC.bodyHash('abd'));
  assert.ok(/^[0-9a-f]{8}$/.test(LC.bodyHash('')));
});

t('the whole raw payload rides along in properties.raw', async () => {
  reset();
  const body = { call_id: 'c-7', phone: '9876543210', weird_future_field: { a: 1 } };
  await LC.handleLimechatWebhook(ENV, req(body));
  assert.deepStrictEqual(ingested[0].properties.raw, body,
    'the outcome rule is written later against real fields — the raw payload must survive');
});

t('the event name is outcome-neutral', async () => {
  reset();
  await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210', call_status: 'completed' }));
  assert.strictEqual(ingested[0].name, 'voice_call_received');
  assert.strictEqual(ingested[0].source, 'limechat_webhook');
  // It must NOT encode confirmed/declined/unresolved — that mapping waits on Pruthvi's flow.
  assert.ok(!/confirm|cancel|declin|abandon/i.test(ingested[0].name));
});

// ── hardening found by the S352 hostile review ──
t('a TOP-LEVEL field beats a nested one even under a DIFFERENT candidate name', () => {
  // The old ranking used candidate-index only, so a vendor blob one level down won whenever its
  // key happened to be listed first. `status` is what the Phase-1 send rule keys on, and
  // "purchased" vs "completed" is exactly the confirmed/unresolved distinction.
  const got = LC.extract({ disposition: 'purchased', provider: { call_status: 'completed' } });
  assert.strictEqual(got.status, 'purchased');
});

t('depth still yields to preference WITHIN one level', () => {
  const got = LC.extract({ result: 'ok', disposition: 'no answer' });
  assert.strictEqual(got.status, 'no answer');
});

t('a wrapper `to` / `number` is no longer mistaken for a phone', () => {
  const got = LC.extract({ to: 'support@legendoftoys.com', number: 9876543210 });
  assert.strictEqual(got.phone, null, 'missing a field beats inventing one');
});

t('timestamps outside a plausible window are rejected, not coerced to 1970', () => {
  assert.strictEqual(LC.extract({ updated_at: '2026' }).occurred_at, null);
  assert.strictEqual(LC.extract({ updated_at: 0 }).occurred_at, null);
  assert.strictEqual(LC.extract({ updated_at: -1 }).occurred_at, null);
  assert.strictEqual(LC.extract({ updated_at: true }).occurred_at, null);
  assert.strictEqual(LC.extract({ updated_at: 4102444800 }).occurred_at, null, 'year 2100 rejected');
  const good = new Date(Date.now() - 60000).toISOString();
  assert.strictEqual(LC.extract({ updated_at: good }).occurred_at, good, 'a real one still passes');
});

t('the UNAUTHENTICATED rejection capture stores only allow-listed headers', async () => {
  reset();
  const headers = new Headers({ 'content-type': 'application/json', 'x-huge': 'A'.repeat(5000) });
  headers.set('Authorization', 'Bearer wrong');
  const r = await LC.handleLimechatWebhook(ENV, new Request('https://x/webhooks/limechat',
    { method: 'POST', headers, body: '{}' }));
  assert.strictEqual(r.status, 401);
  assert.ok(!('x-huge' in captures[0].headers), 'a public endpoint must not be an unbounded write primitive');
  assert.strictEqual(captures[0].headers['content-type'], 'application/json');
});

t('an AUTHENTICATED capture keeps full headers — that is the discovery value', async () => {
  reset();
  await LC.handleLimechatWebhook(ENV, req({ phone: '9876543210' }));
  assert.strictEqual(captures[0].headers['x-vendor'], 'limechat');
});

run().then(() => {
  A.sbComms = realSb; ingestMod.ingest = realIngest;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
