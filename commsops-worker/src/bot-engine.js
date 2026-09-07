// Pure bot turn engine (spec 2026-08-26-bot-builder-design.md). NO I/O in this file —
// async work (order lookup, handoff forward) is returned as an EFFECT; the route executes
// it and re-enters with input {kind:'action_result'}. That is what makes this testable
// exactly like journey-graph.js, and what keeps validator and runtime from drifting.
const G = require('./journey-graph.js');

const MAX_MENU_MISSES = 2;     // Afshaan: free text re-shows the menu; 2 misses -> fallback
const MAX_ORDER_ATTEMPTS = 5;  // enumeration guard: sequential order numbers, public surface

// Meta's interactive-message caps (buttons / list rows). Lint blocks publish rather than let
// the send fail at Meta with a 400 the customer never sees.
const WA_MAX_BUTTONS = 3, WA_BUTTON_LABEL = 20, WA_MAX_ROWS = 10, WA_ROW_TITLE = 24, WA_ROW_DESC = 72, WA_BODY = 1024;

const PHONE_RE = /(?:\+?91[\s-]?)?([0-9][\s-]?){10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Real LOT order names are ALPHANUMERIC (#LOT48622) — found live in the S312 smoke;
// a digits-only pattern rejected every real order number. Letters prefix + digits.
const ORDER_RE = /^#?[A-Za-z]{0,6}\d{3,10}$/;

function normPhone(s) { const d = String(s).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; }

// Honest default handoff copy — every path that gives up on the bot says this (never silence,
// never an email address the customer has to go find).
const HANDOFF_DEFAULT = 'Let me connect you to our support team — a human will reply right here as soon as one is available.';

const MAX_KEYWORDS = 20;
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// First matching rule wins. Whole-word/phrase, case-insensitive. Checked ONLY on the opening
// message and at a FAILED collect (spec §3.3) — never at a menu, never on valid input.
function matchKeyword(def, text) {
  const rules = Array.isArray(def?.keywords) ? def.keywords.slice(0, MAX_KEYWORDS) : [];
  const t = String(text || '').toLowerCase();
  if (!t || !rules.length) return null;
  for (const r of rules) {
    for (const m of (r.match || [])) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(String(m).toLowerCase())}([^a-z0-9]|$)`);
      if (re.test(t)) return r.target || null;
    }
  }
  return null;
}

function renderStep(step) {
  if (step.type === 'menu') {
    return {
      text: step.text,
      style: step.style === 'list' ? 'list' : 'buttons',
      list_button: step.style === 'list' ? (step.list_button || 'Choose') : null,
      buttons: step.buttons.map((b) => ({ id: b.id, label: b.label, description: b.description || null })),
    };
  }
  return { text: step.text || step.prompt || '' };
}

// Walk forward from stepId, emitting replies, until a step that WAITS (collect, menu,
// action pending I/O, handoff/end terminal). Returns {state, replies, effects}.
function walk(def, state, stepId, replies, effects) {
  let id = stepId;
  const seen = new Set();
  for (let hops = 0; hops < 50 && id; hops++) {          // hop cap: authoring loops end the walk, never the worker
    // Revisiting a step within ONE walk is an authored message-cycle (lint can't see it —
    // every target exists). Without this a cycle emits 50 replies per turn into the widget
    // AND the inbox transcript. Break after the first lap: each message said once.
    if (seen.has(id)) break;
    seen.add(id);
    const step = def.steps[id];
    if (!step) break;
    state.current_step = id;
    if (step.type === 'message') { replies.push({ ...renderStep(step), step_id: id }); id = G.resolveTarget(step, 'next'); continue; }
    if (step.type === 'collect') { state.context.collect_misses = 0; replies.push({ text: step.prompt, step_id: id }); return { state, replies, effects }; }
    if (step.type === 'menu')    { state.context.menu_misses = 0; replies.push({ ...renderStep(step), step_id: id }); return { state, replies, effects }; }
    if (step.type === 'action' && step.kind === 'order_status') {
      effects.push({ type: 'order_lookup', orderNumber: state.context.order_number, identity: state.context.identity || {} });
      return { state, replies, effects };                 // wait for action_result
    }
    if (step.type === 'handoff') {
      // NEVER silent (spec guard 3, violated live in the S312 smoke: identity_mismatch ->
      // handoff said nothing and the customer just saw the chat stop). Authorable copy,
      // honest default. Business-hours-aware wording is a csops-side residual.
      replies.push({ text: step.text || HANDOFF_DEFAULT, step_id: id });
      state.status = 'handed_off'; effects.push({ type: 'handoff' }); return { state, replies, effects };
    }
    if (step.type === 'subflow') {
      // Depth 1 only: the route swaps the definition and re-enters. The engine stays pure —
      // it never loads the other bot itself.
      effects.push({ type: 'subflow_enter', bot_id: step.bot_id, return_step: id });
      return { state, replies, effects };
    }
    if (step.type === 'end') {
      if (step.text) replies.push({ text: step.text, step_id: id });
      if (state.frame) {                                     // inside a shared sub-flow: hand back to the parent
        effects.push({ type: 'subflow_return', return_step: state.frame.return_step });
        state.frame = null;
        return { state, replies, effects };
      }
      state.status = 'ended'; return { state, replies, effects };
    }
    break;
  }
  return { state, replies, effects };
}

function advance(def, prev, input) {
  const state = { current_step: prev.current_step, status: prev.status, context: { ...(prev.context || {}) }, frame: prev.frame || null };
  const replies = []; const effects = [];
  if (state.status !== 'active' && input.kind !== 'agent') return { state, replies, effects };  // agent supremacy: handed_off/ended bot is silent

  if (input.kind === 'expire') { state.status = 'ended'; return { state, replies, effects }; }
  if (input.kind === 'resume') {
    state.frame = null;                                    // re-entering the parent: the sub-flow frame is spent
    const from = def.steps[input.from];
    return walk(def, state, from ? G.resolveTarget(from, 'next') : def.entry, replies, effects);
  }

  if (input.kind === 'open') {
    const kw = matchKeyword(def, input.text);
    return walk(def, state, kw && def.steps[kw] ? kw : def.entry, replies, effects);
  }

  const step = def.steps[state.current_step];
  if (!step) return walk(def, state, def.entry, replies, effects);

  if (step.type === 'collect' && (input.kind === 'text' || input.kind === 'button')) {
    const raw = String(input.text || '').trim();
    let valid = true;
    if (step.field === 'phone_or_email') {
      const phone = PHONE_RE.test(raw) ? normPhone(raw) : null;
      const email = EMAIL_RE.test(raw) ? raw.toLowerCase() : null;
      if (!phone && !email) valid = false; else state.context.identity = phone ? { phone } : { email };
    } else if (step.field === 'order_number') {
      if (!ORDER_RE.test(raw)) valid = false;
      else state.context.order_number = `#${raw.replace(/^#/, '').toUpperCase()}`;
    } else { state.context[step.field] = raw; }
    if (valid) { state.context.collect_misses = 0; return walk(def, state, G.resolveTarget(step, 'next'), replies, effects); }
    // Invalid: a handoff/other keyword escapes first (spec §3.3b); then the miss cap (§3.4).
    const kw = matchKeyword(def, raw);
    if (kw && def.steps[kw]) return walk(def, state, kw, replies, effects);
    const misses = (state.context.collect_misses || 0) + 1;
    state.context.collect_misses = misses;
    if (misses >= MAX_MENU_MISSES) {
      const fb = G.resolveTarget(step, 'fallback');
      if (fb && def.steps[fb]) return walk(def, state, fb, replies, effects);
      // No fallback wired (the pre-S355 web bot shape): walk(null) would emit NOTHING and leave
      // the customer staring at silence. Hand off instead — never a silent dead end.
      replies.push({ text: HANDOFF_DEFAULT, step_id: state.current_step });
      state.status = 'handed_off'; effects.push({ type: 'handoff' });
      return { state, replies, effects };
    }
    replies.push({ text: step.field === 'order_number'
      ? 'That does not look like an order number — it is on your confirmation, like #LOT48622.'
      : 'Please share a valid phone number or email so we can help.', step_id: state.current_step });
    return { state, replies, effects };
  }

  if (step.type === 'menu') {
    let handle = null;
    if (input.kind === 'button' && step.buttons.some((b) => b.id === input.buttonId)) handle = input.buttonId;
    else if (input.kind === 'text') {
      const t = String(input.text || '').trim().toLowerCase();
      const byLabel = step.buttons.find((b) => b.label.toLowerCase() === t);
      const byIndex = /^\d+$/.test(t) ? step.buttons[Number(t) - 1] : null;
      handle = (byLabel || byIndex || {}).id || null;
    }
    if (!handle) {
      const misses = (state.context.menu_misses || 0) + 1;
      if (misses >= MAX_MENU_MISSES) return walk(def, state, G.resolveTarget(step, 'fallback'), replies, effects);
      state.context.menu_misses = misses;
      replies.push({ text: 'Sorry, I did not catch that — please pick an option below.', step_id: state.current_step });
      replies.push({ ...renderStep(step), step_id: state.current_step });
      return { state, replies, effects };
    }
    return walk(def, state, G.resolveTarget(step, handle), replies, effects);
  }

  if (step.type === 'action' && input.kind === 'action_result') {
    if (input.ok) { replies.push({ text: input.data.statusText, step_id: state.current_step }); return walk(def, state, G.resolveTarget(step, 'found'), replies, effects); }
    const attempts = (state.context.order_attempts || 0) + 1;
    state.context.order_attempts = attempts;
    if (attempts >= MAX_ORDER_ATTEMPTS) {
      // The cap is a dead end for the BOT, not for the customer: hand off, never send them away
      // to an email address (spec §3.5).
      replies.push({ text: step.text_exhausted || HANDOFF_DEFAULT, step_id: state.current_step });
      state.status = 'handed_off'; effects.push({ type: 'handoff' });
      return { state, replies, effects };
    }
    return walk(def, state, G.resolveTarget(step, 'not_found'), replies, effects);
  }

  // Anything else (text at an action/terminal): restate where we are — unless the current
  // step has nothing to restate (e.g. a subflow step, which is a wait-for-effect, not text).
  const restate = renderStep(step);
  if (restate.text) replies.push({ ...restate, step_id: state.current_step });
  return { state, replies, effects };
}

// Canvas + publish lint. Same discipline as journeys compile(): validator reads targets
// through the SAME resolveTarget the runtime uses.
function validateBotDef(def, opts = {}) {
  const errs = [];
  if (!def || !def.entry || !def.steps || !def.steps[def.entry]) return [{ code: 'no_entry', stepId: def && def.entry }];
  for (const [id, step] of Object.entries(def.steps)) {
    // wire ids are `bot:<step_id>:<handle>` (bot-wa.js wireId) and stripBotId only strips the
    // first two `:`-delimited segments, so a step id containing `:` under-strips on the way back.
    if (String(id).includes(':')) errs.push({ code: 'step_id_invalid', stepId: id });
    const handles = step.type === 'menu'
      ? [...(step.buttons || []).map((b) => b.id), 'fallback']
      : step.type === 'action' ? ['found', 'not_found']
      : step.type === 'collect' ? ['next', 'fallback']
      : step.type === 'subflow' ? ['next']
      : (step.type === 'handoff' || step.type === 'end') ? []
      : ['next'];
    for (const h of handles) {
      const t = G.resolveTarget(step, h);
      if (!t) {
        // EVERY handle must be wired. An unwired menu button is a customer tapping a button
        // and getting silence — walk(null) emits nothing — so it is a lint error, not a style choice.
        if (step.type === 'menu' && h === 'fallback') errs.push({ code: 'fallback_unwired', stepId: id });
        else if (step.type === 'menu') errs.push({ code: 'button_unwired', stepId: id, handle: h });
        // A collect with no fallback re-prompts forever; the runtime hands off instead, but an
        // author should wire it explicitly, so it is a lint error too.
        else if (step.type === 'collect' && h === 'fallback') errs.push({ code: 'fallback_unwired', stepId: id });
        else errs.push({ code: 'dangling_target', stepId: id });
        continue;
      }
      if (!def.steps[t]) errs.push({ code: 'dangling_target', stepId: id });
    }
    if (step.type === 'menu' && !(step.buttons || []).length) errs.push({ code: 'menu_no_buttons', stepId: id });
    if (step.type === 'subflow') {
      if (opts.isShared) errs.push({ code: 'shared_contains_subflow', stepId: id });
      if (opts.sharedIds && !(step.bot_id && opts.sharedIds.has(step.bot_id))) errs.push({ code: 'subflow_target_invalid', stepId: id });
    }
    if (opts.channel === 'whatsapp') {
      if (step.type === 'menu') {
        const btns = step.buttons || [];
        if (step.style === 'list') {
          if (btns.length > WA_MAX_ROWS) errs.push({ code: 'wa_too_many_rows', stepId: id });
          if (btns.some((b) => String(b.label || '').length > WA_ROW_TITLE)) errs.push({ code: 'wa_row_title_long', stepId: id });
          if (btns.some((b) => String(b.description || '').length > WA_ROW_DESC)) errs.push({ code: 'wa_row_description_long', stepId: id });
        } else {
          if (btns.length > WA_MAX_BUTTONS) errs.push({ code: 'wa_too_many_buttons', stepId: id });
          if (btns.some((b) => String(b.label || '').length > WA_BUTTON_LABEL)) errs.push({ code: 'wa_button_label_long', stepId: id });
        }
      }
      const body = step.text || step.prompt || '';   // text_exhausted has its own check below
      if (String(body).length > WA_BODY) errs.push({ code: 'wa_text_long', stepId: id });
    }
    if (step.type === 'action' && String(step.text_exhausted || '').length > WA_BODY) errs.push({ code: 'text_exhausted_long', stepId: id });
  }
  for (const [i, r] of (Array.isArray(def.keywords) ? def.keywords : []).entries()) {
    if (!r || !r.target || !def.steps[r.target]) errs.push({ code: 'keyword_target_missing', stepId: r?.target || `keyword_${i}` });
    if (!Array.isArray(r?.match) || !r.match.filter(Boolean).length) errs.push({ code: 'keyword_empty', stepId: `keyword_${i}` });
  }
  return errs;
}

module.exports = { advance, walk, validateBotDef, matchKeyword, HANDOFF_DEFAULT, MAX_MENU_MISSES, MAX_ORDER_ATTEMPTS, normPhone,
  WA_MAX_BUTTONS, WA_BUTTON_LABEL, WA_MAX_ROWS, WA_ROW_TITLE, WA_ROW_DESC, WA_BODY };
