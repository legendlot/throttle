// S241 — pre-send shape check. Guards the three live incidents of 2026-07-28, all of which
// were LOCAL template drift from Meta's approved copy surfacing only as an opaque send error.
const { test } = require('node:test');
const assert = require('node:assert');
const WATPL = require('../src/wa-templates.js');

// Stub the Graph list call by swapping global fetch — waCheckTemplateShape reaches Meta only
// through waListTemplates, so one stub covers it.
function withMeta(templates, fn) {
  const real = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: templates }),
  });
  return fn().finally(() => { global.fetch = real; });
}
const env = { WA_TOKEN: 'x', WA_GRAPH_VERSION: 'v21.0' };
const tpl = (content) => ({ channel: 'whatsapp', content: { meta_name: 't1', waba_id: 'W1', ...content } });
const codes = (r) => r.issues.map((i) => i.code).sort();

test('clean template with matching shape reports match', async () => {
  await withMeta([{ name: 't1', status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Hi {{1}} order {{2}}' }] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({
      body: 'Hi {{1}} order {{2}}',
      mapping: [{ pos: 1, token: 'a', component: 'body' }, { pos: 2, token: 'b', component: 'body' }],
    }));
    assert.equal(r.checked, true);
    assert.equal(r.match, true, JSON.stringify(r.issues));
  });
});

test('INCIDENT: local IMAGE header Meta never approved (Order Cancelled + COD, #132018)', async () => {
  await withMeta([{ name: 't1', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({
      header_format: 'IMAGE', header_media_url: 'https://x/y.png',
      body: 'Hi {{1}}', mapping: [{ pos: 1, token: 'a', component: 'body' }],
    }));
    assert.equal(r.match, false);
    assert.ok(codes(r).includes('header_mismatch'));
  });
});

test('INCIDENT: template mid-review — every send fails #132001', async () => {
  await withMeta([{ name: 't1', status: 'PENDING', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({
      body: 'Hi {{1}}', mapping: [{ pos: 1, token: 'a', component: 'body' }],
    }));
    assert.equal(r.match, false);
    assert.ok(codes(r).includes('meta_status_pending'));
  });
});

test('INCIDENT: template absent from the pinned WABA (stale waba_id, #200)', async () => {
  await withMeta([], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({ body: 'Hi' }));
    assert.equal(r.match, false);
    assert.deepEqual(codes(r), ['not_on_waba']);
  });
});

test('INCIDENT: button mapping against a STATIC url button', async () => {
  await withMeta([{ name: 't1', status: 'APPROVED', components: [
    { type: 'BODY', text: 'Hi {{1}}' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Order', url: 'https://lot.com/account' }] },
  ] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({
      body: 'Hi {{1}}',
      buttons: [{ type: 'URL', text: 'Order', url: 'https://lot.com/account' }],
      mapping: [{ pos: 1, token: 'a', component: 'body' },
                { pos: 2, token: 'url', component: 'button', index: 0 }],
    }));
    assert.ok(codes(r).includes('button_slot_static'));
  });
});

test('a DYNAMIC url button with a mapping is accepted', async () => {
  await withMeta([{ name: 't1', status: 'APPROVED', components: [
    { type: 'BODY', text: 'Hi {{1}}' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://lot.com/{{1}}' }] },
  ] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({
      body: 'Hi {{1}}',
      buttons: [{ type: 'URL', text: 'Track', url: 'https://lot.com/{{1}}' }],
      mapping: [{ pos: 1, token: 'a', component: 'body' },
                { pos: 2, token: 'sfx', component: 'button', index: 0 }],
    }));
    assert.equal(r.match, true, JSON.stringify(r.issues));
  });
});

test('QUICK_REPLY buttons need no mapping — not flagged (the C2P shape)', async () => {
  await withMeta([{ name: 't1', status: 'APPROVED', components: [
    { type: 'BODY', text: 'Hi {{1}} {{2}} {{3}}' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Make Payment' },
                                 { type: 'QUICK_REPLY', text: 'Cancel Order' }] },
  ] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({
      body: 'Hi {{1}} {{2}} {{3}}',
      buttons: [{ type: 'QUICK_REPLY', text: 'Make Payment' }, { type: 'QUICK_REPLY', text: 'Cancel Order' }],
      mapping: [1, 2, 3].map((p) => ({ pos: p, token: 't' + p, component: 'body' })),
    }));
    assert.equal(r.match, true, JSON.stringify(r.issues));
  });
});

test('body parameter count mismatch is caught (#132000)', async () => {
  await withMeta([{ name: 't1', status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Hi {{1}} {{2}} {{3}} {{4}}' }] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({
      body: 'Hi {{1}} {{2}} {{3}}',
      mapping: [1, 2, 3].map((p) => ({ pos: p, token: 't' + p, component: 'body' })),
    }));
    assert.ok(codes(r).includes('body_param_count'));
  });
});

test('media header with no asset fails closed at send — caught here instead', async () => {
  await withMeta([{ name: 't1', status: 'APPROVED', components: [
    { type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }] }], async () => {
    const r = await WATPL.waCheckTemplateShape(env, tpl({ header_format: 'IMAGE', body: 'Hi' }));
    assert.ok(codes(r).includes('media_header_no_asset'));
  });
});

test('never-submitted template is skipped, not reported broken', async () => {
  const r = await WATPL.waCheckTemplateShape(env, { channel: 'whatsapp', content: { waba_id: 'W1' } });
  assert.equal(r.checked, false);
  assert.equal(r.reason, 'not_submitted_to_meta');
});
