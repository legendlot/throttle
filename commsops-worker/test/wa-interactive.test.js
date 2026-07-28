// S241 — interactive SESSION messages (reply buttons, no template). The gap that blocked
// the COD→prepaid cancel branch: its "Are you sure?" confirm is an interactive session
// message, and the adapter previously supported only `template` and `text`.
const { test } = require('node:test');
const assert = require('node:assert');
const WA = require('../src/adapters/whatsapp.js');
const { renderWhatsapp } = require('../src/render.js');

function capture() {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.TEST' }] }) };
  };
  return { calls, restore: () => { global.fetch = real; } };
}
const env = { WA_TOKEN: 't' };
const base = { to: '+919999999999', phone_number_id: 'P1' };

test('renderWhatsapp emits interactive mode when the step supplies buttons', () => {
  // tokens must be DECLARED — undeclared ones deliberately pass through unsubstituted.
  const r = renderWhatsapp({ content: { text: 'Cancel order {order_no}?' },
      variables: [{ token: 'order_no', source: 'constant', field: 'order_no' }] },
    { constants: { order_no: '44818' }, interactiveButtons: [
      { id: 'yes', text: 'Yes, Cancel' }, { id: 'no', text: 'No, Confirm Order' }] });
  assert.equal(r.mode, 'interactive');
  assert.equal(r.text, 'Cancel order 44818?');
  assert.deepEqual(r.buttons.map((b) => b.id), ['yes', 'no']);
});

test('no buttons still renders plain text — a misconfigured node says something', () => {
  const r = renderWhatsapp({ content: { text: 'hi' }, variables: [] }, { interactiveButtons: [] });
  assert.equal(r.mode, 'text');
});

test('adapter builds Meta interactive/button payload with stable reply ids', async () => {
  const c = capture();
  try {
    const res = await WA.send({ ...base, mode: 'interactive', window_open: true,
      text: 'Are you sure?', buttons: [{ id: 'yes', text: 'Yes, Cancel' }, { id: 'no', text: 'No, Confirm Order' }] }, env);
    assert.equal(res.status, 'sent');
    const p = c.calls[0];
    assert.equal(p.type, 'interactive');
    assert.equal(p.interactive.type, 'button');
    assert.equal(p.interactive.body.text, 'Are you sure?');
    assert.deepEqual(p.interactive.action.buttons.map((b) => b.reply.id), ['yes', 'no']);
    // the id is what comes back on interactive.button_reply.id and what the graph routes on
    assert.deepEqual(p.interactive.action.buttons.map((b) => b.reply.title), ['Yes, Cancel', 'No, Confirm Order']);
  } finally { c.restore(); }
});

test('interactive is WINDOW-GATED like text — refused when the window is shut', async () => {
  const c = capture();
  try {
    const res = await WA.send({ ...base, mode: 'interactive', window_open: false,
      text: 'x', buttons: [{ id: 'a', text: 'A' }] }, env);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'window_closed');
    assert.equal(c.calls.length, 0, 'must not reach Meta');
  } finally { c.restore(); }
});

test('Meta caps: 3 buttons max, titles truncated to 20 chars (never a silent 400)', async () => {
  const c = capture();
  try {
    await WA.send({ ...base, mode: 'interactive', window_open: true, text: 'x',
      buttons: [{ id: 'a', text: 'A button title that is far too long' },
                { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }] }, env);
    const btns = c.calls[0].interactive.action.buttons;
    assert.equal(btns.length, 3);
    assert.equal(btns[0].reply.title.length, 20);
  } finally { c.restore(); }
});

test('interactive with no buttons fails loudly rather than sending a blank prompt', async () => {
  const c = capture();
  try {
    const res = await WA.send({ ...base, mode: 'interactive', window_open: true, text: 'x', buttons: [] }, env);
    assert.equal(res.status, 'failed');
    assert.equal(res.reason, 'interactive_no_buttons');
  } finally { c.restore(); }
});

test('template mode is untouched by the new branch', async () => {
  const c = capture();
  try {
    const res = await WA.send({ ...base, mode: 'template',
      template: { name: 'lot_cod_confirm_01', language: 'en', components: [] } }, env);
    assert.equal(res.status, 'sent');
    assert.equal(c.calls[0].type, 'template');
    assert.equal(c.calls[0].template.name, 'lot_cod_confirm_01');
  } finally { c.restore(); }
});
