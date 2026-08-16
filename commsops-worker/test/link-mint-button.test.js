// Minting a redirect-backed WhatsApp URL button.
//
// The opt-in is `content.buttons[i].target_base` — authoring-side only, never sent to Meta. It
// holds what the approved button URL is TODAY (including its `{{1}}`), so migrating a template is
// a copy across, and the Meta-facing `url` then becomes `https://<host>/r/{{1}}`.
//
// A button WITHOUT target_base must be byte-identical to today's behaviour. That is what lets this
// ship ahead of any re-approval and be opted in one template at a time — the sequencing the S241
// incident demands.
// Run: node test/link-mint-button.test.js
const assert = require('node:assert');
const { buildButtonTarget, applyButtonRedirects } = require('../src/links.js');

// ── buildButtonTarget: reproduce exactly what Meta does with {{1}} ───────────
assert.equal(
  buildButtonTarget('https://checkout.shopflo.co/stable/{{1}}', '?tokenId=d16b&checkout_type=ABANDONED'),
  'https://checkout.shopflo.co/stable/?tokenId=d16b&checkout_type=ABANDONED');
assert.equal(
  buildButtonTarget('https://www.legendoftoys.com/products/{{1}}', 'ghost-rc-drift-car'),
  'https://www.legendoftoys.com/products/ghost-rc-drift-car');
// A static button (no variable) ignores any suffix rather than concatenating junk onto it.
assert.equal(buildButtonTarget('https://legendoftoys.com/account/orders', 'ignored'),
  'https://legendoftoys.com/account/orders');
assert.equal(buildButtonTarget('https://legendoftoys.com/account/orders'),
  'https://legendoftoys.com/account/orders');
// A missing suffix on a variable button yields the bare base, not the literal '{{1}}' —
// a customer must never be shown a template placeholder.
assert.equal(buildButtonTarget('https://www.legendoftoys.com/products/{{1}}'),
  'https://www.legendoftoys.com/products/');
assert.equal(buildButtonTarget(null, 'x'), null);

const comps = () => ([
  { type: 'body', parameters: [{ type: 'text', text: 'Rahul' }] },
  { type: 'button', sub_type: 'url', index: '0',
    parameters: [{ type: 'text', text: '?tokenId=d16b' }] },
]);

(async () => {
  // (a) opted in → the parameter becomes the code, and the minted target is the resolved link.
  {
    const minted = [];
    const c = comps();
    const tpl = { content: { buttons: [{ type: 'URL', url: 'https://go.legendoftoys.com/r/{{1}}',
                                         target_base: 'https://checkout.shopflo.co/stable/{{1}}' }] } };
    await applyButtonRedirects(c, {
      template: tpl, baseUrl: 'https://go.legendoftoys.com',
      mint: async (target) => { minted.push(target); return 'CODE1234567890abcdefgh'; },
    });
    assert.deepEqual(minted, ['https://checkout.shopflo.co/stable/?tokenId=d16b']);
    assert.equal(c[1].parameters[0].text, 'CODE1234567890abcdefgh');
    assert.equal(c[0].parameters[0].text, 'Rahul', 'body parameters must be untouched');
  }

  // (b) NOT opted in → no mint, and the component is byte-identical to before.
  {
    const minted = [];
    const c = comps();
    const before = JSON.stringify(c);
    const tpl = { content: { buttons: [{ type: 'URL', url: 'https://checkout.shopflo.co/stable/{{1}}' }] } };
    await applyButtonRedirects(c, {
      template: tpl, baseUrl: 'https://go.legendoftoys.com',
      mint: async (t) => { minted.push(t); return 'NOPE'; },
    });
    assert.deepEqual(minted, [], 'a button without target_base must never mint');
    assert.equal(JSON.stringify(c), before, 'components must be untouched');
  }

  // (c) the feature OFF SWITCH — no baseUrl configured, even with target_base set.
  // This is the state the whole thing ships in, so it gets an explicit test rather than being
  // assumed from the null-check in getLinkBaseUrl.
  {
    const minted = [];
    const c = comps();
    const before = JSON.stringify(c);
    const tpl = { content: { buttons: [{ type: 'URL', target_base: 'https://checkout.shopflo.co/stable/{{1}}' }] } };
    await applyButtonRedirects(c, {
      template: tpl, baseUrl: null,
      mint: async (t) => { minted.push(t); return 'NOPE'; },
    });
    assert.deepEqual(minted, []);
    assert.equal(JSON.stringify(c), before);
  }

  // (d) a mint failure PROPAGATES. Post-re-approval there is no untracked link to fall back to —
  // the button would land on the homepage instead of the customer's cart. send.js turns this into
  // a failed send, which is visible and retried, rather than invisible damage.
  {
    const c = comps();
    const tpl = { content: { buttons: [{ type: 'URL', target_base: 'https://checkout.shopflo.co/stable/{{1}}' }] } };
    await assert.rejects(
      () => applyButtonRedirects(c, {
        template: tpl, baseUrl: 'https://go.legendoftoys.com',
        mint: async () => { throw new Error('link_mint_failed:boom'); },
      }),
      /link_mint_failed/);
  }

  // (e) multiple buttons: only the opted-in index is rewritten, and each gets its OWN code.
  {
    const c = [
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'aaa' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'bbb' }] },
    ];
    let n = 0;
    const tpl = { content: { buttons: [
      { type: 'URL', target_base: 'https://legendoftoys.com/a/{{1}}' },
      { type: 'URL' },
    ] } };
    await applyButtonRedirects(c, {
      template: tpl, baseUrl: 'https://go.legendoftoys.com',
      mint: async () => `code${++n}`,
    });
    assert.equal(c[0].parameters[0].text, 'code1');
    assert.equal(c[1].parameters[0].text, 'bbb', 'button 1 is not opted in');
  }

  // (f) a quick-reply button is never touched, even at an index whose URL button opted in.
  {
    const c = [{ type: 'button', sub_type: 'quick_reply', index: '0',
                 parameters: [{ type: 'payload', payload: 'STOP' }] }];
    const before = JSON.stringify(c);
    const tpl = { content: { buttons: [{ type: 'URL', target_base: 'https://legendoftoys.com/{{1}}' }] } };
    await applyButtonRedirects(c, {
      template: tpl, baseUrl: 'https://go.legendoftoys.com', mint: async () => 'X',
    });
    assert.equal(JSON.stringify(c), before);
  }

  // (g) STATIC button, no mapping slot → the component is SYNTHESIZED. This is the whole
  // static-template class: render.js emits no button component (there was never a parameter to
  // fill), so before this the opt-in changed nothing — the template passed Meta, sent, and never
  // tracked.
  {
    const c = [{ type: 'body', parameters: [{ type: 'text', text: 'hi' }] }];
    const tpl = { content: { buttons: [
      { type: 'URL', text: 'Dive Back In', target_base: 'https://legendoftoys.com/collections/all' },
    ] } };
    let minted = null;
    await applyButtonRedirects(c, {
      template: tpl, baseUrl: 'https://lottoys.in',
      mint: async (t) => { minted = t; return 'abc123'; },
    });
    assert.equal(minted, 'https://legendoftoys.com/collections/all',
      'a static base is minted as-is — it IS the destination, no suffix substitution');
    const btn = c.find((x) => x.type === 'button');
    assert.ok(btn, 'a button component is synthesized for a static opted-in button');
    assert.equal(btn.sub_type, 'url');
    assert.equal(btn.index, '0');
    assert.deepEqual(btn.parameters, [{ type: 'text', text: 'abc123' }]);
    assert.equal(c[0].type, 'body', 'existing components are left in place');
  }

  // (h) a failed mint must add NOTHING. An empty/placeholder button component is rejected by Meta
  // (132000) — failing loudly beats delivering a button pointing at a literal {{1}}.
  {
    const c = [{ type: 'body', parameters: [] }];
    const tpl = { content: { buttons: [{ type: 'URL', target_base: 'https://legendoftoys.com/x' }] } };
    await applyButtonRedirects(c, {
      template: tpl, baseUrl: 'https://lottoys.in', mint: async () => null,
    });
    assert.equal(c.filter((x) => x.type === 'button').length, 0,
      'no component is synthesized when the mint fails');
  }

  // (i) default_target — the always-resolves half. A VARIABLE base whose per-recipient suffix is
  // missing falls back to it; a STATIC base never consults it.
  {
    const tpl = { content: { buttons: [{ type: 'URL',
      target_base: 'https://www.legendoftoys.com/products/{{1}}',
      default_target: 'https://www.legendoftoys.com/collections/all' }] } };
    // missing suffix → default
    let got = null;
    await applyButtonRedirects([], { template: tpl, baseUrl: 'https://lottoys.in',
      mint: async (t) => { got = t; return 'c1'; } });
    assert.equal(got, 'https://www.legendoftoys.com/collections/all', 'no suffix → default_target');
    // blank suffix counts as missing — a resolved-but-empty variable is not a destination
    got = null;
    await applyButtonRedirects(
      [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '  ' }] }],
      { template: tpl, baseUrl: 'https://lottoys.in', mint: async (t) => { got = t; return 'c2'; } });
    assert.equal(got, 'https://www.legendoftoys.com/collections/all', 'blank suffix → default_target');
    // a real per-recipient suffix WINS over the default
    got = null;
    await applyButtonRedirects(
      [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'ghost' }] }],
      { template: tpl, baseUrl: 'https://lottoys.in', mint: async (t) => { got = t; return 'c3'; } });
    assert.equal(got, 'https://www.legendoftoys.com/products/ghost', 'per-recipient target wins');
    // a STATIC base ignores default_target entirely — overriding it would silently retarget a
    // button that already works.
    got = null;
    const staticTpl = { content: { buttons: [{ type: 'URL',
      target_base: 'https://legendoftoys.com/account/orders',
      default_target: 'https://legendoftoys.com/collections/all' }] } };
    await applyButtonRedirects([], { template: staticTpl, baseUrl: 'https://lottoys.in',
      mint: async (t) => { got = t; return 'c4'; } });
    assert.equal(got, 'https://legendoftoys.com/account/orders', 'static base is never overridden');
  }

  console.log('link-mint-button.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
