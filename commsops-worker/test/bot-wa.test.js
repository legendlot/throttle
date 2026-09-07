// S355 — WhatsApp bot ingress: engage conditions, claim, sends, forward payload.
// Run: node test/bot-wa.test.js
const assert = require('assert');
const W = require('../src/bot-wa.js');
const DEF = { entry: 'menu', keywords: [{ match: ['agent'], target: 'h' }], steps: {
  menu: { type: 'menu', style: 'list', text: 'Hi', buttons: [{ id: 'b_faq', label: 'FAQs' }], outcomes: { b_faq: 'a', fallback: 'h' } },
  a: { type: 'message', text: 'Answer', outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} }, h: { type: 'handoff', outcomes: {} } } };
const BOT = { id: 'bot1', active_version: 2, config: { mode: 'pilot', pilot_numbers: ['917709991011'] } };
function mk(over = {}) {
  const calls = { sends: [], claims: [], sessions: [] };
  const deps = {
    supportPhoneId: async () => 'PNID',
    activeWaBot: async () => BOT,
    threadLastOutbound: async () => ({ found: false }),
    hasActiveEnrolment: async () => false,
    findLatestSession: async () => null,
    createSession: async (env, row) => { calls.sessions.push(row); return { id: 'S1', ...row, status: 'active', current_step: null, context: {} }; },
    claimTurn: async (env, row) => { calls.claims.push(row); return true; },
    loadDefinition: async () => DEF,
    loadActiveShared: async () => null,
    lookupOrderStatus: async () => ({ ok: false }),
    send: async (env, opts) => { calls.sends.push(opts); return { status: 'sent' }; },
    persist: async () => {},
    ...over,
  };
  return { deps, calls };
}
const M = (o = {}) => ({ from: '917709991011', phone_number_id: 'PNID', type: 'text', text: 'hi', provider_message_id: 'wamid.1', ts: new Date().toISOString(), ...o });
const ING = { ok: true, profile_id: 'prof1' };
(async () => {
  // engages on a pilot number: opens a session, sends the greeting as a LIST, returns the forward payload
  let { deps, calls } = mk();
  let r = await W.maybeHandleInbound({}, M(), ING, deps);
  assert.equal(r.handled, true); assert.equal(r.session_status, 'active'); assert.equal(r.replies[0].text, 'Hi');
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].purpose, 'utility'); assert.equal(calls.sends[0].phoneNumberId, 'PNID'); assert.equal(calls.sends[0].to, '+917709991011');
  assert.equal(calls.sends[0].interactiveList.rows[0].id, 'bot:menu:b_faq');
  assert.equal(calls.sends[0].dedupKey, 'bot:S1:wamid.1:0');
  assert.equal(calls.sends[0].profileId, 'prof1');                       // every bot message row is attributed
  assert.equal(calls.claims[0].provider_message_id, 'wamid.1');
  assert.equal(calls.sessions[0].channel, 'whatsapp'); assert.equal(calls.sessions[0].wa_from, '917709991011'); assert.equal(calls.sessions[0].profile_id, 'prof1');
  assert.ok(!('visitor_key' in calls.sessions[0]));                      // web identity; column is nullable since 0068
  // not on the support number / no active bot / non-pilot number / STOP / human active / mid-journey -> null
  assert.equal(await W.maybeHandleInbound({}, M({ phone_number_id: 'OTHER' }), ING, mk().deps), null);
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ activeWaBot: async () => null }).deps), null);
  assert.equal(await W.maybeHandleInbound({}, M({ from: '919999999999' }), ING, mk().deps), null);
  assert.equal(await W.maybeHandleInbound({}, M({ text: 'STOP' }), ING, mk().deps), null);
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ threadLastOutbound: async () => ({ found: true, last_outbound_at: new Date(Date.now() - 3600e3).toISOString() }) }).deps), null);
  assert.notEqual(await W.maybeHandleInbound({}, M(), ING, mk({ threadLastOutbound: async () => ({ found: true, last_outbound_at: new Date(Date.now() - 13 * 3600e3).toISOString() }) }).deps), null);
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ threadLastOutbound: async () => ({ error: true }) }).deps), null);   // read failed -> do not engage
  assert.equal(await W.maybeHandleInbound({}, M(), ING, mk({ hasActiveEnrolment: async () => true }).deps), null);
  // public mode ignores the allow-list
  ({ deps } = mk({ activeWaBot: async () => ({ ...BOT, config: { mode: 'public', pilot_numbers: [] } }) }));
  assert.equal((await W.maybeHandleInbound({}, M({ from: '919999999999' }), ING, deps)).handled, true);
  // duplicate claim -> handled but silent: nothing sent, but the LIVE session state still travels
  const live = { id: 'S1', bot_id: 'bot1', bot_version: 2, channel: 'whatsapp', status: 'active', current_step: 'menu', context: {}, last_activity_at: new Date().toISOString() };
  ({ deps, calls } = mk({ claimTurn: async () => false, findLatestSession: async () => live }));
  r = await W.maybeHandleInbound({}, M(), ING, deps);
  assert.deepEqual(r, { handled: true, duplicate: true, session_id: 'S1', session_status: 'active', replies: [], handoff: false }); assert.equal(calls.sends.length, 0);
  // STICKY HANDOFF: a handed-off session under 6h idle keeps the bot silent (the customer is waiting for a human)
  const handed = { ...live, status: 'handed_off', last_activity_at: new Date(Date.now() - 120e3).toISOString() };
  ({ deps, calls } = mk({ findLatestSession: async () => handed }));
  assert.equal(await W.maybeHandleInbound({}, M({ text: 'hello?', provider_message_id: 'wamid.9' }), ING, deps), null);
  assert.equal(calls.sessions.length, 0);
  // ...but after 6h idle a handed-off session no longer blocks: a fresh session opens
  ({ deps, calls } = mk({ findLatestSession: async () => ({ ...handed, last_activity_at: new Date(Date.now() - 7 * 3600e3).toISOString() }) }));
  assert.equal((await W.maybeHandleInbound({}, M({ provider_message_id: 'wamid.10' }), ING, deps)).session_status, 'active');
  assert.equal(calls.sessions.length, 1);
  // an ENDED session never blocks — the next "hi" opens a fresh one
  ({ deps, calls } = mk({ findLatestSession: async () => ({ ...live, status: 'ended' }) }));
  assert.equal(calls.sessions.length, 0); await W.maybeHandleInbound({}, M({ provider_message_id: 'wamid.11' }), ING, deps); assert.equal(calls.sessions.length, 1);
  // createSession failure is logged and the bot stays silent (never throws into the webhook)
  ({ deps } = mk({ createSession: async () => null }));
  assert.equal(await W.maybeHandleInbound({}, M({ provider_message_id: 'wamid.12' }), ING, deps), null);
  // list tap on an existing session: bot: prefix stripped, walks to the answer, ends -> session_status ended
  const sess = live;
  ({ deps, calls } = mk({ findLatestSession: async () => sess }));
  r = await W.maybeHandleInbound({}, M({ type: 'interactive', text: 'FAQs', button_id: 'bot:menu:b_faq', provider_message_id: 'wamid.2' }), ING, deps);
  assert.equal(r.session_status, 'ended'); assert.deepEqual(r.replies.map((x) => x.text), ['Answer']);
  assert.equal(calls.sessions.length, 0);
  // idle > 6h: old session expired, new one opened with the greeting
  const stale = { ...sess, last_activity_at: new Date(Date.now() - 7 * 3600e3).toISOString() };
  const expired = [];
  ({ deps, calls } = mk({ findLatestSession: async () => stale, persist: async (env, s, patch) => { if (patch.status === 'ended') expired.push(s.id); } }));
  r = await W.maybeHandleInbound({}, M({ provider_message_id: 'wamid.3' }), ING, deps);
  assert.deepEqual(expired, ['S1']); assert.equal(calls.sessions.length, 1); assert.equal(r.replies[0].text, 'Hi');
  // keyword on the opening message -> straight to handoff
  ({ deps } = mk());
  r = await W.maybeHandleInbound({}, M({ text: 'I want an agent', provider_message_id: 'wamid.4' }), ING, deps);
  assert.equal(r.handoff, true); assert.equal(r.session_status, 'handed_off');
  assert.equal(W.stripBotId('bot:menu:b_faq'), 'b_faq'); assert.equal(W.stripBotId('confirm_yes'), 'confirm_yes');
  console.log('bot-wa ok');
})().catch((e) => { console.error(e); process.exit(1); });
