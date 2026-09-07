// S355 — WhatsApp interactive LIST mode at render, adapter, gate and send-ctx sites.
// Run: node test/wa-list.test.js
const assert = require('assert');
const wa = require('../src/adapters/whatsapp.js');
const { renderWhatsapp } = require('../src/render.js');
const A = require('../src/auth.js');
const { runGate, _clearSettingsCache } = require('../src/gate.js');
let pass = 0, fail = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ', name); }, (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); }); }
const realFetch = global.fetch;
(async () => {
  const tpl = { content: { text_body: 'Pick a topic' } };
  await t('render picks list mode when interactiveList is present', () => {
    const r = renderWhatsapp(tpl, { interactiveList: { button: 'Topics', rows: [{ id: 'bot:m:b_ship', title: 'Shipping', description: 'How long' }] } });
    assert.equal(r.mode, 'list'); assert.equal(r.button, 'Topics'); assert.equal(r.rows[0].id, 'bot:m:b_ship');
  });
  await t('render still prefers interactive buttons when both given', () => {
    const r = renderWhatsapp(tpl, { interactiveButtons: [{ id: 'a', text: 'A' }], interactiveList: { rows: [{ id: 'x', title: 'X' }] } });
    assert.equal(r.mode, 'interactive');
  });
  await t('adapter builds a Meta list payload with caps applied', async () => {
    let sent = null;
    global.fetch = async (u, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; };
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `bot:m:b${i}`, title: 'T'.repeat(30), description: 'D'.repeat(80) }));
    const r = await wa.send({ mode: 'list', text: 'Pick', button: 'A very long button title indeed', rows, to: '919999999999', phone_number_id: 'P', window_open: true }, { WA_TOKEN: 'tok' });
    global.fetch = realFetch;
    assert.equal(r.status, 'sent');
    assert.equal(sent.type, 'interactive'); assert.equal(sent.interactive.type, 'list');
    assert.equal(sent.interactive.action.button.length, 20);
    const got = sent.interactive.action.sections[0].rows;
    assert.equal(got.length, 10); assert.equal(got[0].title.length, 24); assert.equal(got[0].description.length, 72);
  });
  await t('adapter refuses a list outside the window and with no rows', async () => {
    assert.equal((await wa.send({ mode: 'list', text: 'x', rows: [{ id: 'a', title: 'A' }], to: '9199', phone_number_id: 'P', window_open: false }, { WA_TOKEN: 't' })).reason, 'window_closed');
    assert.equal((await wa.send({ mode: 'list', text: 'x', rows: [], to: '9199', phone_number_id: 'P', window_open: true }, { WA_TOKEN: 't' })).reason, 'list_no_rows');
  });
  await t('adapter fails closed on an unknown render mode', async () => {
    assert.equal((await wa.send({ mode: 'carousel', text: 'x', to: '9199', phone_number_id: 'P', window_open: true }, { WA_TOKEN: 't' })).reason, 'unknown_render_mode');
  });
  await t('gate refuses an out-of-window list like text/interactive', async () => {
    // Same stub as test/wa.test.js:337-352 — without it getSettings falls back to test_mode:true
    // and the gate returns test_mode_blocked at step 0, never reaching the window check.
    const orig = A.sbComms;
    A.sbComms = async (path) => {
      if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [{ test_mode: false, test_mode_allow: [], quiet_hours_start: 21, quiet_hours_end: 9, frequency_cap_per_day: 3, frequency_cap_window_hours: 24 }] };
      if (path.startsWith('/rest/v1/suppressions')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    _clearSettingsCache();
    const g = await runGate({}, { channel: 'whatsapp', purpose: 'utility', to: '919880212323', wa: { mode: 'list', window_open: false } });
    assert.equal(g.pass, false); assert.equal(g.reason, 'window_closed');
    const open = await runGate({}, { channel: 'whatsapp', purpose: 'utility', to: '919880212323', wa: { mode: 'list', window_open: true } });
    assert.equal(open.pass, true);
    A.sbComms = orig;
  });
  console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
})();
