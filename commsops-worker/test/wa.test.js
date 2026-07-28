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
const { waWindowOpen } = require('../src/send.js');

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

  await t('cost: billable:false service message is NOT costed; absent billable is unpriced', () => {
    const mk = (pricing) => ({ entry: [{ changes: [{ value: { statuses: [{ id: 'w', status: 'delivered', timestamp: '1700000000', pricing }] } }] }] });
    assert.strictEqual(wa.parseStatusWebhook(mk({ billable: false, category: 'service' }))[0].cost, null);
    assert.strictEqual(wa.parseStatusWebhook(mk({ category: 'utility' }))[0].cost, null);          // tri-state: absent ≠ billable
    assert.strictEqual(wa.parseStatusWebhook(mk({ billable: true, category: 'marketing' }))[0].cost, 1);
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

  await t('handleStatuses persists Meta pricing (category + tri-state billable)', async () => {
    const orig = A.sbComms;
    const patches = [];
    A.sbComms = async (path, env, init) => {
      if (path.startsWith('/rest/v1/messages?provider=eq.whatsapp'))
        return { ok: true, data: [{ id: 'msg-1', profile_id: 'prof-1', channel: 'whatsapp' }] };
      if (path.startsWith('/rest/v1/messages?id=eq.')) { patches.push(JSON.parse(init.body)); return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    const mk = (id, pricing) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      statuses: [{ id, status: 'delivered', timestamp: '1700000000', recipient_id: '9199', ...(pricing ? { pricing } : {}) }] } }] }] });

    await waHook.handleStatuses({}, mk('m1', { billable: true, category: 'marketing', pricing_model: 'PMP' }));
    assert.equal(patches[0].pricing_category, 'marketing');
    assert.equal(patches[0].billable, true);

    patches.length = 0;
    await waHook.handleStatuses({}, mk('m2', { billable: false, category: 'service' }));
    assert.equal(patches[0].billable, false);          // genuinely free

    patches.length = 0;
    await waHook.handleStatuses({}, mk('m3', { category: 'utility' }));   // no billable flag
    assert.equal(patches[0].billable, null);           // absent must NOT collapse to false

    patches.length = 0;
    await waHook.handleStatuses({}, mk('m4', null));   // no pricing object at all
    assert.ok(!('pricing_category' in patches[0]));
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

  await t('renderWhatsapp fails CLOSED on an IMAGE header with no media url (not a silent omit)', () => {
    const tpl = {
      language: 'en', variables: [],
      content: { meta_name: 'lot_x', header_format: 'IMAGE', body: 'Hi', mapping: [] },
    };
    assert.throws(() => renderWhatsapp(tpl, {}), /media_header_missing_url/);
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

  // ── self-serve image headers: auto-upload on submit ──
  await t('waSubmitTemplate auto-uploads a media header (IMAGE+url+no-handle) before submitting', async () => {
    const calls = [];
    stubFetch(async (u, opts = {}) => {
      calls.push({ u, method: opts.method || 'GET', body: opts.body });
      if (u.includes('/rest/v1/templates') && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{
          id: 'T1', channel: 'whatsapp', purpose: 'utility', language: 'en',
          content: { meta_name: 'lot_promo', body: 'Hi there.', header_format: 'IMAGE',
            header_media_url: 'https://cdn.example.com/hero.png', waba_id: 'WABA1' },
        }]) };
      }
      if (u.includes('/rest/v1/templates') && opts.method === 'PATCH') {
        return { ok: true, status: 200, text: async () => '[]' };
      }
      if (u === 'https://cdn.example.com/hero.png') {
        return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      }
      if (u.includes('/uploads?')) return { ok: true, json: async () => ({ id: 'upload:SESS1' }) };
      if (u.includes('/upload:SESS1')) return { ok: true, json: async () => ({ h: 'h:NEWHANDLE' }) };
      if (u.includes('/message_templates')) return { ok: true, status: 200, json: async () => ({ id: 'PTID', status: 'PENDING' }) };
      throw new Error('unexpected fetch ' + u);
    });
    const r = await WATPL.waSubmitTemplate(
      { WA_TOKEN: 'tok', WA_APP_ID: 'APPID', SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      { templateId: 'T1' });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.equal(r.provider_template_id, 'PTID');
    // upload happens BEFORE submit: asset fetch -> upload session -> upload -> message_templates
    const idx = (needle) => calls.findIndex((c) => c.u.includes(needle));
    assert.ok(idx('hero.png') < idx('/uploads?'), 'must fetch the asset before opening an upload session');
    assert.ok(idx('/uploads?') < idx('/upload:SESS1'), 'must open the session before uploading bytes');
    assert.ok(idx('/upload:SESS1') < idx('/message_templates'), 'must have a handle before submitting to Meta');
    // Must match the POST specifically: since 2026-07-28 submit first does a GET
    // /message_templates to see whether the name already exists on the WABA (auto-routing to
    // the edit path if so), so "the first /message_templates call" is now that lookup.
    const submitCall = calls.find((c) => c.u.includes('/message_templates') && c.method === 'POST');
    const submitted = JSON.parse(submitCall.body);
    const header = submitted.components.find((c) => c.type === 'HEADER');
    assert.equal(header.format, 'IMAGE');
    assert.deepEqual(header.example, { header_handle: ['h:NEWHANDLE'] });
  });

  await t('waSubmitTemplate REFUSES to submit a media template when the upload fails', async () => {
    stubFetch(async (u, opts = {}) => {
      if (u.includes('/rest/v1/templates') && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{
          id: 'T2', channel: 'whatsapp', language: 'en',
          content: { meta_name: 'lot_promo2', body: 'Hi.', header_format: 'IMAGE',
            header_media_url: 'https://cdn.example.com/bad.png', waba_id: 'WABA1' },
        }]) };
      }
      if (u === 'https://cdn.example.com/bad.png') return { ok: false, status: 404 };
      throw new Error('unexpected fetch ' + u);
    });
    const r = await WATPL.waSubmitTemplate(
      { WA_TOKEN: 'tok', WA_APP_ID: 'APPID', SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      { templateId: 'T2' });
    restoreFetch();
    assert.equal(r.ok, false);
    assert.ok(r.error.startsWith('header_upload_failed:'), r.error);
    assert.ok(r.error.includes('asset_fetch_http_404'), r.error);
  });

  // ── waSubmitTemplate stage mode (migration pre-staging) ──
  await t('waSubmitTemplate stageWabaId submits to the override WABA with ZERO local mutation', async () => {
    const calls = [];
    stubFetch(async (u, opts = {}) => {
      calls.push({ u, method: opts.method || 'GET' });
      if (u.includes('/rest/v1/templates')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'T1', channel: 'whatsapp',
          purpose: 'utility', language: 'en',
          content: { meta_name: 'lot_x', body: 'Hello {{1}}, bye.', waba_id: 'LIVE_WABA' } }]) };
      }
      if (u.includes('/message_templates')) {
        return { ok: true, status: 200, json: async () => ({ id: 'STAGED_ID', status: 'PENDING' }) };
      }
      throw new Error('unexpected fetch ' + u);
    });
    const r = await WATPL.waSubmitTemplate(
      { WA_TOKEN: 'tok', SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      { templateId: 'T1', stageWabaId: 'DEST_WABA' });
    restoreFetch();
    assert.equal(r.ok, true);
    assert.equal(r.staged, true);
    assert.equal(r.waba_id, 'DEST_WABA');
    assert.equal(r.provider_template_id, 'STAGED_ID');
    const graph = calls.find((c) => c.u.includes('/message_templates'));
    assert.ok(graph.u.includes('/DEST_WABA/'), 'must submit to the override WABA, not the pin');
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'staged submit must never PATCH the local row');
  });

  await t('waSubmitTemplate refuses staging onto the pinned WABA', async () => {
    stubFetch(async (u) => {
      if (u.includes('/rest/v1/templates')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'T1', channel: 'whatsapp',
          content: { meta_name: 'lot_x', body: 'b', waba_id: 'LIVE_WABA' } }]) };
      }
      throw new Error('unexpected fetch ' + u);
    });
    const r = await WATPL.waSubmitTemplate(
      { WA_TOKEN: 'tok', SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      { templateId: 'T1', stageWabaId: 'LIVE_WABA' });
    restoreFetch();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'stage_waba_is_pinned_waba');
  });

  // ── waWindowOpen — per (customer, business number) window (review H5 part 3) ──
  await t('waWindowOpen fails closed with no phoneNumberId — no DB call made', async () => {
    const orig = A.sbComms;
    let called = false;
    A.sbComms = async () => { called = true; return { ok: true, data: [] }; };
    const openNoId = await waWindowOpen({}, '919880212323', null);
    assert.equal(openNoId, false);
    assert.equal(called, false, 'must not query sbComms without a phone_number_id');
    A.sbComms = orig;
  });

  await t('waWindowOpen is isolated per business number — SUPPORT window does not open MARKETING', async () => {
    const orig = A.sbComms;
    A.sbComms = async (path) => {
      // only the SUPPORT phone_number_id has an open window row
      if (path.includes('phone_number_id=eq.SUPPORT_PID')) {
        return { ok: true, data: [{ last_inbound_at: new Date().toISOString() }] };
      }
      return { ok: true, data: [] };   // MARKETING_PID (or anything else) → no row
    };
    const support = await waWindowOpen({}, '919880212323', 'SUPPORT_PID');
    const marketing = await waWindowOpen({}, '919880212323', 'MARKETING_PID');
    assert.equal(support, true);
    assert.equal(marketing, false, 'a window opened on SUPPORT must not leak to MARKETING for the same customer');
    A.sbComms = orig;
  });

  await t('waWindowOpen treats a stale last_inbound_at (>24h) as closed', async () => {
    const orig = A.sbComms;
    A.sbComms = async () => ({ ok: true, data: [{ last_inbound_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }] });
    const stale = await waWindowOpen({}, '919880212323', 'SUPPORT_PID');
    assert.equal(stale, false);
    A.sbComms = orig;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
