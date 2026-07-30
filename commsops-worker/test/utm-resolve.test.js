// UTM precedence + WhatsApp parameter tagging.
// Covers the two things that were wrong before this shipped: WhatsApp sends carried NO utm at
// all (100% of real volume), and there was no way for an author to set the values themselves.
const assert = require('node:assert');
const { resolveUtm, normalizeUtm, tagLinks, appendUtm } = require('../src/tracking.js');

// ── normalizeUtm ─────────────────────────────────────────────────────────────
// Shorthand keys an author is likely to type are accepted and prefixed.
assert.deepEqual(normalizeUtm({ campaign: 'diwali' }), { utm_campaign: 'diwali' });
assert.deepEqual(normalizeUtm({ utm_campaign: 'diwali' }), { utm_campaign: 'diwali' });
// Blanks are DROPPED, so an empty UI field never overrides a more general layer.
assert.deepEqual(normalizeUtm({ utm_campaign: '', utm_content: '   ', utm_term: 'x' }), { utm_term: 'x' });
assert.deepEqual(normalizeUtm({ utm_source: null, utm_medium: undefined }), {});
// Non-utm keys are dropped: these become query params on customer-facing links, so an
// arbitrary key would be a silent injection surface.
assert.deepEqual(normalizeUtm({ ref: 'abc', gclid: '123' }), { utm_ref: 'abc', utm_gclid: '123' });
assert.deepEqual(normalizeUtm(null), {});
assert.deepEqual(normalizeUtm({ utm_campaign: '  spaced  ' }), { utm_campaign: 'spaced' });
console.log('normalizeUtm ok');

// ── resolveUtm precedence ────────────────────────────────────────────────────
// Nothing configured → exactly the pre-existing auto-derived behaviour (no regression).
assert.deepEqual(
  resolveUtm({ channel: 'whatsapp', tracking: { campaign: 'Cart Recovery' }, template: { name: 'cart_wa' } }),
  { utm_source: 'relay', utm_medium: 'whatsapp', utm_campaign: 'Cart Recovery', utm_content: 'cart_wa' });

// Account defaults override auto-derived (e.g. pinning utm_source).
assert.equal(
  resolveUtm({ channel: 'email', template: { name: 't' }, defaults: { utm_source: 'lot-relay' } }).utm_source,
  'lot-relay');

// Journey/campaign overrides defaults; PER-KEY, so auto-derived utm_content survives.
{
  const r = resolveUtm({
    channel: 'whatsapp', template: { name: 'hero_a' },
    tracking: { campaign: 'Journey Name', utm: { utm_campaign: 'diwali_2026' } },
    defaults: { utm_source: 'lot-relay' },
  });
  assert.equal(r.utm_campaign, 'diwali_2026');   // journey layer wins over auto
  assert.equal(r.utm_source, 'lot-relay');       // defaults still apply
  assert.equal(r.utm_content, 'hero_a');         // untouched auto-derived key survives
  assert.equal(r.utm_medium, 'whatsapp');
}

// Template is the MOST specific layer — it beats journey/campaign and defaults.
{
  const r = resolveUtm({
    channel: 'whatsapp', template: { name: 'hero_a', utm: { utm_content: 'variant_b', utm_campaign: 'tpl_wins' } },
    tracking: { campaign: 'J', utm: { utm_campaign: 'journey_camp', utm_term: 'kept' } },
    defaults: { utm_source: 'acct' },
  });
  assert.equal(r.utm_content, 'variant_b');
  assert.equal(r.utm_campaign, 'tpl_wins');
  assert.equal(r.utm_term, 'kept');    // journey key with no template override survives
  assert.equal(r.utm_source, 'acct');
}
// A template may also carry it under content.utm (where the WA editor stores template config).
assert.equal(
  resolveUtm({ channel: 'whatsapp', template: { name: 't', content: { utm: { utm_content: 'from_content' } } } }).utm_content,
  'from_content');
// A blank author field does not blank the send — it falls back through the chain.
assert.equal(
  resolveUtm({ channel: 'whatsapp', template: { name: 'fallback_name', utm: { utm_content: '' } } }).utm_content,
  'fallback_name');
console.log('resolveUtm precedence ok');

// ── WhatsApp tagging shape ───────────────────────────────────────────────────
// A template send transmits variable VALUES, not prose, so the URL lives inside a parameter.
// This mirrors what send.js now does to body/header params.
{
  const utm = resolveUtm({ channel: 'whatsapp', tracking: { campaign: 'c' }, template: { name: 't' } });
  const tagged = tagLinks('Your cart: https://legendoftoys.com/cart/abc', { params: utm, mode: 'text' });
  assert.ok(tagged.includes('utm_source=relay'), tagged);
  assert.ok(tagged.includes('utm_medium=whatsapp'), tagged);
  // Non-URL parameter values pass through untouched — names, order numbers, quantities.
  assert.equal(tagLinks('Rahul', { params: utm, mode: 'text' }), 'Rahul');
  assert.equal(tagLinks('45012', { params: utm, mode: 'text' }), '45012');
  // A bare LOT URL as the whole value (the common cart_link case).
  assert.ok(tagLinks('https://legendoftoys.com/cart/x', { params: utm, mode: 'text' }).includes('utm_campaign=c'));
  // Third-party links are never touched (a courier tracking URL must stay pristine).
  assert.equal(tagLinks('https://www.delhivery.com/track/xyz', { params: utm, mode: 'text' }),
    'https://www.delhivery.com/track/xyz');
  // Idempotent: an already-tagged link is left alone rather than double-tagged.
  const once = appendUtm('https://legendoftoys.com/p/1', utm);
  assert.equal(appendUtm(once, utm), once);
}
// A WA url-BUTTON parameter is a bare suffix, not a URL — proof that tagging it would be a
// no-op even if it were not excluded in send.js (it is excluded, deliberately).
assert.equal(appendUtm('45012', { utm_source: 'relay' }), '45012');
console.log('whatsapp param tagging ok');

console.log('utm-resolve.test.js: all assertions passed');
