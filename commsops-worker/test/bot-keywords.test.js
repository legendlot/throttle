// S355 — keyword routing on the FIRST message and at a FAILED collect; collect fallback cap.
// Run: node test/bot-keywords.test.js
const assert = require('assert');
const E = require('../src/bot-engine.js');

const DEF = { entry: 'welcome', keywords: [
    { match: ['track', 'where is my order', 'status'], target: 'ask_order' },
    { match: ['agent', 'human'], target: 'handoff1' },
  ], steps: {
  welcome:   { type: 'menu', text: 'Hi! Pick one', buttons: [{ id: 'b_track', label: 'Track my order' }, { id: 'b_agent', label: 'Agent' }],
               outcomes: { b_track: 'ask_order', b_agent: 'handoff1', fallback: 'handoff1' } },
  ask_order: { type: 'collect', field: 'order_number', prompt: 'Order number?', outcomes: { next: 'status1', fallback: 'handoff1' } },
  status1:   { type: 'action', kind: 'order_status', outcomes: { found: 'done', not_found: 'handoff1' } },
  handoff1:  { type: 'handoff', outcomes: {} },
  done:      { type: 'end', outcomes: {} },
} };
const fresh = () => ({ current_step: null, status: 'active', context: {} });

// matchKeyword: case-insensitive, whole word / phrase, first rule wins
assert.equal(E.matchKeyword(DEF, 'Where IS my order please'), 'ask_order');
assert.equal(E.matchKeyword(DEF, 'I need a HUMAN'), 'handoff1');
assert.equal(E.matchKeyword(DEF, 'tracking'), null);            // 'track' is not a whole word here
assert.equal(E.matchKeyword(DEF, 'hi'), null);
assert.equal(E.matchKeyword({ steps: {} }, 'track'), null);      // no keywords declared

// open WITH text: keyword skips the greeting menu
let r = E.advance(DEF, fresh(), { kind: 'open', text: 'where is my order' });
assert.equal(r.state.current_step, 'ask_order');
assert.deepEqual(r.replies.map((x) => x.text), ['Order number?']);

// open with a non-keyword text or no text: greeting as before
r = E.advance(DEF, fresh(), { kind: 'open', text: 'hi' });
assert.equal(r.state.current_step, 'welcome');
r = E.advance(DEF, fresh(), { kind: 'open' });
assert.equal(r.state.current_step, 'welcome');

// keyword at a FAILED collect escapes; valid input ignores keywords
r = E.advance(DEF, { current_step: 'ask_order', status: 'active', context: {} }, { kind: 'text', text: 'agent' });
assert.equal(r.state.status, 'handed_off');
r = E.advance(DEF, { current_step: 'ask_order', status: 'active', context: {} }, { kind: 'text', text: '#LOT48622' });
assert.equal(r.state.current_step, 'status1');
assert.equal(r.state.context.order_number, '#LOT48622');

// collect miss cap: two non-keyword invalid inputs -> fallback (handoff)
let s = { current_step: 'ask_order', status: 'active', context: {} };
r = E.advance(DEF, s, { kind: 'text', text: 'zzz' });
assert.equal(r.state.current_step, 'ask_order'); assert.equal(r.state.context.collect_misses, 1);
r = E.advance(DEF, r.state, { kind: 'text', text: '' });     // media -> empty text counts as a miss
assert.equal(r.state.status, 'handed_off');

// a collect with NO fallback wired (the live web bot's shape) must hand off, never go silent
const NOFB = { entry: 'c', steps: { c: { type: 'collect', field: 'order_number', prompt: 'Order?', outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} } } };
r = E.advance(NOFB, { current_step: 'c', status: 'active', context: { collect_misses: 1 } }, { kind: 'text', text: 'zzz' });
assert.equal(r.state.status, 'handed_off');
assert.ok(r.effects.some((e) => e.type === 'handoff'));
assert.ok(r.replies.length >= 1 && r.replies[r.replies.length - 1].text.length > 0);

// keyword is NOT consulted at a menu — free text that is a keyword still counts as a miss
// (R4: 'human', not 'agent' — 'agent' equals the button LABEL 'Agent' and would resolve by label)
r = E.advance(DEF, { current_step: 'welcome', status: 'active', context: {} }, { kind: 'text', text: 'human' });
assert.equal(r.state.current_step, 'welcome'); assert.equal(r.state.context.menu_misses, 1);

// Fix round 1 finding 1: collect_misses must reset on ENTERING a collect via a keyword escape —
// a miss at collect A, then keyword-escape to collect B, then ONE typo at B must re-prompt
// (misses 1), not hand off (it would if B inherited A's miss count).
{
  const TWO_COLLECTS = { entry: 'a', keywords: [{ match: ['help me'], target: 'b' }], steps: {
    a: { type: 'collect', field: 'order_number', prompt: 'A?', outcomes: { next: 'e', fallback: 'h' } },
    b: { type: 'collect', field: 'order_number', prompt: 'B?', outcomes: { next: 'e', fallback: 'h' } },
    e: { type: 'end', outcomes: {} }, h: { type: 'handoff', outcomes: {} },
  } };
  // one prior miss at A (an invalid order number that does NOT match any keyword)
  let s = E.advance(TWO_COLLECTS, { current_step: 'a', status: 'active', context: {} }, { kind: 'text', text: 'zzz' }).state;
  assert.equal(s.current_step, 'a'); assert.equal(s.context.collect_misses, 1);
  // keyword escape from A to collect B (input is invalid for order_number AND matches a keyword)
  let r = E.advance(TWO_COLLECTS, s, { kind: 'text', text: 'help me please' });
  assert.equal(r.state.current_step, 'b');
  assert.equal(r.state.context.collect_misses, 0, 'entering B must reset collect_misses');
  // one typo at B: must re-prompt (misses 1), NOT hand off
  r = E.advance(TWO_COLLECTS, r.state, { kind: 'text', text: 'zzz' });
  assert.equal(r.state.current_step, 'b');
  assert.equal(r.state.context.collect_misses, 1);
  assert.equal(r.state.status, 'active');
}

// finding 5 coverage: keyword_empty lint
{
  const kerr2 = E.validateBotDef({ entry: 'e', keywords: [{ match: [], target: 'e' }], steps: { e: { type: 'end', outcomes: {} } } });
  assert.ok(kerr2.some((e) => e.code === 'keyword_empty'), JSON.stringify(kerr2));
}

// lint: collect.fallback must be wired
const errs = E.validateBotDef({ entry: 'c', steps: { c: { type: 'collect', field: 'order_number', outcomes: { next: 'e' } }, e: { type: 'end', outcomes: {} } } });
assert.ok(errs.some((e) => e.code === 'fallback_unwired' && e.stepId === 'c'), JSON.stringify(errs));
// lint: keyword target must exist
const kerr = E.validateBotDef({ entry: 'e', keywords: [{ match: ['x'], target: 'nope' }], steps: { e: { type: 'end', outcomes: {} } } });
assert.ok(kerr.some((e) => e.code === 'keyword_target_missing'), JSON.stringify(kerr));
console.log('bot-keywords ok');
