// S355 — sub-flow enter/return as effects (spec §2), channel lint (spec §3).
// Run: node test/bot-subflow.test.js
const assert = require('assert');
const E = require('../src/bot-engine.js');
const FAQ_ID = '11111111-1111-1111-1111-111111111111';

const PARENT = { entry: 'menu', steps: {
  menu: { type: 'menu', text: 'Hi', buttons: [{ id: 'b_faq', label: 'FAQs' }, { id: 'b_agent', label: 'Agent' }],
          outcomes: { b_faq: 'faq', b_agent: 'h', fallback: 'h' } },
  faq:  { type: 'subflow', bot_id: FAQ_ID, outcomes: { next: 'menu' } },
  h:    { type: 'handoff', outcomes: {} },
} };
const SUB = { entry: 'list', steps: {
  list: { type: 'menu', style: 'list', text: 'Topics', buttons: [{ id: 'b_ship', label: 'Shipping' }], outcomes: { b_ship: 'a_ship', fallback: 'h' } },
  a_ship: { type: 'message', text: '3-5 days.', outcomes: { next: 'e' } },
  e: { type: 'end', outcomes: {} },
  h: { type: 'handoff', outcomes: {} },
} };
const fresh = () => ({ current_step: null, status: 'active', context: {}, frame: null });

// tap FAQs -> subflow_enter effect, no replies from the parent
let r = E.advance(PARENT, Object.assign(fresh(), { current_step: 'menu' }), { kind: 'button', buttonId: 'b_faq' });
assert.deepEqual(r.effects, [{ type: 'subflow_enter', bot_id: FAQ_ID, return_step: 'faq' }]);
assert.equal(r.replies.length, 0);
assert.equal(r.state.current_step, 'faq');

// route sets the frame and opens the sub-flow
let st = { ...r.state, frame: { bot_id: FAQ_ID, version: 1, return_step: 'faq' } };
r = E.advance(SUB, st, { kind: 'open' });
assert.equal(r.replies[0].style, 'list');
// pick a topic -> answer -> end -> subflow_return effect, frame cleared, still active
r = E.advance(SUB, r.state, { kind: 'button', buttonId: 'b_ship' });
assert.deepEqual(r.replies.map((x) => x.text), ['3-5 days.']);
assert.deepEqual(r.effects, [{ type: 'subflow_return', return_step: 'faq' }]);
assert.equal(r.state.frame, null); assert.equal(r.state.status, 'active');
// route resumes the parent from the subflow step's next -> greeting menu again
r = E.advance(PARENT, r.state, { kind: 'resume', from: 'faq' });
assert.equal(r.state.current_step, 'menu');

// handoff inside a sub-flow is terminal for the session
st = { current_step: 'list', status: 'active', context: {}, frame: { bot_id: FAQ_ID, version: 1, return_step: 'faq' } };
r = E.advance(SUB, st, { kind: 'text', text: 'x' }); r = E.advance(SUB, r.state, { kind: 'text', text: 'y' });
assert.equal(r.state.status, 'handed_off');

// an end WITHOUT a frame still ends the session
r = E.advance(SUB, { current_step: 'a_ship', status: 'active', context: {}, frame: null }, { kind: 'resume', from: 'a_ship' });
assert.equal(r.state.status, 'ended');

// ── lint ──
const okErrs = E.validateBotDef(PARENT, { channel: 'whatsapp', sharedIds: new Set([FAQ_ID]) });
assert.deepEqual(okErrs, []);
assert.ok(E.validateBotDef(PARENT, { channel: 'whatsapp', sharedIds: new Set() }).some((e) => e.code === 'subflow_target_invalid'));
assert.ok(E.validateBotDef(PARENT, { isShared: true, sharedIds: new Set([FAQ_ID]) }).some((e) => e.code === 'shared_contains_subflow'));
const WA = { entry: 'm', steps: { m: { type: 'menu', text: 'x', buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, label: 'A label that is far too long for Meta' })),
  outcomes: { b1: 'e', b2: 'e', b3: 'e', b4: 'e', fallback: 'e' } }, e: { type: 'end', outcomes: {} } } };
const waErrs = E.validateBotDef(WA, { channel: 'whatsapp' });
assert.ok(waErrs.some((e) => e.code === 'wa_too_many_buttons'));
assert.ok(waErrs.some((e) => e.code === 'wa_button_label_long'));
assert.deepEqual(E.validateBotDef(WA, { channel: 'web' }), []);   // web has no such limits
const LIST = { entry: 'm', steps: { m: { type: 'menu', style: 'list', text: 'x', buttons: Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, label: `R${i}`, description: 'd'.repeat(73) })),
  outcomes: Object.assign({ fallback: 'e' }, ...Array.from({ length: 11 }, (_, i) => ({ [`b${i}`]: 'e' }))) }, e: { type: 'end', outcomes: {} } } };
const lErrs = E.validateBotDef(LIST, { channel: 'whatsapp' });
assert.ok(lErrs.some((e) => e.code === 'wa_too_many_rows'));
assert.ok(lErrs.some((e) => e.code === 'wa_row_description_long'));
console.log('bot-subflow ok');
