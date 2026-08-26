// Pure bot turn engine (spec 2026-08-26-bot-builder-design.md). NO I/O in this file —
// async work (order lookup, handoff forward) is returned as an EFFECT; the route executes
// it and re-enters with input {kind:'action_result'}. That is what makes this testable
// exactly like journey-graph.js, and what keeps validator and runtime from drifting.
const G = require('./journey-graph.js');

const MAX_MENU_MISSES = 2;     // Afshaan: free text re-shows the menu; 2 misses -> fallback
const MAX_ORDER_ATTEMPTS = 5;  // enumeration guard: sequential order numbers, public surface

const PHONE_RE = /(?:\+?91[\s-]?)?([0-9][\s-]?){10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Real LOT order names are ALPHANUMERIC (#LOT48622) — found live in the S312 smoke;
// a digits-only pattern rejected every real order number. Letters prefix + digits.
const ORDER_RE = /^#?[A-Za-z]{0,6}\d{3,10}$/;

function normPhone(s) { const d = String(s).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; }

function renderStep(step) {
  if (step.type === 'menu') return { text: step.text, buttons: step.buttons.map((b) => ({ id: b.id, label: b.label })) };
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
    if (step.type === 'message') { replies.push(renderStep(step)); id = G.resolveTarget(step, 'next'); continue; }
    if (step.type === 'collect') { replies.push({ text: step.prompt }); return { state, replies, effects }; }
    if (step.type === 'menu')    { state.context.menu_misses = 0; replies.push(renderStep(step)); return { state, replies, effects }; }
    if (step.type === 'action' && step.kind === 'order_status') {
      effects.push({ type: 'order_lookup', orderNumber: state.context.order_number, identity: state.context.identity || {} });
      return { state, replies, effects };                 // wait for action_result
    }
    if (step.type === 'handoff') {
      // NEVER silent (spec guard 3, violated live in the S312 smoke: identity_mismatch ->
      // handoff said nothing and the customer just saw the chat stop). Authorable copy,
      // honest default. Business-hours-aware wording is a csops-side residual.
      replies.push({ text: step.text || 'Let me connect you to our support team — a human will reply right here as soon as one is available.' });
      state.status = 'handed_off'; effects.push({ type: 'handoff' }); return { state, replies, effects };
    }
    if (step.type === 'end')     { if (step.text) replies.push({ text: step.text }); state.status = 'ended'; return { state, replies, effects }; }
    break;
  }
  return { state, replies, effects };
}

function advance(def, prev, input) {
  const state = { current_step: prev.current_step, status: prev.status, context: { ...(prev.context || {}) } };
  const replies = []; const effects = [];
  if (state.status !== 'active' && input.kind !== 'agent') return { state, replies, effects };  // agent supremacy: handed_off/ended bot is silent

  if (input.kind === 'open') return walk(def, state, def.entry, replies, effects);

  const step = def.steps[state.current_step];
  if (!step) return walk(def, state, def.entry, replies, effects);

  if (step.type === 'collect' && (input.kind === 'text' || input.kind === 'button')) {
    const raw = String(input.text || '').trim();
    if (step.field === 'phone_or_email') {
      const phone = PHONE_RE.test(raw) ? normPhone(raw) : null;
      const email = EMAIL_RE.test(raw) ? raw.toLowerCase() : null;
      if (!phone && !email) { replies.push({ text: 'Please share a valid phone number or email so we can help.' }); return { state, replies, effects }; }
      state.context.identity = phone ? { phone } : { email };
    } else if (step.field === 'order_number') {
      if (!ORDER_RE.test(raw)) { replies.push({ text: 'That does not look like an order number — it is on your confirmation, like #LOT48622.' }); return { state, replies, effects }; }
      const canon = raw.replace(/^#/, '').toUpperCase();
      state.context.order_number = `#${canon}`;
    } else { state.context[step.field] = raw; }
    return walk(def, state, G.resolveTarget(step, 'next'), replies, effects);
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
      replies.push({ text: 'Sorry, I did not catch that — please pick an option below.' });
      replies.push(renderStep(step));
      return { state, replies, effects };
    }
    return walk(def, state, G.resolveTarget(step, handle), replies, effects);
  }

  if (step.type === 'action' && input.kind === 'action_result') {
    if (input.ok) { replies.push({ text: input.data.statusText }); return walk(def, state, G.resolveTarget(step, 'found'), replies, effects); }
    const attempts = (state.context.order_attempts || 0) + 1;
    state.context.order_attempts = attempts;
    if (attempts >= MAX_ORDER_ATTEMPTS) { state.status = 'ended'; replies.push({ text: 'We could not verify those details. Please write to support@legendoftoys.com.' }); return { state, replies, effects }; }
    return walk(def, state, G.resolveTarget(step, 'not_found'), replies, effects);
  }

  // Anything else (text at an action/terminal): restate where we are.
  replies.push(renderStep(step));
  return { state, replies, effects };
}

// Canvas + publish lint. Same discipline as journeys compile(): validator reads targets
// through the SAME resolveTarget the runtime uses.
function validateBotDef(def) {
  const errs = [];
  if (!def || !def.entry || !def.steps || !def.steps[def.entry]) return [{ code: 'no_entry', stepId: def && def.entry }];
  for (const [id, step] of Object.entries(def.steps)) {
    const handles = step.type === 'menu'
      ? [...(step.buttons || []).map((b) => b.id), 'fallback']
      : step.type === 'action' ? ['found', 'not_found']
      : (step.type === 'handoff' || step.type === 'end') ? []
      : ['next'];
    for (const h of handles) {
      const t = G.resolveTarget(step, h);
      if (!t) {
        // EVERY handle must be wired. An unwired menu button is a customer tapping a button
        // and getting silence — walk(null) emits nothing — so it is a lint error, not a style choice.
        if (step.type === 'menu' && h === 'fallback') errs.push({ code: 'fallback_unwired', stepId: id });
        else if (step.type === 'menu') errs.push({ code: 'button_unwired', stepId: id, handle: h });
        else errs.push({ code: 'dangling_target', stepId: id });
        continue;
      }
      if (!def.steps[t]) errs.push({ code: 'dangling_target', stepId: id });
    }
    if (step.type === 'menu' && !(step.buttons || []).length) errs.push({ code: 'menu_no_buttons', stepId: id });
  }
  return errs;
}

module.exports = { advance, walk, validateBotDef, MAX_MENU_MISSES, MAX_ORDER_ATTEMPTS, normPhone };
