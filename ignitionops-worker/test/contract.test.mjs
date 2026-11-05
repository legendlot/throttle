import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIP_LOCK_STAGES, composeContract, renderContractEmail, shipLockRefusal, validateBank, maskBank,
  needsPayment, wordingPublished, isTerminalStage, isDeadStage, invoicePathOk, validEmail,
  newToken, hashToken, tokenShapeOk,
} from '../src/contract.js';
import { partnerGetRefusal, PARTNER_GET_ACTIONS, stripPartnerFields, partnerEngagementView } from '../src/partner.js';
import { LOCKED_FIELDS } from '../src/completeness.js';

const published = { published_at: '2026-11-05T00:00:00Z', dos_and_donts: 'Do show the car.', terms: 'Term one.', subject: 'Your deal' };
const unpublished = { published_at: null, dos_and_donts: 'Do show the car.', terms: 'Term one.' };
const deal = (over = {}) => ({
  engagement_no: 'IGN-2026-00001', engagement_type: 'video_tracking', deal_type: 'paid', stage: 'planning',
  approved_at: '2026-11-01T00:00:00Z', deliverables: '1 reel', expected_post_date: '2026-12-09',
  payment_amount: '5000.00', payment_terms: 'advance', contract_required: true,
  influencer: { email: 'creator@example.com', person_name: 'Asha', channel_name: 'asha_cars' },
  ...over,
});
const compose = (d = deal(), settings = published, products = [{ product_code: 'Crest', product_variant: 'Sly', quantity: 2 }], coupons = [], campaign = null) =>
  composeContract(d, products, coupons, campaign, settings);

// ── composeContract ──────────────────────────────────────────────────────────────────────────────
test('a complete paid deal composes every section and has no blockers', () => {
  const c = compose(deal({ utm_link: 'https://l.in/x' }), published, undefined, [{ code: 'ASHALOT', kind: 'affiliate', status: 'active' }], { name: 'Diwali' });
  assert.deepEqual(c.blockers, []);
  assert.equal(c.to, 'creator@example.com');
  assert.equal(c.subject, 'Your deal (IGN-2026-00001)');
  for (const bit of ['Hi Asha,', 'Campaign: Diwali', 'Type: Paid', 'Crest Sly x 2', '1 reel', 'Post date: 9 Dec 2026',
    'Amount: ₹5,000', 'Paid in advance', 'https://l.in/x', 'ASHALOT', 'Do show the car.', 'Term one.']) {
    assert.ok(c.body.includes(bit), bit);
  }
});

test('payment words: each measured payment_terms value is plain, numeric strings are read as numbers', () => {
  assert.ok(compose(deal({ payment_terms: 'on_draft' })).body.includes('once we have your draft'));
  assert.ok(compose(deal({ payment_terms: 'on_release' })).body.includes('once your video is live'));
  assert.ok(!compose(deal({ payment_terms: 'n_a' })).body.includes('Not applicable'));
  assert.ok(!compose(deal({ payment_terms: 'advance' })).body.includes('advance\n'));
  assert.ok(compose(deal({ payment_amount: '120000.50' })).body.includes('₹1,20,000.5'));
});

test('barter: no payment section at all, even with an amount left on the row, and no amount blocker', () => {
  const c = compose(deal({ deal_type: 'barter', payment_amount: 900, payment_terms: 'advance' }));
  assert.ok(!c.body.includes('Payment:'));
  assert.ok(!c.body.includes('₹'));
  assert.deepEqual(c.blockers, []);
});

test('affiliate with no amount and n_a terms prints no payment section and is not blocked', () => {
  const c = compose(deal({ deal_type: 'affiliate', payment_amount: null, payment_terms: 'n_a' }));
  assert.ok(!c.body.includes('Payment:'));
  assert.deepEqual(c.blockers, []);
});

test('legal wording comes only from settings: with none, the body holds no such section', () => {
  const c = compose(deal(), {});
  assert.ok(!c.body.includes('Terms:'));
  assert.ok(!c.body.includes("Dos and don'ts:"));
});

test('a gift code is internal and 100% off: never printed. A pending affiliate code is not live either', () => {
  const body = compose(deal(), published, undefined, [
    { code: 'GIFTSECRET', kind: 'gift', status: 'active' },
    { code: 'PENDINGCODE', kind: 'affiliate', status: 'pending_shopify' },
  ]).body;
  assert.ok(!body.includes('GIFTSECRET'));
  assert.ok(!body.includes('PENDINGCODE'));
});

test('a legacy deal with no product lines falls back to the mirror on the deal', () => {
  const c = composeContract(deal({ product_code: 'Knox', product_variant: 'Red' }), [], [], null, published);
  assert.ok(c.body.includes('· Knox Red'));
});

const blocked = (d, settings = published) => compose(d, settings).blockers;
test('blockers: each condition on its own', () => {
  const cases = [
    [deal(), unpublished, /wording/],
    [deal({ influencer: {} }), published, /email/],
    [deal({ influencer: { email: 'not-an-email' } }), published, /email/],
    [deal({ influencer: { email: 'a@b.in, c@d.in' } }), published, /email/],
    [deal({ approved_at: null }), published, /approved/],
    [deal({ stage: 'dropped' }), published, /closed/],
    [deal({ stage: 'cancelled' }), published, /closed/],
    [deal({ stage: 'live' }), published, /closed/],
    [deal({ engagement_type: 'ugc' }), published, /UGC/],
    [deal({ deliverables: null }), published, /deliverables/],
    [deal({ deliverables: '  \n ' }), published, /deliverables/],
    [deal({ expected_post_date: '' }), published, /post date/],
    [deal({ payment_amount: null }), published, /amount/],
    [deal({ payment_amount: '0' }), published, /amount/],
    [deal({ payment_amount: 'abc' }), published, /amount/],
  ];
  for (const [d, s, re] of cases) {
    const b = blocked(d, s);
    assert.equal(b.length, 1, JSON.stringify(b));
    assert.match(b[0], re);
  }
});

test('hostile compose inputs do not throw and refuse', () => {
  for (const d of [null, undefined, {}]) {
    const c = composeContract(d, null, null, null, null);
    assert.ok(c.blockers.length >= 4);
    assert.equal(c.to, null);
    assert.equal(typeof c.body, 'string');
  }
});

// ── wordingPublished ─────────────────────────────────────────────────────────────────────────────
test('published means stamped AND both sections still filled', () => {
  assert.equal(wordingPublished(published), true);
  for (const s of [null, undefined, {}, unpublished, { ...published, terms: '  ' }, { ...published, dos_and_donts: null }]) {
    assert.equal(wordingPublished(s), false);
  }
});

// ── shipLockRefusal ──────────────────────────────────────────────────────────────────────────────
const lock = (over = {}) => shipLockRefusal({ deal: deal(), settings: published, accepted: false, toStage: 'shipped', ...over });
test('the lock refuses every post-ship stage with no acceptance, including planning → live', () => {
  assert.deepEqual(SHIP_LOCK_STAGES, ['shipped', 'delivered', 'scheduled', 'posting', 'live']);
  for (const toStage of SHIP_LOCK_STAGES) assert.match(lock({ toStage }), /has not accepted/, toStage);
  assert.ok(lock({ deal: deal({ stage: 'planning' }), toStage: 'live' }));
});

test('the lock leaves alone: pre-ship and side stages, acceptance, exempt deals, unpublished wording', () => {
  for (const toStage of ['proposed', 'planning', 'delayed', 'on_hold', 'ghosted', 'dropped', 'cancelled']) {
    assert.equal(lock({ toStage }), null, toStage);
  }
  assert.equal(lock({ accepted: true }), null);
  assert.equal(lock({ deal: deal({ contract_required: false }) }), null);
  assert.equal(lock({ deal: deal({ engagement_type: 'ugc' }) }), null);
  assert.equal(lock({ deal: deal({ deal_type: 'barter' }), accepted: true }), null);
  assert.equal(lock({ settings: unpublished }), null);
  assert.equal(lock({ settings: null }), null);
});

test('barter is locked too: the contract is about the goods, not the money', () => {
  assert.ok(lock({ deal: deal({ deal_type: 'barter' }) }));
});

test('hostile lock inputs: a missing flag or deal fails closed, a missing argument does not throw', () => {
  assert.ok(lock({ deal: { engagement_type: 'video_tracking' } }));
  assert.ok(lock({ deal: null }));
  assert.ok(lock({ deal: deal({ contract_required: null }) }));
  assert.equal(shipLockRefusal(), null);
  assert.equal(lock({ toStage: null }), null);
});

// ── needsPayment + stages ────────────────────────────────────────────────────────────────────────
test('needsPayment: paid and affiliate yes, barter and nonsense no', () => {
  for (const deal_type of ['paid', 'affiliate', 'paid_plus_affiliate']) assert.equal(needsPayment({ deal_type }), true);
  for (const v of [{ deal_type: 'barter' }, {}, null, undefined, { deal_type: '' }]) assert.equal(needsPayment(v), false);
});

test('live is terminal for accepting but not dead: an on-release creator invoices after going live', () => {
  assert.equal(isTerminalStage('live'), true);
  assert.equal(isDeadStage('live'), false);
  for (const s of ['ghosted', 'dropped', 'cancelled', 'retired']) { assert.equal(isDeadStage(s), true); assert.equal(isTerminalStage(s), true); }
  for (const s of ['proposed', 'planning', 'shipped', null, undefined]) { assert.equal(isDeadStage(s), false); assert.equal(isTerminalStage(s), false); }
});

// ── validateBank ─────────────────────────────────────────────────────────────────────────────────
const bank = (over = {}) => ({
  account_name: ' Asha Rao ', account_number: ' 001234567890 ', account_number_confirm: '001234567890',
  ifsc: 'hdfc0001234', pan: 'abcde1234f', ...over,
});
test('a good form: trimmed, uppercased, leading zeros kept, confirm field not stored', () => {
  const v = validateBank(bank({ gstin: '27aaaaa0000a1z5', upi_id: ' asha@okhdfc ' }));
  assert.deepEqual(v.errors, {});
  assert.equal(v.ok, true);
  assert.equal(v.clean.account_number, '001234567890');
  assert.equal(v.clean.ifsc, 'HDFC0001234');
  assert.equal(v.clean.pan, 'ABCDE1234F');
  assert.equal(v.clean.gstin, '27AAAAA0000A1Z5');
  assert.equal(v.clean.upi_id, 'asha@okhdfc');
  assert.equal(v.clean.account_name, 'Asha Rao');
  assert.ok(!('account_number_confirm' in v.clean));
});

test('optional fields left blank become null, not empty strings', () => {
  const v = validateBank(bank({ gstin: '  ', upi_id: '' }));
  assert.equal(v.ok, true);
  assert.equal(v.clean.gstin, null);
  assert.equal(v.clean.upi_id, null);
  assert.equal(v.clean.bank_name, null);
});

test('each bad field gets its own field error', () => {
  const cases = [
    [{ account_name: '   ' }, 'account_name'],
    [{ account_number: '12345', account_number_confirm: '12345' }, 'account_number'],
    [{ account_number: '1'.repeat(19), account_number_confirm: '1'.repeat(19) }, 'account_number'],
    [{ account_number: '1234 5678', account_number_confirm: '1234 5678' }, 'account_number'],
    [{ account_number_confirm: '999999999' }, 'account_number_confirm'],
    [{ ifsc: 'HDFC1001234' }, 'ifsc'],
    [{ ifsc: 'HDF0001234' }, 'ifsc'],
    [{ pan: 'ABCDE12345' }, 'pan'],
    [{ gstin: 'SHORT' }, 'gstin'],
    [{ upi_id: 'nope' }, 'upi_id'],
  ];
  for (const [over, field] of cases) {
    const v = validateBank(bank(over));
    assert.equal(v.ok, false, field);
    assert.deepEqual(Object.keys(v.errors), [field]);
  }
});

test('hostile bank inputs: empty, null, whitespace and objects are refused, not thrown', () => {
  for (const input of [null, undefined, 'x', 7, {}, { account_number: {}, ifsc: [], pan: null, account_name: '  ' }]) {
    const v = validateBank(input);
    assert.equal(v.ok, false);
    for (const f of ['account_name', 'account_number', 'ifsc', 'pan']) assert.ok(v.errors[f], f);
  }
});

// ── maskBank ─────────────────────────────────────────────────────────────────────────────────────
test('mask: exactly the allowed keys, last four only, never the number or PAN', () => {
  const m = maskBank({ account_number: '001234567890', ifsc: 'HDFC0001234', bank_name: 'HDFC', submitted_at: 'T', pan: 'ABCDE1234F', upi_id: 'a@b', account_name: 'Asha', gstin: 'G' });
  assert.deepEqual(m, { received: true, account_last4: '7890', ifsc: 'HDFC0001234', bank_name: 'HDFC', submitted_at: 'T' });
  const json = JSON.stringify(m);
  for (const secret of ['001234567890', 'ABCDE1234F', 'a@b', 'Asha']) assert.ok(!json.includes(secret));
});

test('mask: nothing on file reads as not received', () => {
  for (const row of [null, undefined, {}]) {
    assert.deepEqual(maskBank(row), { received: false, account_last4: null, ifsc: null, bank_name: null, submitted_at: null });
  }
});

// ── Email ────────────────────────────────────────────────────────────────────────────────────────
test('the email carries the server link in both parts, and the html escapes the edited text', () => {
  const link = 'https://ignition.legendoftoys.com/deal/?t=abc';
  const m = renderContractEmail('Hi <script>alert(1)</script> & "you"', link);
  assert.ok(m.text.includes(link));
  assert.ok(m.text.includes('<script>'), 'the text part is literal');
  assert.ok(m.html.includes(`href="${link}"`));
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(m.html.includes('&amp;'));
});

test('validEmail', () => {
  for (const e of ['a@b.in', ' A.B+c@sub.example.com ']) assert.equal(validEmail(e), true, e);
  for (const e of ['', null, undefined, 'a@b', 'a b@c.in', 'a@b.in,c@d.in', 'A <a@b.in>', 'a@b.in\r\nBcc: x@y.in']) assert.equal(validEmail(e), false, String(e));
});

// ── Invoice path ─────────────────────────────────────────────────────────────────────────────────
test('an invoice path must sit under this deal, with no dot or empty segments', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  assert.equal(invoicePathOk(`${id}/1700_invoice.pdf`, id), true);
  for (const p of [`${id}/`, `22222222-2222-2222-2222-222222222222/x.pdf`, `${id}/../other/x.pdf`, `${id}//x.pdf`, `${id}/./x.pdf`, `x${id}/a.pdf`, '', null, 7, {}]) {
    assert.equal(invoicePathOk(p, id), false, String(p));
  }
  assert.equal(invoicePathOk('a/b.pdf', null), false);
});

// ── Tokens ───────────────────────────────────────────────────────────────────────────────────────
test('tokens: 32 random bytes, url-safe, never repeat; the hash is SHA-256 hex', async () => {
  const a = newToken(); const b = newToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokenShapeOk(a), true);
  assert.equal(await hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hashToken(null), await hashToken(''));
});

test('a malformed token is refused before it reaches a query', () => {
  for (const t of ['', null, undefined, 7, {}, 'short', 'a'.repeat(65), `${'a'.repeat(43)}&status=eq.sent`, `${'a'.repeat(43)} `]) {
    assert.equal(tokenShapeOk(t), false, String(t));
  }
});

// ── Partner role stays as it was ─────────────────────────────────────────────────────────────────
test('partners are refused every new read, and it is not on their allowlist', () => {
  for (const a of ['getContractSettings', 'getDealContractDraft', 'getDealInvoiceUrl']) {
    assert.equal(partnerGetRefusal(a, { ignition_external: true, partner_money: true, partner_contacts: true, partner_campaigns: true, partner_all_influencers: true }), 'partner_forbidden');
    assert.ok(!Object.hasOwn(PARTNER_GET_ACTIONS, a));
  }
});

test('nothing contract-shaped reaches a partner, whatever the toggles', () => {
  const view = partnerEngagementView({ engagement: { deliverables: 'x', contract_required: true }, contract: { bank: {} } });
  assert.ok(!('contract' in view));
  const out = stripPartnerFields(view, { partner_money: true, partner_contacts: true });
  assert.deepEqual(out.engagement, {});
});

test('deliverables is frozen with the other deal terms on a complete deal', () => {
  assert.ok(LOCKED_FIELDS.includes('deliverables'));
  assert.ok(!LOCKED_FIELDS.includes('contract_required'));
});

test('a paid deal with not-applicable terms prints no When line', () => {
  const c = compose(deal({ payment_terms: 'n_a' }));
  assert.doesNotMatch(c.body, /When:/);
  assert.match(c.body, /Amount: ₹5,000/);
});
