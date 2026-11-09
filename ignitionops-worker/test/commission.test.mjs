// Monthly affiliate commission (Reann #3 S2) against a fake database and a fake Shopify: the formula,
// the ex-GST net per order, the statement rebuild, verify/reopen and their refusal mapping, the
// affiliate % rule, and the fee sums that must leave commission out. The money rules themselves are
// SQL (migration 0008); these tests pin what the worker asks the database to do.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  orderNetExGst, commissionRateOf, redemptionCommission, commissionStatementRows, rebuildCommissionStatements,
  affiliatePctRefusal, affiliatePctPatchRefusal, commissionRpcResult, snorkelPaymentRow, istMonth, prevMonth, nextMonth,
  AFFILIATE_PCT_REQUIRED,
} from '../src/index.js';

const EID = '11111111-1111-1111-1111-111111111111';
const EID2 = '22222222-2222-2222-2222-222222222222';
const IID = '33333333-3333-3333-3333-333333333333';
const RID = '44444444-4444-4444-4444-444444444444';
const SID = '77777777-7777-7777-7777-777777777777';
const UID = '66666666-6666-6666-6666-666666666666';
const CID = '88888888-8888-8888-8888-888888888888';

// routes: [[METHOD, regex over path+query, status, json | (call) => json]]. First match wins; default 200 [].
function db(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET', at = u.pathname + decodeURIComponent(u.search);
    let body = null;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { body = null; }
    const call = { method, at, prefer: init.headers?.Prefer, body };
    calls.push(call);
    if (u.pathname === '/auth/v1/user') return new Response(JSON.stringify({ id: UID }), { status: 200 });
    const hit = routes.find(([m, re]) => m === method && re.test(at));
    const data = hit ? (typeof hit[3] === 'function' ? hit[3](call) : hit[3]) : [];
    return new Response(JSON.stringify(data), { status: hit ? hit[2] : 200 });
  };
  return calls;
}
const env = () => ({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' });
const as = perms => [
  ['GET', /users_profile/, 200, [{ role: 'staff', full_name: 'Mohit Jain', active: true }]],
  ['GET', /ignition_user_roles/, 200, [{ role_key: 'x' }]],
  ['GET', /ignition_roles/, 200, [{ permissions: { ignition_view: true, ...perms } }]],
];
const post = (e, body) => worker.fetch(new Request('https://w.test/', {
  method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify(body) }), e);
const get = (e, qs) => worker.fetch(new Request(`https://w.test/?${qs}`, { headers: { Authorization: 'Bearer jwt' } }), e);
const writes = (calls, re) => calls.filter(c => c.method !== 'GET' && re.test(c.at));
const rpc = (calls, fn) => calls.filter(c => c.method === 'POST' && c.at.includes(`/rpc/${fn}`));

// ── 1. net ex-GST per order, from a sample Shopify order ──
// Two ₹1,000 toys (GST 18% inside), the code's 10% off → ₹1,800; one returned and refunded → ₹900 left.
// ₹100 shipping carrying ₹15.25 of GST. Line tax left = 900 − 900/1.18 = ₹137.29.
const order = (over = {}) => ({
  id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2026-11-03T10:00:00Z',
  totalPriceSet: { shopMoney: { amount: '1900.00' } }, totalRefundedSet: { shopMoney: { amount: '900.00' } },
  taxesIncluded: true,
  currentSubtotalPriceSet: { shopMoney: { amount: '900.00' } },
  currentTotalTaxSet: { shopMoney: { amount: '152.54' } },
  shippingLine: { taxLines: [{ priceSet: { shopMoney: { amount: '15.25' } } }] },
  ...over,
});

test('net ex-GST, taxes included: subtotal after discount + refund, less the line-item tax only (not shipping tax)', () => {
  assert.equal(orderNetExGst(order()), 762.71);
});

test('net ex-GST, taxes NOT included: the subtotal already excludes GST and shipping', () => {
  assert.equal(orderNetExGst(order({ taxesIncluded: false, currentSubtotalPriceSet: { shopMoney: { amount: '900.00' } },
    currentTotalTaxSet: { shopMoney: { amount: '180.00' } } })), 900);
});

test('net ex-GST: fully refunded is 0, no shipping line is fine, never negative', () => {
  assert.equal(orderNetExGst(order({ currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } },
    currentTotalTaxSet: { shopMoney: { amount: '0.00' } } })), 0);
  assert.equal(orderNetExGst(order({ shippingLine: null, currentTotalTaxSet: { shopMoney: { amount: '137.29' } } })), 762.71);
  assert.equal(orderNetExGst({}), 0);
});

// ── 2. the formula ──
test('commission rate is affiliate_pct on affiliate-type deals only; commission_rate is never read', () => {
  assert.equal(commissionRateOf({ deal_type: 'affiliate', affiliate_pct: '10', commission_rate: 0 }), 10);
  assert.equal(commissionRateOf({ deal_type: 'paid_plus_affiliate', affiliate_pct: 7.5 }), 7.5);
  assert.equal(commissionRateOf({ deal_type: 'barter', affiliate_pct: 10 }), 0);
  assert.equal(commissionRateOf({ deal_type: 'affiliate', affiliate_pct: null, commission_rate: 20 }), 0);
  assert.equal(redemptionCommission(true, 762.71, 10), 76.27);
  assert.equal(redemptionCommission(false, 762.71, 10), 0);
});

test('sync: the order read asks for the ex-GST fields and writes net_ex_gst + commission on affiliate_pct', async () => {
  const calls = db([
    ...as({ ignition_manage: true }),
    ['POST', /admin\/oauth\/access_token/, 200, { access_token: 'shp', expires_in: 3600 }],
    ['POST', /graphql\.json/, 200, { data: { orders: { edges: [{ cursor: 'c1', node: order() }], pageInfo: { hasNextPage: false } } } }],
    ['GET', /coupon_codes\?id=eq\./, 200, [{ id: CID, code: 'ASHALOT', kind: 'affiliate', engagement_id: EID }]],
    ['GET', /engagements\?id=eq\..*affiliate_pct/, 200, [{ affiliate_active_from: '2026-11-01', affiliate_active_to: null, deal_type: 'affiliate', affiliate_pct: 10 }]],
    ['GET', /coupon_redemptions\?coupon_code_id=eq\./, 200, []],
  ]);
  const res = await post({ ...env(), SHOPIFY_STORE_DOMAIN: 'lot.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's' },
    { action: 'syncCouponRedemptions', coupon_code_id: CID });
  assert.equal(res.status, 200);
  const q = calls.find(c => /graphql\.json/.test(c.at)).body.query;
  for (const f of ['taxesIncluded', 'currentSubtotalPriceSet', 'currentTotalTaxSet', 'currentShippingPriceSet', 'shippingLine{ originalPriceSet']) assert.ok(q.includes(f), f);
  const [up] = writes(calls, /coupon_redemptions\?on_conflict/);
  assert.equal(up.body[0].net_value, 1000);
  assert.equal(up.body[0].net_ex_gst, 762.71);
  assert.equal(up.body[0].commission_eligible, true);
  assert.equal(up.body[0].commission_amount, 76.27);
  assert.ok(!calls.some(c => /select=[^&]*commission_rate/.test(c.at)), 'commission_rate is not read by the sync');
});

// ── 3. the rebuild ──
const deals = [{ id: EID, influencer_id: IID, affiliate_pct: 10 }, { id: EID2, influencer_id: IID, affiliate_pct: 5 }];
const codes = [{ id: 'c1', engagement_id: EID }, { id: 'c2', engagement_id: EID }, { id: 'c3', engagement_id: EID2 }];

test('rebuild rows: distinct orders per IST month, refunded orders out, verified skipped, 0 only for an existing estimate', () => {
  const reds = [
    { coupon_code_id: 'c1', shopify_order_id: 'o1', order_date: '2026-11-05T10:00:00Z', net_ex_gst: '1000' },
    { coupon_code_id: 'c2', shopify_order_id: 'o1', order_date: '2026-11-05T10:00:00Z', net_ex_gst: '1000' },   // 2 codes, 1 order
    { coupon_code_id: 'c1', shopify_order_id: 'o2', order_date: '2026-11-30T19:00:00Z', net_ex_gst: '500.5' },  // 1 Dec IST
    { coupon_code_id: 'c1', shopify_order_id: 'o3', order_date: '2026-11-10T10:00:00Z', net_ex_gst: '0' },      // refunded
    { coupon_code_id: 'c3', shopify_order_id: 'o4', order_date: '2026-11-10T10:00:00Z', net_ex_gst: '200' },
  ];
  const rows = commissionStatementRows({ deals, codes, reds, months: ['2026-11', '2026-12'], now: 'T',
    existing: [{ engagement_id: EID2, month: '2026-11', state: 'verified' }, { engagement_id: EID2, month: '2026-12', state: 'estimated' }] });
  const by = Object.fromEntries(rows.map(r => [`${r.engagement_id === EID ? 'A' : 'B'}|${r.month}`, r]));
  assert.deepEqual(Object.keys(by).sort(), ['A|2026-11', 'A|2026-12', 'B|2026-12']);
  assert.deepEqual(by['A|2026-11'], { engagement_id: EID, influencer_id: IID, month: '2026-11', orders: 1, net_sales: 1000, rate: 10,
    estimate: 100, last_computed_at: 'T', updated_at: 'T' });
  assert.equal(by['A|2026-12'].orders, 1);
  assert.equal(by['A|2026-12'].estimate, 50.05);
  assert.equal(by['B|2026-12'].orders, 0);          // an existing estimate falls to 0
  assert.equal(by['B|2026-12'].estimate, 0);
});

test('rebuild: reads verified pairs first, upserts the rest in one batch on (engagement_id, month)', async () => {
  const cur = istMonth();
  const calls = db([
    ['GET', /engagements\?deal_type=in\.\(affiliate,paid_plus_affiliate\)&affiliate_pct=gt\.0/, 200, deals],
    ['GET', /coupon_codes\?engagement_id=in\./, 200, codes],
    ['GET', /commission_statements\?engagement_id=in\./, 200, [{ engagement_id: EID, month: cur, state: 'verified' }]],
    ['GET', /coupon_redemptions\?coupon_code_id=in\..*commission_eligible=is\.true/, 200, [
      { coupon_code_id: 'c1', shopify_order_id: 'o1', order_date: new Date().toISOString(), net_ex_gst: '1000' },
      { coupon_code_id: 'c3', shopify_order_id: 'o2', order_date: new Date().toISOString(), net_ex_gst: '400' },
    ]],
    ['POST', /commission_statements\?on_conflict=engagement_id,month/, 201, null],
  ]);
  const r = await rebuildCommissionStatements(env(), { month: cur });
  assert.equal(r.written, 1);
  const ups = writes(calls, /commission_statements/);
  assert.equal(ups.length, 1);
  assert.match(ups[0].prefer, /merge-duplicates/);
  assert.deepEqual(ups[0].body.map(x => [x.engagement_id, x.orders, x.estimate]), [[EID2, 1, 20]]);   // EID's verified month is not in it
  assert.ok(calls.findIndex(c => /commission_statements\?engagement_id/.test(c.at)) < calls.findIndex(c => c.method === 'POST'));
});

test('rebuild: a future month or one before November 2026 is refused; the POST action is admin-only', async () => {
  assert.ok((await rebuildCommissionStatements(env(), { month: '2026-10' })).error);
  assert.ok((await rebuildCommissionStatements(env(), { month: nextMonth(istMonth()) })).error);
  db([...as({ ignition_manage: true, ignition_commission_verify: true })]);
  assert.equal((await post(env(), { action: 'rebuildCommissionStatements' })).status, 403);
  db([...as({ ignition_admin: true }), ['GET', /engagements\?deal_type/, 200, []]]);
  const ok = await post(env(), { action: 'rebuildCommissionStatements' });
  assert.equal(ok.status, 200);
});

// ── 4. verify / reopen ──
test('verify: one RPC with the verifier and their display name; result returned', async () => {
  const calls = db([...as({ ignition_commission_verify: true }), ['GET', /commission_statements\?id=eq\./, 200, [{ engagement_id: EID, month: '2026-11' }]],
    ['POST', /rpc\/verify_commission_statement/, 200, { ok: true, statement: { id: SID, state: 'verified' }, request: { id: RID, state: 'waiting_for_invoice' } }]]);
  const res = await post(env(), { action: 'verifyCommission', statement_id: SID, amount: '96', reason: ' RTO ' });
  assert.equal(res.status, 200);
  assert.deepEqual(rpc(calls, 'verify_commission_statement')[0].body, {
    p_statement_id: SID, p_amount: 96, p_reason: ' RTO ', p_verified_by: UID, p_verified_by_name: 'Mohit Jain' });
  assert.equal((await res.json()).data.request.state, 'waiting_for_invoice');
  assert.equal(writes(calls, /commission_statements|deal_payment_requests/).length, 0);   // no PATCH + raise
});

test('verify: needs ignition_commission_verify; an amount is required', async () => {
  db([...as({ ignition_manage: true })]);
  assert.equal((await post(env(), { action: 'verifyCommission', statement_id: SID, amount: 1 })).status, 403);
  const calls = db([...as({ ignition_commission_verify: true })]);
  assert.equal((await post(env(), { action: 'verifyCommission', statement_id: SID, amount: '' })).status, 400);
  assert.equal(rpc(calls, 'verify_commission_statement').length, 0);
});

test('verify: each refusal is a plain sentence with its status', async () => {
  const cases = [
    [200, { ok: false, code: 'refused', message: 'Commission for 2026-11 is already verified.' }, 409, /already verified/],
    [200, { ok: false, code: 'not_found', message: 'not_found' }, 404, /no longer exists/],
    [400, { code: 'P0001', hint: 'ignition_commission_month_open', message: '2026-11 can be verified once the month is over.' }, 409, /once the month is over/],
    [400, { code: 'P0001', hint: 'ignition_commission_verified_locked', message: 'Commission for 2026-11 is verified and locked.' }, 409, /locked/],
    [400, { code: 'P0001', hint: 'ignition_commission_raise_failed', message: 'Commission for 2026-11 is already raised.' }, 409, /already raised/],
    [400, { code: '23514', message: 'new row for relation "commission_statements" violates check constraint "commission_statements_verified_complete"' }, 422, /add the reason/],
    [500, { code: 'XX000', message: 'boom' }, 500, /db_error/],
  ];
  for (const [st, body, want, re] of cases) {
    db([...as({ ignition_commission_verify: true }), ['GET', /commission_statements\?id=eq\./, 200, [{ engagement_id: EID, month: '2026-11' }]], ['POST', /rpc\/verify_commission_statement/, st, body]]);
    const res = await post(env(), { action: 'verifyCommission', statement_id: SID, amount: 80 });
    assert.equal(res.status, want, JSON.stringify(body));
    assert.match((await res.json()).error, re);
  }
  assert.equal(commissionRpcResult({ ok: true, data: { ok: true } }), null);
});

test('reopen: admins only, through reopen_commission_statement; a live request refusal is a 409', async () => {
  let calls = db([...as({ ignition_commission_verify: true, ignition_manage: true })]);
  assert.equal((await post(env(), { action: 'reopenCommission', statement_id: SID })).status, 403);
  assert.equal(rpc(calls, 'reopen_commission_statement').length, 0);
  calls = db([...as({ ignition_admin: true }), ['POST', /rpc\/reopen_commission_statement/, 200, { ok: true, statement: { id: SID, state: 'estimated' } }]]);
  assert.equal((await post(env(), { action: 'reopenCommission', statement_id: SID })).status, 200);
  assert.deepEqual(rpc(calls, 'reopen_commission_statement')[0].body, { p_statement_id: SID });
  db([...as({ ignition_admin: true }), ['POST', /rpc\/reopen_commission_statement/, 200,
    { ok: false, code: 'refused', message: 'Commission for 2026-11 is already raised in Snorkel; cancel that request first.' }]]);
  const res = await post(env(), { action: 'reopenCommission', statement_id: SID });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cancel that request first/);
});

test('getCommissionStatements: month list needs verify or reports; per-deal needs view; latest request + month_open', async () => {
  db([...as({})]);
  assert.equal((await get(env(), 'action=getCommissionStatements&month=2026-11')).status, 403);
  const st = { id: SID, engagement_id: EID, influencer_id: IID, month: istMonth(), orders: 2, net_sales: '960', rate: '10', estimate: '96',
    state: 'estimated', verified_amount: null, difference_reason: null, verified_by_name: null, verified_at: null,
    engagement: { engagement_no: 'IGN-2026-00042', deal_type: 'affiliate' },
    influencer: { person_name: 'Asha', channel_name: 'Asha Toys', channel_link: 'https://instagram.com/asha.toys' } };
  const calls = db([...as({}),
    ['GET', /commission_statements\?engagement_id=eq\./, 200, [st, { ...st, id: RID, month: '2026-11' }]],
    ['GET', /deal_payment_requests\?statement_id=in\./, 200, [
      { id: 'r2', statement_id: SID, state: 'submitted', amount: '96', snorkel_request_no: 'PAY-0900', paid_amount: null, utr: null },
      { id: 'r1', statement_id: SID, state: 'rejected', amount: '96', snorkel_request_no: 'PAY-0800', paid_amount: null, utr: null }]]]);
  const res = await get(env(), `action=getCommissionStatements&engagement_id=${EID}`);
  assert.equal(res.status, 200);
  const d = (await res.json()).data;
  assert.equal(d.statements[0].engagement_no, 'IGN-2026-00042');
  assert.deepEqual(d.statements[0].creator, { handle: 'asha.toys', name: 'Asha' });
  assert.equal(d.statements[0].estimate, 96);
  assert.equal(d.statements[0].request.snorkel_request_no, 'PAY-0900');
  assert.equal(d.statements[0].month_open, true);
  assert.equal(d.statements[1].request, null);
  db([...as({ ignition_reports_view: true }), ['GET', /commission_statements\?month=eq\./, 200, []]]);
  const lr = await get(env(), 'action=getCommissionStatements');
  assert.equal(lr.status, 200);
  assert.equal((await lr.json()).data.month, prevMonth(istMonth()));   // default: last IST month
  assert.ok(!calls.some(c => c.method !== 'GET'));
});

// ── 5. affiliate % required ──
test('affiliate %: required on affiliate-type deals, any value on others', () => {
  for (const pct of [null, undefined, '', 0, -1, 101, 'x', true]) assert.equal(affiliatePctRefusal('affiliate', pct), AFFILIATE_PCT_REQUIRED, String(pct));
  assert.equal(affiliatePctRefusal('paid_plus_affiliate', 10), null);
  assert.equal(affiliatePctRefusal('affiliate', '100'), null);
  assert.equal(affiliatePctRefusal('barter', null), null);
});

test('affiliate %: an edit is refused only when the patch itself makes it wrong', () => {
  const legacy = { deal_type: 'affiliate', affiliate_pct: null };
  assert.equal(affiliatePctPatchRefusal(legacy, { payment_amount: 5000 }), null);
  assert.equal(affiliatePctPatchRefusal(legacy, { deal_type: 'affiliate', affiliate_pct: null, payment_amount: 1 }), null);   // deal card re-send
  assert.equal(affiliatePctPatchRefusal({ deal_type: 'paid', affiliate_pct: null }, { deal_type: 'affiliate' }), AFFILIATE_PCT_REQUIRED);
  assert.equal(affiliatePctPatchRefusal({ deal_type: 'paid', affiliate_pct: 10 }, { deal_type: 'affiliate' }), null);
  assert.equal(affiliatePctPatchRefusal({ deal_type: 'affiliate', affiliate_pct: 10 }, { affiliate_pct: null }), AFFILIATE_PCT_REQUIRED);
  assert.equal(affiliatePctPatchRefusal({ deal_type: 'affiliate', affiliate_pct: 10 }, { affiliate_pct: 150 }), AFFILIATE_PCT_REQUIRED);
  assert.equal(affiliatePctPatchRefusal({ deal_type: 'affiliate', affiliate_pct: 10 }, { deal_type: 'paid', affiliate_pct: null }), null);
  assert.equal(affiliatePctPatchRefusal(legacy, { affiliate_pct: 10 }), null);
});

test('createEngagement / updateEngagement: 422 with the sentence; an unrelated patch on the no-% deal saves', async () => {
  let calls = db([...as({ ignition_manage: true })]);
  let res = await post(env(), { action: 'createEngagement', influencer_id: IID, engagement_type: 'video_tracking', deal_type: 'affiliate', poc_user_id: UID });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, AFFILIATE_PCT_REQUIRED);
  assert.equal(writes(calls, /engagements/).length, 0);

  calls = db([...as({ ignition_manage: true }), ['GET', /engagements\?id=eq\..*select=deal_type,affiliate_pct/, 200, [{ deal_type: 'paid', affiliate_pct: null }]]]);
  res = await post(env(), { action: 'updateEngagement', engagement_id: EID, deal_type: 'affiliate' });
  assert.equal(res.status, 422);
  assert.equal(writes(calls, /engagements/).length, 0);

  calls = db([...as({ ignition_manage: true }),
    ['GET', /engagements\?id=eq\..*select=deal_type,affiliate_pct/, 200, [{ deal_type: 'affiliate', affiliate_pct: null }]],
    ['GET', /engagements\?id=eq\..*select=id,stage/, 200, [{ id: EID, stage: 'shipped' }]],   // the COMPLETE-deal lock read
    ['PATCH', /engagements\?id=eq\./, 200, [{ id: EID }]]]);
  res = await post(env(), { action: 'updateEngagement', engagement_id: EID, deal_type: 'affiliate', affiliate_pct: null, payment_terms: 'advance' });
  assert.equal(res.status, 200);
  assert.equal(writes(calls, /engagements\?id=eq\./).length >= 1, true);
});

// ── 6. the S1 hostile-review checklist ──
test('deleteEngagement: a verified commission month refuses before ANY delete', async () => {
  const calls = db([...as({ ignition_manage: true }),
    ['GET', /engagements\?id=eq\..*engagement_no/, 200, [{ id: EID, engagement_no: 'IGN-2026-00042' }]],
    ['GET', /commission_statements\?engagement_id=eq\./, 200, [{ id: SID, state: 'estimated' }, { id: RID, state: 'verified' }]]]);
  const res = await post(env(), { action: 'deleteEngagement', engagement_id: EID });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'has_verified_commission_cannot_delete');
  assert.equal(calls.filter(c => c.method === 'DELETE' || c.method === 'PATCH').length, 0);
});

test('deleteEngagement: estimated statements are deleted before the children and the deal', async () => {
  const calls = db([...as({ ignition_manage: true }),
    ['GET', /engagements\?id=eq\..*engagement_no/, 200, [{ id: EID, engagement_no: 'IGN-2026-00042' }]],
    ['GET', /commission_statements\?engagement_id=eq\..*select=id&limit=1/, 200, []],
    ['GET', /commission_statements\?engagement_id=eq\./, 200, [{ id: SID, state: 'estimated' }]]]);
  const res = await post(env(), { action: 'deleteEngagement', engagement_id: EID });
  assert.equal(res.status, 200);
  const dels = calls.filter(c => c.method === 'DELETE').map(c => c.at.split('?')[0].split('/').pop());
  assert.equal(dels[0], 'commission_statements');
  assert.match(calls.find(c => c.method === 'DELETE').at, /state=eq\.estimated/);
  assert.equal(dels[dels.length - 1], 'engagements');
});

test('addPayment: the hand-log pre-check ignores commission requests', async () => {
  const calls = db([...as({ ignition_manage: true }),
    ['GET', /engagements\?id=eq\..*influencer_id/, 200, [{ influencer_id: IID }]],
    ['POST', /\/payments$/, 201, [{ id: 'p1' }]]]);
  const res = await post(env(), { action: 'addPayment', engagement_id: EID, amount: 100, proof_path: `${EID}/x.png` });
  assert.equal(res.status, 200);
  assert.match(calls.find(c => /deal_payment_requests\?engagement_id/.test(c.at)).at, /kind=neq\.commission/);
});

test('getDealPayments: raised / remaining / paid leave commission out', async () => {
  db([...as({}),
    ['GET', /engagements\?id=eq\./, 200, [{ id: EID, payment_amount: '10000', influencer_id: IID }]],
    ['GET', /deal_payment_requests\?engagement_id/, 200, [
      { id: 'a', kind: 'advance', state: 'approved', amount: '4000' },
      { id: 'c', kind: 'commission', state: 'submitted', amount: '96', statement_id: SID }]],
    ['GET', /payments\?engagement_id/, 200, [
      { amount: '2000', kind: 'other', snorkel_request_id: null },
      { amount: '50', kind: 'commission', snorkel_request_id: 900 }]],
    ['GET', /contract_settings/, 200, [{ published_at: null }]]]);
  const res = await get(env(), `action=getDealPayments&engagement_id=${EID}`);
  assert.equal(res.status, 200);
  const d = (await res.json()).data;
  assert.equal(d.raised_live_total, 4000);
  assert.equal(d.paid_total, 2000);
  assert.equal(d.hand_paid_total, 2000);
  assert.equal(d.remaining, 4000);
  assert.equal(d.commission_paid_total, 50);
  assert.equal(d.requests.length, 2);   // the commission request is still listed
});

test("snorkelPaymentRow: a commission payout is kind 'commission', never 'final'", () => {
  const s = { request_id: 900, paid_amount: 90, tds_amount: 6, paid_at: '2026-12-05T10:00:00Z', payment_ref: 'UTR1', request_no: 'PAY-0900' };
  assert.equal(snorkelPaymentRow({ kind: 'commission', engagement_id: EID, influencer_id: IID, amount: 96 }, s).kind, 'commission');
  assert.equal(snorkelPaymentRow({ kind: 'balance', engagement_id: EID, influencer_id: IID, amount: 96 }, s).kind, 'final');
  assert.equal(snorkelPaymentRow({ kind: 'advance', engagement_id: EID, influencer_id: IID, amount: 96 }, s).kind, 'advance');
});

test('send: a commission request goes through the same claim + Snorkel path, purpose carries the month', async () => {
  const INV = '55555555-5555-5555-5555-555555555555';
  const row = { id: RID, engagement_id: EID, influencer_id: IID, kind: 'commission', statement_id: SID, amount: 96, invoice_id: INV,
    invoice_no: 'INV-9', invoice_date: null, invoice_total: 96, state: 'waiting_for_invoice', updated_at: 'u' };
  const sent = [];
  const e = { ...env(), IGNITION_INTERNAL_TOKEN: 't', SNORKELOPS: { fetch: async (u, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, data: { request_id: 900, request_no: 'PAY-0900', status: 'submitted' } }), { status: 200 });
  } } };
  db([...as({ ignition_manage: true }),
    ['GET', /deal_payment_requests\?id=eq\./, 200, [row]],
    ['POST', /rpc\/claim_deal_payment_send/, 200, { ok: true, row: { ...row, state: 'sending' } }],
    ['GET', /engagements\?id=eq\..*engagement_no/, 200, [{ engagement_no: 'IGN-2026-00042' }]],
    ['GET', /influencers\?id/, 200, [{ id: IID, person_name: 'Asha', channel_name: 'Asha Toys', channel_link: 'https://instagram.com/asha.toys' }]],
    ['GET', /influencer_bank_details/, 200, [{ account_number: '1', ifsc: 'HDFC0001234' }]],
    ['GET', /deal_invoices\?id=eq\./, 200, [{ path: `${EID}/inv.pdf`, file_name: 'inv.pdf', mime: 'application/pdf' }]],
    ['GET', /commission_statements\?id=eq\..*select=month/, 200, [{ month: '2026-11' }]],
    ['PATCH', /deal_payment_requests/, 200, c => [{ ...row, ...c.body }]]]);
  const res = await post(e, { action: 'attachDealPaymentInvoice', request_id: RID, invoice_id: INV, invoice_no: 'INV-9', invoice_total: 96 });
  assert.equal(res.status, 200);
  const raise = sent.find(b => b.action === 'ignitionRaisePayment');
  assert.equal(raise.purpose, 'IGN-2026-00042 · commission 2026-11 · @asha.toys');
  assert.equal(raise.amount_to_pay, 96);
});

// ── S2 review fixes ──
test('net ex-GST: a refunded shipping charge takes its tax with it (not counted as product value)', () => {
  // ₹100 products incl ₹18 GST + ₹118 shipping incl ₹18 GST; shipping fully refunded → tax left ₹18.
  const n = { taxesIncluded: true, currentSubtotalPriceSet: { shopMoney: { amount: '118' } },
    currentTotalTaxSet: { shopMoney: { amount: '18' } }, currentShippingPriceSet: { shopMoney: { amount: '0' } },
    shippingLine: { originalPriceSet: { shopMoney: { amount: '118' } }, taxLines: [{ priceSet: { shopMoney: { amount: '18' } } }] } };
  assert.equal(orderNetExGst(n), 100);
  // shipping kept → its tax is subtracted from the total, line tax = 18
  const kept = { ...n, currentTotalTaxSet: { shopMoney: { amount: '36' } }, currentShippingPriceSet: { shopMoney: { amount: '118' } } };
  assert.equal(orderNetExGst(kept), 100);
});

test('commission per order: nothing before November 2026 (IST), even inside the window', () => {
  assert.equal(redemptionCommission(true, 1000, 10, '2026-10-31T18:30:00Z'), 100);   // 1 Nov 00:00 IST
  assert.equal(redemptionCommission(true, 1000, 10, '2026-10-31T18:29:00Z'), 0);     // 31 Oct 23:59 IST
  assert.equal(redemptionCommission(false, 1000, 10, '2026-11-05T00:00:00Z'), 0);
});

test('rebuild rows: a deal-month with an unsynced (null) ex-GST order is reported as missing', () => {
  const rows = commissionStatementRows({
    deals: [{ id: EID, influencer_id: IID, affiliate_pct: 10 }], codes: [{ id: CID, engagement_id: EID }],
    reds: [{ coupon_code_id: CID, shopify_order_id: 'o1', order_date: '2026-11-03T10:00:00Z', net_ex_gst: null }],
    existing: [], months: ['2026-11'] });
  assert.deepEqual(rows.missing, [`${EID}|2026-11`]);
});

test('verify: refused while one of the month\'s orders has no ex-GST value yet; junk amounts refused', async () => {
  let calls = db([...as({ ignition_commission_verify: true }),
    ['GET', /commission_statements\?id=eq\./, 200, [{ engagement_id: EID, month: '2026-11' }]],
    ['GET', /coupon_codes\?engagement_id=eq\./, 200, [{ id: CID }]],
    ['GET', /coupon_redemptions\?.*net_ex_gst=is\.null/, 200, [{ id: 'r1' }]]]);
  const res = await post(env(), { action: 'verifyCommission', statement_id: SID, amount: 80 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not synced/);
  assert.equal(rpc(calls, 'verify_commission_statement').length, 0);
  for (const bad of ['  ', [], '0x10', '1e3', -5, '12.345']) {
    calls = db([...as({ ignition_commission_verify: true })]);
    assert.equal((await post(env(), { action: 'verifyCommission', statement_id: SID, amount: bad })).status, 400, JSON.stringify(bad));
    assert.equal(rpc(calls, 'verify_commission_statement').length, 0);
  }
});

test('rebuild: only EMPTY estimated rows of non-affiliate deals are removed, one by one', async () => {
  const calls = db([
    ['GET', /engagements\?deal_type/, 200, []],
    ['GET', /commission_statements\?state=eq\.estimated&orders=eq\.0/, 200, [{ id: SID, engagement_id: EID2 }]],
  ]);
  const r = await rebuildCommissionStatements(env(), { month: '2026-11' });
  const dels = calls.filter(c => c.method === 'DELETE');
  assert.equal(dels.length, 1);
  assert.match(dels[0].at, new RegExp(`id=eq\\.${SID}.*orders=eq\\.0`));
  assert.equal(r.removed, 1);
});

test('advanceStage: the affiliate % rule guards this door too', async () => {
  const calls = db([...as({ ignition_manage: true }),
    ['GET', /engagements\?id=eq\..*deal_type,affiliate_pct/, 200, [{ stage: 'proposed', engagement_type: 'video_tracking', deal_type: 'paid', affiliate_pct: null, approved_at: 'x' }]],
    ['GET', /engagements\?id=eq\..*unlocked_until/, 200, [{ id: EID, stage: 'proposed' }]]]);
  const res = await post(env(), { action: 'advanceStage', engagement_id: EID, to_stage: 'planning', deal_type: 'affiliate' });
  const msg = (await res.clone().json()).error;
  assert.match(msg, /%/, msg);
  assert.equal(res.status, 422);
  assert.equal(calls.filter(c => c.method === 'PATCH' && /engagements\?id/.test(c.at)).length, 0);
});
