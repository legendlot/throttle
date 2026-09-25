// Relay voice channel — the orchestrator (S400, 2026-09-25).
//
// ⭐ RELAY DECIDES, LIMECHAT DIALS (Afshaan, S336 → re-affirmed 2026-09-25: "orchestration happens
// at our end … we are able to invoke the calls … we should have all the details"). LimeChat's
// answers (#bugs 1790255060.947059, "LC Q&A.pdf") made that buildable: they accept a Relay-
// initiated call, send call-started AND call-ended webhooks within seconds, take any payload we
// define, and — Q15 — have NO do-not-call filter of their own ("you need to send us clean
// numbers"). So every check below is the ONLY check between a customer and a call.
//
// Flow:  placeCall → voiceGate → comms.voice_calls row → adapters/voice.js (LimeChat) →
//        POST /webhooks/limechat (call_started / call_ended, echoing call_ref) → applyVendorEvent
//        → row updated + `voice_call_ended` event (scalars only) for journeys to branch on.
//        The 5-min cron sweeps calls that never reported back (sweepTimeouts).
//
// Business rules, from Pruthvi's accepted v3 doc (F0C184CTN4T, 2026-09-13):
//   · calls only 09:00–21:00 IST (TRAI) — the `voice` row in comms.channel_quiet_hours
//   · one ABANDONMENT call per number per rolling 7 days; COD calls count toward it but are never
//     blocked by it
//   · an explicit "don't contact me" = a permanent do-not-call flag (voice/marketing opted_out),
//     which blocks abandonment + manual calls, never a COD confirmation call
const A = require('./auth.js');
const G = require('./gate.js');
const C = require('./consent.js');
const { ingest } = require('./ingest.js');
const { normalizePhone } = require('./shopify.js');
const VA = require('./adapters/voice.js');

const PURPOSES = new Set(['abandonment', 'cod_confirmation', 'manual', 'test']);
const CAP_DAYS = 7;
const CAP_PURPOSES = new Set(['abandonment']);            // blocked BY the 7-day cap
const DNC_EXEMPT = new Set(['cod_confirmation']);         // the order's own confirmation call
// Statuses that mean "a call went (or may have gone) to LimeChat" — what the 7-day cap counts.
// `skipped` never reached them; `request_failed` was refused by them. A request_failed that was
// actually dialled flips to started/ended when its webhook arrives, and is then counted.
const CAP_STATUSES = ['requested', 'started', 'ended', 'timed_out'];
// What COUNTS toward the cap: abandonment + COD calls (v3). A manual or test call does not — a
// test to a number must not silence that customer's abandonment call for a week (review #11).
const CAP_COUNTED = ['abandonment', 'cod_confirmation'];
// The TRAI window as a hard floor, in IST minutes: quiet 21:00 → 09:00. The `voice` row in
// comms.channel_quiet_hours may TIGHTEN it; a missing or disabled row can never widen it, since
// resolveQuietWindow reads "disabled" as "no quiet hours at all" (review #10).
const TRAI_QUIET = { startMin: 21 * 60, endMin: 9 * 60 };
// A call opt-out is written as a PHONE-keyed voice suppression with this reason, not only a
// profile consent row: the consent row is "latest wins" and per profile, so a later opted_in row
// or a second profile on the same phone would silently re-open the number (review #7).
const DNC_REASON = 'call_opt_out';
// Sweep windows. A call starts within seconds of LimeChat accepting the request (Q6: "within
// seconds"), so 20 min without a call-started = it never happened or the signal was lost. 30 min
// after call-started without a call-ended covers any real call plus Pruthvi's 15-min disposition
// timeout. Both land on Pruthvi's "no pickup" path, logged as their own event (v3 step 3a).
const START_TIMEOUT_MIN = 20;
const END_TIMEOUT_MIN = 30;

// ── vocabularies ─────────────────────────────────────────────────────────────────────────────
// OURS, closed (migration 0078 CHECKs). LimeChat's raw strings are kept in provider_status/raw.
const CALL_STATUS_ALIASES = {
  answered: 'answered', completed: 'answered', connected: 'answered', picked_up: 'answered',
  no_answer: 'no_answer', unanswered: 'no_answer', not_answered: 'no_answer', noanswer: 'no_answer',
  no_pickup: 'no_answer', missed: 'no_answer',
  busy: 'busy',
  failed: 'failed', error: 'failed', invalid_number: 'failed',
  not_dialled: 'not_dialled', not_dialed: 'not_dialled', never_dialled: 'not_dialled',
  never_dialed: 'not_dialled', not_initiated: 'not_dialled',
};
const DISPOSITION_ALIASES = {
  wants_link: 'wants_link', send_link: 'wants_link', link: 'wants_link',
  followup_ok: 'followup_ok', follow_up_ok: 'followup_ok', follow_up: 'followup_ok',
  not_interested_followup: 'followup_ok', not_interested_ok_followup: 'followup_ok',
  opt_out: 'opt_out', optout: 'opt_out', do_not_call: 'opt_out', dnc: 'opt_out',
  do_not_contact: 'opt_out',
  unresolved: 'unresolved', unclear: 'unresolved',
  confirmed: 'confirmed', confirm: 'confirmed',
  cancelled: 'cancelled', canceled: 'cancelled', cancel: 'cancelled',
  wants_human: 'wants_human', handoff: 'wants_human', human: 'wants_human',
  no_pickup: 'no_pickup', no_answer: 'no_pickup',
};
const slug = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
const mapCallStatus = (v) => CALL_STATUS_ALIASES[slug(v)] || null;
const mapDisposition = (v) => DISPOSITION_ALIASES[slug(v)] || null;

// What the journey does next. Pruthvi's v3 Part A has exactly three paths; Part B (COD) keeps
// its own dispositions. ⚠️ Anything we do not positively recognise is `no_pickup` — the doc's
// own default (a missing disposition "defaults to the no-pickup path"), and the safe one: it
// sends the plain no-discount Message 1, never the discount link, never the suppression.
function pathFor(disposition) {
  if (disposition === 'opt_out') return 'opt_out';
  if (disposition === 'wants_link' || disposition === 'followup_ok') return 'send_link';
  if (disposition === 'confirmed' || disposition === 'cancelled' || disposition === 'wants_human') return disposition;
  return 'no_pickup';
}

// Indian mobile only: LimeChat dials on Vobiz, India. Anything else is refused before a row.
function indianMobile(raw) {
  const p = normalizePhone(raw);
  return p && /^\+91[6-9]\d{9}$/.test(p) ? p : null;
}

// Bounded timestamp parse — same bounds as the Phase-0 extractor (a `0` or `"2026"` is a valid
// 1970 date, and these land in started_at/ended_at). Out of bounds → null, the caller uses now.
function parseWhen(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const d = Number.isFinite(n) && String(v).trim() !== '' ? new Date(n > 1e12 ? n : n * 1000) : new Date(String(v));
  const ms = d.getTime(), now = Date.now();
  return !isNaN(ms) && ms > now - 30 * 864e5 && ms < now + 3600e3 ? d.toISOString() : null;
}

const toBool = (v) => (v === true || v === 'true' || v === 1 || v === '1' || slug(v) === 'yes') ? true
  : (v === false || v === 'false' || v === 0 || v === '0' || slug(v) === 'no') ? false : null;
const toInt = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n < 86400 ? n : null; };
const toText = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));

// ── the gate ─────────────────────────────────────────────────────────────────────────────────
// Every check FAILS CLOSED: an unreadable table is a refused call, never a free pass — this is a
// regulated outbound call and LimeChat filters nothing (Q15).
async function voiceGate(env, { profileId, phone, purpose, isTest }) {
  const settings = await G.getSettings(env);

  // 0. test lock / global test mode — the same crown-jewel guard as every message channel.
  if (isTest && !G.testModeAllows(phone, G.testUnion(settings)))
    return { pass: false, reason: 'test_recipient_not_allowlisted' };
  if (settings.test_mode !== false && !G.testModeAllows(phone, isTest ? G.testUnion(settings) : settings.test_mode_allow))
    return { pass: false, reason: 'test_mode_blocked' };

  // 1. suppression — channel 'voice', keyed by the NUMBER. A `call_opt_out` row is the do-not-call
  //    flag and does not block a COD confirmation call (v3); any other voice suppression blocks all.
  const sup = await A.sbComms(`/rest/v1/suppressions?channel=eq.voice&value=eq.${A.enc(phone)}&select=reason&limit=20`, env);
  if (!sup.ok || !Array.isArray(sup.data)) return { pass: false, reason: 'gate_error:suppression' };
  for (const row of sup.data) {
    if (row.reason !== DNC_REASON) return { pass: false, reason: 'suppressed' };
    if (!DNC_EXEMPT.has(purpose)) return { pass: false, reason: 'do_not_call' };
  }

  // 2. do-not-call flag on the PROFILE too (voice/marketing opted_out) — covers a flag set from
  //    the contact screen rather than on a call. A purpose that honours the flag and has no
  //    profile REFUSES: placeCall only passes null when identity resolution FAILED (it always
  //    resolves, creating a profile if needed), and a failed read is not "nothing to find" (#2).
  if (!DNC_EXEMPT.has(purpose)) {
    if (!profileId) return { pass: false, reason: 'gate_error:identity' };
    const c = await C._latestConsentRaw(env, profileId, 'voice', 'marketing');
    if (!c.ok) return { pass: false, reason: 'gate_error:consent' };
    if (c.state === 'opted_out') return { pass: false, reason: 'do_not_call' };
  }

  // 3. 09:00–21:00 IST, every purpose (TRAI). Allowlisted test numbers bypass it, exactly like
  //    quiet hours on the message channels — an end-to-end test at 22:00 must reach the tester.
  const cqh = await G.getChannelQuietHours(env);
  if (!cqh.ok) return { pass: false, reason: 'gate_error:quiet_hours' };
  const win = G.resolveQuietWindow(cqh.rows, 'voice', settings);
  const nowMin = G.istMinutes();
  const quiet = G.inQuietWindow(TRAI_QUIET.startMin, TRAI_QUIET.endMin, nowMin)
    || (win && G.inQuietWindow(win.startMin, win.endMin, nowMin));
  if (quiet && !G.testModeAllows(phone, settings.test_mode_allow))
    return { pass: false, reason: 'outside_call_window' };

  // 4. one abandonment call per number per rolling 7 days (COD calls count, never blocked).
  if (CAP_PURPOSES.has(purpose)) {
    const since = new Date(Date.now() - CAP_DAYS * 864e5).toISOString();
    const r = await A.sbComms(`/rest/v1/voice_calls?phone=eq.${A.enc(phone)}` +
      `&purpose=in.(${CAP_COUNTED.join(',')})&status=in.(${CAP_STATUSES.join(',')})` +
      `&requested_at=gte.${A.enc(since)}&select=id&limit=1`, env);
    if (!r.ok || !Array.isArray(r.data)) return { pass: false, reason: 'gate_error:call_cap' };
    if (r.data.length) return { pass: false, reason: 'call_cap_7d' };
  }
  return { pass: true, reason: null };
}

// Only these context keys travel to LimeChat — the bot reads them into its script. Strings are
// capped: this is a vendor payload, not a place for an arbitrary blob.
const CONTEXT_KEYS = ['customer_name', 'items', 'cart_value', 'checkout_url', 'discount_pct',
  'discount_code', 'order_id', 'order_value', 'language'];
function cleanContext(ctx) {
  const out = {};
  for (const k of CONTEXT_KEYS) {
    const v = ctx?.[k];
    if (v == null || v === '') continue;
    out[k] = typeof v === 'number' ? v : String(v).slice(0, 500);
  }
  return out;
}

async function resolveProfile(env, phone) {
  const r = await A.sbComms('/rest/v1/rpc/resolve_identity', env, { method: 'POST',
    body: JSON.stringify({ p_identifiers: [{ type: 'phone', value: phone, is_verified: false }], p_source: 'voice' }) });
  return r.ok ? r.data : null;
}

// placeCall → { ok, placed, call_ref, status, reason }. `placed:false` with ok:true is a normal
// outcome (the gate said no) and writes a `skipped` row — "call not requested" is a path in the
// journey, and a refused call must be visible, not silent. The one exception is
// outside_call_window: the caller defers and retries, so no row (it would be noise per retry).
async function placeCall(env, opts, deps = {}) {
  const requestCall = deps.requestCall || VA.requestCall;
  const purpose = opts?.purpose;
  if (!PURPOSES.has(purpose)) return { ok: false, error: 'invalid_purpose' };
  const phone = indianMobile(opts.phone);
  if (!phone) return { ok: false, error: 'invalid_phone' };
  // ALWAYS resolved from the number — never a caller-supplied profile id. A wrong-but-real id
  // would make the do-not-call check read somebody else's consent and write this customer's
  // opt-out onto them (review #1). The number is what gets dialled, so the number decides.
  const profileId = await resolveProfile(env, phone);
  const isTest = purpose === 'test';

  const gate = await voiceGate(env, { profileId, phone, purpose, isTest });
  if (!gate.pass && gate.reason === 'outside_call_window')
    return { ok: true, placed: false, reason: gate.reason };

  const context = cleanContext(opts.context);
  const base = {
    connector: 'limechat', origin: 'relay', purpose, flow: toText(opts.flow, 40), profile_id: profileId || null,
    phone, context, journey_id: opts.journeyId || null, enrolment_id: opts.enrolmentId || null,
    campaign_id: opts.campaignId || null, requested_by: toText(opts.requestedBy, 200),
  };
  const ins = await A.sbComms('/rest/v1/voice_calls', env, { method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...base, status: gate.pass ? 'requested' : 'skipped', skip_reason: gate.pass ? null : gate.reason }) });
  const row = ins.ok && Array.isArray(ins.data) ? ins.data[0] : null;
  if (!row) return { ok: false, error: 'ledger_write_failed' };            // never dial without a ledger row
  if (!gate.pass) return { ok: true, placed: false, call_ref: row.id, status: 'skipped', reason: gate.reason };

  const r = await requestCall(env, { callRef: row.id, phone, profileId, purpose, flow: base.flow, context });
  if (!r.ok) {
    await A.sbComms(`/rest/v1/voice_calls?id=eq.${row.id}&status=eq.requested`, env, { method: 'PATCH',
      body: JSON.stringify({ status: 'request_failed', skip_reason: String(r.error).slice(0, 200),
        raw: r.data ?? null, updated_at: new Date().toISOString() }) });
    return { ok: true, placed: false, call_ref: row.id, status: 'request_failed', reason: r.error };
  }
  return { ok: true, placed: true, call_ref: row.id, status: 'requested' };
}

// ── vendor → us ──────────────────────────────────────────────────────────────────────────────
// Our payload contract (sent to LimeChat, 2026-09-25). Top-level, or wrapped once in `data`.
const pick = (body, k) => (body?.[k] !== undefined ? body[k] : body?.data?.[k]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function callRefOf(body) { const v = String(pick(body, 'call_ref') ?? '').trim(); return UUID_RE.test(v) ? v.toLowerCase() : null; }
// Any payload that NAMES a call_ref belongs to the ledger branch — even an unparseable one
// ("{{call_ref}}" from an unfilled template), which must not fall through to the Phase-0 event.
function hasCallRefKey(body) { const v = pick(body, 'call_ref'); return v !== undefined && v !== null && v !== ''; }

function eventKind(body) {
  const e = slug(pick(body, 'event'));
  if (['call_started', 'started', 'initiated', 'ringing', 'call_initiated'].includes(e)) return 'started';
  if (['call_ended', 'ended', 'completed', 'call_completed', 'disposition'].includes(e)) return 'ended';
  // No event name: anything carrying an outcome is an end.
  return ['call_status', 'disposition', 'ended_at'].some((k) => pick(body, k) != null) ? 'ended' : 'started';
}

// Called by the webhook for a payload that carries a call_ref. The raw capture has already been
// written by the caller. Returns { matched, ... } — never throws on a shape problem.
async function applyVendorEvent(env, body) {
  const callRef = callRefOf(body);
  if (!callRef) return { matched: false, reason: 'malformed_call_ref' };
  const g = await A.sbComms(`/rest/v1/voice_calls?id=eq.${callRef}&select=*&limit=1`, env);
  if (!g.ok) return { matched: false, reason: 'ledger_read_failed' };
  const row = g.data?.[0];
  if (!row || row.origin !== 'relay') return { matched: false, reason: 'unknown_call_ref' };
  // S372 prerequisite: an outcome acts only on a call WE requested — our unguessable call_ref
  // (random v4 UUID) within the window, and the number too WHEN the payload carries one.
  const vPhone = normalizePhone(pick(body, 'phone'));
  if (vPhone && vPhone !== row.phone) return { matched: false, reason: 'phone_mismatch' };
  if (Date.now() - Date.parse(row.requested_at) > CAP_DAYS * 864e5) return { matched: false, reason: 'stale_call_ref' };
  if (row.status === 'skipped') return { matched: false, reason: 'call_was_not_requested' };

  const now = new Date().toISOString();
  const providerRef = toText(pick(body, 'call_id'), 200);
  const kind = eventKind(body);

  if (kind === 'started') {
    if (!['requested', 'request_failed'].includes(row.status)) return { matched: true, deduped: true, status: row.status };
    const p = await A.sbComms(`/rest/v1/voice_calls?id=eq.${callRef}&status=eq.${row.status}`, env, { method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'started', started_at: parseWhen(pick(body, 'started_at')) || now,
        provider_call_ref: providerRef || row.provider_call_ref, raw: body, updated_at: now }) });
    return { matched: true, status: 'started', raced: !(p.ok && p.data?.length) };
  }

  const rawStatus = pick(body, 'call_status');
  let callStatus = mapCallStatus(rawStatus);
  let disposition = mapDisposition(pick(body, 'disposition'));
  if (!disposition && callStatus && callStatus !== 'answered') disposition = 'no_pickup';
  if (!callStatus && disposition && disposition !== 'no_pickup') callStatus = 'answered';

  // A disposition arriving AFTER an ended row that had none (Pruthvi's 15-min disposition window)
  // is an amendment, not a redelivery: it must still set the flag and reach the journey (#4).
  if (row.status === 'ended') {
    if (row.disposition || !disposition || disposition === 'no_pickup') return { matched: true, deduped: true, status: 'ended' };
    const p = await A.sbComms(`/rest/v1/voice_calls?id=eq.${callRef}&status=eq.ended&disposition=is.null`, env, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ disposition, call_status: row.call_status || callStatus,
        discount_agreed: toBool(pick(body, 'discount_agreed')) ?? row.discount_agreed,
        drop_reason: toText(pick(body, 'drop_reason'), 1000) ?? row.drop_reason, updated_at: now }) });
    if (!p.ok) return { matched: true, reason: 'ledger_write_failed' };
    if (!p.data?.length) return { matched: true, deduped: true, status: 'ended' };
    return finishEnded(env, { ...row, ...p.data[0] }, { amended: true, late: true });
  }

  const patch = {
    status: 'ended', call_status: callStatus, disposition,
    discount_agreed: toBool(pick(body, 'discount_agreed')),
    drop_reason: toText(pick(body, 'drop_reason'), 1000),
    summary: toText(pick(body, 'summary') ?? pick(body, 'call_summary'), 8000),
    transcript: toText(pick(body, 'transcript') ?? pick(body, 'call_transcription') ?? pick(body, 'transcription'), 100000),
    recording_url: toText(pick(body, 'recording_url'), 1000),
    duration_seconds: toInt(pick(body, 'duration_seconds')),
    provider_status: toText(rawStatus, 100),
    ended_at: parseWhen(pick(body, 'ended_at')) || now,
    raw: body, updated_at: now,
  };
  // Conditional on the status we READ, so two writers cannot both win. If ours matches nothing,
  // somebody moved the row: a call_started landing first, or the sweep timing it out. Neither is
  // a redelivery of this end, so re-read and try once more against the new status (#3). Only a
  // row that is now `ended` means another end won.
  let cur = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (cur.status === 'ended') return { matched: true, deduped: true, status: 'ended' };
    if (cur.status === 'skipped') return { matched: false, reason: 'call_was_not_requested' };
    const was = cur.status;                               // captured before the write: `late` keys on it
    const full = { ...patch, provider_call_ref: providerRef || cur.provider_call_ref,
      started_at: cur.started_at || parseWhen(pick(body, 'started_at')) };
    const p = await A.sbComms(`/rest/v1/voice_calls?id=eq.${callRef}&status=eq.${was}`, env, { method: 'PATCH',
      headers: { Prefer: 'return=representation' }, body: JSON.stringify(full) });
    if (!p.ok) return { matched: true, reason: 'ledger_write_failed' };
    if (p.data?.length) return finishEnded(env, { ...cur, ...p.data[0] }, { late: was === 'timed_out' });
    const g2 = await A.sbComms(`/rest/v1/voice_calls?id=eq.${callRef}&select=*&limit=1`, env);
    if (!g2.ok || !g2.data?.[0]) return { matched: true, reason: 'ledger_read_failed' };
    cur = g2.data[0];
  }
  return { matched: true, reason: 'ledger_write_failed' };
}

// After an end (or an amended disposition) is written: the do-not-call flag, then the event.
async function finishEnded(env, row, { late, amended }) {
  const { disposition } = row;
  const path = pathFor(disposition);
  if (disposition === 'opt_out') await writeDnc(env, row);
  const ev = await emitEnded(env, row, 'voice_call_ended', {
    call_status: row.call_status, disposition, path, discount_agreed: row.discount_agreed, late: !!late,
    amended: !!amended,
  }, amended ? 'amended' : '').catch((e) => ({ ok: false, error: e?.message }));
  if (!ev?.ok) console.log('voice_event_failed', row.id, ev?.error);
  return { matched: true, status: 'ended', call_status: row.call_status, disposition, path, late: !!late, amended: !!amended };
}

// The do-not-call flag (v3: permanent). PHONE-keyed suppression = the permanent part, read by the
// gate for every future call; the profile consent row = what the contact screen shows. Both are
// best-effort and logged: the event still carries path=opt_out, which stops the journey's messages.
async function writeDnc(env, row) {
  const s = await A.sbComms('/rest/v1/suppressions', env, { method: 'POST',
    body: JSON.stringify({ channel: 'voice', value: row.phone, profile_id: row.profile_id || null, reason: DNC_REASON }) })
    .catch((e) => ({ ok: false, data: e?.message }));
  if (!s?.ok) console.log('voice_dnc_suppression_failed', row.id);
  if (row.profile_id) {
    const c = await C.recordConsent(env, { profile_id: row.profile_id, channel: 'voice', purpose: 'marketing',
      state: 'opted_out', source: 'limechat_call', evidence: { call_ref: row.id, provider_call_ref: row.provider_call_ref } })
      .catch((e) => ({ ok: false, data: e?.message }));
    if (!c?.ok) console.log('voice_dnc_consent_failed', row.id);
  }
}

// Scalars only (spec §5 — never a transcript or summary in comms.events).
function emitEnded(env, row, name, props, keySuffix = '') {
  return ingest(env, {
    ...(row.profile_id ? { profile_id: row.profile_id } : { identifiers: [{ type: 'phone', value: row.phone, is_verified: false }] }),
    name, source: 'voice', idempotency_key: `voice:${name}:${row.id}${keySuffix ? ':' + keySuffix : ''}`,
    properties: { call_ref: row.id, purpose: row.purpose, flow: row.flow, journey_id: row.journey_id,
      enrolment_id: row.enrolment_id, ...props },
  });
}

// ── cron: calls that never reported back ─────────────────────────────────────────────────────
async function sweepTimeouts(env) {
  const now = Date.now();
  const s1 = new Date(now - START_TIMEOUT_MIN * 60e3).toISOString();
  const s2 = new Date(now - END_TIMEOUT_MIN * 60e3).toISOString();
  const r = await A.sbComms('/rest/v1/voice_calls?origin=eq.relay' +
    `&or=(and(status.eq.requested,requested_at.lt.${s1}),and(status.eq.started,started_at.lt.${s2}))` +
    '&select=id,status,profile_id,phone,purpose,flow,journey_id,enrolment_id&limit=200', env);
  if (!r.ok || !Array.isArray(r.data)) return { ok: false };
  // request_failed is NOT swept: placeCall already returned it to its caller synchronously (a
  // journey branches on that return), and sweeping it would re-select the same rows every tick
  // forever, since it is terminal unless LimeChat's call-started proves the call happened anyway.
  let timedOut = 0;
  for (const row of r.data) {
    const p = await A.sbComms(`/rest/v1/voice_calls?id=eq.${row.id}&status=eq.${row.status}`, env, { method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'timed_out', updated_at: new Date().toISOString() }) });
    if (!p.ok || !p.data?.length) continue;                 // a webhook landed first — nothing to do
    timedOut++;
    await emitEnded(env, row, 'voice_call_timed_out', { path: 'no_pickup', was: row.status })
      .catch((e) => console.log('voice_timeout_event_failed', row.id, e?.message));
  }
  return { ok: true, examined: r.data.length, timed_out: timedOut };
}

// ── reads for Relay / Pitstop ────────────────────────────────────────────────────────────────
const LIST_COLS = 'id,origin,purpose,flow,profile_id,phone,status,skip_reason,call_status,disposition,' +
  'discount_agreed,drop_reason,duration_seconds,requested_by,requested_at,started_at,ended_at';
async function listCalls(env, { profileId, phone, status, limit, before } = {}) {
  const q = [`select=${LIST_COLS}`, 'order=requested_at.desc', `limit=${Math.min(Math.max(Number(limit) || 50, 1), 200)}`];
  if (profileId) q.push(`profile_id=eq.${A.enc(profileId)}`);
  if (phone) { const p = normalizePhone(phone); if (p) q.push(`phone=eq.${A.enc(p)}`); }
  if (status) q.push(`status=eq.${A.enc(status)}`);
  if (before && !Number.isNaN(Date.parse(before))) q.push(`requested_at=lt.${A.enc(before)}`);
  return A.sbComms(`/rest/v1/voice_calls?${q.join('&')}`, env);
}
async function getCall(env, id) {
  if (!UUID_RE.test(String(id || ''))) return { ok: false, data: null };
  return A.sbComms(`/rest/v1/voice_calls?id=eq.${id}&select=*&limit=1`, env);
}

module.exports = {
  placeCall, voiceGate, applyVendorEvent, sweepTimeouts, hasCallRefKey, DNC_REASON, listCalls, getCall,
  mapCallStatus, mapDisposition, pathFor, indianMobile, eventKind, callRefOf, cleanContext, parseWhen,
  START_TIMEOUT_MIN, END_TIMEOUT_MIN,
};
