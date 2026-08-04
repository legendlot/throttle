// The Meta button payload is built from an ALLOW-LIST, so authoring-side fields cannot leak.
//
// This exists because they did. `buildComponents` used to spread the whole button object and
// `delete` exactly one private key (`example_suffix`) — a deny-list of size one. The first
// template carrying `target_base` was rejected outright on submit:
//   (#100) Unexpected key "target_base" on param "components[2]['buttons'][0]"  (S261)
// Meta rejects ANY unrecognised key, so a deny-list here is a defect generator: every future
// private field is a new outage waiting on someone remembering to strip it.
// Run: node test/wa-button-payload.test.js
const assert = require('node:assert');
const { buildComponents } = require('../src/wa-templates.js');

const btnComp = (content) =>
  buildComponents(content).find((c) => c.type === 'BUTTONS');

// ── the regression: private keys must NOT reach Meta ─────────────────────────
{
  const comp = btnComp({
    body: 'hi {{1}}',
    buttons: [{
      type: 'URL', text: 'Track Order',
      url: 'https://lottoys.in/r/{{1}}',
      target_base: '{{1}}',          // Phase-B, authoring-side only
      example_suffix: 'abc123',      // the older private key
      some_future_private_field: 'x',// whatever we add next must be safe BY CONSTRUCTION
    }],
    mapping: [{ index: 0, component: 'button', token: 'tracking_url', example: 'abc123' }],
  });
  const b = comp.buttons[0];
  for (const leaked of ['target_base', 'example_suffix', 'some_future_private_field']) {
    assert.ok(!(leaked in b), `${leaked} leaked into the Meta payload — Meta rejects unknown keys`);
  }
  // and the legitimate keys survive
  assert.equal(b.type, 'URL');
  assert.equal(b.text, 'Track Order');
  assert.equal(b.url, 'https://lottoys.in/r/{{1}}');
  // Meta requires the fully-substituted sample as an ARRAY, derived from example_suffix.
  assert.deepEqual(b.example, ['https://lottoys.in/r/abc123']);
}

// ── example falls back to the mapping slot when there is no example_suffix ───
{
  const b = btnComp({
    body: 'x',
    buttons: [{ type: 'URL', text: 'Go', url: 'https://lottoys.in/r/{{1}}', target_base: '{{1}}' }],
    mapping: [{ index: 0, component: 'button', token: 'tracking_url', example: 'fromMapping' }],
  }).buttons[0];
  assert.deepEqual(b.example, ['https://lottoys.in/r/fromMapping']);
  assert.ok(!('target_base' in b));
}

// ── a STATIC url button gets no example, and still no private keys ───────────
{
  const b = btnComp({
    body: 'x',
    buttons: [{ type: 'URL', text: 'Orders', url: 'https://legendoftoys.com/account/orders',
                target_base: 'https://legendoftoys.com/account/orders' }],
  }).buttons[0];
  assert.equal(b.example, undefined, 'a static button must not carry an example');
  assert.ok(!('target_base' in b));
}

// ── non-URL button types keep their own legitimate keys ──────────────────────
{
  const comp = btnComp({
    body: 'x',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Yes', target_base: 'nope' },
      { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919999999999', target_base: 'nope' },
    ],
  });
  assert.deepEqual(comp.buttons[0], { type: 'QUICK_REPLY', text: 'Yes' });
  assert.deepEqual(comp.buttons[1], { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919999999999' });
}

console.log('wa-button-payload.test.js: all assertions passed');
