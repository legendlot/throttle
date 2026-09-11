// Unit tests for the bot turn engine. Run: node test/bot-engine.test.js
const assert = require('assert');
const E = require('../src/bot-engine.js');

const DEF = { entry: 'welcome', steps: {
  welcome: { type: 'message', text: 'Hi!', outcomes: { next: 'ident' } },
  ident:   { type: 'collect', field: 'phone_or_email', prompt: 'Phone or email?', outcomes: { next: 'menu1', fallback: 'handoff1' } },
  menu1:   { type: 'menu', text: 'Pick one', buttons: [{ id: 'b_track', label: 'Track my order' }, { id: 'b_agent', label: 'Agent' }],
             outcomes: { b_track: 'collect_order', b_agent: 'handoff1', fallback: 'handoff1' } },
  collect_order: { type: 'collect', field: 'order_number', prompt: 'Order number?', outcomes: { next: 'status1', fallback: 'handoff1' } },
  status1: { type: 'action', kind: 'order_status', outcomes: { found: 'done', not_found: 'handoff1' } },
  handoff1:{ type: 'handoff', outcomes: {} },
  done:    { type: 'end', text: 'Bye!', outcomes: {} },
} };
const fresh = () => ({ current_step: null, status: 'active', context: {} });

// open: walks message -> stops at collect, both prompts returned in order
let r = E.advance(DEF, fresh(), { kind: 'open' });
assert.equal(r.state.current_step, 'ident');
assert.deepEqual(r.replies.map(x => x.text), ['Hi!', 'Phone or email?']);
// S355 (R3): every reply carries the id of the step that emitted it
assert.deepEqual(r.replies.map(x => x.step_id), ['welcome', 'ident']);

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
// handoff is NEVER silent — the customer is told a human is coming
assert.match(mi.replies[mi.replies.length - 1].text, /support team|human/i);

// menu: miss re-shows menu; second miss fires fallback (MAX_MENU_MISSES = 2)
let x1 = E.advance(DEF, { current_step: 'menu1', status: 'active', context: {} }, { kind: 'text', text: 'weather?' });
assert.equal(x1.state.current_step, 'menu1');
assert.equal(x1.state.context.menu_misses, 1);
let x2 = E.advance(DEF, x1.state, { kind: 'text', text: 'still weather' });
assert.equal(x2.state.current_step, 'handoff1');

// Fix round 2 (minor a): the same miss cap on a menu whose fallback is NOT wired must hand off,
// not walk(null) into silence — mirrors the collect miss cap. (Lint flags the unwired fallback,
// but a definition published before that lint existed is still live.)
{
  const NOFB = { entry: 'm', steps: { m: { type: 'menu', text: 'Pick', buttons: [{ id: 'a', label: 'A' }], outcomes: { a: 'e' } }, e: { type: 'end', outcomes: {} } } };
  const m1 = E.advance(NOFB, { current_step: 'm', status: 'active', context: {} }, { kind: 'text', text: 'huh' });
  const m2 = E.advance(NOFB, m1.state, { kind: 'text', text: 'huh again' });
  assert.equal(m2.state.status, 'handed_off');
  assert.ok(m2.effects.some((e) => e.type === 'handoff' && e.step_id === 'm'));
  assert.equal(m2.replies[m2.replies.length - 1].text, E.HANDOFF_DEFAULT);
}

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

// the 5th failure hits MAX_ORDER_ATTEMPTS: S355 HANDS OFF (never an email address), no handoff walk
let cap = E.advance(DEF, { current_step: 'status1', status: 'active', context: { order_attempts: 4 } }, { kind: 'action_result', ok: false });
assert.equal(cap.state.status, 'handed_off');
assert.match(cap.replies[0].text, /support team|human/i);

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

// ── S355: list-style menu renders rows with descriptions ──
{
  const LDEF = { entry: 'm', steps: {
    m: { type: 'menu', style: 'list', list_button: 'Topics', text: 'Pick a topic',
         buttons: [{ id: 'b_ship', label: 'Shipping', description: 'How long delivery takes' }, { id: 'b_war', label: 'Warranty' }],
         outcomes: { b_ship: 'e', b_war: 'e', fallback: 'e' } },
    e: { type: 'end', outcomes: {} },
  } };
  const r = E.advance(LDEF, fresh(), { kind: 'open' });
  assert.equal(r.replies[0].style, 'list');
  assert.equal(r.replies[0].list_button, 'Topics');
  assert.deepEqual(r.replies[0].buttons[0], { id: 'b_ship', label: 'Shipping', description: 'How long delivery takes' });
  assert.equal(r.replies[0].buttons[1].description, null);
  // default style is buttons, list_button null
  const BDEF = { entry: 'm', steps: { m: { type: 'menu', text: 'x', buttons: [{ id: 'a', label: 'A' }], outcomes: { a: 'e', fallback: 'e' } }, e: { type: 'end', outcomes: {} } } };
  assert.equal(E.advance(BDEF, fresh(), { kind: 'open' }).replies[0].style, 'buttons');
}

// ── S355: attempt cap hands off (never "email support"); expire; resume ──
{
  const s = { current_step: 'status1', status: 'active', context: { order_attempts: E.MAX_ORDER_ATTEMPTS - 1, identity: { phone: '9876543210' }, order_number: '#LOT1' } };
  const r = E.advance(DEF, s, { kind: 'action_result', ok: false, data: {} });
  assert.equal(r.state.status, 'handed_off');
  assert.ok(r.effects.some((e) => e.type === 'handoff'));
  assert.ok(!/support@/.test(r.replies.map((x) => x.text).join(' ')));
  const DEF2 = JSON.parse(JSON.stringify(DEF)); DEF2.steps.status1.text_exhausted = 'Passing you to a person.';
  assert.equal(E.advance(DEF2, s, { kind: 'action_result', ok: false, data: {} }).replies[0].text, 'Passing you to a person.');
  // expire: ends silently
  const x = E.advance(DEF, { current_step: 'menu1', status: 'active', context: {} }, { kind: 'expire' });
  assert.equal(x.state.status, 'ended'); assert.equal(x.replies.length, 0);
  // resume from a step's next handle
  const y = E.advance(DEF, { current_step: 'welcome', status: 'active', context: {} }, { kind: 'resume', from: 'welcome' });
  assert.equal(y.state.current_step, 'ident');
}

// ── Stale chip: a tap from a step OTHER than the current one is read as its typed label ──
// Live bots reuse button ids across menus (`b_opt1` on 5 menus), so an old chip's id matched
// against the current menu used to fire whatever option shared it.
{
  const SDEF = { entry: 'M1', steps: {
    M1: { type: 'menu', text: 'Topics', buttons: [{ id: 'b_opt1', label: 'Shipping' }, { id: 'b_opt3', label: 'Returns' }],
          outcomes: { b_opt1: 'M2', b_opt3: 'M2', fallback: 'h' } },
    M2: { type: 'menu', text: 'Which?', buttons: [{ id: 'b_opt1', label: 'Warranty' }, { id: 'b_opt2', label: 'Returns' }],
          outcomes: { b_opt1: 'warranty', b_opt2: 'returns', fallback: 'h' } },
    warranty: { type: 'end', text: 'W', outcomes: {} },
    returns:  { type: 'end', text: 'R', outcomes: {} },
    h: { type: 'handoff', outcomes: {} },
  } };
  const atM2 = () => ({ current_step: 'M2', status: 'active', context: {} });
  // colliding id from M1 at M2 -> typed "Shipping" -> a miss, NOT M2's b_opt1 (Warranty)
  let s = E.advance(SDEF, atM2(), { kind: 'button', buttonId: 'b_opt1', stepId: 'M1', text: 'Shipping' });
  assert.equal(s.state.current_step, 'M2');
  assert.equal(s.state.context.menu_misses, 1);
  assert.ok(!s.replies.some((x) => x.text === 'W'));
  assert.deepEqual(s.replies[1].buttons.map((b) => b.id), ['b_opt1', 'b_opt2']);   // menu re-shown
  // stale chip whose LABEL is a current option -> typed semantics take that option (id b_opt3 is not on M2)
  s = E.advance(SDEF, atM2(), { kind: 'button', buttonId: 'b_opt3', stepId: 'M1', text: 'Returns' });
  assert.deepEqual(s.replies.map((x) => x.text), ['R']);
  // current-step tap -> unchanged id match
  s = E.advance(SDEF, atM2(), { kind: 'button', buttonId: 'b_opt1', stepId: 'M2', text: 'Warranty' });
  assert.deepEqual(s.replies.map((x) => x.text), ['W']);
  // no stepId (old cached widget / in-flight message) -> today's id match, whatever the label says
  s = E.advance(SDEF, atM2(), { kind: 'button', buttonId: 'b_opt1', text: 'Shipping' });
  assert.deepEqual(s.replies.map((x) => x.text), ['W']);
  // a stale tap at a COLLECT is its label as text: same validation as a typed reply
  const c = E.advance(DEF, { current_step: 'collect_order', status: 'active', context: {} }, { kind: 'button', buttonId: 'b_track', stepId: 'menu1', text: 'Track my order' });
  assert.equal(c.state.current_step, 'collect_order'); assert.equal(c.state.context.collect_misses, 1);
  // a stale tap at an ACTION step restates, exactly as typed text does
  const a = E.advance(DEF, { current_step: 'status1', status: 'active', context: {} }, { kind: 'button', buttonId: 'b_track', stepId: 'menu1', text: 'Track my order' });
  assert.equal(a.state.current_step, 'status1'); assert.equal(a.effects.length, 0);
  // terminal: a handed-off bot stays silent for a stale tap too
  const t = E.advance(DEF, { current_step: 'handoff1', status: 'handed_off', context: {} }, { kind: 'button', buttonId: 'b_agent', stepId: 'menu1', text: 'Agent' });
  assert.equal(t.replies.length, 0); assert.equal(t.state.status, 'handed_off');
}

console.log('bot-engine tests OK');
