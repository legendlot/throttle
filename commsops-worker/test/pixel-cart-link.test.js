// Pixel add_to_cart must emit the cart permalink tokens the WA cart templates bind.
// Run: node test/pixel-cart-link.test.js
//
// WHY: measured 2026-07-29, 0 of 4,119 pixel `add_to_cart` events carried `cart_link_suffix`
// (vs 90.8% of Shopflo's), even though the pixel payload has `variant_id` + `quantity` —
// everything needed to build it. Any cart template bound to that token hard-failed at render
// (`unresolved_variables:cart_link_suffix`) on a pixel-triggered send.
//
// The token is a PATH SEGMENT in a link sent to a customer, so the id validation (numeric-only,
// no all-zero sentinel) is the load-bearing part — it is shared with the Shopflo path rather
// than re-derived.

const assert = require('assert');
const A = require('../src/auth.js');
const { handlePixel } = require('../src/shopify-webhooks.js');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok  ', name); },
  (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });

// Capture the properties handed to the events insert.
function stubDb(capture) {
  const orig = A.sbComms;
  A.sbComms = async (path, env, init) => {
    if (path.startsWith('/rest/v1/rpc/resolve_identity')) return { ok: true, data: 'prof-1' };
    if (path.startsWith('/rest/v1/events')) {
      if (init && init.method === 'POST') {
        try { capture.props = JSON.parse(init.body).properties; } catch { /* ignore */ }
        return { ok: true, data: [{ id: 'ev-1' }] };
      }
      return { ok: true, data: [] };
    }
    if (path.startsWith('/rest/v1/profiles')) return { ok: true, data: [{ attributes: {} }] };
    return { ok: true, data: [] };
  };
  return () => { A.sbComms = orig; };
}

const req = (body) => ({ json: async () => body });
const ENV = { PIXEL_TOKEN: 'tok' };
const atc = (properties) => req({
  token: 'tok', event: 'add_to_cart', email: 'b@x.com', client_id: 'cid-1', properties,
});

(async () => {
  await t('builds cart_link_suffix + cart_link from variant_id', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, atc({ variant_id: '46875677720628', quantity: 1 }));
    restore();
    assert.equal(cap.props.cart_link_suffix, '46875677720628:1');
    assert.equal(cap.props.cart_link, 'https://www.legendoftoys.com/cart/46875677720628:1');
  });

  await t('carries a real quantity > 1', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, atc({ variant_id: '46875677720628', quantity: 3 }));
    restore();
    assert.equal(cap.props.cart_link_suffix, '46875677720628:3');
  });

  await t('missing/!=1 quantity degrades to :1 rather than breaking the link', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, atc({ variant_id: '46875677720628' }));
    restore();
    assert.equal(cap.props.cart_link_suffix, '46875677720628:1');
  });

  // The safety property: a malformed id must never reach the URL. Null is correct — the
  // template's own fallback URL then applies, instead of a /cart/ path that 404s.
  await t('non-numeric variant_id yields NO token (template fallback applies)', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, atc({ variant_id: '../../evil', quantity: 1 }));
    restore();
    assert.equal(cap.props.cart_link_suffix, undefined);
    assert.equal(cap.props.cart_link, undefined);
  });

  await t('all-zero sentinel variant_id yields NO token', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, atc({ variant_id: '0', quantity: 1 }));
    restore();
    assert.equal(cap.props.cart_link_suffix, undefined);
  });

  await t('an existing cart_link_suffix is never overwritten', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, atc({ variant_id: '111', quantity: 1, cart_link_suffix: '999:2' }));
    restore();
    assert.equal(cap.props.cart_link_suffix, '999:2');
  });

  await t('non-add_to_cart pixel events are untouched', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, req({ token: 'tok', event: 'checkout_started', email: 'b@x.com',
      client_id: 'cid-1', properties: { variant_id: '46875677720628', quantity: 1 } }));
    restore();
    assert.equal(cap.props.cart_link_suffix, undefined);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
