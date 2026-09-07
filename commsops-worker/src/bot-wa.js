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
  if (ids.length !== 1) {
    // A failed or ambiguous read is NOT cached — caching it would silently wedge the bot for 60s
    // on every retry of a transient read. Log it and return null without touching supportCache.
    console.log('bot_wa_support_number_unresolved', JSON.stringify({ ok: r.ok, count: ids.length }));
    return null;
  }
  supportCache = { at: Date.now(), id: String(ids[0]) };   // exactly one, else fail closed
  return supportCache.id;
}
async function activeWaBot(env) {
  const r = await A.sbComms('/rest/v1/bots?channel=eq.whatsapp&status=eq.active&active_version=not.is.null&select=id,active_version,config&limit=2', env);
  return r.ok && r.data?.length === 1 ? r.data[0] : null;
}
// ONE read: csops writes every bot reply row with template_name='relay_bot' and sent_by_user_id
// NULL (Task 11 / spec §5.5), which store.cs_touch_thread_outbound treats as automated, so bot
// turns never bump last_outbound_at; only agent-authored rows do. It IS the "human replied"
// signal. Thread not found = no human = engage (§5.1.5).
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
  if (ins.ok && ins.data?.[0]) return { session: ins.data[0], adopted: false };
  // Lost the active-session unique-index race: adopt the winner. Any OTHER failure is logged —
  // a silent null here is a silently dead bot (the deps-stubbed tests cannot catch a DB-shape error).
  const winner = await findLatestSession(env, row.wa_from, row.phone_number_id);
  if (winner && winner.status === 'active') return { session: winner, adopted: true };
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
  A.checkWrite('bot_wa_persist_failed', await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(session.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) }), { session_id: session.id });
  if (stepRows?.length) A.checkWrite('bot_wa_persist_failed', await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(stepRows) }), { session_id: session.id });
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
  if ((cfg.mode || 'pilot') !== 'public' && !(cfg.pilot_numbers || []).map(E.normPhone).includes(E.normPhone(m.from))) return null;   // 3
  if (detectOptOut(m.text)) return null;                                                       // 4
  const lo = await d.threadLastOutbound(env, m.from, pid);                                     // 5
  if (lo.error) return null;
  if (lo.found && lo.last_outbound_at && Date.now() - new Date(lo.last_outbound_at).getTime() < HUMAN_ACTIVE_MS) return null;
  if (!ingestRes?.profile_id) return null;   // unreadable ingest -> silent, not fail-open into condition 6
  if (await d.hasActiveEnrolment(env, ingestRes?.profile_id)) return null;                     // 6
  const kindOk = ['text', 'interactive', 'button', 'image', 'video', 'audio', 'document', 'sticker'].includes(m.type || 'text');
  if (!kindOk) return null;                                                                    // 7
  const text = String(m.text || '').slice(0, 500);

  let session = await d.findLatestSession(env, m.from, pid);
  const idleMs = session ? Date.now() - new Date(session.last_activity_at || session.started_at).getTime() : 0;
  // 8. STICKY HANDOFF — and it is NOT on the idle clock. A customer who asked for a human is owed
  // one however long the queue takes; expiring the handoff after 6h let the bot re-greet somebody
  // still waiting AND re-hid the thread behind bot_active. The only thing that ends it is a human
  // actually replying (condition 5's read): after that reply, condition 5 governs — inside 12h the
  // bot is silent anyway, outside it a fresh session is the right answer.
  if (session && session.status === 'handed_off') {
    const humanAfter = lo.found && lo.last_outbound_at && new Date(lo.last_outbound_at) > new Date(session.last_activity_at);
    if (!humanAfter) return null;
    session = null;
  }
  if (session && session.status !== 'active') session = null;                                    // ended: start fresh
  if (session && idleMs > IDLE_EXPIRE_MS) {
    const ex = E.advance({ entry: null, steps: {} }, session, { kind: 'expire' });
    await d.persist(env, session, { status: ex.state.status, ended_at: new Date().toISOString() }, [{ session_id: session.id, step_id: session.current_step || 'entry', step_type: 'expire', result: null }]);
    session = null;
  }
  let opened = false;
  if (!session) {
    const created = await d.createSession(env, { bot_id: bot.id, bot_version: bot.active_version, channel: 'whatsapp', wa_from: String(m.from), phone_number_id: pid,
      profile_id: ingestRes?.profile_id || null, context: { identity: { phone: E.normPhone(m.from) } } });
    if (!created) return null;
    session = created.session;
    // adopted = lost the unique-index race; the WINNER's state stands, so this turn must NOT
    // re-greet from def.entry and clobber it (fix round 1 finding 2).
    opened = !created.adopted;
  }
  // load def BEFORE claiming — a transient definition read must not burn the message's claim
  // (fix round 1 finding 5): the claim below is a one-shot dedup key, so a null def AFTER
  // claiming would drop the message forever with no retry and no log.
  const def = await T.sessionDefinition(env, session, { loadDefinition: d.loadDefinition });
  if (!def) { console.log('bot_wa_no_definition', JSON.stringify({ session_id: session.id, bot_id: bot.id })); return null; }
  // claim THIS message before advancing — redelivery / concurrent invocation = skip (spec §5.2).
  // The duplicate branch still reports the LIVE session state: csops drives the thread rail off it
  // even when it skips the transcript rows (a redelivered first message must not leave bot_active false).
  const claimed = await d.claimTurn(env, { session_id: session.id, step_id: session.current_step || 'entry', step_type: 'customer_message', result: { text, type: m.type || 'text', button_id: m.button_id || null }, provider_message_id: m.provider_message_id || null });
  if (!claimed) {
    // Re-read: the concurrent winner may have handed off between our findLatestSession and here,
    // and the stale pre-claim status would tell csops to keep bot_active=true on a thread that is
    // now waiting for a human. Read failure falls back to what we already have.
    const fresh = await d.findLatestSession(env, m.from, pid).catch(() => null);
    const st = (fresh && fresh.id === session.id ? fresh.status : session.status);
    return { handled: true, duplicate: true, session_id: session.id, session_status: st, replies: [], handoff: st === 'handed_off' };
  }
  const input = opened ? { kind: 'open', text }
    : m.button_id ? { kind: 'button', buttonId: stripBotId(m.button_id), text }
    : { kind: 'text', text };
  const t = await T.executeTurn(env, session, def, input, { loadActiveShared: d.loadActiveShared, loadDefinition: d.loadDefinition, ...(d.lookupOrderStatus ? { lookupOrderStatus: d.lookupOrderStatus } : {}) });
  const out = t.out;
  const sendRows = [];
  for (const [i, r] of out.replies.entries()) {
    const res = await d.send(env, toSendOpts(session, m.provider_message_id || 'nopmid', i, r.step_id || out.state.current_step || 'entry', r, m.from, pid)).catch((e) => ({ status: 'failed', reason: String(e?.message || e) }));
    // Attribute the failure to the step that EMITTED this reply, not the turn's final
    // current_step (after a sub-flow return they differ) — same rule as bot-turn's bot_message rows.
    if (res.status !== 'sent' && res.status !== 'deduped') sendRows.push({ session_id: session.id, step_id: r.step_id || out.state.current_step || 'entry', step_type: 'send_failed', result: { status: res.status, reason: res.reason || null } });
  }
  await d.persist(env, session, { current_step: out.state.current_step, status: out.state.status, context: out.state.context,
    sub_bot_id: t.frame ? t.frame.bot_id : null, sub_version: t.frame ? t.frame.version : null, return_step: t.frame ? t.frame.return_step : null,
    last_activity_at: new Date().toISOString(), ended_at: out.state.status === 'ended' ? new Date().toISOString() : null }, [...t.stepRows, ...sendRows]);
  return { handled: true, session_id: session.id, session_status: out.state.status,
    replies: out.replies.map((r) => ({ text: r.text, buttons: r.buttons || null, style: r.style || null })), handoff: t.handoff || out.state.status === 'handed_off' };
}

module.exports = { maybeHandleInbound, stripBotId, wireId, BOT_ID_PREFIX, HUMAN_ACTIVE_MS, IDLE_EXPIRE_MS, toSendOpts };
