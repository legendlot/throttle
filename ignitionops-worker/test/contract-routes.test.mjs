// The contract routes against a fake database: what each one asks the database to do, because the
// races the reviews found live in the shape of the write, not in any pure function.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { publishContractSettings, sendDealContract, updateEngagement, allowBankUpdate } from '../src/index.js';
import { hashToken } from '../src/contract.js';

const TOKEN = 'a'.repeat(43);
const EID = '11111111-1111-1111-1111-111111111111';
const CID = '22222222-2222-2222-2222-222222222222';
const IID = '33333333-3333-3333-3333-333333333333';
const auth = { userId: 'u1', permissions: { ignition_manage: true, ignition_view: true, ignition_admin: true } };
const row = (over = {}) => ({ id: CID, engagement_id: EID, influencer_id: IID, subject: 's', body: 'b', status: 'accepted',
  accepted_at: '2026-11-05T00:00:00Z', deal: { engagement_no: 'IGN-1', stage: 'planning', deal_type: 'paid' }, ...over });
const BANK = { account_name: 'Asha', account_number: '123456789', account_number_confirm: '123456789', ifsc: 'HDFC0001234', bank_name: 'HDFC', pan: 'ABCDE1234F' };

// routes: [[METHOD, regex over path+query, status, json]]. First match wins; default 200 [].
function db(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET', at = u.pathname + decodeURIComponent(u.search);
    calls.push({ method, at, prefer: init.headers?.Prefer, body: init.body ? JSON.parse(init.body) : null });
    const hit = routes.find(([m, re]) => m === method && re.test(at));
    return new Response(JSON.stringify(hit ? hit[3] : []), { status: hit ? hit[2] : 200 });
  };
  return calls;
}
const env = (bridge = { ok: true, data: { message_id: 'g1' } }, status = 200) => {
  const order = [];
  return { order, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k',
    CSOPS: { fetch: async () => { order.push('mail'); return new Response(JSON.stringify(bridge), { status }); } } };
};
const post = (path, body) => worker.fetch(new Request(`https://w.test${path}`, { method: 'POST', body: JSON.stringify({ t: TOKEN, ...body }) }), env());
const tokenRoute = (r) => ['GET', /deal_contracts\?token_hash/, 200, [r]];
const writes = (calls, re) => calls.filter(c => c.method !== 'GET' && re.test(c.at));

test('first bank details insert, ignoring a conflict, so two first submissions cannot overwrite', async () => {
  const calls = db([tokenRoute(row()), ['POST', /influencer_bank_details/, 201, [{ influencer_id: IID }]]]);
  const res = await post('/public/contract/bank', BANK);
  assert.equal(res.status, 200);
  const [w] = writes(calls, /influencer_bank_details/);
  assert.match(w.prefer, /ignore-duplicates/);
  assert.doesNotMatch(w.prefer, /merge-duplicates/);
});

test('bank details on file with no reopen are refused and nothing is changed', async () => {
  const calls = db([tokenRoute(row()), ['POST', /influencer_bank_details/, 201, []], ['PATCH', /influencer_bank_details/, 200, []]]);
  const res = await post('/public/contract/bank', BANK);
  assert.equal(res.status, 409);
  assert.equal(writes(calls, /deal_contracts|engagement_history/).length, 0);
});

test('a reopen only works through the contract it names, and is used up', async () => {
  const calls = db([tokenRoute(row()), ['POST', /influencer_bank_details/, 201, []], ['PATCH', /influencer_bank_details/, 200, [{ influencer_id: IID }]]]);
  assert.equal((await post('/public/contract/bank', BANK)).status, 200);
  const p = writes(calls, /influencer_bank_details/).find(c => c.method === 'PATCH');
  assert.match(p.at, new RegExp(`reopen_contract_id=eq\\.${CID}`));
  assert.match(p.at, /editable_until=gt\./);
  assert.equal(p.body.editable_until, null);
  assert.equal(p.body.reopen_contract_id, null);
});

test('a reopen from another deal does not show this link the bank form', async () => {
  db([tokenRoute(row()), ['GET', /influencer_bank_details/, 200, [{ account_number: '123456789', editable_until: '2099-01-01T00:00:00Z', reopen_contract_id: 'someone-else' }]]]);
  const res = await worker.fetch(new Request(`https://w.test/public/contract?t=${TOKEN}`), env());
  assert.equal((await res.json()).data.bank_editable, false);
});

test('reopening needs an accepted link on this deal', async () => {
  db([['GET', /engagements\?id/, 200, [{ id: EID, influencer_id: IID }]]]);
  const res = await allowBankUpdate({ influencer_id: IID, engagement_id: EID }, auth, env());
  assert.equal(res.status, 409);
});

test('an invoice that was never uploaded is refused', async () => {
  const calls = db([tokenRoute(row()), ['POST', /object\/list/, 200, [{ name: 'real.pdf' }]]]);
  const res = await post('/public/contract/invoice-done', { path: `${EID}/fake.pdf`, file_name: 'fake.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 422);
  assert.equal(writes(calls, /deal_invoices|engagement_history/).length, 0);
});

test('a real invoice is recorded', async () => {
  const calls = db([tokenRoute(row()), ['POST', /object\/list/, 200, [{ name: 'real.pdf' }]]]);
  const res = await post('/public/contract/invoice-done', { path: `${EID}/real.pdf`, file_name: 'real.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 200);
  assert.equal(writes(calls, /deal_invoices/).length, 1);
});

test('the invoice cap counts what is in storage', async () => {
  db([tokenRoute(row()), ['POST', /object\/list/, 200, Array.from({ length: 20 }, (_, i) => ({ name: `${i}.pdf` }))]]);
  const res = await post('/public/contract/invoice-url', { file_name: 'x.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 409);
});

test('a closed deal returns nothing but closed', async () => {
  db([tokenRoute(row({ deal: { engagement_no: 'IGN-1', stage: 'cancelled', deal_type: 'paid' } }))]);
  const res = await worker.fetch(new Request(`https://w.test/public/contract?t=${TOKEN}`), env());
  assert.deepEqual((await res.json()).data, { closed: true });
});

test('accept is POST only: a mail scanner following the link accepts nothing', async () => {
  const calls = db([tokenRoute(row({ status: 'sent', accepted_at: null }))]);
  const res = await worker.fetch(new Request(`https://w.test/public/contract/accept?t=${TOKEN}`), env());
  assert.equal(res.status, 405);
  assert.equal(writes(calls, /deal_contracts/).length, 0);
});

const SETTINGS = { id: 1, published_at: '2026-11-01T00:00:00Z', dos_and_donts: 'd', terms: 't', subject: 's' };
const DEAL = { id: EID, influencer_id: IID, engagement_no: 'IGN-1', engagement_type: 'video_tracking', deal_type: 'paid', stage: 'planning',
  approved_at: 'x', deliverables: '1 reel', expected_post_date: '2026-12-01', payment_amount: '100', payment_terms: 'advance', influencer: { email: 'a@b.co' } };
const sendRoutes = (accepted) => [
  ['GET', /engagements\?id/, 200, [DEAL]],
  ['GET', /contract_settings/, 200, [SETTINGS]],
  ['GET', /deal_contracts.*status=in\.\(accepted,accepted_by_hand\)/, 200, accepted],
  ['POST', /deal_contracts/, 201, [{ id: CID }]],
];
const SEND = { engagement_id: EID, to: 'a@b.co', subject: 's', body: 'contract text' };

test('marking sent cannot undo an acceptance that landed while the mail was going', async () => {
  const calls = db(sendRoutes([]));
  assert.equal((await sendDealContract(SEND, auth, env())).status, 200);
  const toSent = writes(calls, /deal_contracts/).filter(c => c.body?.status === 'sent');
  assert.equal(toSent.length, 1);
  assert.match(toSent[0].at, /status=eq\.sending/);
});

test('an ordinary send never supersedes an accepted row', async () => {
  const calls = db(sendRoutes([]));
  await sendDealContract(SEND, auth, env());
  for (const c of writes(calls, /deal_contracts/).filter(x => x.body?.status === 'superseded')) {
    assert.doesNotMatch(c.at, /accepted/);
  }
});

test('a stated resend clears the acceptance before the mail goes', async () => {
  const calls = db(sendRoutes([{ id: 'old' }]));
  const e = env();
  const orig = globalThis.fetch;
  globalThis.fetch = async (i, o) => { const r = await orig(i, o); if (o?.body?.includes('superseded') && String(i).includes('accepted')) e.order.push('clear'); return r; };
  assert.equal((await sendDealContract({ ...SEND, force_resend: true, note: 'terms changed' }, auth, e)).status, 200);
  assert.deepEqual(e.order, ['clear', 'mail']);
  assert.ok(calls.length);
});

test('if the acceptance cannot be cleared, no mail goes', async () => {
  db([...sendRoutes([{ id: 'old' }]).slice(0, 4), ['PATCH', /status=in\.\(accepted,accepted_by_hand\)/, 500, { message: 'boom' }]]);
  const e = env();
  assert.equal((await sendDealContract({ ...SEND, force_resend: true, note: 'x' }, auth, e)).status, 500);
  assert.deepEqual(e.order, []);
});

test('an accepted contract is not resent by accident', async () => {
  db(sendRoutes([{ id: 'old' }]));
  const e = env();
  assert.equal((await sendDealContract(SEND, auth, e)).status, 409);
  assert.deepEqual(e.order, []);
});

test('the first publish exempts deals already past Planning, a re-publish does not', async () => {
  const words = { id: 1, dos_and_donts: 'd', terms: 't' };
  let calls = db([['GET', /contract_settings/, 200, [{ ...words, published_at: null }]], ['PATCH', /contract_settings/, 200, [words]]]);
  await publishContractSettings({}, auth, env());
  const [ex] = writes(calls, /engagements/);
  assert.match(ex.at, /stage=not\.in\.\(proposed,planning\)/);
  assert.equal(ex.body.contract_required, false);
  calls = db([['GET', /contract_settings/, 200, [{ ...words, published_at: 'x' }]], ['PATCH', /contract_settings/, 200, [words]]]);
  await publishContractSettings({}, auth, env());
  assert.equal(writes(calls, /engagements/).length, 0);
});

test('if the exemption fails the publish is undone', async () => {
  const words = { dos_and_donts: 'd', terms: 't', published_at: null };
  const calls = db([['GET', /contract_settings/, 200, [words]], ['PATCH', /engagements/, 500, {}], ['PATCH', /contract_settings/, 200, [words]]]);
  assert.equal((await publishContractSettings({}, auth, env())).status, 500);
  const w = writes(calls, /contract_settings/);
  assert.equal(w.at(-1).body.published_at, null);
});

test('two publishers: only the one who wins the guarded write exempts deals', async () => {
  const words = { dos_and_donts: 'd', terms: 't', published_at: null };
  const calls = db([['GET', /contract_settings/, 200, [words]], ['PATCH', /published_at=is\.null/, 200, []], ['PATCH', /contract_settings/, 200, [words]]]);
  assert.equal((await publishContractSettings({}, auth, env())).status, 200);
  assert.equal(writes(calls, /engagements/).length, 0);
});

test('a failed mail cannot overwrite an acceptance made during the send', async () => {
  const calls = db(sendRoutes([]));
  assert.equal((await sendDealContract(SEND, auth, env({ ok: false, error: 'no' }, 502))).status, 502);
  // The stuck-send cleanup also writes `failed`, on other rows. This is the write to this send's row.
  const failed = writes(calls, /deal_contracts\?id=eq/).filter(c => c.body?.status === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].at, /status=eq\.sending/);
});

test('a send only supersedes older rows, so a newer send keeps its link', async () => {
  const routes = sendRoutes([]);
  routes[3] = ['POST', /deal_contracts/, 201, [{ id: CID, created_at: '2026-11-05T10:00:00Z' }]];
  const calls = db(routes);
  await sendDealContract(SEND, auth, env());
  const [sup] = writes(calls, /deal_contracts/).filter(c => c.body?.status === 'superseded');
  assert.match(sup.at, /created_at=lt\.2026-11-05T10:00:00Z/);
});

test('a by-hand record with no link is not treated as an acceptance to clear', async () => {
  const calls = db(sendRoutes([]));
  await sendDealContract(SEND, auth, env());
  const read = calls.find(c => c.method === 'GET' && /status=in\.\(accepted,accepted_by_hand\)/.test(c.at));
  assert.match(read.at, /token_hash=not\.is\.null/);
});

test('invoice-done looks for the one file and caps on what is recorded', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `${EID}/${i}.pdf` }));
  const calls = db([tokenRoute(row()), ['POST', /object\/list/, 200, [{ name: 'new.pdf' }]], ['GET', /deal_invoices\?engagement_id=[^&]+&select=path/, 200, many]]);
  const res = await post('/public/contract/invoice-done', { path: `${EID}/new.pdf`, file_name: 'new.pdf', mime: 'application/pdf' });
  assert.equal(res.status, 409);
  assert.equal(calls.find(c => /object\/list/.test(c.at)).body.search, 'new.pdf');
});

test('a deal type cannot be changed after creation', async () => {
  const calls = db([]);
  const res = await updateEngagement({ engagement_id: EID, engagement_type: 'ugc' }, auth, env());
  assert.equal(res.status, 400);
  assert.equal(writes(calls, /engagements/).length, 0);
});

test('token hash is what the lookup uses', async () => {
  const calls = db([tokenRoute(row())]);
  await worker.fetch(new Request(`https://w.test/public/contract?t=${TOKEN}`), env());
  assert.ok(calls.some(c => c.at.includes(await_hash)));
});
const await_hash = await hashToken(TOKEN);
