// Unit tests for the bot turn engine. Run: node test/bot-engine.test.js
const assert = require('assert');
const E = require('../src/bot-engine.js');

const DEF = { entry: 'welcome', steps: {
  welcome: { type: 'message', text: 'Hi!', outcomes: { next: 'ident' } },
  ident:   { type: 'collect', field: 'phone_or_email', prompt: 'Phone or email?', outcomes: { next: 'menu1' } },
  menu1:   { type: 'menu', text: 'Pick one', buttons: [{ id: 'b_track', label: 'Track my order' }, { id: 'b_agent', label: 'Agent' }],
             outcomes: { b_track: 'collect_order', b_agent: 'handoff1', fallback: 'handoff1' } },
  collect_order: { type: 'collect', field: 'order_number', prompt: 'Order number?', outcomes: { next: 'status1' } },
  status1: { type: 'action', kind: 'order_status', outcomes: { found: 'done', not_found: 'handoff1' } },
  handoff1:{ type: 'handoff', outcomes: {} },
  done:    { type: 'end', text: 'Bye!', outcomes: {} },
} };
const fresh = () => ({ current_step: null, status: 'active', context: {} });

// open: walks message -> stops at collect, both prompts returned in order
let r = E.advance(DEF, fresh(), { kind: 'open' });
assert.equal(r.state.current_step, 'ident');
assert.deepEqual(r.replies.map(x => x.text), ['Hi!', 'Phone or email?']);

// collect valid phone -> lands on menu with buttons; identity normalized to last-10 digits
r = E.advance(DEF, r.state, { kind: 'text', text: '+91 98765-43210' });
assert.equal(r.state.current_step, 'menu1');
assert.equal(r.state.context.identity.phone, '9876543210');
assert.deepEqual(r.replies[0].buttons.map(b => b.id), ['b_track', 'b_agent']);

// collect invalid -> re-prompts, stays put
let bad = E.advance(DEF, { current_step: 'ident', status: 'active', context: {} }, { kind: 'text', text: 'zzz' });
assert.equal(bad.state.current_step, 'ident');
assert.match(bad.replies[0].text, /valid phone|email/i);

// menu: free text matching a label (case-insensitive) counts as that button
let m = E.advance(DEF, r.state, { kind: 'text', text: 'track MY order' });
assert.equal(m.state.current_step, 'collect_order');

// menu: 1-based index also matches
let mi = E.advance(DEF, { current_step: 'menu1', status: 'active', context: {} }, { kind: 'text', text: '2' });
assert.equal(mi.state.current_step, 'handoff1');
assert.equal(mi.effects[0].type, 'handoff');
assert.equal(mi.state.status, 'handed_off');

// menu: miss re-shows menu; second miss fires fallback (MAX_MENU_MISSES = 2)
let x1 = E.advance(DEF, { current_step: 'menu1', status: 'active', context: {} }, { kind: 'text', text: 'weather?' });
assert.equal(x1.state.current_step, 'menu1');
assert.equal(x1.state.context.menu_misses, 1);
let x2 = E.advance(DEF, x1.state, { kind: 'text', text: 'still weather' });
assert.equal(x2.state.current_step, 'handoff1');

// order number collect -> action emits order_lookup effect and waits
let o = E.advance(DEF, { current_step: 'collect_order', status: 'active', context: { identity: { phone: '9876543210' } } }, { kind: 'text', text: '#12345' });
assert.equal(o.state.current_step, 'status1');
assert.deepEqual(o.effects[0], { type: 'order_lookup', orderNumber: '#12345', identity: { phone: '9876543210' } });
assert.equal(o.replies.length, 0);

// real LOT order names are alphanumeric (#LOT48622) — and lowercase input canonicalises
let oa = E.advance(DEF, { current_step: 'collect_order', status: 'active', context: { identity: { phone: '9876543210' } } }, { kind: 'text', text: 'lot48622' });
assert.equal(oa.effects[0].orderNumber, '#LOT48622');

// action_result found -> renders status text, walks to end
let f = E.advance(DEF, o.state, { kind: 'action_result', ok: true, data: { statusText: 'Out for delivery' } });
assert.equal(f.state.status, 'ended');
assert.deepEqual(f.replies.map(x => x.text), ['Out for delivery', 'Bye!']);

// action_result not ok -> not_found branch -> handoff (attempts below the cap)
let nf = E.advance(DEF, { current_step: 'status1', status: 'active', context: { order_attempts: 0 } }, { kind: 'action_result', ok: false });
assert.equal(nf.state.current_step, 'handoff1');

// the 5th failure hits MAX_ORDER_ATTEMPTS: session ENDS with the support copy, no handoff walk
let cap = E.advance(DEF, { current_step: 'status1', status: 'active', context: { order_attempts: 4 } }, { kind: 'action_result', ok: false });
assert.equal(cap.state.status, 'ended');
assert.match(cap.replies[0].text, /could not verify/i);

// handed_off session: bot NEVER replies (agent supremacy)
let h = E.advance(DEF, { current_step: 'menu1', status: 'handed_off', context: {} }, { kind: 'text', text: 'hello?' });
assert.equal(h.replies.length, 0);
assert.equal(h.effects.length, 0);

// validator: dangling target + menu without fallback wiring
assert.deepEqual(E.validateBotDef(DEF), []);
const badDef = { entry: 'a', steps: { a: { type: 'menu', text: 'x', buttons: [{ id: 'b1', label: 'One' }], outcomes: { b1: 'ghost' } } } };
const errs = E.validateBotDef(badDef).map(e => e.code).sort();
assert.deepEqual(errs, ['dangling_target', 'fallback_unwired']);

// an unwired menu BUTTON is a lint error (tap -> silence otherwise)
const unwired = { entry: 'a', steps: { a: { type: 'menu', text: 'x', buttons: [{ id: 'b1', label: 'One' }], outcomes: { fallback: 'z' } }, z: { type: 'end', outcomes: {} } } };
assert.ok(E.validateBotDef(unwired).some(e => e.code === 'button_unwired'));

// an authored message-cycle emits each message ONCE per turn, never 50
const loopDef = { entry: 'a', steps: {
  a: { type: 'message', text: 'A', outcomes: { next: 'b' } },
  b: { type: 'message', text: 'B', outcomes: { next: 'a' } } } };
const lr = E.advance(loopDef, fresh(), { kind: 'open' });
assert.deepEqual(lr.replies.map(x => x.text), ['A', 'B']);

console.log('bot-engine tests OK');
