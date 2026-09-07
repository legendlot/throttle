// Channel-neutral turn runner (S355). Runs the pure engine, executes its EFFECTS
// (order lookup re-enters with action_result; subflow_enter loads the shared bot's active
// version and opens it; subflow_return resumes the parent), and returns replies + step rows.
// NO persistence and NO sending here — bot-web.js and bot-wa.js own those.
const A = require('./auth.js');
const E = require('./bot-engine.js');
const OS = require('./bot-order-status.js');

const MAX_EFFECT_LOOPS = 6;   // enter + walk + return + resume + one lookup, with slack

async function defaultLoadDefinition(env, botId, version) {
  const r = await A.sbComms(`/rest/v1/bot_versions?bot_id=eq.${A.enc(botId)}&version=eq.${version}&select=definition&limit=1`, env);
  return (r.ok && r.data?.[0]?.definition) || null;
}
async function defaultLoadActiveShared(env, botId) {
  const b = await A.sbComms(`/rest/v1/bots?id=eq.${A.enc(botId)}&channel=eq.shared&status=eq.active&select=active_version&limit=1`, env);
  const v = b.ok && b.data?.[0]?.active_version;
  if (!v) return null;
  const d = await defaultLoadDefinition(env, botId, v);
  return d ? { version: v, definition: d } : null;
}

// The definition THIS turn runs against: the sub-flow's when the session is inside one.
async function sessionDefinition(env, session, deps = {}) {
  const load = deps.loadDefinition || defaultLoadDefinition;
  if (session.sub_bot_id && session.sub_version) return load(env, session.sub_bot_id, session.sub_version);
  return load(env, session.bot_id, session.bot_version);
}

async function executeTurn(env, session, def, input, deps = {}) {
  const lookup = deps.lookupOrderStatus || OS.lookupOrderStatus;
  const loadShared = deps.loadActiveShared || defaultLoadActiveShared;
  const prev = { current_step: session.current_step, status: session.status, context: session.context || {},
    frame: (session.sub_bot_id && session.sub_version) ? { bot_id: session.sub_bot_id, version: session.sub_version, return_step: session.return_step } : null };
  let curDef = def;                 // definition the engine is currently walking
  let parentDef = prev.frame ? null : def;   // parent, needed to resume after a return
  const stepRows = [];
  let out = E.advance(curDef, prev, input);
  // Every engine reply already carries `step_id` — the step that EMITTED it, not the final
  // current_step, which after a sub-flow return is the parent's. bot_session_steps is the
  // analytics substrate: drop-off inside a shared sub-flow must attribute to the sub-flow's step.
  const replies = [];
  const pushReplies = (rs) => {
    for (const r of rs) {
      replies.push(r);
      stepRows.push({ session_id: session.id, step_id: r.step_id || 'entry', step_type: 'bot_message', result: { text: r.text, buttons: r.buttons || null, style: r.style || null } });
    }
  };
  pushReplies(out.replies);
  let handoff = false;
  for (let guard = 0; guard < MAX_EFFECT_LOOPS; guard++) {
    const fx = out.effects || []; out.effects = [];
    let reentered = false;
    for (const e of fx) {
      if (e.type === 'order_lookup') {
        const r = await lookup(env, e);
        stepRows.push({ session_id: session.id, step_id: out.state.current_step, step_type: 'order_lookup', result: { ok: r.ok, reason: r.reason || null } });
        out = E.advance(curDef, out.state, { kind: 'action_result', ok: r.ok, data: r.ok ? { statusText: r.statusText } : {} });
        pushReplies(out.replies); reentered = true;
      } else if (e.type === 'subflow_enter') {
        const shared = await loadShared(env, e.bot_id);
        stepRows.push({ session_id: session.id, step_id: e.return_step, step_type: 'subflow_enter', result: { bot_id: e.bot_id, version: shared?.version || null } });
        if (!shared) {          // unpublished/paused/missing shared bot: never stall the customer
          pushReplies([{ text: E.HANDOFF_DEFAULT, step_id: e.return_step }]); out.state.status = 'handed_off'; handoff = true;
          stepRows.push({ session_id: session.id, step_id: e.return_step, step_type: 'handoff', result: { reason: 'subflow_unavailable' } });
          continue;
        }
        parentDef = curDef; curDef = shared.definition;
        out.state.frame = { bot_id: e.bot_id, version: shared.version, return_step: e.return_step };
        out = E.advance(curDef, out.state, { kind: 'open' });
        pushReplies(out.replies); reentered = true;
      } else if (e.type === 'subflow_return') {
        stepRows.push({ session_id: session.id, step_id: e.return_step, step_type: 'subflow_return', result: null });
        if (!parentDef) parentDef = await sessionDefinition(env, { ...session, sub_bot_id: null }, deps);
        if (!parentDef) {       // parent definition missing/pruned/transient error: never stall the customer
          pushReplies([{ text: E.HANDOFF_DEFAULT, step_id: e.return_step }]);
          out.state.status = 'handed_off'; out.state.frame = null; handoff = true;
          stepRows.push({ session_id: session.id, step_id: e.return_step, step_type: 'handoff', result: { reason: 'parent_unavailable' } });
          continue;
        }
        curDef = parentDef;
        out = E.advance(curDef, out.state, { kind: 'resume', from: e.return_step });
        pushReplies(out.replies); reentered = true;
      } else if (e.type === 'handoff') {
        handoff = true;
        stepRows.push({ session_id: session.id, step_id: e.step_id || out.state.current_step, step_type: 'handoff', result: null });
      }
    }
    if (!reentered) break;
    if (guard === MAX_EFFECT_LOOPS - 1 && (out.effects || []).length)
      console.log('bot_turn_effect_loop_exhausted', JSON.stringify({ session_id: session.id, pending: out.effects.map((x) => x.type) }));
  }
  out.replies = replies;
  return { out, stepRows, handoff, frame: out.state.frame || null };
}

module.exports = { executeTurn, sessionDefinition, defaultLoadDefinition, defaultLoadActiveShared };
