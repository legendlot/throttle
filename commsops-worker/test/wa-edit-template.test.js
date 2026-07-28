// waEditTemplate + the submit→edit auto-route (2026-07-28).
//
// Adding a header to an APPROVED template is a component change, and Meta rejects a create on
// a duplicate name — so "Submit to Meta" was a dead end for every approved template. These
// cover the edit path and, most importantly, the WABA-scoping trap: the stored
// provider_template_id belongs to whichever WABA the template was FIRST created on, so after a
// re-pin it points at the wrong account's copy and must never be used to address an edit.
//
// Run: node test/wa-edit-template.test.js   (Node 18+)
const assert = require('assert');
const Module = require('module');

// ── stub the Supabase layer before wa-templates.js requires it ────────────────────────────
const patches = [];
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './auth.js' && parent && parent.filename.includes('wa-templates')) {
    return {
      enc: (s) => encodeURIComponent(s),
      sbComms: async (path, env, opts) => { patches.push({ path, opts }); return { ok: true, data: [] }; },
    };
  }
  return origLoad.apply(this, arguments);
};
const WATPL = require('../src/wa-templates.js');
Module._load = origLoad;

// ── fake Graph ────────────────────────────────────────────────────────────────────────────
let calls = [];
const PINNED = '1734668990887383';   // spare WABA (where the template really lives now)
const OLD = '717043791430518';       // BiteSpeed WABA (where the stored id was minted)

function installGraph({ onWaba = {}, editStatus = 200, editBody = { success: true } } = {}) {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const listing = u.match(/\/(\d+)\/message_templates/);
    if (listing && (opts.method || 'GET') === 'GET') {
      return { ok: true, json: async () => ({ data: onWaba[listing[1]] || [] }) };
    }
    if ((opts.method || '') === 'POST' && /\/\d+$/.test(u.split('?')[0])) {   // POST /{template_id}
      return { ok: editStatus === 200, status: editStatus, json: async () => editBody };
    }
    if ((opts.method || '') === 'POST' && listing) {                          // create
      return { ok: true, json: async () => ({ id: 'NEW_ID', status: 'PENDING' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'unexpected' } }) };
  };
}

const env = { WA_TOKEN: 'tok', WA_GRAPH_VERSION: 'v21.0' };
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e && e.message); });

(async () => {
  // ── resolveMetaTemplateId: the WABA-scoping guarantee ───────────────────────────────────
  await t('resolves the id from the PINNED waba, not the stored (other-waba) id', async () => {
    installGraph({ onWaba: {
      [PINNED]: [{ id: 'CORRECT_ID', name: 'lot_order_placed_01', language: 'en', status: 'APPROVED' }],
      [OLD]:    [{ id: 'STALE_ID_ON_OLD_WABA', name: 'lot_order_placed_01', language: 'en', status: 'APPROVED' }],
    } });
    const r = await WATPL.resolveMetaTemplateId(env, { wabaId: PINNED, name: 'lot_order_placed_01', language: 'en' });
    assert.strictEqual(r.id, 'CORRECT_ID');
    assert.ok(calls[0].url.includes(`/${PINNED}/message_templates`), 'must query the pinned waba');
    assert.ok(calls[0].url.includes('fields=id'), 'must ask Meta for the id');
  });

  await t('name filter is a prefix match — _01 must not resolve to _02', async () => {
    installGraph({ onWaba: { [PINNED]: [
      { id: 'ID02', name: 'lot_order_placed_02', language: 'en', status: 'APPROVED' },
      { id: 'ID01', name: 'lot_order_placed_01', language: 'en', status: 'APPROVED' },
    ] } });
    const r = await WATPL.resolveMetaTemplateId(env, { wabaId: PINNED, name: 'lot_order_placed_01', language: 'en' });
    assert.strictEqual(r.id, 'ID01');
  });

  await t('language must match too', async () => {
    installGraph({ onWaba: { [PINNED]: [
      { id: 'IDHI', name: 'lot_order_placed_01', language: 'hi', status: 'APPROVED' },
    ] } });
    const r = await WATPL.resolveMetaTemplateId(env, { wabaId: PINNED, name: 'lot_order_placed_01', language: 'en' });
    assert.strictEqual(r, null);
  });

  await t('not present on the waba → null (never guesses)', async () => {
    installGraph({ onWaba: { [PINNED]: [] } });
    const r = await WATPL.resolveMetaTemplateId(env, { wabaId: PINNED, name: 'lot_order_placed_01', language: 'en' });
    assert.strictEqual(r, null);
  });

  await t('Graph error surfaces rather than reading as not-found', async () => {
    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'no access' } }) });
    const r = await WATPL.resolveMetaTemplateId(env, { wabaId: PINNED, name: 'x', language: 'en' });
    assert.ok(r && r.error, 'a 403 must not look like "template absent"');
  });

  // ── the mid-review guard ────────────────────────────────────────────────────────────────
  await t('PENDING and IN_APPEAL are not editable', () => {
    assert.ok(WATPL.UNEDITABLE_STATUSES.has('PENDING'));
    assert.ok(WATPL.UNEDITABLE_STATUSES.has('IN_APPEAL'));
    assert.ok(!WATPL.UNEDITABLE_STATUSES.has('APPROVED'));
    assert.ok(!WATPL.UNEDITABLE_STATUSES.has('REJECTED'));   // a rejected template MUST be fixable
  });

  // ── buildComponents actually emits the image header we are adding ───────────────────────
  await t('an IMAGE header with a handle becomes a HEADER/IMAGE component', () => {
    const comps = WATPL.buildComponents({
      meta_name: 'x', body: 'hi', header_format: 'IMAGE', header_handle: 'h:abc',
    });
    const h = comps.find((c) => c.type === 'HEADER');
    assert.ok(h, 'header component missing');
    assert.strictEqual(h.format, 'IMAGE');
    const ex = JSON.stringify(h.example || {});
    assert.ok(ex.includes('h:abc'), 'the upload handle must ride in the header example');
  });


  // ── no-op guard: never burn the once-per-24h edit on an unchanged template ──────────────
  await t('identical components → sameAsMeta true (edit is skipped)', () => {
    const local = [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h:AAA'] } },
                   { type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Rahul']] } }];
    const meta  = [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h:ZZZ'] } },
                   { type: 'BODY', text: 'Hi {{1}}' }];
    assert.strictEqual(WATPL.sameAsMeta(local, meta), true, 'a rotated header_handle is not a change');
  });

  await t('changed body text → false (edit proceeds)', () => {
    assert.strictEqual(WATPL.sameAsMeta(
      [{ type: 'BODY', text: 'Hi {{1}}, new copy' }], [{ type: 'BODY', text: 'Hi {{1}}' }]), false);
  });

  await t('ADDING a header → false (the image-header case)', () => {
    assert.strictEqual(WATPL.sameAsMeta(
      [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }],
      [{ type: 'BODY', text: 'Hi' }]), false);
  });

  await t('changed button url → false', () => {
    assert.strictEqual(WATPL.sameAsMeta(
      [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://a/{{1}}' }] }],
      [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://b/{{1}}' }] }]), false);
  });

  await t('case/format differences alone are not a change', () => {
    assert.strictEqual(WATPL.sameAsMeta(
      [{ type: 'header', format: 'image' }], [{ type: 'HEADER', format: 'IMAGE' }]), true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
