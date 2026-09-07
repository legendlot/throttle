// S355 — channel-neutral effect loop. Run: node test/bot-turn.test.js
const assert = require('assert');
const T = require('../src/bot-turn.js');
const FAQ_ID = '11111111-1111-1111-1111-111111111111';
const PARENT = { entry: 'menu', steps: {
  menu: { type: 'menu', text: 'Hi', buttons: [{ id: 'b_faq', label: 'FAQs' }], outcomes: { b_faq: 'faq', fallback: 'h' } },
  faq:  { type: 'subflow', bot_id: FAQ_ID, outcomes: { next: 'menu' } },
  h:    { type: 'handoff', outcomes: {} } } };
const SUB = { entry: 'a', steps: { a: { type: 'message', text: 'Answer.', outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} } } };
const deps = {
  loadActiveShared: async (env, id) => (id === FAQ_ID ? { version: 3, definition: SUB } : null),
  loadDefinition: async () => null,
  lookupOrderStatus: async () => ({ ok: false, reason: 'test' }),
};
(async () => {
  const session = { id: 's1', bot_id: 'p', bot_version: 1, current_step: 'menu', status: 'active', context: {}, sub_bot_id: null };
  // FAQ tap: enter sub-flow, walk it to its end, return, resume parent at the menu — ONE turn
  const r = await T.executeTurn({}, session, PARENT, { kind: 'button', buttonId: 'b_faq', text: 'FAQs' }, deps);
  assert.deepEqual(r.out.replies.map((x) => x.text), ['Answer.', 'Hi']);
  assert.equal(r.out.state.current_step, 'menu');
  assert.equal(r.frame, null);
  assert.equal(r.handoff, false);
  const types = r.stepRows.map((s) => s.step_type);
  assert.ok(types.includes('subflow_enter') && types.includes('subflow_return'), types.join(','));
  // each bot_message row is attributed to the step that produced it, not the final step
  const msgRows = r.stepRows.filter((s) => s.step_type === 'bot_message');
  assert.deepEqual(msgRows.map((s) => s.step_id), ['a', 'menu']);
  // the engine's own step_id is what carries the attribution — no side channel, nothing stripped
  assert.equal(r.out.replies[0].step_id, 'a');
  // a sub-flow that WAITS (menu) leaves the frame set for the next turn
  const SUB2 = { entry: 'm', steps: { m: { type: 'menu', text: 'Topics', buttons: [{ id: 'x', label: 'X' }], outcomes: { x: 'e', fallback: 'e' } }, e: { type: 'end', outcomes: {} } } };
  const deps2 = { ...deps, loadActiveShared: async () => ({ version: 5, definition: SUB2 }) };
  const r2 = await T.executeTurn({}, session, PARENT, { kind: 'button', buttonId: 'b_faq', text: 'FAQs' }, deps2);
  assert.deepEqual(r2.frame, { bot_id: FAQ_ID, version: 5, return_step: 'faq' });
  assert.equal(r2.out.state.current_step, 'm');
  // next turn on a session carrying the frame runs the SUB definition
  const s2 = { ...session, current_step: 'm', sub_bot_id: FAQ_ID, sub_version: 5, return_step: 'faq' };
  const defs = { loadDefinition: async (env, id, v) => (id === FAQ_ID && v === 5 ? SUB2 : null) };
  assert.deepEqual(await T.sessionDefinition({}, s2, defs), SUB2);
  // unknown shared bot: the turn hands off rather than stalling
  const r3 = await T.executeTurn({}, session, PARENT, { kind: 'button', buttonId: 'b_faq', text: 'FAQs' }, { ...deps, loadActiveShared: async () => null });
  assert.equal(r3.handoff, true);
  console.log('bot-turn ok');
})().catch((e) => { console.error(e); process.exit(1); });
