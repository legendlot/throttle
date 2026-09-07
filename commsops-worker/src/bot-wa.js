// WhatsApp ingress for the Relay flow bot (S355, spec §5). Runs inside wa-webhooks.handleInbound
// AFTER the window upsert / ingest / STOP-START and BEFORE the Pitstop forward. Every condition
// fails CLOSED (silent bot, forward exactly as today). Sends go through send() like every other
// WhatsApp message. The forward payload (m.bot) is how the transcript reaches the inbox.
const A = require('./auth.js');
const E = require('./bot-engine.js');
const T = require('./bot-turn.js');
const { send } = require('./send.js');
const { detectOptOut } = require('./optout.js');

const BOT_ID_PREFIX = 'bot:';
const HUMAN_ACTIVE_MS = 12 * 3600 * 1000;   // csops's own human_active window
const IDLE_EXPIRE_MS = 6 * 3600 * 1000;
const stripBotId = (id) => String(id || '').replace(/^bot:[^:]+:/, '');
const wireId = (stepId, handle) => `${BOT_ID_PREFIX}${stepId}:${handle}`;

// ── default deps (real I/O) ──
let supportCache = { at: 0, id: null };
async function supportPhoneId(env) {
  if (Date.now() - supportCache.at < 60000) return supportCache.id;
  const r = await A.sbComms('/rest/v1/sender_identities?channel=eq.whatsapp&purpose=eq.utility&status=eq.active&select=metadata', env);
  const ids = (r.ok ? r.data : []).map((s) => s.metadata?.phone_number_id).filter(Boolean);
  supportCache = { at: Date.now(), id: ids.length === 1 ? String(ids[0]) : null };   // exactly one, else fail closed
  return supportCache.id;
}
async function activeWaBot(env) {
  const r = await A.sbComms('/rest/v1/bots?channel=eq.whatsapp&status=eq.active&active_version=not.is.null&select=id,active_version,config&limit=2', env);
  return r.ok && r.data?.length === 1 ? r.data[0] : null;
}
// ONE read: last_outbound_at is bumped only by human-ish rows (the trigger excludes tagged bot
// rows), so it IS the "human replied" signal. Thread not found = no human = engage (§5.1.5).
async function threadLastOutbound(env, from, phoneNumberId) {
  const r = await A.sbStore(`/rest/v1/cs_wa_threads?customer_phone=eq.${A.enc('+' + from)}&waba_phone_number_id=eq.${A.enc(phoneNumberId)}&select=last_outbound_at&limit=1`, env).catch(() => ({ ok: false }));
  if (!r.ok) return { error: true };
  return r.data?.[0] ? { found: true, last_outbound_at: r.data[0].last_outbound_at } : { found: false };
}
async function hasActiveEnrolment(env, profileId) {
  if (!profileId) return false;
  const r = await A.sbComms(`/rest/v1/enrolments?profile_id=eq.${A.enc(profileId)}&status=eq.active&select=id&limit=1`, env).catch(() => ({ ok: false }));
  return !r.ok || !!r.data?.[0];      // unreadable -> treat as enrolled (fail closed)
}
// Newest session of ANY status — a handed_off one is the sticky-handoff signal (condition 8).
async function findLatestSession(env, from, phoneNumberId) {
  const r = await A.sbComms(`/rest/v1/bot_sessions?channel=eq.whatsapp&wa_from=eq.${A.enc(from)}&phone_number_id=eq.${A.enc(phoneNumberId)}&select=*&order=started_at.desc&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
async function createSession(env, row) {
  const ins = await A.sbComms('/rest/v1/bot_sessions', env, { method: 'POST', body: JSON.stringify(row) });
  if (ins.ok && ins.data?.[0]) return ins.data[0];
  // Lost the active-session unique-index race: adopt the winner. Any OTHER failure is logged —
  // a silent null here is a silently dead bot (the deps-stubbed tests cannot catch a DB-shape error).
  const winner = await findLatestSession(env, row.wa_from, row.phone_number_id);
  if (winner && winner.status === 'active') return winner;
  console.log('bot_wa_session_create_failed', JSON.stringify({ status: ins.status, detail: JSON.stringify(ins.data || '').slice(0, 200) }));
  return null;
}
async function claimTurn(env, row) {
  const r = await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) });
  if (r.ok) return true;
  if (r.status === 409 || /23505|duplicate key/.test(JSON.stringify(r.data || ''))) return false;
  throw new Error('claim_failed:' + JSON.stringify(r.data).slice(0, 200));
}
async function persist(env, session, patch, stepRows) {
  await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(session.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
  if (stepRows?.length) await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(stepRows) });
}
const DEFAULTS = { supportPhoneId, activeWaBot, threadLastOutbound, hasActiveEnrolment, findLatestSession, createSession, claimTurn, persist, send,
  loadDefinition: T.defaultLoadDefinition, loadActiveShared: T.defaultLoadActiveShared, lookupOrderStatus: null };

function toSendOpts(session, pmid, i, stepId, reply, from, phoneNumberId) {
  const base = { channel: 'whatsapp', purpose: 'utility', to: '+' + from, phoneNumberId, profileId: session.profile_id || null,
    template: { content: { text_body: reply.text } }, dedupKey: `bot:${session.id}:${pmid}:${i}`, source: 'relay_bot' };
  if (reply.buttons && reply.buttons.length) {
    if (reply.style === 'list' || reply.buttons.length > 3)
      base.interactiveList = { button: reply.list_button || 'Choose', rows: reply.buttons.map((b) => ({ id: wireId(stepId, b.id), title: b.label, description: b.description || null })) };
    else base.interactiveButtons = reply.buttons.map((b) => ({ id: wireId(stepId, b.id), text: b.label }));
  }
  return base;
}

async function maybeHandleInbound(env, m, ingestRes, depsIn) {
  const d = { ...DEFAULTS, ...(depsIn || {}) };
  if (!m?.from || !m.phone_number_id) return null;
  const pid = await d.supportPhoneId(env);
  if (!pid || String(m.phone_number_id) !== String(pid)) return null;                        // 1
  const bot = await d.activeWaBot(env); if (!bot) return null;                                // 2
  const cfg = bot.config || {};
  if ((cfg.mode || 'pilot') !== 'public' && !(cfg.pilot_numbers || []).includes(String(m.from))) return null;   // 3
  if (detectOptOut(m.text)) return null;                                                       // 4
  const lo = await d.threadLastOutbound(env, m.from, pid);                                     // 5
  if (lo.error) return null;
  if (lo.found && lo.last_outbound_at && Date.now() - new Date(lo.last_outbound_at).getTime() < HUMAN_ACTIVE_MS) return null;
  if (await d.hasActiveEnrolment(env, ingestRes?.profile_id)) return null;                     // 6
  const kindOk = ['text', 'interactive', 'button', 'image', 'video', 'audio', 'document', 'sticker'].includes(m.type || 'text');
  if (!kindOk) return null;                                                                    // 7
  const text = String(m.text || '').slice(0, 500);

  let session = await d.findLatestSession(env, m.from, pid);
  const idleMs = session ? Date.now() - new Date(session.last_activity_at || session.started_at).getTime() : 0;
  if (session && session.status === 'handed_off' && idleMs < IDLE_EXPIRE_MS) return null;      // 8. sticky handoff: a human is owed
  if (session && session.status !== 'active') session = null;                                    // ended / stale handed_off: start fresh
  if (session && idleMs > IDLE_EXPIRE_MS) {
    const ex = E.advance({ entry: null, steps: {} }, session, { kind: 'expire' });
    await d.persist(env, session, { status: ex.state.status, ended_at: new Date().toISOString() }, [{ session_id: session.id, step_id: session.current_step || 'entry', step_type: 'expire', result: null }]);
    session = null;
  }
  let opened = false;
  if (!session) {
    session = await d.createSession(env, { bot_id: bot.id, bot_version: bot.active_version, channel: 'whatsapp', wa_from: String(m.from), phone_number_id: pid,
      profile_id: ingestRes?.profile_id || null, context: { identity: { phone: E.normPhone(m.from) } } });
    if (!session) return null;
    opened = true;
  }
  // claim THIS message before advancing — redelivery / concurrent invocation = skip (spec §5.2).
  // The duplicate branch still reports the LIVE session state: csops drives the thread rail off it
  // even when it skips the transcript rows (a redelivered first message must not leave bot_active false).
  const claimed = await d.claimTurn(env, { session_id: session.id, step_id: session.current_step || 'entry', step_type: 'customer_message', result: { text, type: m.type || 'text', button_id: m.button_id || null }, provider_message_id: m.provider_message_id || null });
  if (!claimed) return { handled: true, duplicate: true, session_id: session.id, session_status: session.status, replies: [], handoff: session.status === 'handed_off' };

  const def = await T.sessionDefinition(env, session, { loadDefinition: d.loadDefinition });
  if (!def) return null;
  const input = opened ? { kind: 'open', text }
    : m.button_id ? { kind: 'button', buttonId: stripBotId(m.button_id), text }
    : { kind: 'text', text };
  const t = await T.executeTurn(env, session, def, input, { loadActiveShared: d.loadActiveShared, loadDefinition: d.loadDefinition, ...(d.lookupOrderStatus ? { lookupOrderStatus: d.lookupOrderStatus } : {}) });
  const out = t.out;
  const sendRows = [];
  for (const [i, r] of out.replies.entries()) {
    const res = await d.send(env, toSendOpts(session, m.provider_message_id || 'nopmid', i, out.state.current_step || 'entry', r, m.from, pid)).catch((e) => ({ status: 'failed', reason: String(e?.message || e) }));
    if (res.status !== 'sent' && res.status !== 'deduped') sendRows.push({ session_id: session.id, step_id: out.state.current_step || 'entry', step_type: 'send_failed', result: { status: res.status, reason: res.reason || null } });
  }
  await d.persist(env, session, { current_step: out.state.current_step, status: out.state.status, context: out.state.context,
    sub_bot_id: t.frame ? t.frame.bot_id : null, sub_version: t.frame ? t.frame.version : null, return_step: t.frame ? t.frame.return_step : null,
    last_activity_at: new Date().toISOString(), ended_at: out.state.status === 'ended' ? new Date().toISOString() : null }, [...t.stepRows, ...sendRows]);
  return { handled: true, session_id: session.id, session_status: out.state.status,
    replies: out.replies.map((r) => ({ text: r.text, buttons: r.buttons || null, style: r.style || null })), handoff: t.handoff || out.state.status === 'handed_off' };
}

module.exports = { maybeHandleInbound, stripBotId, wireId, BOT_ID_PREFIX, HUMAN_ACTIVE_MS, IDLE_EXPIRE_MS, toSendOpts };
