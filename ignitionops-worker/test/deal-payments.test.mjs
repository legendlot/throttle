// Ignition → Snorkel payment requests (Reann #2 S3) against a fake database and a fake snorkelops:
// what each route asks the database and Snorkel to do, because the guards and races live in the
// shape of the writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  snorkelStatusMove, snorkelErrorSentence, snorkelPaymentRow, reconcileDealPayments,
} from '../src/index.js';

const EID = '11111111-1111-1111-1111-111111111111';
const IID = '33333333-3333-3333-3333-333333333333';
const RID = '44444444-4444-4444-4444-444444444444';
const INV = '55555555-5555-5555-5555-555555555555';
const UID = '66666666-6666-6666-6666-666666666666';
const TOK = 'internal-token';

// routes: [[METHOD, regex over path+query, status, json | (call) => json]]. First match wins; default 200 [].
function db(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET', at = u.pathname + decodeURIComponent(u.search);
    const call = { method, at, prefer: init.headers?.Prefer, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (u.pathname === '/auth/v1/user') return new Response(JSON.stringify({ id: UID }), { status: 200 });
    const hit = routes.find(([m, re]) => m === method && re.test(at));
    const data = hit ? (typeof hit[3] === 'function' ? hit[3](call) : hit[3]) : [];
    return new Response(JSON.stringify(data), { status: hit ? hit[2] : 200 });
  };
  return calls;
}
// A fake snorkelops binding: `reply(body)` → [status, json].
function snorkel(reply) {
  const sent = [];
  return { sent, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, auth: init.headers.Authorization, body, signal: !!init.signal });
    const [status, j] = reply(body);
    return new Response(JSON.stringify(j), { status });
  } };
}
const env = (sn = snorkel(() => [200, { ok: true, data: {} }])) =>
  ({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a', IGNITION_INTERNAL_TOKEN: TOK, SNORKELOPS: sn });
const writes = (calls, re) => calls.filter(c => c.method !== 'GET' && re.test(c.at));

// The JWT layer: a manage-level staff user.
const authRoutes = [
  ['GET', /users_profile/, 200, [{ role: 'staff', full_name: 'Jash', active: true }]],
  ['GET', /ignition_user_roles/, 200, [{ role_key: 'lead' }]],
  ['GET', /ignition_roles/, 200, [{ permissions: { ignition_view: true, ignition_manage: true } }]],
];
const post = (e, body) => worker.fetch(new Request('https://w.test/', {
  method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify(body) }), e);

const DEAL = { id: EID, influencer_id: IID, stage: 'planning', payment_amount: '10000', engagement_no: 'IGN-2026-00042' };
const dealRoute = (over = {}) => ['GET', /engagements\?id/, 200, [{ ...DEAL, ...over }]];
const dpr = (over = {}) => ({ id: RID, engagement_id: EID, influencer_id: IID, kind: 'advance', amount: 4000, invoice_id: INV,
  invoice_no: 'INV-1', invoice_date: '2026-11-01', invoice_total: 10000, state: 'waiting_for_invoice', snorkel_request_id: null,
  snorkel_request_no: null, raised_by: UID, raised_by_name: 'Jash', ...over });
const sendReads = [
  ['GET', /influencers\?id/, 200, [{ id: IID, person_name: 'Asha', channel_name: 'Asha Toys', channel_link: 'https://instagram.com/asha.toys', email: 'a@b.co', contact_number: '9999999999' }]],
  ['GET', /influencer_bank_details/, 200, [{ account_name: 'Asha', account_number: '123456789', ifsc: 'HDFC0001234', bank_name: 'HDFC', upi_id: null, pan: 'ABCDE1234F', gstin: null }]],
  ['GET', /deal_invoices\?id=eq\.[^&]+&engagement_id=eq\./, 200, [{ path: `${EID}/inv.pdf`, file_name: 'inv.pdf', mime: 'application/pdf' }]],
];

// RPC replies: {ok,row} | {ok:false,code,message} — the money guard itself is SQL (migration 0006).
const rpcOk = row => ({ ok: true, row });
const rpcNo = (code, message) => ({ ok: false, code, message });
const rpcCalls = (calls, fn) => calls.filter(c => c.method === 'POST' && c.at.includes(`/rpc/${fn}`));
// Snorkel's status read for one row.
const statusReply = (over = {}) => b => b.action === 'ignitionGetPaymentStatus'
  ? [200, { ok: true, data: { requests: [{ source_ref: RID, request_id: 812, request_no: 'PAY-0812', status: 'approved',
      held_reason: null, rejection_note: null, paid_at: null, paid_amount: null, payment_ref: null, tds_amount: null, ...over }], missing: [] } }]
  : [500, { ok: false }];

// ── raiseDealPayment: the guard is ONE atomic RPC; the worker writes no row itself ──
test('raise: goes through raise_deal_payment with the exact args, and writes no row directly', async () => {
  const calls = db([...authRoutes, ['POST', /rpc\/raise_deal_payment/, 200, rpcOk(dpr({ invoice_id: null }))]]);
  const res = await post(env(), { action: 'raiseDealPayment', engagement_id: EID, kind: 'advance', amount: '4000.004' });
  assert.equal(res.status, 200);
  const [c] = rpcCalls(calls, 'raise_deal_payment');
  assert.deepEqual(c.body, { p_engagement_id: EID, p_kind: 'advance', p_amount: 4000, p_raised_by: UID, p_raised_by_name: 'Jash',
    p_invoice_id: null, p_invoice_no: null, p_invoice_date: null, p_invoice_total: null });
  assert.equal(writes(calls, /deal_payment_requests/).length, 0);
});

test('raise: a guard refusal (sum over fee incl. hand log, full vs advance, balance before Live, closed deal) is a 409 with its sentence', async () => {
  for (const msg of ['That would take this deal to ₹10500.00 against the agreed ₹10000.00 (₹4000.00 already raised, ₹6000.00 paid by hand).',
    'An advance or balance is already raised on this deal, so a full payment cannot be added.',
    'The balance can be raised once the deal is Live.', 'This deal is dropped.']) {
    const calls = db([...authRoutes, ['POST', /rpc\/raise_deal_payment/, 200, rpcNo('refused', msg)]]);
    const sn = snorkel(() => [200, { ok: true, data: {} }]);
    const res = await post(env(sn), { action: 'raiseDealPayment', engagement_id: EID, kind: 'full', amount: 1, invoice_id: INV, invoice_no: 'I', invoice_total: 10 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, msg);
    assert.equal(writes(calls, /deal_payment_requests/).length, 0);
    assert.equal(sn.sent.length, 0);
  }
});

test("raise: another deal's invoice is refused by the RPC (it checks engagement_id under the lock)", async () => {
  db([...authRoutes, ['POST', /rpc\/raise_deal_payment/, 200, rpcNo('refused', 'That invoice is not on this deal.')]]);
  const res = await post(env(), { action: 'raiseDealPayment', engagement_id: EID, kind: 'advance', amount: 1000,
    invoice_id: INV, invoice_no: 'INV-1', invoice_total: 10000 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not on this deal/);
});

test('raise: an amount above the invoice total is refused before the RPC', async () => {
  const calls = db([...authRoutes]);
  const res = await post(env(), { action: 'raiseDealPayment', engagement_id: EID, kind: 'advance', amount: 5000, invoice_id: INV, invoice_no: 'I', invoice_total: 4000 });
  assert.equal(res.status, 422);
  assert.equal(rpcCalls(calls, 'raise_deal_payment').length, 0);
});

test('raise with an invoice sends at once: claim RPC, source_ref, purpose, bank and invoice file', async () => {
  const calls = db([...authRoutes, dealRoute(), ...sendReads,
    ['POST', /rpc\/raise_deal_payment/, 200, rpcOk(dpr())],
    ['POST', /rpc\/claim_deal_payment_send/, 200, rpcOk(dpr({ state: 'sending' }))],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const sn = snorkel(() => [200, { ok: true, data: { request_id: 812, request_no: 'PAY-0812', status: 'approved' } }]);
  const res = await post(env(sn), { action: 'raiseDealPayment', engagement_id: EID, kind: 'advance', amount: 4000,
    invoice_id: INV, invoice_no: 'INV-1', invoice_total: 10000, invoice_date: '2026-11-01' });
  assert.equal(res.status, 200);
  assert.equal(rpcCalls(calls, 'claim_deal_payment_send')[0].body.p_id, RID);
  const [s] = sn.sent;
  assert.equal(s.auth, `Bearer ${TOK}`);
  assert.equal(s.body.action, 'ignitionRaisePayment');
  assert.equal(s.body.source_ref, RID);
  assert.equal(s.body.purpose, 'IGN-2026-00042 · advance · @asha.toys');
  assert.equal(s.body.influencer.name, 'Asha');
  assert.equal(s.body.influencer.pan, 'ABCDE1234F');
  assert.equal(s.body.bank.account_number, '123456789');
  assert.deepEqual(s.body.invoice_file, { bucket: 'ignition-creator-invoices', path: `${EID}/inv.pdf`, file_name: 'inv.pdf', mime: 'application/pdf' });
  assert.equal(s.body.requested_by_user_id, UID);
  const [p] = writes(calls, /deal_payment_requests/);
  assert.equal(p.body.state, 'approved');
  assert.equal(p.body.snorkel_request_id, 812);
  assert.match(p.at, /state=eq\.sending/);
  const out = (await res.json()).data.request;
  assert.equal(out.state, 'approved');
  assert.doesNotMatch(JSON.stringify(out), /123456789|ABCDE1234F/);   // nothing bank-shaped back to the browser
});

// ── the send claim + error mapping ──
test('double send: a click that loses the claim (or a fee cut since raising) sends nothing and leaves the row', async () => {
  for (const [code, msg] of [['busy', 'This request is already being sent.'], ['refused', 'This deal is cancelled.']]) {
    const calls = db([...authRoutes, ...sendReads, dealRoute(),
      ['GET', /deal_payment_requests\?id=eq/, 200, [dpr()]],
      ['POST', /rpc\/claim_deal_payment_send/, 200, rpcNo(code, msg)]]);
    const sn = snorkel(() => [200, { ok: true, data: {} }]);
    const res = await post(env(sn), { action: 'attachDealPaymentInvoice', request_id: RID, invoice_id: INV, invoice_no: 'INV-1', invoice_total: 10000 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, msg);
    const [c] = rpcCalls(calls, 'claim_deal_payment_send');
    assert.equal(c.body.p_invoice_id, INV);
    assert.equal(c.body.p_stale_before, null);
    assert.equal(sn.sent.length, 0);
    assert.equal(writes(calls, /deal_payment_requests/).length, 0);
  }
});

test('a Snorkel refusal marks the row send_failed with the plain sentence', async () => {
  const calls = db([...authRoutes, ...sendReads, dealRoute(),
    ['GET', /deal_payment_requests\?id=eq/, 200, [dpr({ state: 'send_failed' })]],
    ['POST', /rpc\/claim_deal_payment_send/, 200, rpcOk(dpr({ state: 'sending' }))],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const sn = snorkel(() => [409, { ok: false, error: 'no_bank_details' }]);
  const res = await post(env(sn), { action: 'retryDealPayment', request_id: RID });
  assert.equal(res.status, 200);
  const [p] = writes(calls, /deal_payment_requests/);
  assert.equal(p.body.state, 'send_failed');
  assert.match(p.at, /state=eq\.sending/);
  assert.equal(p.body.last_error, 'No bank details on file — send the contract so the creator can add them.');
});

test('error sentences: every Snorkel code, network and 5xx', () => {
  assert.match(snorkelErrorSentence(400, { error: 'bank_incomplete' }), /incomplete/);
  assert.match(snorkelErrorSentence(409, { error: 'payee_inactive', candidates: ['PAY-0007'] }), /PAY-0007.*inactive/);
  assert.match(snorkelErrorSentence(409, { error: 'payee_ambiguous', candidates: ['PAY-0001', 'PAY-0002'] }), /PAY-0001, PAY-0002/);
  assert.match(snorkelErrorSentence(409, { error: 'source_ref_conflict', request_no: 'PAY-0812' }), /PAY-0812.*different amount/);
  assert.match(snorkelErrorSentence(502, { error: 'invoice_copy_failed' }), /invoice file could not be copied/);
  assert.match(snorkelErrorSentence(0, null), /could not be reached — retry/);
  assert.match(snorkelErrorSentence(503, null), /error 503/);
  assert.match(snorkelErrorSentence(401, { error: 'unauthorised' }), /not authorised/);
});

// ── cancel ──
test('cancel: refused once the request is in Snorkel; a paid one says so truthfully', async () => {
  let calls = db([...authRoutes, ['GET', /deal_payment_requests\?id=eq/, 200, [dpr({ state: 'approved', snorkel_request_no: 'PAY-0812' })]]]);
  let res = await post(env(), { action: 'cancelDealPayment', request_id: RID });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /ask Finance to cancel it in Snorkel/);
  assert.equal(writes(calls, /deal_payment_requests/).length, 0);
  calls = db([...authRoutes, ['GET', /deal_payment_requests\?id=eq/, 200, [dpr({ state: 'paid', snorkel_request_no: 'PAY-0812' })]]]);
  res = await post(env(), { action: 'cancelDealPayment', request_id: RID });
  assert.match((await res.json()).error, /already paid by Finance/);
});

test('cancel: a send_failed row that reached Snorkel is adopted, not cancelled', async () => {
  const calls = db([...authRoutes, ['GET', /deal_payment_requests\?id=eq/, 200, [dpr({ state: 'send_failed' })]],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const res = await post(env(snorkel(statusReply())), { action: 'cancelDealPayment', request_id: RID });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /\(PAY-0812\) — ask Finance to cancel/);
  const [p] = writes(calls, /deal_payment_requests/);
  assert.equal(p.body.state, 'approved');
  assert.equal(p.body.snorkel_request_id, 812);
});

test('cancel: a send_failed row Finance already PAID is adopted (payments written) and the 409 says paid', async () => {
  const calls = db([...authRoutes, ['GET', /deal_payment_requests\?id=eq/, 200, [dpr({ state: 'send_failed' })]],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const res = await post(env(snorkel(statusReply({ status: 'paid', paid_at: '2026-11-09T06:00:00Z', paid_amount: 3600, tds_amount: 400, payment_ref: 'U1' }))),
    { action: 'cancelDealPayment', request_id: RID });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already paid by Finance \(PAY-0812\)/);
  assert.equal(writes(calls, /payments\?on_conflict/).length, 1);
});

test('cancel: guarded on the exact state read; a send_failed row Snorkel does not have is cancelled', async () => {
  for (const state of ['waiting_for_invoice', 'send_failed']) {
    const calls = db([...authRoutes, ['GET', /deal_payment_requests\?id=eq/, 200, [dpr({ state })]],
      ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
    const sn = snorkel(() => [200, { ok: true, data: { requests: [], missing: [RID] } }]);
    const res = await post(env(sn), { action: 'cancelDealPayment', request_id: RID });
    assert.equal(res.status, 200);
    assert.equal(sn.sent.length, state === 'send_failed' ? 1 : 0);
    const [p] = writes(calls, /deal_payment_requests/);
    assert.match(p.at, new RegExp(`state=eq\\.${state}&`));
    assert.equal(p.body.state, 'cancelled');
  }
});

// ── the receiver: a doorbell ──
const push = (e, body, token = TOK) => worker.fetch(new Request('https://w.test/internal/snorkel-status', {
  method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }), e);
const PUSH = { action: 'snorkelStatusChanged', source_ref: RID, request_id: 812, request_no: 'PAY-0812', status: 'held',
  held_reason: 'PAN mismatch', rejection_note: null, paid_at: null, paid_amount: null, payment_ref: null, tds_amount: null };

test('receiver: 401 with no token, a wrong token, or the secret unset', async () => {
  const calls = db([]);
  assert.equal((await push(env(), PUSH, null)).status, 401);
  assert.equal((await push(env(), PUSH, 'wrong')).status, 401);
  assert.equal((await push({ ...env(), IGNITION_INTERNAL_TOKEN: '' }, PUSH, '')).status, 401);
  assert.equal(calls.length, 0);
});

test('receiver: only a row matching BOTH source_ref and request_id is looked at', async () => {
  const calls = db([['GET', /deal_payment_requests/, 200, []]]);
  const sn = snorkel(statusReply());
  assert.equal((await push(env(sn), PUSH)).status, 404);
  assert.match(calls[0].at, new RegExp(`id=eq\\.${RID}&snorkel_request_id=eq\\.812`));
  assert.equal(writes(calls, /./).length, 0);
  assert.equal(sn.sent.length, 0);
});

test("receiver: the push payload is never applied — Snorkel's current status is re-read and applied", async () => {
  const calls = db([['GET', /deal_payment_requests/, 200, [dpr({ state: 'held', snorkel_request_id: 812 })]],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const sn = snorkel(statusReply({ status: 'approved' }));     // a stale "held" push arrives after release
  assert.equal((await push(env(sn), PUSH)).status, 200);
  assert.deepEqual(sn.sent[0].body, { action: 'ignitionGetPaymentStatus', source_refs: [RID] });
  const [p] = writes(calls, /deal_payment_requests/);
  assert.match(p.at, /state=eq\.held/);
  assert.equal(p.body.state, 'approved');
  assert.equal(p.body.held_reason, null);
});

test('receiver: Snorkel unreachable on the re-read → 502 and nothing written', async () => {
  const calls = db([['GET', /deal_payment_requests/, 200, [dpr({ state: 'approved', snorkel_request_id: 812 })]]]);
  assert.equal((await push(env(snorkel(() => [503, { ok: false }])), PUSH)).status, 502);
  assert.equal(writes(calls, /./).length, 0);
});

test('status moves: held↔approved both ways as Snorkel says; paid/rejected/cancelled terminal', () => {
  assert.equal(snorkelStatusMove('approved', 'held'), 'move');
  assert.equal(snorkelStatusMove('held', 'approved'), 'move');
  assert.equal(snorkelStatusMove('pending_approval', 'approved'), 'move');
  assert.equal(snorkelStatusMove('paid', 'approved'), 'ignore');
  assert.equal(snorkelStatusMove('rejected', 'cancelled'), 'ignore');
  assert.equal(snorkelStatusMove('cancelled', 'paid'), 'ignore');
  assert.equal(snorkelStatusMove('paid', 'paid'), 'refresh');
  assert.equal(snorkelStatusMove('approved', 'bogus'), 'ignore');
  assert.equal(snorkelStatusMove('send_failed', 'approved'), 'move');
});

// ── paid ──
const PAIDS = { status: 'paid', paid_at: '2026-11-09T20:00:00+00:00', paid_amount: 5400, payment_ref: 'UTR123', tds_amount: 600 };
test('paid: payments gets the GROSS (net paid + TDS), TDS kept, IST day, upserted before the request moves', async () => {
  const calls = db([['GET', /deal_payment_requests/, 200, [dpr({ kind: 'balance', state: 'approved', snorkel_request_id: 812 })]],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  assert.equal((await push(env(snorkel(statusReply(PAIDS))), PUSH)).status, 200);
  const w = writes(calls, /./);
  assert.match(w[0].at, /payments\?on_conflict=snorkel_request_id/);
  assert.match(w[0].prefer, /merge-duplicates/);
  const { note, created_by, ...pay } = w[0].body[0];
  assert.deepEqual(pay, { snorkel_request_id: 812, engagement_id: EID, influencer_id: IID, kind: 'final', amount: 6000,
    paid_on: '2026-11-10', utr: 'UTR123', tds_amount: 600 });
  assert.equal(w[1].body.state, 'paid');
  assert.equal(w[1].body.paid_amount, 5400);
});

test('paid: no paid_amount falls back to the requested amount; advance stays advance', () => {
  const p = snorkelPaymentRow(dpr({ kind: 'advance', amount: '4000' }), { request_id: 9, paid_at: null, paid_amount: null, tds_amount: null });
  assert.equal(p.amount, 4000);
  assert.equal(p.kind, 'advance');
});

test('paid: a paid_amount of zero or less is refused and nothing is written', async () => {
  const calls = db([['GET', /deal_payment_requests/, 200, [dpr({ state: 'approved', snorkel_request_id: 812 })]]]);
  assert.equal((await push(env(snorkel(statusReply({ ...PAIDS, paid_amount: 0 }))), PUSH)).status, 500);
  assert.equal(writes(calls, /./).length, 0);
});

test('paid: a UTR edit re-upserts the same payments row (idempotent) and updates the request', async () => {
  const calls = db([['GET', /deal_payment_requests/, 200, [dpr({ state: 'paid', snorkel_request_id: 812, utr: 'UTR123' })]],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  await push(env(snorkel(statusReply({ ...PAIDS, payment_ref: 'UTR999' }))), PUSH);
  const ups = writes(calls, /payments\?on_conflict/);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].body[0].snorkel_request_id, 812);
  assert.equal(ups[0].body[0].utr, 'UTR999');
  assert.equal(writes(calls, /deal_payment_requests/)[0].body.utr, 'UTR999');
});

test('paid: a failed payments write leaves the request open for the reconcile', async () => {
  const calls = db([['GET', /deal_payment_requests/, 200, [dpr({ state: 'approved', snorkel_request_id: 812 })]],
    ['POST', /payments/, 500, { message: 'x' }]]);
  assert.equal((await push(env(snorkel(statusReply(PAIDS))), PUSH)).status, 500);
  assert.equal(writes(calls, /deal_payment_requests/).length, 0);
});

// ── reconcile ──
test('reconcile: open + recently-paid + send_failed rows, in batches of 200; unchanged rows get one write per batch', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => dpr({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, state: 'approved', snorkel_request_id: i + 1 }));
  const calls = db([['GET', /state=eq\.sending/, 200, []], ['GET', /deal_payment_requests\?or=/, 200, rows]]);
  const sn = snorkel(b => [200, { ok: true, data: {
    requests: b.source_refs.map(ref => { const r = rows.find(x => x.id === ref);
      return { source_ref: ref, request_id: r.snorkel_request_id, status: 'approved', held_reason: null, rejection_note: null,
        paid_at: null, paid_amount: null, payment_ref: null, tds_amount: null }; }), missing: [] } }]);
  const out = await reconcileDealPayments(env(sn));
  const q = calls.find(c => /deal_payment_requests\?or=/.test(c.at)).at;
  assert.match(q, /state\.in\.\(submitted,pending_approval,approved,held\),snorkel_request_id\.not\.is\.null/);
  assert.match(q, /and\(state\.eq\.paid,paid_at\.gt\./);
  assert.match(q, /state\.eq\.send_failed/);
  assert.deepEqual(sn.sent.map(s => s.body.source_refs.length), [200, 200, 50]);
  assert.equal(out.checked, 450);
  assert.equal(out.applied, 0);
  assert.equal(writes(calls, /deal_payment_requests\?id=in/).length, 3);
});

test('reconcile: a send_failed row found in Snorkel is adopted (id + status), a changed one goes through the updater', async () => {
  const lost = dpr({ id: '88888888-8888-8888-8888-888888888888', state: 'send_failed' });
  const open = dpr({ state: 'approved', snorkel_request_id: 812 });
  const calls = db([['GET', /state=eq\.sending/, 200, []], ['GET', /deal_payment_requests\?or=/, 200, [lost, open]],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const sn = snorkel(() => [200, { ok: true, data: { requests: [
    { ...PUSH, status: 'rejected', held_reason: null, rejection_note: 'Wrong invoice' },
    { ...PUSH, source_ref: lost.id, request_id: 813, request_no: 'PAY-0813', status: 'pending_approval', held_reason: null }], missing: [] } }]);
  const out = await reconcileDealPayments(env(sn));
  assert.equal(out.adopted, 1);
  assert.equal(out.applied, 1);
  const w = writes(calls, /deal_payment_requests/);
  const adopt = w.find(c => c.at.includes(lost.id));
  assert.equal(adopt.body.snorkel_request_id, 813);
  assert.equal(adopt.body.state, 'pending_approval');
  assert.equal(w.find(c => c.body?.state === 'rejected').body.rejection_note, 'Wrong invoice');
});

test('reconcile: a stuck send is re-claimed with staleBefore and re-sent', async () => {
  const stuck = dpr({ state: 'sending' });
  const calls = db([...sendReads, dealRoute(), ['GET', /state=eq\.sending/, 200, [stuck]], ['GET', /deal_payment_requests\?or=/, 200, []],
    ['POST', /rpc\/claim_deal_payment_send/, 200, rpcOk(stuck)],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const sn = snorkel(() => [200, { ok: true, data: { request_id: 900, request_no: 'PAY-0900', status: 'approved' } }]);
  const out = await reconcileDealPayments(env(sn));
  assert.equal(out.resent, 1);
  assert.ok(rpcCalls(calls, 'claim_deal_payment_send')[0].body.p_stale_before);
  assert.equal(sn.sent[0].body.source_ref, RID);
});

test('reconcile: a stuck send the guard now refuses, or whose payload cannot be built, ends send_failed (never stuck)', async () => {
  // (a) the claim refuses (deal cancelled since)
  let calls = db([['GET', /state=eq\.sending/, 200, [dpr({ state: 'sending' })]], ['GET', /deal_payment_requests\?or=/, 200, []],
    ['POST', /rpc\/claim_deal_payment_send/, 200, rpcNo('refused', 'This deal is cancelled.')],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  const sn = snorkel(() => [200, { ok: true, data: {} }]);
  let out = await reconcileDealPayments(env(sn));
  let [p] = writes(calls, /deal_payment_requests/);
  assert.equal(p.body.state, 'send_failed');
  assert.equal(p.body.last_error, 'This deal is cancelled.');
  assert.match(p.at, /state=eq\.sending/);
  assert.equal(out.failed, 1);
  // (b) the claim succeeds but the payload cannot be built (no requester on the row)
  calls = db([...sendReads, dealRoute(), ['GET', /state=eq\.sending/, 200, [dpr({ state: 'sending', raised_by: null })]], ['GET', /deal_payment_requests\?or=/, 200, []],
    ['POST', /rpc\/claim_deal_payment_send/, 200, rpcOk(dpr({ state: 'sending', raised_by: null }))],
    ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
  out = await reconcileDealPayments(env(sn));
  [p] = writes(calls, /deal_payment_requests/);
  assert.equal(p.body.state, 'send_failed');
  assert.match(p.body.last_error, /No requester/);
  assert.equal(sn.sent.length, 0);
});

// ── delete ──
test('deleteEngagement: 409 has_payment_requests_cannot_delete before any child delete', async () => {
  const calls = db([...authRoutes, ['GET', /engagements\?id/, 200, [{ id: EID, engagement_no: 'IGN-1' }]],
    ['GET', /deal_payment_requests\?engagement_id/, 200, [{ id: RID }]]]);
  const res = await post(env(), { action: 'deleteEngagement', engagement_id: EID });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'has_payment_requests_cannot_delete');
  assert.equal(writes(calls, /./).length, 0);
});

test('deletePayment: a Snorkel payout row cannot be deleted from the hand log', async () => {
  const calls = db([...authRoutes, ['GET', /payments\?id=eq/, 200, [{ proof_path: null, engagement_id: EID, snorkel_request_id: 812 }]]]);
  const res = await post(env(), { action: 'deletePayment', id: 'p1' });
  assert.equal(res.status, 409);
  assert.equal(writes(calls, /./).length, 0);
});

// ── reads ──
test('getDealPayments: totals, and no bank field anywhere in the reply', async () => {
  db([...authRoutes, dealRoute(),
    ['GET', /deal_payment_requests\?engagement_id/, 200, [dpr({ amount: 4000, state: 'paid' }), dpr({ kind: 'balance', amount: 6000, state: 'rejected' })]],
    ['GET', /payments\?engagement_id/, 200, [{ amount: 4000 }]]]);
  const res = await worker.fetch(new Request(`https://w.test/?action=getDealPayments&engagement_id=${EID}`, { headers: { Authorization: 'Bearer jwt' } }), env());
  const d = (await res.json()).data;
  assert.equal(d.agreed, 10000);
  assert.equal(d.raised_live_total, 4000);
  assert.equal(d.paid_total, 4000);
  assert.doesNotMatch(JSON.stringify(d), /account_number|pan|ifsc/i);
});

test('getDealPayments: snorkel_ready follows contract_settings.published_at; invoices + remaining ride along', async () => {
  const get = () => worker.fetch(new Request(`https://w.test/?action=getDealPayments&engagement_id=${EID}`, { headers: { Authorization: 'Bearer jwt' } }), env());
  const base = [...authRoutes, dealRoute(),
    ['GET', /deal_payment_requests\?engagement_id/, 200, [dpr({ amount: 4000, state: 'approved' })]],
    ['GET', /payments\?engagement_id/, 200, [{ amount: 1000, snorkel_request_id: null }]],
    ['GET', /deal_invoices\?engagement_id/, 200, [{ id: INV, file_name: 'inv.pdf', mime: 'application/pdf', uploaded_at: '2026-11-09T00:00:00Z', contract_id: null }]]];
  db([...base, ['GET', /contract_settings/, 200, [{ published_at: null }]]]);
  let d = (await (await get()).json()).data;
  assert.equal(d.snorkel_ready, false);
  assert.equal(d.hand_paid_total, 1000);
  assert.equal(d.remaining, 5000);   // 10000 − 4000 raised − 1000 by hand
  assert.equal(d.invoices[0].id, INV);
  db([...base, ['GET', /contract_settings/, 200, [{ published_at: '2026-11-10T00:00:00Z' }]]]);
  d = (await (await get()).json()).data;
  assert.equal(d.snorkel_ready, true);
  // A failed settings read is an error, never a silent "not ready".
  db([...base, ['GET', /contract_settings/, 500, { message: 'x' }]]);
  assert.equal((await get()).status, 500);
});

// ── staff invoice upload (S4): the creator path's helpers, contract_id null ──
const listRoute = names => ['POST', /object\/list\/ignition-creator-invoices/, 200, names.map(name => ({ name }))];
test('staff invoice: mints into ignition-creator-invoices/<deal>/, same mime list and cap as the creator link', async () => {
  let calls = db([...authRoutes, dealRoute(), listRoute([]),
    ['POST', /object\/upload\/sign\/ignition-creator-invoices\//, 200, { url: '/object/upload/sign/x?token=tk%3D' }]]);
  let res = await post(env(), { action: 'createDealInvoiceUploadUrl', engagement_id: EID, file_name: 'Inv 1.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 200);
  const d = (await res.json()).data;
  assert.equal(d.bucket, 'ignition-creator-invoices');
  assert.match(d.storage_path, new RegExp(`^${EID}/\\d+_Inv_1\\.pdf$`));
  assert.equal(d.token, 'tk=');
  calls = db([...authRoutes, dealRoute(), listRoute([])]);
  res = await post(env(), { action: 'createDealInvoiceUploadUrl', engagement_id: EID, file_name: 'x.docx', mime: 'application/msword' });
  assert.equal(res.status, 422);
  assert.equal(calls.filter(c => /upload\/sign/.test(c.at)).length, 0);
  db([...authRoutes, dealRoute(), listRoute(Array.from({ length: 20 }, (_, i) => `${i}.pdf`))]);
  res = await post(env(), { action: 'createDealInvoiceUploadUrl', engagement_id: EID, file_name: 'x.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 409);
});

test('staff invoice: recorded with contract_id null only once the object is in the bucket; returns the row id', async () => {
  const NEW = '77777777-7777-7777-7777-777777777777';
  const calls = db([...authRoutes, dealRoute(), listRoute(['real.pdf']),
    ['POST', /deal_invoices\?on_conflict=path/, 201, [{ id: NEW }]]]);
  const res = await post(env(), { action: 'uploadDealInvoice', engagement_id: EID, path: `${EID}/real.pdf`, file_name: 'real.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.invoice_id, NEW);
  const [w] = writes(calls, /deal_invoices/);
  assert.equal(w.body[0].contract_id, null);
  assert.equal(w.body[0].engagement_id, EID);
  assert.equal(writes(calls, /engagement_history/)[0].body[0].actor, UID);
});

test("staff invoice: another deal's path, a missing object, or the cap writes nothing", async () => {
  const OTHER = '99999999-9999-9999-9999-999999999999';
  let calls = db([...authRoutes, dealRoute(), listRoute(['real.pdf'])]);
  assert.equal((await post(env(), { action: 'uploadDealInvoice', engagement_id: EID, path: `${OTHER}/real.pdf`, file_name: 'real.pdf' })).status, 403);
  assert.equal((await post(env(), { action: 'uploadDealInvoice', engagement_id: EID, path: `${EID}/../x/real.pdf`, file_name: 'real.pdf' })).status, 403);
  assert.equal((await post(env(), { action: 'uploadDealInvoice', engagement_id: EID, path: `${EID}/fake.pdf`, file_name: 'fake.pdf' })).status, 422);
  assert.equal(writes(calls, /deal_invoices|engagement_history/).length, 0);
  calls = db([...authRoutes, dealRoute(), listRoute(['new.pdf']),
    ['GET', /deal_invoices\?engagement_id/, 200, Array.from({ length: 20 }, (_, i) => ({ id: `id${i}`, path: `${EID}/${i}.pdf` }))]]);
  assert.equal((await post(env(), { action: 'uploadDealInvoice', engagement_id: EID, path: `${EID}/new.pdf`, file_name: 'new.pdf' })).status, 409);
  assert.equal(writes(calls, /deal_invoices|engagement_history/).length, 0);
});

test('staff invoice: view-only users and a missing deal are refused before any storage call', async () => {
  let calls = db([['GET', /users_profile/, 200, [{ role: 'staff', full_name: 'V', active: true }]],
    ['GET', /ignition_user_roles/, 200, [{ role_key: 'viewer' }]],
    ['GET', /ignition_roles/, 200, [{ permissions: { ignition_view: true } }]]]);
  for (const action of ['createDealInvoiceUploadUrl', 'uploadDealInvoice']) {
    assert.equal((await post(env(), { action, engagement_id: EID, file_name: 'x.pdf', mime: 'application/pdf', path: `${EID}/x.pdf` })).status, 403);
  }
  assert.equal(calls.filter(c => /storage\/v1/.test(c.at)).length, 0);
  calls = db([...authRoutes, ['GET', /engagements\?id/, 200, []]]);
  assert.equal((await post(env(), { action: 'createDealInvoiceUploadUrl', engagement_id: EID, file_name: 'x.pdf', mime: 'application/pdf' })).status, 404);
  assert.equal(calls.filter(c => /storage\/v1/.test(c.at)).length, 0);
});

test('getDealPayments: bank_on_file is per deal (account+IFSC or UPI) and only a boolean leaves', async () => {
  const get = () => worker.fetch(new Request(`https://w.test/?action=getDealPayments&engagement_id=${EID}`, { headers: { Authorization: 'Bearer jwt' } }), env());
  const base = [...authRoutes, dealRoute(), ['GET', /contract_settings/, 200, [{ published_at: '2026-11-10T00:00:00Z' }]]];
  const cases = [
    [[{ account_number: '123456789', ifsc: 'HDFC0001234', upi_id: null }], true],
    [[{ account_number: null, ifsc: null, upi_id: 'asha@upi' }], true],
    [[{ account_number: '123456789', ifsc: null, upi_id: null }], false],
    [[], false],
  ];
  for (const [rows, want] of cases) {
    const calls = db([...base, ['GET', new RegExp(`influencer_bank_details\\?influencer_id=eq\\.${IID}`), 200, rows]]);
    const body = await (await get()).text();
    assert.equal(JSON.parse(body).data.bank_on_file, want);
    assert.doesNotMatch(body, /123456789|HDFC0001234|asha@upi/);
    assert.ok(calls.some(c => /influencer_bank_details/.test(c.at)));
  }
  db([...base, ['GET', /influencer_bank_details/, 500, { message: 'x' }]]);
  assert.equal((await get()).status, 500);
});

test('staff invoice: a repeat of an already-recorded path returns its id, with no insert and no history row', async () => {
  const calls = db([...authRoutes, dealRoute(), listRoute(['real.pdf']),
    ['GET', /deal_invoices\?engagement_id/, 200, [{ id: INV, path: `${EID}/real.pdf` }]]]);
  const res = await post(env(), { action: 'uploadDealInvoice', engagement_id: EID, path: `${EID}/real.pdf`, file_name: 'real.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.invoice_id, INV);
  assert.equal(writes(calls, /deal_invoices|engagement_history/).length, 0);
});

// ── S5: owner DM on a move into held/rejected (Snorkel's Slack app sends it; Ignition passes ids only) ──
const notifyReply = (over = {}, notify = [200, { ok: true, data: { sent: true, reason: null } }]) => b =>
  b.action === 'ignitionNotifyOwner' ? notify : statusReply(over)(b);
const OWNER = '77777777-7777-7777-7777-777777777777';

test('S5: a move into held or rejected asks Snorkel to DM the owner — source_ref only, once, time-boxed', async () => {
  for (const status of ['held', 'rejected']) {
    db([['GET', /deal_payment_requests/, 200, [dpr({ state: 'approved', snorkel_request_id: 812 })]],
      ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
    const sn = snorkel(notifyReply({ status, held_reason: 'PAN mismatch' }));
    assert.equal((await push(env(sn), { ...PUSH, status })).status, 200);
    const dm = sn.sent.filter(s => s.body.action === 'ignitionNotifyOwner');
    assert.equal(dm.length, 1, status);
    assert.deepEqual(dm[0].body, { action: 'ignitionNotifyOwner', source_ref: RID });
    assert.equal(dm[0].auth, `Bearer ${TOK}`);
    assert.equal(dm[0].signal, true);
    assert.equal(sn.sent.find(s => s.body.action === 'ignitionGetPaymentStatus').signal, false);
  }
});

test('S5: no DM on a refresh (held → held), on release (held → approved), or on paid', async () => {
  for (const [from, to] of [['held', 'held'], ['held', 'approved'], ['approved', 'paid']]) {
    db([['GET', /deal_payment_requests/, 200, [dpr({ state: from, snorkel_request_id: 812 })]],
      ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]],
      ['POST', /payments/, 200, [{ id: 'p1' }]]]);
    const sn = snorkel(notifyReply(to === 'paid' ? PAIDS : { status: to }));
    await push(env(sn), { ...PUSH, status: to });
    assert.equal(sn.sent.filter(s => s.body.action === 'ignitionNotifyOwner').length, 0, `${from}→${to}`);
  }
});

test('S5: a failed or refused DM never fails the status update', async () => {
  for (const notify of [[500, { ok: false, error: 'slack down' }], [200, { ok: true, data: { sent: false, reason: 'no_owner' } }]]) {
    const calls = db([['GET', /deal_payment_requests/, 200, [dpr({ state: 'approved', snorkel_request_id: 812 })]],
      ['PATCH', /deal_payment_requests/, 200, c => [dpr({ ...c.body })]]]);
    const sn = snorkel(notifyReply({ status: 'held' }, notify));
    assert.equal((await push(env(sn), PUSH)).status, 200);
    assert.equal(writes(calls, /deal_payment_requests/)[0].body.state, 'held');
  }
});
