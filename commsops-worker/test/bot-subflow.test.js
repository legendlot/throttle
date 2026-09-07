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

// handoff inside a sub-flow is terminal for the session — and must NOT emit subflow_return
// (a handoff is not a return to the parent; the frame is left intact for the record)
st = { current_step: 'list', status: 'active', context: {}, frame: { bot_id: FAQ_ID, version: 1, return_step: 'faq' } };
r = E.advance(SUB, st, { kind: 'text', text: 'x' }); r = E.advance(SUB, r.state, { kind: 'text', text: 'y' });
assert.equal(r.state.status, 'handed_off');
assert.ok(!r.effects.some((e) => e.type === 'subflow_return'));
assert.ok(r.state.frame, 'frame must still be set — a handoff is not a subflow return');

// Fix round 1 finding 2: a `resume` carrying a stale frame must clear it, so the parent's `end`
// does not emit a second subflow_return and the session actually ends.
{
  let s2 = E.advance(PARENT, Object.assign(fresh(), { current_step: 'menu' }), { kind: 'button', buttonId: 'b_faq' }).state;
  s2 = { ...s2, frame: { bot_id: FAQ_ID, version: 1, return_step: 'faq' } };   // stale frame carried in
  const END_PARENT = { entry: 'faq', steps: { faq: { type: 'subflow', bot_id: FAQ_ID, outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} } } };
  const rr = E.advance(END_PARENT, s2, { kind: 'resume', from: 'faq' });
  assert.equal(rr.state.status, 'ended');
  assert.ok(!rr.effects.some((e) => e.type === 'subflow_return'));
  assert.equal(rr.state.frame, null);
}

// Fix round 1 finding 3: text arriving while current_step is a subflow step emits NO replies
// (the "restate where we are" fallthrough must skip a step with nothing to restate).
{
  const SF_PARENT = { entry: 'menu', steps: PARENT.steps };
  const rr = E.advance(SF_PARENT, { current_step: 'faq', status: 'active', context: {}, frame: null }, { kind: 'text', text: 'hi' });
  assert.equal(rr.replies.length, 0);
}

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

// finding 5 coverage: wa_row_title_long
const LIST_TITLE = { entry: 'm', steps: { m: { type: 'menu', style: 'list', text: 'x',
  buttons: [{ id: 'b0', label: 'x'.repeat(25) }], outcomes: { b0: 'e', fallback: 'e' } }, e: { type: 'end', outcomes: {} } } };
assert.ok(E.validateBotDef(LIST_TITLE, { channel: 'whatsapp' }).some((e) => e.code === 'wa_row_title_long'));

// finding 5 coverage: wa_text_long
const LONG_TEXT = { entry: 'm', steps: { m: { type: 'message', text: 'x'.repeat(1025), outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} } } };
assert.ok(E.validateBotDef(LONG_TEXT, { channel: 'whatsapp' }).some((e) => e.code === 'wa_text_long'));

// finding 4 + 5: a 1,100-char text_exhausted fires text_exhausted_long, and — after the fix —
// NOT wa_text_long (the WA body check reads text/prompt only, not text_exhausted).
const LONG_EXHAUSTED = { entry: 'm', steps: {
  m: { type: 'action', kind: 'order_status', text_exhausted: 'x'.repeat(1100), outcomes: { found: 'e', not_found: 'e' } },
  e: { type: 'end', outcomes: {} } } };
const exErrs = E.validateBotDef(LONG_EXHAUSTED, { channel: 'whatsapp' }).map((e) => e.code);
assert.ok(exErrs.includes('text_exhausted_long'), JSON.stringify(exErrs));
assert.ok(!exErrs.includes('wa_text_long'), JSON.stringify(exErrs));

console.log('bot-subflow ok');
