// Node unit tests for the WhatsApp adapter / render / template / gate logic (M14 / WS-A).
// Run: node test/wa.test.js   (Node 18+ — global fetch/crypto/TextEncoder/atob/btoa)
// Pure-function coverage; no network (fetch is stubbed per-case).

const assert = require('assert');
const wa = require('../src/adapters/whatsapp.js');
const { renderWhatsapp } = require('../src/render.js');
const WATPL = require('../src/wa-templates.js');
const waHook = require('../src/wa-webhooks.js');
const A = require('../src/auth.js');
const { runGate, _clearSettingsCache } = require('../src/gate.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ', name); },
    (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
}
const realFetch = global.fetch;
function stubFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = realFetch; }

(async () => {
  // ── toWaId ──
  await t('toWaId strips non-digits', () => {
    assert.equal(wa.toWaId('+91 98802 12323'), '919880212323');
    assert.equal(wa.toWaId('919880212323'), '919880212323');
    assert.equal(wa.toWaId(null), '');
  });

  // ── adapter.send guards ──
  await t('send fails without recipient / phone_number_id / token', async () => {
    assert.equal((await wa.send({ mode: 'text', text: 'hi' }, {})).reason, 'no_recipient');
    assert.equal((await wa.send({ mode: 'text', text: 'hi', to: '9199' }, {})).reason, 'no_phone_number_id');
    assert.equal((await wa.send({ mode: 'text', text: 'hi', to: '9199', phone_number_id: 'P' }, {})).reason, 'no_wa_token');
  });

  await t('send text refuses when window closed', async () => {
    const r = await wa.send({ mode: 'text', text: 'hi', to: '9199', phone_number_id: 'P', window_open: false },
      { WA_TOKEN: 'x' });
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'window_closed');
  });

  await t('send text success inside window', async () => {
    let captured;
    stubFetch(async (u, opts) => { captured = { u, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.ABC' }] }) }; });
    const r = await wa.send({ mode: 'text', text: 'hello', to: '919880212323', phone_number_id: 'PID', window_open: true },
      { WA_TOKEN: 'tok' });
    restoreFetch();
    assert.equal(r.status, 'sent');
    assert.equal(r.provider_message_id, 'wamid.ABC');
    assert.ok(captured.u.includes('/PID/messages'));
    assert.equal(captured.body.type, 'text');
    assert.equal(captured.body.to, '919880212323');
    assert.equal(captured.body.text.body, 'hello');
  });

  await t('send template success (any time, no window needed)', async () => {
    let captured;
    stubFetch(async (u, opts) => { captured = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.T' }] }) }; });
    const r = await wa.send({ mode: 'template', to: '919880212323', phone_number_id: 'PID', window_open: false,
      template: { name: 'order_update', language: 'en', components: [{ type: 'body', parameters: [{ type: 'text', text: 'X' }] }] } },
      { WA_TOKEN: 'tok' });
    restoreFetch();
    assert.equal(r.status, 'sent');
    assert.equal(captured.type, 'template');
    assert.equal(captured.template.name, 'order_update');
    assert.equal(captured.template.language.code, 'en');
  });

  await t('send surfaces Graph error code', async () => {
    stubFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }) }));
    const r = await wa.send({ mode: 'text', text: 'hi', to: '9199', phone_number_id: 'P', window_open: true }, { WA_TOKEN: 'x' });
    restoreFetch();
    assert.equal(r.status, 'failed');
    assert.ok(r.reason.startsWith('wa_131047:'));
  });

  // ── parseStatusWebhook ──
  await t('parseStatusWebhook maps statuses + cost + reasons', () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [
      { id: 'm1', status: 'delivered', timestamp: '1700000000', recipient_id: '9199', pricing: { billable: true, category: 'utility' } },
      { id: 'm2', status: 'read', timestamp: '1700000100', recipient_id: '9199' },
      { id: 'm3', status: 'failed', timestamp: '1700000200', errors: [{ code: 131026, title: 'Undeliverable' }] },
    ] } }] }] };
    const u = wa.parseStatusWebhook(payload);
    assert.equal(u.length, 3);
    assert.equal(u[0].canonical_status, 'delivered');
    assert.equal(u[0].engagement_event, 'whatsapp_delivered');
    assert.equal(u[0].cost, 1);
    assert.equal(u[1].canonical_status, 'opened');   // WA read → opened
    assert.equal(u[1].engagement_event, 'whatsapp_read');
    assert.equal(u[2].canonical_status, 'failed');
    assert.ok(u[2].reason.startsWith('wa_131026:'));
    assert.equal(u[2].cost, null);
  });

  // ── parseInbound ──
  await t('parseInbound normalizes text/button/interactive/media', () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'PID' },
      contacts: [{ wa_id: '9199', profile: { name: 'Raghav' } }],
      messages: [
        { id: 'i1', from: '9199', type: 'text', timestamp: '1700000000', text: { body: 'where is my order' } },
        { id: 'i2', from: '9199', type: 'button', timestamp: '1700000001', button: { text: 'Track' } },
        { id: 'i3', from: '9199', type: 'interactive', timestamp: '1700000002', interactive: { button_reply: { title: 'Yes' } } },
        { id: 'i4', from: '9199', type: 'image', timestamp: '1700000003', image: { id: 'MID', mime_type: 'image/jpeg', caption: 'broken wheel' } },
      ] } }] }] };
    const inb = wa.parseInbound(payload);
    assert.equal(inb.length, 4);
    assert.equal(inb[0].text, 'where is my order');
    assert.equal(inb[0].name, 'Raghav');
    assert.equal(inb[0].phone_number_id, 'PID');
    assert.equal(inb[1].text, 'Track');
    assert.equal(inb[2].text, 'Yes');
    assert.equal(inb[3].media.mime_type, 'image/jpeg');
    assert.equal(inb[3].text, 'broken wheel');
  });

  // ── WS-B: button taps carry a branchable id ──
  await t('parseInbound surfaces button_id from both tap shapes', () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'PID' },
      messages: [
        // template quick-reply WITH an explicit payload (what we send for J3)
        { id: 'b1', from: '9199', type: 'button', timestamp: '1700000000', button: { text: 'Make Payment', payload: 'pay_now' } },
        // template quick-reply with NO payload param — Meta echoes the LABEL
        { id: 'b2', from: '9199', type: 'button', timestamp: '1700000001', button: { text: 'Cancel Order' } },
        // free-form interactive reply — author-defined id
        { id: 'b3', from: '9199', type: 'interactive', timestamp: '1700000002', interactive: { button_reply: { id: 'confirm_cod', title: 'Confirm COD Order' } } },
        // a plain text message is not a reply signal
        { id: 'b4', from: '9199', type: 'text', timestamp: '1700000003', text: { body: 'hello' } },
      ] } }] }] };
    const inb = wa.parseInbound(payload);
    assert.equal(inb[0].button_id, 'pay_now');
    assert.equal(inb[1].button_id, 'Cancel Order');   // label fallback
    assert.equal(inb[2].button_id, 'confirm_cod');
    assert.equal(inb[2].text, 'Confirm COD Order');
    assert.equal(inb[3].button_id, null);
  });

  await t('handleInbound emits whatsapp_reply ALONGSIDE whatsapp_inbound on a button tap', async () => {
    const orig = A.sbComms;
    const events = [];
    A.sbComms = async (path, env, init) => {
      if (path.startsWith('/rest/v1/rpc/resolve_identity')) return { ok: true, data: 'prof-1' };
      if (path.startsWith('/rest/v1/events')) {
        events.push(JSON.parse(init.body));
        return { ok: true, data: [{ id: `ev-${events.length}` }] };
      }
      return { ok: true, data: [] };   // wa_windows upsert, waits matcher, journeys
    };
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'PID' },
      messages: [
        { id: 'b1', from: '919880212323', type: 'button', timestamp: '1700000000', button: { text: 'Make Payment', payload: 'pay_now' } },
        { id: 't1', from: '919880212323', type: 'text', timestamp: '1700000001', text: { body: 'hi' } },
      ] } }] }] };
    await waHook.handleInbound({}, payload);
    const names = events.map((e) => e.name);
    // the tap yields BOTH events; the plain text yields only the generic one
    assert.deepEqual(names, ['whatsapp_inbound', 'whatsapp_reply', 'whatsapp_inbound']);
    const reply = events[1];
    assert.equal(reply.properties.button_id, 'pay_now');
    assert.equal(reply.properties.button_text, 'Make Payment');
    assert.equal(reply.idempotency_key, 'wa:reply:b1');   // distinct from wa:inbound:b1
    assert.equal(events[0].idempotency_key, 'wa:inbound:b1');
    A.sbComms = orig;
  });

  // ── renderWhatsapp ──
  await t('renderWhatsapp text mode applies tokens', () => {
    const tpl = { content: { text_body: 'Hi {name}, your order {order} shipped.' },
      variables: [{ token: 'name', source: 'profile', field: 'first_name' }, { token: 'order', source: 'constant' }] };
    const r = renderWhatsapp(tpl, { profile: { attributes: { first_name: 'Asha' } }, constants: { order: '#40582' } });
    assert.equal(r.mode, 'text');
    assert.equal(r.text, 'Hi Asha, your order #40582 shipped.');
  });

  await t('renderWhatsapp template mode builds components from mapping', () => {
    const tpl = { language: 'en', content: { meta_name: 'order_update', language: 'en',
      mapping: [{ component: 'body', token: 'name' }, { component: 'body', token: 'order' }, { component: 'button', sub_type: 'url', index: 0, token: 'trk' }] },
      variables: [{ token: 'name', source: 'constant' }, { token: 'order', source: 'constant' }, { token: 'trk', source: 'constant' }] };
    const r = renderWhatsapp(tpl, { constants: { name: 'Asha', order: '#40582', trk: 'abc' } });
    assert.equal(r.mode, 'template');
    assert.equal(r.template.name, 'order_update');
    const body = r.template.components.find((c) => c.type === 'body');
    assert.deepEqual(body.parameters.map((p) => p.text), ['Asha', '#40582']);
    const btn = r.template.components.find((c) => c.type === 'button');
    assert.equal(btn.sub_type, 'url'); assert.equal(btn.index, '0'); assert.equal(btn.parameters[0].text, 'abc');
  });

  await t('renderWhatsapp throws on unresolved variable', () => {
    const tpl = { content: { text_body: 'Hi {name}' }, variables: [{ token: 'name', source: 'profile', field: 'nope' }] };
    assert.throws(() => renderWhatsapp(tpl, { profile: { attributes: {} } }), /unresolved_variables:name/);
  });

  // ── template submission builder ──
  await t('buildComponents assembles header/body/footer/buttons with examples', () => {
    const comps = WATPL.buildComponents({
      header: 'Order {{1}}', body: 'Hi {{1}}, tracking {{2}}', footer: 'Legend of Toys',
      buttons: [{ type: 'URL', text: 'Track', url: 'https://x/{{1}}' }],
      mapping: [{ component: 'header', pos: 0, example: 'ORD1' }, { component: 'body', pos: 0, example: 'Asha' }, { component: 'body', pos: 1, example: 'TRK9' }],
    });
    const body = comps.find((c) => c.type === 'BODY');
    assert.deepEqual(body.example.body_text, [['Asha', 'TRK9']]);
    const header = comps.find((c) => c.type === 'HEADER');
    assert.deepEqual(header.example.header_text, ['ORD1']);
    assert.ok(comps.find((c) => c.type === 'FOOTER'));
    assert.ok(comps.find((c) => c.type === 'BUTTONS'));
  });

  await t('buildComponents emits a MEDIA header with an upload handle, not text', () => {
    const comps = WATPL.buildComponents({
      header_format: 'IMAGE', header: 'ignored when media', header_handle: 'h:ABC123',
      body: 'Hi {{1}}', mapping: [{ component: 'body', pos: 1, example: 'Asha' }],
    });
    const header = comps.find((c) => c.type === 'HEADER');
    assert.equal(header.format, 'IMAGE');
    assert.equal(header.text, undefined);                       // media headers carry no text
    assert.deepEqual(header.example, { header_handle: ['h:ABC123'] });
  });

  await t('buildComponents substitutes a URL-button example (Meta rejects without one)', () => {
    const comps = WATPL.buildComponents({
      body: 'Hi',
      buttons: [
        { type: 'URL', text: 'Track', url: 'https://go.example.com/{{1}}', example_suffix: 'a1b2c3' },
        { type: 'QUICK_REPLY', text: 'Cancel Order' },
      ],
    });
    const btns = comps.find((c) => c.type === 'BUTTONS').buttons;
    assert.deepEqual(btns[0].example, ['https://go.example.com/a1b2c3']);
    assert.equal(btns[0].example_suffix, undefined);             // internal-only, never sent to Meta
    assert.equal(btns[1].example, undefined);                    // quick-reply takes no example
  });

  await t('buildComponents takes a URL-button example from the mapping index', () => {
    const comps = WATPL.buildComponents({
      body: 'Hi',
      buttons: [{ type: 'QUICK_REPLY', text: 'No' }, { type: 'URL', text: 'Go', url: 'https://x.io/{{1}}' }],
      mapping: [{ component: 'button', index: 1, token: 'code', example: 'zz9' }],
    });
    const btns = comps.find((c) => c.type === 'BUTTONS').buttons;
    assert.deepEqual(btns[1].example, ['https://x.io/zz9']);     // index 1 → the 2nd button
  });

  await t('wabaFor prefers the template pin over the env default', () => {
    assert.equal(WATPL.wabaFor({ WA_WABA_ID: 'ENV' }, { content: { waba_id: 'PINNED' } }), 'PINNED');
    assert.equal(WATPL.wabaFor({ WA_WABA_ID: 'ENV' }, { content: {} }), 'ENV');
    assert.equal(WATPL.wabaFor({}, { content: {} }), null);
  });

  await t('renderWhatsapp sends a media header component from header_media_url', () => {
    const r = renderWhatsapp({
      language: 'en',
      variables: [{ token: 'first_name', source: 'profile', field: 'first_name' }],
      content: {
        meta_name: 'lot_x', header_format: 'IMAGE',
        header_media_url: 'https://cdn.example.com/hero.jpg',
        body: 'Hi {{1}}', mapping: [{ component: 'body', pos: 1, token: 'first_name' }],
      },
    }, { profile: { first_name: 'Asha' } });
    const header = r.template.components.find((c) => c.type === 'header');
    assert.deepEqual(header.parameters, [{ type: 'image', image: { link: 'https://cdn.example.com/hero.jpg' } }]);
  });

  await t('categoryFor derives from purpose + honours override', () => {
    assert.equal(WATPL.categoryFor({ purpose: 'marketing', content: {} }), 'MARKETING');
    assert.equal(WATPL.categoryFor({ purpose: 'utility', content: {} }), 'UTILITY');
    assert.equal(WATPL.categoryFor({ purpose: 'marketing', content: { category: 'authentication' } }), 'AUTHENTICATION');
  });

  // ── webhook signature ──
  await t('verifySignature accepts a correct HMAC and rejects a wrong one', async () => {
    const secret = 'appsecret';
    const bodyStr = JSON.stringify({ object: 'whatsapp_business_account' });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyStr));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    assert.equal(await waHook.verifySignature(secret, `sha256=${hex}`, bodyStr), true);
    assert.equal(await waHook.verifySignature(secret, `sha256=${'0'.repeat(64)}`, bodyStr), false);
    assert.equal(await waHook.verifySignature(secret, null, bodyStr), false);
  });

  // ── gate WA channel rule (stub sbComms) ──
  await t('gate: WA text with closed window → window_closed; template → pass', async () => {
    const orig = A.sbComms;
    A.sbComms = async (path) => {
      if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [{ test_mode: false, test_mode_allow: [], quiet_hours_start: 21, quiet_hours_end: 9, frequency_cap_per_day: 3, frequency_cap_window_hours: 24 }] };
      if (path.startsWith('/rest/v1/suppressions')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    _clearSettingsCache();
    const closed = await runGate({}, { channel: 'whatsapp', purpose: 'utility', to: '919880212323', wa: { mode: 'text', window_open: false } });
    assert.equal(closed.pass, false); assert.equal(closed.reason, 'window_closed');
    const tmpl = await runGate({}, { channel: 'whatsapp', purpose: 'utility', to: '919880212323', wa: { mode: 'template', window_open: false, hasTemplate: true } });
    assert.equal(tmpl.pass, true);
    const badAddr = await runGate({}, { channel: 'whatsapp', purpose: 'utility', to: '12', wa: { mode: 'template' } });
    assert.equal(badAddr.reason, 'invalid_address');
    A.sbComms = orig;
  });

  await t('gate: WA text open window → pass', async () => {
    const orig = A.sbComms;
    A.sbComms = async (path) => {
      if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [{ test_mode: false, test_mode_allow: [] }] };
      return { ok: true, data: [] };
    };
    _clearSettingsCache();
    const openW = await runGate({}, { channel: 'whatsapp', purpose: 'utility', to: '919880212323', wa: { mode: 'text', window_open: true } });
    assert.equal(openW.pass, true);
    A.sbComms = orig;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
