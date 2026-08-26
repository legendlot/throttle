// Public web-bot surface (S312) — the first unauthenticated write surface in this fleet,
// so it is deliberately tiny: three routes, hard caps, no free-form writes anywhere.
const A = require('./auth.js');
const E = require('./bot-engine.js');
const OS = require('./bot-order-status.js');

const ALLOWED_ORIGINS = new Set(['https://www.legendoftoys.com', 'https://legendoftoys.com']);
const MAX_TEXT = 500;              // message length cap
const MAX_TURNS_PER_MIN = 20;      // per-session flood cap

function corsHeaders(origin) {
  return ALLOWED_ORIGINS.has(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
    : {};
}

async function loadSession(env, id) {
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}

async function loadDefinition(env, botId, version) {
  const r = await A.sbComms(`/rest/v1/bot_versions?bot_id=eq.${A.enc(botId)}&version=eq.${version}&select=definition&limit=1`, env);
  return (r.ok && r.data?.[0]?.definition) || null;
}

async function persist(env, session, out, stepRows) {
  await A.sbComms(`/rest/v1/bot_sessions?id=eq.${A.enc(session.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ current_step: out.state.current_step, status: out.state.status, context: out.state.context,
      profile_id: session.profile_id || out.state.context.profile_id || null,
      last_activity_at: new Date().toISOString(), ended_at: out.state.status === 'ended' ? new Date().toISOString() : null }) });
  if (stepRows.length)
    await A.sbComms('/rest/v1/bot_session_steps', env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(stepRows) });
}

// Forward the turn's lines to the csops thread — the inbox transcript IS the transcript.
// ⚠️ identity comes from the POST-turn state, never the stale session row: the thread is
// created on turn 1 (before collect has run), so if this sent session.context the phone
// collected THIS turn would never reach the inbox thread — csops PATCHes it in on arrival.
async function forwardToCsops(env, session, identity, inboundText, replies, handoff) {
  if (!env.CSOPS || !env.CSOPS_WA_FORWARD_TOKEN) return;
  const messages = [];
  if (inboundText) messages.push({ direction: 'inbound', text: inboundText });
  for (const r of replies) messages.push({ direction: 'outbound', text: r.text + (r.buttons ? '\n' + r.buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n') : '') });
  const init = { method: 'POST', headers: { Authorization: `Bearer ${env.CSOPS_WA_FORWARD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: session.id, identity: identity || {}, messages, handoff: !!handoff }) };
  await env.CSOPS.fetch(new Request('https://internal/webhooks/relay-web', init)).catch((e) => console.log('web_forward_error', String(e?.message || e)));
}

// One turn: engine -> execute effects (order lookup loops back in; handoff forwards) -> persist.
async function runTurn(env, session, def, input, inboundText) {
  let out = E.advance(def, session, input);
  const stepRows = [{ session_id: session.id, step_id: out.state.current_step || 'entry', step_type: inboundText ? 'customer_message' : 'open', result: inboundText ? { text: inboundText } : null }];
  let handoff = false;
  for (let guard = 0; guard < 3; guard++) {           // an order_lookup re-enters at most once; handoff is terminal
    const fx = out.effects || [];
    out.effects = [];
    let reentered = false;
    for (const e of fx) {
      if (e.type === 'order_lookup') {
        const r = await OS.lookupOrderStatus(env, e);
        stepRows.push({ session_id: session.id, step_id: out.state.current_step, step_type: 'order_lookup', result: { ok: r.ok, reason: r.reason || null } });
        const next = E.advance(def, out.state, { kind: 'action_result', ok: r.ok, data: r.ok ? { statusText: r.statusText } : {} });
        out = { state: next.state, replies: [...out.replies, ...next.replies], effects: next.effects };
        reentered = true;
      }
      if (e.type === 'handoff') { handoff = true; stepRows.push({ session_id: session.id, step_id: out.state.current_step, step_type: 'handoff', result: null }); }
    }
    if (!reentered) break;
  }
  for (const r of out.replies) stepRows.push({ session_id: session.id, step_id: out.state.current_step || 'entry', step_type: 'bot_message', result: { text: r.text, buttons: r.buttons || null } });
  // Resolve a profile the moment identity lands — this is what makes the 24h conversion join
  // possible. is_verified:false ON PURPOSE: the visitor TYPED this phone/email, nothing proved
  // ownership, so it must stay a weak key and never force-merge profiles (S224 rules).
  const ident = out.state.context.identity;
  if (ident && !session.profile_id && !out.state.context.profile_id) {
    const ids = ident.phone ? [{ type: 'phone', value: `+91${ident.phone}`, is_verified: false }]
                            : [{ type: 'email', value: ident.email, is_verified: false }];
    const rp = await A.sbComms('/rest/v1/rpc/resolve_identity', env, { method: 'POST',
      body: JSON.stringify({ p_identifiers: ids, p_source: 'web_bot' }) }).catch(() => ({ ok: false }));
    if (rp.ok && rp.data) out.state.context.profile_id = rp.data;   // RPC returns the uuid scalar
  }
  await persist(env, session, out, stepRows);
  // Forward only once a HUMAN has said something (or a handoff fires). The open turn used to
  // forward too, which meant an unauthenticated POST /web/session minted a Pitstop inbox
  // thread by itself — an inbox-spam vector, and 2 of the 5 S312 smoke sessions were exactly
  // that noise (open-only "Web visitor" threads with no customer line). The constant greeting
  // is all the transcript loses; per-IP limiting on /web/* stays a WAF-config residual.
  if (inboundText || handoff)
    await forwardToCsops(env, session, out.state.context.identity, inboundText, out.replies, handoff);
  return out;
}

async function floodCheck(env, sessionId) {
  const since = new Date(Date.now() - 60000).toISOString();
  const r = await A.sbComms(`/rest/v1/bot_session_steps?session_id=eq.${A.enc(sessionId)}&step_type=eq.customer_message&entered_at=gte.${A.enc(since)}&select=id&limit=${MAX_TURNS_PER_MIN + 1}`, env);
  return (r.ok ? r.data.length : 0) <= MAX_TURNS_PER_MIN;
}

module.exports = { corsHeaders, loadSession, loadDefinition, runTurn, floodCheck, MAX_TEXT, ALLOWED_ORIGINS };
