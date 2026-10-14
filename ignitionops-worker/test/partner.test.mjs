import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  ROSTER_STAGES, PARTNER_TOGGLES, PARTNER_GET_ACTIONS, partnerGetRefusal, stripPartnerFields,
  partnerEngagementView, partnerEmailRefusal, partnerExpiry, partnerParamRefusal,
} from '../src/partner.js';

// §S419-ClearshotPartner — external partner mode. The worker is the control (a partner's JWT can
// call any action directly), so these pin the allowlist, the strip and the auth admission.

test('allowlist: always-open actions pass, toggled ones need their toggle, everything else is refused', () => {
  for (const a of ['getMe', 'getRoster', 'getEngagement', 'getEngagements', 'getInfluencer']) {
    assert.equal(partnerGetRefusal(a, {}), null, a);
  }
  assert.equal(partnerGetRefusal('getCampaigns', {}), 'partner_forbidden');
  assert.equal(partnerGetRefusal('getCampaigns', { partner_campaigns: true }), null);
  assert.equal(partnerGetRefusal('getConnects', {}), 'partner_forbidden');          // Pitstop chats OFF
  assert.equal(partnerGetRefusal('getConnects', { ignition_connects: true }), null);
  assert.equal(partnerGetRefusal('getInfluencers', {}), 'partner_forbidden');       // the bulk list
  // Closed by default: exports, Shopify lookups, payments, admin, prototype keys, unknown names.
  for (const a of ['getPayments', 'getInfluencerShopify', 'searchShopifyCustomer', 'getIgnitionAccess',
    'getPaymentProofUrl', 'getKpis', 'getDiscountCodes', 'toString', '__proto__', 'nope']) {
    assert.equal(partnerGetRefusal(a, { ignition_admin: true, ignition_manage: true }), 'partner_forbidden', a);
  }
});

test('every toggle the allowlist reads is an admin-settable PARTNER_TOGGLE', () => {
  for (const rule of Object.values(PARTNER_GET_ACTIONS)) {
    if (typeof rule === 'string') assert.ok(PARTNER_TOGGLES.includes(rule), rule);
  }
});

test('strip: contact + money + staff keys go at any depth; toggles bring back their own set only', () => {
  const body = { ok: true, data: { engagement: {
    stage: 'live', views: 10, payment_amount: '5000', total_cost: 7000, tracking_id: 'AWB1', poc_name: 'Reann',
    influencer: { channel_name: 'x', contact_number: '99', email: 'a@b.c', address: 'Street', rating_notes: 'n' },
    shipment: { lifecycle: 'delivered', tracking_number: 'T1' },
  }, products: [{ product_code: 'P', goodies_cost: 1, cogs_inr: 2 }] } };
  const none = stripPartnerFields(body, {});
  const e = none.data.engagement;
  assert.deepEqual(Object.keys(e.influencer), ['channel_name']);
  assert.equal(e.payment_amount, undefined); assert.equal(e.total_cost, undefined);
  assert.equal(e.tracking_id, undefined); assert.equal(e.shipment.tracking_number, undefined);
  assert.equal(e.shipment.lifecycle, 'delivered');
  assert.equal(e.poc_name, undefined);
  assert.equal(e.views, 10);
  assert.deepEqual(none.data.products, [{ product_code: 'P' }]);
  assert.equal(body.data.engagement.payment_amount, '5000', 'input not mutated');

  const money = stripPartnerFields(body, { partner_money: true }).data.engagement;
  assert.equal(money.payment_amount, '5000');
  assert.equal(money.influencer.contact_number, undefined);
  assert.equal(money.poc_name, undefined, 'staff names never come back');

  const contacts = stripPartnerFields(body, { partner_contacts: true }).data.engagement;
  assert.equal(contacts.influencer.contact_number, '99');
  assert.equal(contacts.payment_amount, undefined);
});

test('getEngagement partner view drops the audit trail, notes, files, ledgers and staff names', () => {
  const v = partnerEngagementView({ engagement: {}, products: [], videos: [], history: [1], notes: [1],
    attachments: [1], payments: [1], ad_payments: [1], ugc_briefs: [1], approved_by_name: 'A',
    unlocked_by_name: 'B', allowed_next: ['live'], ads: [] });
  assert.deepEqual(Object.keys(v).sort(), ['ads', 'allowed_next', 'engagement', 'products', 'videos']);
  assert.deepEqual(v.allowed_next, []);
});

test('invite: refuses staff domain and junk; expiry must be a future date', () => {
  assert.match(partnerEmailRefusal('reann@legendoftoys.com'), /staff/);
  assert.match(partnerEmailRefusal('Reann@LegendOfToys.com '), /staff/);
  assert.match(partnerEmailRefusal('nope'), /valid email/);
  assert.equal(partnerEmailRefusal('ana@clearshot.in'), null);
  const now = Date.parse('2026-10-14T06:00:00Z');
  assert.equal(partnerExpiry('2027-01-12', now).iso, '2027-01-12T18:29:59.000Z');   // end of day IST
  assert.match(partnerExpiry('2026-10-13', now).error, /future/);
  assert.match(partnerExpiry('', now).error, /required/);
  assert.match(partnerExpiry('soon', now).error, /not a date/);
  assert.match(partnerExpiry('9999-12-31', now).error, /within a year/);
});

// ── Dispatcher, end to end with a mocked Supabase ────────────────────────────────────────────
const ENV = { SUPABASE_URL: 'https://sb', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' };
const PARTNER_PERMS = { ignition_view: true, ignition_external: true };

function mockSupabase({ active = false, perms = PARTNER_PERMS, roleRow = true, rows = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const u = String(input);
    calls.push(u);
    const j = d => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/auth/v1/user')) return j({ id: '11111111-1111-1111-1111-111111111111', email: 'ana@clearshot.in' });
    if (u.includes('/users_profile')) return j([{ role: 'viewer', full_name: 'Ana', active }]);
    if (u.includes('/ignition_user_roles')) return j(roleRow ? [{ role_key: 'ignition_partner' }] : []);
    if (u.includes('/ignition_roles')) return j([{ permissions: perms }]);
    for (const [frag, data] of Object.entries(rows)) if (u.includes(frag)) return j(data);
    return j([]);
  };
  return calls;
}
const get = (action, qs = '') => worker.fetch(
  new Request(`https://w/?action=${action}${qs}`, { headers: { Authorization: 'Bearer t' } }), ENV);

test('auth: an inactive profile is admitted only with an external Ignition role', async () => {
  mockSupabase({ perms: { ignition_view: true, ignition_manage: true } });   // staff role, inactive profile
  assert.equal((await get('getRoster')).status, 401);
  mockSupabase({ roleRow: false });                                          // no (or expired) role row
  assert.equal((await get('getRoster')).status, 401);
  const calls = mockSupabase();
  assert.equal((await get('getMe')).status, 200);
  assert.ok(calls.some(c => c.includes('ignition_user_roles') && c.includes('expires_at.is.null')),
    'role read carries the expiry filter');
});

test('dispatch: partner POST refused, off-list GET refused, getMe keeps the partner email', async () => {
  mockSupabase();
  const post = await worker.fetch(new Request('https://w/', { method: 'POST', headers: { Authorization: 'Bearer t' },
    body: JSON.stringify({ action: 'addNote', engagement_id: 'x', body: 'hi' }) }), ENV);
  assert.equal(post.status, 403);
  assert.equal((await post.json()).error, 'partner_read_only');
  const bulk = await get('getInfluencers', '&limit=200');
  assert.equal(bulk.status, 403);
  assert.equal((await bulk.json()).error, 'partner_forbidden');
  const me = await (await get('getMe')).json();
  assert.equal(me.data.email, 'ana@clearshot.in');
  assert.equal(me.data.ignition_external, true);
  assert.equal(me.data.partner_toggles.partner_money, false);
});

test('dispatch: getEngagements is scoped to ROSTER_STAGES in SQL and the response is stripped', async () => {
  const calls = mockSupabase({ rows: { '/engagements?': [{ id: 'e1', stage: 'live', payment_amount: 9, shipping_order_id: '#LOT1',
    influencer: { channel_name: 'c', contact_number: '9' } }] } });
  const res = await (await get('getEngagements', '&limit=50')).json();
  const q = calls.find(c => c.includes('/engagements?'));
  assert.ok(q.includes(`stage=in.(${ROSTER_STAGES.join(',')})`), q);
  assert.ok(q.indexOf('stage=in.') < q.indexOf('limit='), 'scope applies before the page');
  const e = res.data.engagements[0];
  assert.equal(e.payment_amount, undefined);
  assert.equal(e.shipping_order_id, undefined);
  assert.deepEqual(e.influencer, { channel_name: 'c' });
});

test('dispatch: getEngagement 404s a deal outside the roster stages', async () => {
  mockSupabase({ rows: { '/engagements?id=eq.': [{ id: 'e1', stage: 'planning', influencer: {} }] } });
  assert.equal((await get('getEngagement', '&id=e1')).status, 404);
});

test('dispatch: active staff are untouched — no strip, no allowlist', async () => {
  mockSupabase({ active: true, perms: { ignition_view: true, ignition_manage: true },
    rows: { '/engagements?': [{ id: 'e1', stage: 'planning', payment_amount: 9 }] } });
  const res = await get('getEngagements');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.engagements[0].payment_amount, 9);
});

test('partnerParamRefusal: URL syntax in any partner query value is refused (S419 select= injection)', () => {
  const q = s => new URL('https://x/?' + s).searchParams;
  // The hostile-review payload: %26 decodes to & and would inject a second select= into PostgREST.
  assert.equal(partnerParamRefusal(q('action=getEngagements&date_from=2000-01-01%26select%3D*,payments(*)')), 'partner_bad_param');
  assert.equal(partnerParamRefusal(q('action=getInfluencer&id=abc%3Dx')), 'partner_bad_param');
  assert.equal(partnerParamRefusal(q('action=getEngagements&search=a%23b')), 'partner_bad_param');
  assert.equal(partnerParamRefusal(q('action=getEngagements&search=a%0Ab')), 'partner_bad_param');
  assert.equal(partnerParamRefusal(q('action=getEngagements&date_from=2026-01-01&search=Rohit Sharma&limit=25')), null);
});
