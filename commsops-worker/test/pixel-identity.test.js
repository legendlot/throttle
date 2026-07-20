// Unit tests for handlePixel's identifier construction — the identity-fragmentation fix.
// Run: node test/pixel-identity.test.js
//
// Why this exists: the web_session key used to be sent ONLY when email/phone were absent
// (`if (!idents.length && body.client_id)`). That meant the anonymous browser key and the
// known customer key never appeared in the SAME resolve_identity call, so the anonymous→known
// merge the code comment promised could never fire. 17,403 web_session profiles piled up 1:1
// with their identifiers and never joined a real customer; 0 of 15,487 add_to_cart profiles
// had a phone or email, so the whole cart-recovery ladder had nobody to send to.
//
// These tests pin the invariant: whenever client_id is present it rides ALONGSIDE any strong
// key, never instead of it.

const assert = require('assert');
const A = require('../src/auth.js');
const { handlePixel } = require('../src/shopify-webhooks.js');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok  ', name); },
  (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });

// Capture what ingest() hands to resolve_identity.
function stubDb(capture) {
  const orig = A.sbComms;
  A.sbComms = async (path, env, init) => {
    if (path.startsWith('/rest/v1/rpc/resolve_identity')) {
      capture.identifiers = JSON.parse(init.body).p_identifiers;
      return { ok: true, data: 'prof-1' };
    }
    if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'ev-1' }] };
    return { ok: true, data: [] };
  };
  return () => { A.sbComms = orig; };
}

const req = (body) => ({ json: async () => body });
const ENV = { PIXEL_TOKEN: 'tok' };
const types = (ids) => (ids || []).map((i) => i.type).sort();

(async () => {
  await t('checkout_started WITH email sends email AND web_session (the fix)', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, req({ token: 'tok', event: 'checkout_started',
      email: 'Buyer@Example.com', client_id: 'cid-123', checkout_token: 'ck1' }));
    restore();
    assert.deepEqual(types(cap.identifiers), ['email', 'web_session']);
    const email = cap.identifiers.find((i) => i.type === 'email');
    assert.equal(email.value, 'buyer@example.com', 'email should be lowercased');
    assert.equal(cap.identifiers.find((i) => i.type === 'web_session').value, 'cid-123');
  });

  await t('checkout_started with email AND phone still carries web_session', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, req({ token: 'tok', event: 'checkout_started',
      email: 'b@x.com', phone: '+91 98802 12323', client_id: 'cid-456' }));
    restore();
    assert.deepEqual(types(cap.identifiers), ['email', 'phone', 'web_session']);
  });

  await t('anonymous add_to_cart still sends web_session alone', async () => {
    const cap = {}; const restore = stubDb(cap);
    await handlePixel(ENV, req({ token: 'tok', event: 'add_to_cart', client_id: 'cid-789' }));
    restore();
    assert.deepEqual(types(cap.identifiers), ['web_session']);
  });

  await t('no client_id and no contact → skipped, never a phantom profile', async () => {
    const cap = {}; const restore = stubDb(cap);
    const r = await handlePixel(ENV, req({ token: 'tok', event: 'add_to_cart' }));
    restore();
    assert.equal(r.skipped, 'no_identifier');
    assert.equal(cap.identifiers, undefined, 'resolve_identity must not be called');
  });

  await t('bad token is rejected before any DB call', async () => {
    const cap = {}; const restore = stubDb(cap);
    const r = await handlePixel(ENV, req({ token: 'wrong', event: 'add_to_cart', client_id: 'c' }));
    restore();
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.equal(cap.identifiers, undefined);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
