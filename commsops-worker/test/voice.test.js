// Voice channel orchestrator (S400) — gate, ledger lifecycle, vendor webhook, timeout sweep.
// Run: node --test test/voice.test.js
const test = require('node:test');
const assert = require('assert');

// ── stub every seam BEFORE requiring the modules under test (voice.js destructures ingest) ──
const A = require('../src/auth.js');
const ingestMod = require('../src/ingest.js');
let ingested = [];
ingestMod.ingest = async (env, env2) => { ingested.push(env2); return { ok: true, profile_id: 'p-1' }; };

const G = require('../src/gate.js');
const C = require('../src/consent.js');
let settings, quiet, consentState, consentReadOk, consentWrites, nowMin;
G.getSettings = async () => settings;
G.getChannelQuietHours = async () => quiet;
G.istMinutes = () => nowMin;
C._latestConsentRaw = async () => (consentReadOk ? { ok: true, state: consentState } : { ok: false, state: null });
C.recordConsent = async (env, row) => { consentWrites.push(row); return { ok: true }; };

// A tiny in-memory comms.voice_calls + suppressions behind A.sbComms.
let calls, suppressed, capHit, failRead, requests, captures, supRows, supWrites, resolveOk, patchHook;
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
A.sbComms = async (path, env, opts = {}) => {
  const method = opts.method || 'GET';
  if (path.startsWith('/rest/v1/webhook_captures')) { captures.push(JSON.parse(opts.body)); return { ok: true, data: [] }; }
  if (path.startsWith('/rest/v1/rpc/resolve_identity')) return resolveOk ? { ok: true, data: 'prof-1' } : { ok: false, data: null };
  if (path.startsWith('/rest/v1/suppressions')) {
    if (method === 'POST') { const r = JSON.parse(opts.body); supWrites.push(r); supRows.push(r); return { ok: true, data: [] }; }
    if (failRead === 'suppression') return { ok: false };
    return { ok: true, data: suppressed ? [{ reason: 'manual' }] : supRows.map((r) => ({ reason: r.reason })) };
  }
  if (path.startsWith('/rest/v1/voice_calls')) {
    const q = new URLSearchParams(path.split('?')[1] || '');
    if (method === 'POST') {
      const row = { id: newId(), origin: 'relay', requested_at: new Date().toISOString(), started_at: null,
        provider_call_ref: null, ...JSON.parse(opts.body) };
      calls.push(row); return { ok: true, data: [row] };
    }
    if (method === 'PATCH') {
      const id = (q.get('id') || '').replace('eq.', ''), st = (q.get('status') || '').replace('eq.', '');
      if (patchHook) { const h = patchHook; patchHook = null; h(); }       // simulate a concurrent writer
      const dispNull = q.get('disposition') === 'is.null';
      const row = calls.find((r) => r.id === id && (!st || r.status === st) && (!dispNull || r.disposition == null));
      if (!row) return { ok: true, data: [] };
      Object.assign(row, JSON.parse(opts.body)); return { ok: true, data: [row] };
    }
    // GETs: the 7-day cap probe, a by-id read, and the sweep
    if (q.get('phone') && q.get('requested_at')) {
      if (failRead === 'cap') return { ok: false };
      return { ok: true, data: capHit ? [{ id: 'x' }] : [] };
    }
    if (q.get('id')) return { ok: true, data: calls.filter((r) => `eq.${r.id}` === q.get('id')) };
    if (q.get('or')) {
      const cut = Date.now() - 20 * 60e3, cut2 = Date.now() - 30 * 60e3;
      return { ok: true, data: calls.filter((r) => r.origin === 'relay' && (
        (r.status === 'requested' && Date.parse(r.requested_at) < cut) ||
        (r.status === 'started' && Date.parse(r.started_at) < cut2))) };
    }
    return { ok: true, data: calls };
  }
  return { ok: true, data: [] };
};

const V = require('../src/voice.js');
const VA = require('../src/adapters/voice.js');
const LC = require('../src/limechat-webhooks.js');

function reset() {
  settings = { test_mode: false, test_mode_allow: ['+917709991011'], test_allowlist: [] };
  quiet = { ok: true, rows: { voice: { channel: 'voice', enabled: true, start_time: '21:00:00', end_time: '09:00:00' } } };
  nowMin = 12 * 60;                       // 12:00 IST — inside the call window
  consentState = null; consentReadOk = true; consentWrites = [];
  calls = []; suppressed = false; capHit = false; failRead = null; requests = []; captures = []; ingested = [];
  supRows = []; supWrites = []; resolveOk = true; patchHook = null;
}
const okDial = async (env, args) => { requests.push(args); return { ok: true, data: { status: 'queued' } }; };
const env = {};

// ── vocabularies ──
test('LimeChat strings map into OUR closed vocab; anything unknown is null, never coerced', () => {
  assert.strictEqual(V.mapCallStatus('Completed'), 'answered');
  assert.strictEqual(V.mapCallStatus('unanswered'), 'no_answer');
  assert.strictEqual(V.mapCallStatus('never dialed'), 'not_dialled');
  assert.strictEqual(V.mapCallStatus('voicemail'), null);
  assert.strictEqual(V.mapDisposition('Send Link'), 'wants_link');
  assert.strictEqual(V.mapDisposition('do-not-call'), 'opt_out');
  assert.strictEqual(V.mapDisposition('maybe later'), null);
  assert.strictEqual(V.mapDisposition(null), null);
});

test('path: only a positive opt_out suppresses, only wants_link/followup_ok send the link, all else = no_pickup', () => {
  assert.strictEqual(V.pathFor('opt_out'), 'opt_out');
  assert.strictEqual(V.pathFor('wants_link'), 'send_link');
  assert.strictEqual(V.pathFor('followup_ok'), 'send_link');
  for (const d of ['unresolved', 'no_pickup', null, undefined, 'garbage']) assert.strictEqual(V.pathFor(d), 'no_pickup');
});

test('indianMobile accepts Indian mobiles in any spelling and refuses everything else', () => {
  assert.strictEqual(V.indianMobile('98765 43210'), '+919876543210');
  assert.strictEqual(V.indianMobile('+91-98765-43210'), '+919876543210');
  for (const bad of ['', null, '12345', '+15555550123', '0123456789', '+915876543210', 42]) assert.strictEqual(V.indianMobile(bad), null);
});

// ── the gate ──
test('placeCall refuses a bad purpose or number without writing a ledger row', async () => {
  reset();
  assert.deepStrictEqual(await V.placeCall(env, { purpose: 'blast', phone: '9876543210' }), { ok: false, error: 'invalid_purpose' });
  assert.deepStrictEqual(await V.placeCall(env, { purpose: 'manual', phone: '12' }), { ok: false, error: 'invalid_phone' });
  assert.strictEqual(calls.length, 0);
});

test('happy path: ledger row FIRST, then LimeChat is asked with call_ref = that row id', async () => {
  reset();
  const r = await V.placeCall(env, { purpose: 'abandonment', flow: 'checkout', phone: '9876543210',
    context: { customer_name: 'Asha', cart_value: 2499, secret_blob: 'x' } }, { requestCall: okDial });
  assert.strictEqual(r.placed, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].status, 'requested');
  assert.strictEqual(requests[0].callRef, calls[0].id);
  assert.strictEqual(requests[0].phone, '+919876543210');
  assert.deepStrictEqual(requests[0].context, { customer_name: 'Asha', cart_value: 2499 }, 'unlisted context keys never travel');
});

test('LimeChat refusing the request → request_failed, visible, not silently "requested"', async () => {
  reset();
  const r = await V.placeCall(env, { purpose: 'manual', phone: '9876543210' },
    { requestCall: async () => ({ ok: false, error: 'limechat_http_500' }) });
  assert.strictEqual(r.placed, false);
  assert.strictEqual(calls[0].status, 'request_failed');
  assert.strictEqual(calls[0].skip_reason, 'limechat_http_500');
});

test('the unconfigured adapter dials nothing and says so', async () => {
  reset();
  const r = await VA.requestCall({}, {}, async () => { throw new Error('must not fetch'); });
  assert.deepStrictEqual(r, { ok: false, error: 'limechat_not_configured' });
});

test('outside 09:00–21:00 IST → deferred, NO row, NO dial (every purpose, COD included)', async () => {
  for (const [min, purpose] of [[21 * 60, 'abandonment'], [8 * 60 + 59, 'cod_confirmation'], [2 * 60, 'manual']]) {
    reset(); nowMin = min;
    const r = await V.placeCall(env, { purpose, phone: '9876543210' }, { requestCall: okDial });
    assert.strictEqual(r.reason, 'outside_call_window', `${purpose} at ${min}`);
    assert.strictEqual(calls.length, 0); assert.strictEqual(requests.length, 0);
  }
});

test('the allowlisted test number may be called at night (end-to-end tests), nobody else', async () => {
  reset(); nowMin = 23 * 60;
  const r = await V.placeCall(env, { purpose: 'test', phone: '7709991011' }, { requestCall: okDial });
  assert.strictEqual(r.placed, true);
});

test('purpose test only reaches the test allowlist', async () => {
  reset();
  const r = await V.placeCall(env, { purpose: 'test', phone: '9876543210' }, { requestCall: okDial });
  assert.strictEqual(r.reason, 'test_recipient_not_allowlisted');
  assert.strictEqual(requests.length, 0);
});

test('global test_mode on blocks a real customer', async () => {
  reset(); settings.test_mode = true;
  const r = await V.placeCall(env, { purpose: 'manual', phone: '9876543210' }, { requestCall: okDial });
  assert.strictEqual(r.reason, 'test_mode_blocked');
});

test('do-not-call flag blocks abandonment + manual, NEVER the COD confirmation call', async () => {
  for (const [purpose, blocked] of [['abandonment', true], ['manual', true], ['cod_confirmation', false]]) {
    reset(); consentState = 'opted_out';
    const r = await V.placeCall(env, { purpose, phone: '9876543210' }, { requestCall: okDial });
    assert.strictEqual(r.placed, !blocked, purpose);
    if (blocked) { assert.strictEqual(r.reason, 'do_not_call'); assert.strictEqual(calls[0].status, 'skipped'); }
  }
});

test('7-day cap blocks a second ABANDONMENT call only', async () => {
  for (const [purpose, blocked] of [['abandonment', true], ['cod_confirmation', false], ['manual', false]]) {
    reset(); capHit = true;
    const r = await V.placeCall(env, { purpose, phone: '9876543210' }, { requestCall: okDial });
    assert.strictEqual(r.placed, !blocked, purpose);
    if (blocked) assert.strictEqual(r.reason, 'call_cap_7d');
  }
});

test('every gate read FAILS CLOSED — LimeChat filters nothing, we are the only check', async () => {
  reset(); failRead = 'suppression';
  assert.strictEqual((await V.placeCall(env, { purpose: 'manual', phone: '9876543210' }, { requestCall: okDial })).reason, 'gate_error:suppression');
  reset(); consentReadOk = false;
  assert.strictEqual((await V.placeCall(env, { purpose: 'manual', phone: '9876543210' }, { requestCall: okDial })).reason, 'gate_error:consent');
  reset(); quiet = { ok: false };
  assert.strictEqual((await V.placeCall(env, { purpose: 'manual', phone: '9876543210' }, { requestCall: okDial })).reason, 'gate_error:quiet_hours');
  reset(); failRead = 'cap';
  assert.strictEqual((await V.placeCall(env, { purpose: 'abandonment', phone: '9876543210' }, { requestCall: okDial })).reason, 'gate_error:call_cap');
  assert.strictEqual(requests.length, 0);
});

test('a suppressed number is never called, any purpose', async () => {
  reset(); suppressed = true;
  const r = await V.placeCall(env, { purpose: 'cod_confirmation', phone: '9876543210' }, { requestCall: okDial });
  assert.strictEqual(r.reason, 'suppressed');
});

// ── vendor → us ──
async function placed(purpose = 'abandonment') {
  await V.placeCall(env, { purpose, flow: 'cart', phone: '9876543210' }, { requestCall: okDial });
  return calls[calls.length - 1];
}

test('call_started moves requested → started and records their call id', async () => {
  reset(); const row = await placed();
  const r = await V.applyVendorEvent(env, { event: 'call_started', call_ref: row.id, call_id: 'lc-1', phone: '+919876543210' });
  assert.strictEqual(r.status, 'started'); assert.strictEqual(row.status, 'started'); assert.strictEqual(row.provider_call_ref, 'lc-1');
});

test('call_ended: opt_out writes the do-not-call flag and emits path=opt_out with scalars only', async () => {
  reset(); const row = await placed();
  const r = await V.applyVendorEvent(env, { event: 'call_ended', call_ref: row.id, call_status: 'answered',
    disposition: 'opt_out', transcript: 'long text…', summary: 's', duration_seconds: '63' });
  assert.strictEqual(r.path, 'opt_out');
  assert.strictEqual(row.status, 'ended'); assert.strictEqual(row.duration_seconds, 63); assert.strictEqual(row.transcript, 'long text…');
  assert.strictEqual(consentWrites.length, 1);
  assert.deepStrictEqual([consentWrites[0].channel, consentWrites[0].purpose, consentWrites[0].state], ['voice', 'marketing', 'opted_out']);
  assert.strictEqual(ingested.length, 1);
  assert.strictEqual(ingested[0].name, 'voice_call_ended');
  assert.strictEqual(ingested[0].properties.path, 'opt_out');
  assert.ok(!('transcript' in ingested[0].properties) && !('summary' in ingested[0].properties), 'no transcript/summary in events');
});

test('a redelivered call_ended is deduped: one event, one flag', async () => {
  reset(); const row = await placed();
  const b = { event: 'call_ended', call_ref: row.id, disposition: 'opt_out' };
  await V.applyVendorEvent(env, b);
  const r2 = await V.applyVendorEvent(env, b);
  assert.strictEqual(r2.deduped, true); assert.strictEqual(ingested.length, 1); assert.strictEqual(consentWrites.length, 1);
});

test('no answer with no disposition → disposition no_pickup, path no_pickup', async () => {
  reset(); const row = await placed();
  const r = await V.applyVendorEvent(env, { call_ref: row.id, call_status: 'unanswered' });
  assert.deepStrictEqual([r.call_status, r.disposition, r.path], ['no_answer', 'no_pickup', 'no_pickup']);
});

test('an UNKNOWN disposition on an answered call falls to no_pickup, never to send_link', async () => {
  reset(); const row = await placed();
  const r = await V.applyVendorEvent(env, { call_ref: row.id, call_status: 'completed', disposition: 'customer was confused' });
  assert.deepStrictEqual([r.disposition, r.path], [null, 'no_pickup']);
  assert.strictEqual(row.raw.disposition, 'customer was confused', 'their raw string is kept');
});

test('a late disposition after the timeout still lands, flagged late', async () => {
  reset(); const row = await placed(); row.status = 'timed_out';
  const r = await V.applyVendorEvent(env, { call_ref: row.id, disposition: 'wants_link', call_status: 'answered' });
  assert.strictEqual(r.late, true); assert.strictEqual(r.path, 'send_link'); assert.strictEqual(ingested[0].properties.late, true);
});

test('call_started after a request_failed proves the call happened → started', async () => {
  reset();
  await V.placeCall(env, { purpose: 'manual', phone: '9876543210' }, { requestCall: async () => ({ ok: false, error: 'limechat_unreachable:TimeoutError' }) });
  const row = calls[0];
  const r = await V.applyVendorEvent(env, { event: 'call_started', call_ref: row.id });
  assert.strictEqual(r.status, 'started');
});

test('S372: an outcome acts ONLY on a call we requested — unknown ref, wrong phone, skipped row', async () => {
  reset();
  assert.strictEqual((await V.applyVendorEvent(env, { call_ref: '11111111-1111-4111-8111-111111111111', disposition: 'opt_out' })).reason, 'unknown_call_ref');
  const row = await placed();
  assert.strictEqual((await V.applyVendorEvent(env, { call_ref: row.id, phone: '9999999999', disposition: 'opt_out' })).reason, 'phone_mismatch');
  consentState = 'opted_out';
  await V.placeCall(env, { purpose: 'abandonment', phone: '9876500000' }, { requestCall: okDial });
  const skipped = calls[calls.length - 1];
  assert.strictEqual(skipped.status, 'skipped');
  assert.strictEqual((await V.applyVendorEvent(env, { call_ref: skipped.id, disposition: 'wants_link' })).reason, 'call_was_not_requested');
  assert.strictEqual(ingested.length, 0); assert.strictEqual(consentWrites.length, 0);
});

test('timestamps from the vendor are bounded — a 1970 or far-future value is replaced by now', () => {
  assert.strictEqual(V.parseWhen(0), null);
  assert.strictEqual(V.parseWhen('2026'), null);
  assert.strictEqual(V.parseWhen(Date.now() + 5 * 3600e3), null);
  assert.ok(V.parseWhen(new Date().toISOString()));
});

// ── sweep ──
test('sweep: requested >20 min and started >30 min time out, each emits voice_call_timed_out once', async () => {
  reset();
  const a = await placed(); a.requested_at = new Date(Date.now() - 25 * 60e3).toISOString();
  const b = await placed(); b.status = 'started'; b.started_at = new Date(Date.now() - 31 * 60e3).toISOString();
  const c = await placed();                                        // fresh → untouched
  const r = await V.sweepTimeouts(env);
  assert.strictEqual(r.timed_out, 2);
  assert.deepStrictEqual([a.status, b.status, c.status], ['timed_out', 'timed_out', 'requested']);
  assert.deepStrictEqual(ingested.map((e) => e.name), ['voice_call_timed_out', 'voice_call_timed_out']);
  assert.strictEqual((await V.sweepTimeouts(env)).timed_out, 0, 'second tick finds nothing');
});

// ── adapter + webhook wiring ──
test('adapter wire shape: event per purpose, call_ref inside data', () => {
  const b = VA.buildRequest({ callRef: 'ref-1', phone: '+919876543210', profileId: 'p', purpose: 'abandonment', flow: 'cart', context: { customer_name: 'A' } });
  assert.deepStrictEqual(b, { distinct_id: 'p', phone: '+919876543210', event: 'relay_abandonment_call',
    data: { customer_name: 'A', call_ref: 'ref-1', purpose: 'abandonment', flow: 'cart' } });
});

function req(body) {
  return new Request('https://x/webhooks/limechat', { method: 'POST',
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('webhook: a call_ref payload goes to the ledger, is still captured raw, and does NOT emit voice_call_received', async () => {
  reset(); const row = await placed();
  const r = await LC.handleLimechatWebhook({ LIMECHAT_WEBHOOK_TOKEN: 'tok' },
    req({ event: 'call_ended', call_ref: row.id, phone: '+919876543210', disposition: 'wants_link', call_status: 'answered' }));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.matched, true); assert.strictEqual(r.path, 'send_link');
  assert.strictEqual(captures.length, 1);
  assert.deepStrictEqual(ingested.map((e) => e.name), ['voice_call_ended']);
});

test('webhook: an UNKNOWN call_ref is captured and answered 200, never falls through to the Phase-0 event', async () => {
  reset();
  const r = await LC.handleLimechatWebhook({ LIMECHAT_WEBHOOK_TOKEN: 'tok' },
    req({ call_ref: '22222222-2222-4222-8222-222222222222', phone: '+919876543210', disposition: 'opt_out' }));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.matched, false);
  assert.strictEqual(ingested.length, 0);
});

test('Phase-0 path: a transcript never rides into the event (capture keeps it whole)', async () => {
  reset();
  await LC.handleLimechatWebhook({ LIMECHAT_WEBHOOK_TOKEN: 'tok' },
    req({ phone: '+919876543210', call_id: 'c9', transcript: 'secret words', data: { call_transcription: 'more' } }));
  assert.strictEqual(captures[0].body.transcript, 'secret words');
  assert.strictEqual(ingested[0].properties.raw.transcript, '[in webhook_captures]');
  assert.strictEqual(ingested[0].properties.raw.data.call_transcription, '[in webhook_captures]');
});

// ── hostile-review fixes (S400) ──
test('#1 a caller-supplied profile id is ignored — the number decides whose flag is read', async () => {
  reset();
  let asked = null;
  C._latestConsentRaw = async (env, pid) => { asked = pid; return { ok: true, state: null }; };
  await V.placeCall(env, { purpose: 'manual', phone: '9876543210', profileId: 'someone-else' }, { requestCall: okDial });
  assert.strictEqual(asked, 'prof-1'); assert.strictEqual(calls[0].profile_id, 'prof-1');
  C._latestConsentRaw = async () => (consentReadOk ? { ok: true, state: consentState } : { ok: false, state: null });
});

test('#2 identity resolution failing refuses a DNC-honouring call; COD still goes', async () => {
  reset(); resolveOk = false;
  assert.strictEqual((await V.placeCall(env, { purpose: 'abandonment', phone: '9876543210' }, { requestCall: okDial })).reason, 'gate_error:identity');
  assert.strictEqual((await V.placeCall(env, { purpose: 'cod_confirmation', phone: '9876543210' }, { requestCall: okDial })).placed, true);
});

test('#3 call_started landing between our read and write does not lose the end (or its opt-out)', async () => {
  reset(); const row = await placed();
  patchHook = () => { row.status = 'started'; row.started_at = new Date().toISOString(); };
  const r = await V.applyVendorEvent(env, { event: 'call_ended', call_ref: row.id, disposition: 'opt_out', call_status: 'answered' });
  assert.strictEqual(r.status, 'ended'); assert.strictEqual(r.path, 'opt_out');
  assert.strictEqual(row.status, 'ended'); assert.strictEqual(supWrites.length, 1);
});

test('#3 the sweep timing the call out mid-webhook still lands the end, flagged late', async () => {
  reset(); const row = await placed();
  patchHook = () => { row.status = 'timed_out'; };
  const r = await V.applyVendorEvent(env, { event: 'call_ended', call_ref: row.id, disposition: 'wants_link' });
  assert.strictEqual(r.path, 'send_link'); assert.strictEqual(r.late, true);
});

test('#4 a disposition arriving after an ended row with none is applied (flag + amended event)', async () => {
  reset(); const row = await placed();
  await V.applyVendorEvent(env, { event: 'call_ended', call_ref: row.id, call_status: 'answered' });
  assert.strictEqual(row.disposition, null);
  const r = await V.applyVendorEvent(env, { event: 'disposition', call_ref: row.id, disposition: 'opt_out' });
  assert.strictEqual(r.amended, true); assert.strictEqual(r.path, 'opt_out'); assert.strictEqual(row.disposition, 'opt_out');
  assert.strictEqual(supWrites.length, 1);
  assert.deepStrictEqual(ingested.map((e) => e.idempotency_key), [`voice:voice_call_ended:${row.id}`, `voice:voice_call_ended:${row.id}:amended`]);
  assert.strictEqual((await V.applyVendorEvent(env, { event: 'disposition', call_ref: row.id, disposition: 'wants_link' })).deduped, true, 'a second amendment never overrides');
});

test('#7 an opt-out writes a PHONE-keyed suppression: blocks abandonment + manual forever, never COD', async () => {
  reset(); const row = await placed();
  await V.applyVendorEvent(env, { call_ref: row.id, disposition: 'opt_out', call_status: 'answered' });
  assert.deepStrictEqual(supWrites[0], { channel: 'voice', value: '+919876543210', profile_id: 'prof-1', reason: 'call_opt_out' });
  consentState = 'opted_in';                                        // a later opt-in row cannot re-open it
  for (const [purpose, placedOk] of [['abandonment', false], ['manual', false], ['cod_confirmation', true]]) {
    const r = await V.placeCall(env, { purpose, phone: '9876543210' }, { requestCall: okDial });
    assert.strictEqual(r.placed, placedOk, purpose);
    if (!placedOk) assert.strictEqual(r.reason, 'do_not_call');
  }
});

test('#10 a disabled or missing voice quiet-hours row can never widen the TRAI window', async () => {
  for (const rows of [{ voice: { channel: 'voice', enabled: false, start_time: '21:00:00', end_time: '09:00:00' } }, {}]) {
    reset(); nowMin = 22 * 60; quiet = { ok: true, rows };
    const r = await V.placeCall(env, { purpose: 'manual', phone: '9876543210' }, { requestCall: okDial });
    assert.strictEqual(r.reason, 'outside_call_window');
  }
});

test('#9 a malformed call_ref is answered from the ledger branch, never the Phase-0 event', async () => {
  reset();
  const r = await LC.handleLimechatWebhook({ LIMECHAT_WEBHOOK_TOKEN: 'tok' }, req({ call_ref: '{{call_ref}}', phone: '+919876543210', disposition: 'opt_out' }));
  assert.strictEqual(r.matched, false); assert.strictEqual(r.reason, 'malformed_call_ref'); assert.strictEqual(ingested.length, 0);
  const row = await placed();
  const r2 = await V.applyVendorEvent(env, { call_ref: `  ${row.id.toUpperCase()} `, disposition: 'wants_link' });
  assert.strictEqual(r2.path, 'send_link', 'padded / upper-case ref still matches');
});

test('#12 our own DB failing on a known call → 503 so LimeChat retries (still captured)', async () => {
  reset();
  const saved = A.sbComms;
  A.sbComms = async (path, e, o) => (path.startsWith('/rest/v1/voice_calls') ? { ok: false } : saved(path, e, o));
  const r = await LC.handleLimechatWebhook({ LIMECHAT_WEBHOOK_TOKEN: 'tok' }, req({ call_ref: '33333333-3333-4333-8333-333333333333', disposition: 'opt_out' }));
  A.sbComms = saved;
  assert.deepStrictEqual([r.ok, r.status], [false, 503]); assert.strictEqual(captures.length, 1);
});

test('#8 free text is stripped at any depth, any case, in arrays; summary too', () => {
  const out = LC.withoutTranscript([{ payload: { call: { Transcript: 'x', Call_Summary: 'y', keep: 1 } } }]);
  assert.deepStrictEqual(out, [{ payload: { call: { Transcript: '[in webhook_captures]', Call_Summary: '[in webhook_captures]', keep: 1 } } }]);
});

test('#11 the cap query counts only abandonment + COD calls', async () => {
  reset();
  let capPath = '';
  const saved = A.sbComms;
  A.sbComms = async (path, e, o) => { if (path.includes('requested_at=gte')) capPath = path; return saved(path, e, o); };
  await V.placeCall(env, { purpose: 'abandonment', phone: '9876543210' }, { requestCall: okDial });
  A.sbComms = saved;
  assert.ok(capPath.includes('purpose=in.(abandonment,cod_confirmation)'), capPath);
});
