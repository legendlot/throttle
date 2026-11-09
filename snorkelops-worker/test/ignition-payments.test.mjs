// Reann #2 S2 — Ignition → Snorkel payment requests (plan
// docs/superpowers/plans/2026-11-09-ignition-snorkel-payment-requests.md).
// The REAL worker is imported whole (src/index.js as a module) and driven through its own
// `fetch` handler — POST /internal/ignition, and the user path for the status push — against an
// in-memory Supabase (PostgREST + Storage + Auth) behind a stubbed global fetch. A few source-level
// checks at the bottom pin the wiring that a behavioural test cannot see (every PATCH site pushes).
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const worker = (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src))).default;
const caseBody = name => {
  const i = src.indexOf(`case '${name}': {`);
  assert.ok(i > 0, `case ${name} not found`);
  return src.slice(i, src.indexOf("\n          case '", i + 10));
};

// ── in-memory Supabase ──────────────────────────────────────────────────────
function parseFilters(search) {
  const out = [];
  for (const part of String(search).replace(/^\?/, '').split('&')) {
    const k = part.indexOf('='); if (k < 0) continue;
    const key = part.slice(0, k), val = part.slice(k + 1);
    if (['select', 'order', 'limit'].includes(key)) continue;
    const dot = val.indexOf('.');
    out.push({ key, op: val.slice(0, dot), v: decodeURIComponent(val.slice(dot + 1)) });
  }
  return out;
}
function matches(row, fs) {
  return fs.every(({ key, op, v }) => {
    const x = row[key];
    if (op === 'eq')  return x != null && String(x) === v;
    if (op === 'neq') return x == null || String(x) !== v;
    if (op === 'is')  return v === 'null' ? x == null : v === 'true' ? x === true : x === false;
    if (op === 'in')  return v.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')).includes(String(x));
    throw new Error('fake: unsupported op ' + op);
  });
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const dup = () => json({ code: '23505', message: 'duplicate key value violates unique constraint', details: 'Key (x)=(SECRET)' }, 409);

const INF = 'a1b2c3d4-0000-4000-8000-000000000001';
const USER = 'f0f0f0f0-0000-4000-8000-0000000000aa';
const FIN = 'f1f1f1f1-0000-4000-8000-0000000000bb';
const ACCT = '50100123456789', PAN = 'ABCDE1234F';

function world({ payees = [], banks = [], requests = [], copyOk = true, downloadOk = true, docInsertOk = true, raceDefault = false } = {}) {
  const db = {
    payment_payees: payees.map(p => ({ is_active: true, linked_influencer_id: null, payee_type: 'influencer', pan: null, ...p })),
    payment_payee_banks: banks.map(b => ({ is_active: true, is_default: false, ...b })),
    payment_requests: requests.map(r => ({ ...r })), payment_request_documents: [],
    payment_categories: [{ category_key: 'influencer', label: 'Influencer', po_required: false }],
    payment_settings: [{ id: 1, approval_threshold_inr: 500000 }],
    payment_grants: [{ user_id: FIN, grant_key: 'execute', active: true }],
    payment_notifications: [], activity_log: [],
    users_profile: [{ id: FIN, role: 'finance', full_name: 'Fin', must_change_password: false, active: true }],
    snorkel_user_roles: [], snorkel_roles: [],
  };
  let nextId = 1000, seqN = 0;
  const log = { seq: [], writes: [], copies: [], uploads: [], all: [] };
  const opts = { copyOk, downloadOk, docInsertOk, raceDefault };
  const unique = {
    payment_requests: r => db.payment_requests.some(x => (r.source_system && x.source_system === r.source_system && x.source_ref === r.source_ref) || x.request_no === r.request_no),
    payment_payees: r => (r.linked_influencer_id && db.payment_payees.some(x => x.linked_influencer_id === r.linked_influencer_id)) || db.payment_payees.some(x => x.payee_code === r.payee_code),
    payment_payee_banks: r => r.is_default && (opts.raceDefault || db.payment_payee_banks.some(x => x.payee_id === r.payee_id && x.is_default && x.is_active)),
  };
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    log.all.push([method, u.pathname]);
    if (u.pathname === '/auth/v1/user') return json({ id: FIN, email: 'fin@x' });
    if (u.pathname === '/storage/v1/object/copy') {
      log.copies.push({ ...JSON.parse(init.body), upsert: init.headers?.['x-upsert'] });
      return opts.copyOk ? json({ Key: 'x' }) : json({ error: 'cross-bucket copy refused' }, 400);
    }
    if (u.pathname.startsWith('/storage/v1/object/')) {
      if (method === 'GET') return opts.downloadOk ? new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'application/pdf' } }) : json({}, 404);
      log.uploads.push({ path: u.pathname, upsert: init.headers?.['x-upsert'] });
      return json({ Key: 'x' });
    }
    if (u.pathname === '/rest/v1/rpc/next_seq') { log.seq.push(JSON.parse(init.body).seq_name); return json(++seqN); }
    const table = u.pathname.replace('/rest/v1/', '');
    if (!(table in db)) throw new Error('fake: unknown table ' + table);
    if (method === 'GET') {
      let rows = db[table].filter(r => matches(r, parseFilters(u.search)));
      if (/payee%3Apayment_payees|payee:payment_payees/.test(u.search))
        rows = rows.map(r => ({ ...r, payee: { payee_code: db.payment_payees.find(p => p.id === r.payee_id)?.payee_code } }));
      return json(rows);
    }
    if (method === 'POST') {
      const list = [].concat(JSON.parse(init.body));
      if (table === 'payment_request_documents' && !opts.docInsertOk) return json({ code: 'XX000', message: 'boom' }, 500);
      for (const r of list) if (unique[table] && unique[table](r)) { if (table === 'payment_payee_banks') opts.raceDefault = false; return dup(); }
      const made = list.map(r => ({ id: nextId++, is_active: true, ...r }));
      db[table].push(...made); log.writes.push(['POST', table]);
      return json(made, 201);
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      const hit = db[table].filter(r => matches(r, parseFilters(u.search)));
      hit.forEach(r => Object.assign(r, patch)); log.writes.push(['PATCH', table]);
      return json(hit);
    }
    throw new Error('fake: ' + method);
  };
  const env = { SUPABASE_SERVICE_KEY: 'k', IGNITION_INTERNAL_TOKEN: 'tok' };
  const call = async (action, data, { token = 'tok', e = env } = {}) => {
    const res = await worker.fetch(new Request('https://snorkelops.test/internal/ignition', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token != null ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action, data }),
    }), e, { waitUntil() {} });
    return { status: res.status, body: await res.json() };
  };
  return { db, log, opts, env, call, raise: (o, x) => call('ignitionRaisePayment', raiseInput(o), x) };
}
const raiseInput = (o = {}) => ({
  source_ref: 'dpr-1', influencer: { id: INF, name: 'Riya Sen', channel_name: null, pan: PAN, gstin: null, email: 'r@x.in', phone: '9' },
  bank: { account_name: 'Riya Sen', account_number: ACCT, ifsc: 'HDFC0000001', bank_name: 'HDFC', upi_id: null },
  amount_to_pay: 5000, invoice_no: 'INV-7', invoice_date: '2026-11-09', invoice_total: 10000,
  purpose: 'Advance — reel', requested_by_user_id: USER, requested_by_name: 'Jashwanth',
  invoice_file: { bucket: 'ignition-creator-invoices', path: 'eng-1/inv.pdf', file_name: 'inv.pdf', mime: 'application/pdf', size_bytes: 10 },
  ...o,
});
const noWrites = w => assert.deepEqual(w.log.writes, [], 'nothing written: ' + JSON.stringify(w.log.writes));

// ── raise: happy path + A ordering ──
test('first raise: payee + bank + request + invoice row, deterministic invoice path, doc row BEFORE the Finance notification', async () => {
  const w = world();
  const r = await w.raise();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.data).sort(), ['auto_approved', 'payee_code', 'request_id', 'request_no', 'status']);
  assert.equal(r.body.data.status, 'approved'); assert.equal(r.body.data.auto_approved, true);
  assert.deepEqual(w.log.seq, ['payee', 'pay_request']);
  const p = w.db.payment_payees[0];
  assert.equal(p.payee_type, 'influencer'); assert.equal(p.synced_from, 'ignition'); assert.equal(p.linked_influencer_id, INF);
  const req = w.db.payment_requests[0];
  assert.equal(req.source_system, 'ignition'); assert.equal(req.source_ref, 'dpr-1'); assert.equal(req.category_key, 'influencer');
  assert.equal(req.currency, 'INR'); assert.equal(req.requested_by_user_id, USER); assert.equal(req.requested_by_name, 'Jashwanth');
  assert.equal(req.payee_bank_id, w.db.payment_payee_banks[0].id); assert.equal(w.db.payment_payee_banks[0].is_default, true);
  const doc = w.db.payment_request_documents[0];
  assert.equal(doc.doc_kind, 'invoice'); assert.equal(doc.request_id, req.id); assert.equal(doc.file_path, 'ignition/dpr-1/inv.pdf');
  assert.deepEqual(w.log.copies[0], { bucketId: 'ignition-creator-invoices', sourceKey: 'eng-1/inv.pdf', destinationBucket: 'payment-docs', destinationKey: 'ignition/dpr-1/inv.pdf', upsert: 'true' });
  const order = w.log.writes.map(x => x[1]);
  assert.ok(order.indexOf('payment_request_documents') > order.indexOf('payment_requests'));
  assert.ok(order.indexOf('payment_notifications') > order.indexOf('payment_request_documents'), 'Finance told only after the invoice row');
  assert.equal(w.db.payment_notifications[0].kind, 'payment_needed'); assert.equal(w.db.payment_notifications[0].user_id, FIN);
  // the copy precedes every DB write
  const firstWrite = w.log.all.findIndex(([m, path]) => m !== 'GET' && path.startsWith('/rest/'));
  assert.ok(w.log.all.findIndex(([, path]) => path === '/storage/v1/object/copy') < firstWrite);
});

test('A: invoice copy failure → 502 invoice_copy_failed; no request, no payee, no PAY number, no write at all', async () => {
  const w = world({ copyOk: false, downloadOk: false });
  const r = await w.raise();
  assert.equal(r.status, 502); assert.equal(r.body.error, 'invoice_copy_failed');
  assert.deepEqual(w.log.seq, []); noWrites(w);
});

test('A: cross-bucket copy refused → download + upload with x-upsert to the same deterministic path', async () => {
  const w = world({ copyOk: false });
  const r = await w.raise();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(w.log.uploads, [{ path: '/storage/v1/object/payment-docs/ignition/dpr-1/inv.pdf', upsert: 'true' }]);
});

test('A: invoice row fails → nobody notified; the retry records it and announces it exactly once', async () => {
  const w = world({ docInsertOk: false });
  const a = await w.raise();
  assert.equal(a.status, 502); assert.equal(a.body.error, 'invoice_record_failed'); assert.ok(a.body.request_no);
  assert.equal(w.db.payment_requests.length, 1); assert.equal(w.db.payment_notifications.length, 0);
  w.opts.docInsertOk = true;
  const b = await w.raise();
  assert.equal(b.status, 200, JSON.stringify(b.body)); assert.equal(b.body.data.idempotent, true);
  assert.equal(w.db.payment_request_documents.length, 1); assert.equal(w.db.payment_notifications.length, 1);
  assert.deepEqual(w.log.seq, ['payee', 'pay_request']);
  await w.raise();
  assert.equal(w.db.payment_notifications.length, 1, 'a later replay does not re-announce');
});

// ── F: idempotency / replay ──
test('F: same source_ref + same values → the same row, no second nextSeq4, no second copy', async () => {
  const w = world();
  const a = await w.raise();
  const b = await w.raise();
  assert.equal(b.body.data.request_id, a.body.data.request_id); assert.equal(b.body.data.idempotent, true);
  assert.deepEqual(w.log.seq, ['payee', 'pay_request']);
  assert.equal(w.db.payment_requests.length, 1); assert.equal(w.db.payment_request_documents.length, 1);
  assert.equal(w.log.copies.length, 1);
});

test('F: same source_ref with a different amount or invoice number → 409 source_ref_conflict, nothing written', async () => {
  const w = world();
  await w.raise();
  const writes = w.log.writes.length;
  const x = await w.raise({ amount_to_pay: 4999 });
  assert.equal(x.status, 409); assert.equal(x.body.error, 'source_ref_conflict');
  const y = await w.raise({ invoice_no: 'INV-8' });
  assert.equal(y.status, 409); assert.equal(y.body.error, 'source_ref_conflict');
  assert.equal(w.log.writes.length, writes);
});

test('F: an existing request with no invoice doc is re-attached; if that fails the replay errors, never "success with zero docs"', async () => {
  const seed = { id: 77, request_no: 'PAY-0077', status: 'approved', auto_approved: true, amount_to_pay: 5000, invoice_no: 'INV-7',
                 currency: 'INR', purpose: 'p', payee_id: 1, source_system: 'ignition', source_ref: 'dpr-1' };
  const payees = [{ id: 1, payee_code: 'PAY-0001', name: 'Riya Sen', linked_influencer_id: INF }];
  const bad = world({ requests: [seed], payees, copyOk: false, downloadOk: false });
  const r1 = await bad.raise();
  assert.equal(r1.status, 502); assert.equal(r1.body.error, 'invoice_copy_failed'); assert.equal(r1.body.request_no, 'PAY-0077');
  assert.equal(bad.db.payment_request_documents.length, 0);
  const good = world({ requests: [seed], payees });
  const r2 = await good.raise();
  assert.equal(r2.status, 200); assert.equal(r2.body.data.request_no, 'PAY-0077');
  assert.equal(good.db.payment_request_documents.length, 1); assert.equal(good.db.payment_request_documents[0].request_id, 77);
  assert.deepEqual(good.log.seq, []);
});

// ── B: bank completeness before any payee step ──
test('B: incomplete bank → 400 bank_incomplete with nothing written (and no payee lookup)', async () => {
  for (const bank of [{}, { account_number: ACCT }, { ifsc: 'HDFC0000001' }, { account_number: ACCT, ifsc: 'HDFC000001' },
                      { account_number: ACCT, ifsc: 'hdfc1000001' }, { account_number: '  ', ifsc: ' ', upi_id: ' ' }, 'x', [1]]) {
    const w = world();
    const r = await w.raise({ bank });
    assert.equal(r.status, 400, JSON.stringify(bank)); assert.equal(r.body.error, 'bank_incomplete');
    noWrites(w); assert.deepEqual(w.log.seq, []);
    assert.ok(!w.log.all.some(([, p]) => p === '/rest/v1/payment_payees'), 'payee never touched');
  }
  const ok1 = await world().raise({ bank: { account_number: ACCT, ifsc: ' hdfc0000001 ' } });
  assert.equal(ok1.status, 200, 'IFSC is upper/trimmed before the check');
  const ok2 = await world().raise({ bank: { upi_id: 'riya@okhdfc' } });
  assert.equal(ok2.status, 200);
});

// ── C: linked-but-inactive ──
test('C: linked payee inactive → 409 payee_inactive; never creates a second payee', async () => {
  const w = world({ payees: [{ id: 1, payee_code: 'PAY-0009', name: 'Riya Sen', linked_influencer_id: INF, is_active: false }] });
  const r = await w.raise();
  assert.equal(r.status, 409); assert.equal(r.body.error, 'payee_inactive');
  assert.equal(w.db.payment_payees.length, 1); assert.deepEqual(w.log.seq, []); assert.equal(w.db.payment_requests.length, 0);
});

// ── D + G: bank matching and the default ──
test('D: account+IFSC matches ONLY on account+IFSC; a shared UPI never picks the old account', async () => {
  const seed = () => world({ payees: [{ id: 1, payee_code: 'PAY-0001', name: 'Riya Sen', linked_influencer_id: INF }],
    banks: [{ id: 11, payee_id: 1, account_number: '1111 2222', ifsc: 'icic0000001', upi_id: 'riya@ok', is_default: true }] });
  const a = seed();
  await a.raise({ bank: { account_number: ACCT, ifsc: 'HDFC0000001', upi_id: 'RIYA@ok' } });
  assert.equal(a.db.payment_payee_banks.length, 2, 'new account added despite the shared UPI');
  assert.equal(a.db.payment_requests[0].payee_bank_id, a.db.payment_payee_banks[1].id);
  const b = seed();
  await b.raise({ bank: { account_number: '11112222', ifsc: 'ICIC0000001' } });
  assert.equal(b.db.payment_payee_banks.length, 1); assert.equal(b.db.payment_requests[0].payee_bank_id, 11);
  const c = seed();
  await c.raise({ bank: { upi_id: 'riya@ok' } });
  assert.equal(c.db.payment_payee_banks.length, 2, 'UPI-only input never reuses a row carrying an account');
  const d = world({ payees: [{ id: 1, payee_code: 'PAY-0001', name: 'Riya Sen', linked_influencer_id: INF }],
    banks: [{ id: 12, payee_id: 1, upi_id: 'Riya@OK' }] });
  await d.raise({ bank: { upi_id: ' riya@ok ' } });
  assert.equal(d.db.payment_payee_banks.length, 1); assert.equal(d.db.payment_requests[0].payee_bank_id, 12);
});

test('G: default set only when no active default exists; a one_default race re-inserts non-default instead of 502', async () => {
  const p = [{ id: 1, payee_code: 'PAY-0001', name: 'Riya Sen', linked_influencer_id: INF }];
  const a = world({ payees: p, banks: [{ id: 11, payee_id: 1, account_number: '1', ifsc: 'ICIC0000001', is_default: false }] });
  await a.raise();
  assert.equal(a.db.payment_payee_banks[1].is_default, true, 'no active default → the new one is default');
  const b = world({ payees: p, banks: [{ id: 11, payee_id: 1, account_number: '1', ifsc: 'ICIC0000001', is_default: true }] });
  await b.raise();
  assert.equal(b.db.payment_payee_banks[1].is_default, false);
  const c = world({ payees: p, raceDefault: true });
  const r = await c.raise();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(c.db.payment_payee_banks.length, 1); assert.equal(c.db.payment_payee_banks[0].is_default, false);
});

// ── E: validation before any write ──
test('E: bad amounts, dates and invoice numbers → 400 before nextSeq4 or any write', async () => {
  for (const o of [{ amount_to_pay: 'abc' }, { amount_to_pay: Infinity }, { amount_to_pay: null }, { amount_to_pay: 0 }, { amount_to_pay: -5 },
                   { amount_to_pay: true }, { invoice_total: 'NaN' }, { invoice_total: 0 }, { amount_to_pay: 10001 },
                   { invoice_date: '2026-02-30' }, { invoice_date: '09/11/2026' }, { needed_by: '2026-13-01' }, { needed_by: 'soon' },
                   { invoice_no: '' }, { invoice_no: '   ' }, { invoice_no: 42 }]) {
    const w = world();
    const r = await w.raise(o);
    assert.equal(r.status, 400, JSON.stringify(o)); noWrites(w); assert.deepEqual(w.log.seq, []);
    assert.equal(w.log.copies.length, 0);
  }
  for (const f of [{ bucket: 'payment-docs', path: 'a/b.pdf' }, { bucket: 'ignition-creator-invoices', path: '../x' },
                   { bucket: 'ignition-creator-invoices', path: 'a/%2e%2e/b' }, { bucket: 'ignition-creator-invoices', path: '/a' }]) {
    const w = world();
    assert.equal((await w.raise({ invoice_file: f })).status, 400, JSON.stringify(f)); noWrites(w);
  }
  assert.equal((await world().raise({ needed_by: '2026-12-01' })).status, 200);
});

// ── payee matching (incl. I) ──
test('PAN link: an unlinked hand-made influencer payee with the same PAN (case/space) is linked, not duplicated', async () => {
  const w = world({ payees: [{ id: 1, payee_code: 'PAY-0159', name: 'Someone Else', pan: 'abcde 1234f' }],
                    banks: [{ id: 11, payee_id: 1, account_number: '999', ifsc: 'ICIC0000001', is_default: true }] });
  const r = await w.raise({ bank: null });
  assert.equal(r.body.data.payee_code, 'PAY-0159'); assert.equal(w.db.payment_payees[0].linked_influencer_id, INF);
  assert.deepEqual(w.log.seq, ['pay_request']); assert.equal(w.db.payment_requests[0].payee_bank_id, 11);
});

test('I: legacy payees (no PAN) match on person_name OR channel_name; a different PAN never matches', async () => {
  const banks = [{ id: 11, payee_id: 1, upi_id: 'v@ok', is_default: true }];
  const ch = world({ payees: [{ id: 1, payee_code: 'PAY-0196', name: 'Vyre' }], banks });
  const r = await ch.raise({ bank: null, influencer: { id: INF, name: 'Arjun Rao', channel_name: '  vyre ', pan: PAN } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.payee_code, 'PAY-0196');
  assert.equal(ch.db.payment_payees[0].linked_influencer_id, INF);
  const pn = world({ payees: [{ id: 1, payee_code: 'PAY-0208', name: '  sandhya   MOHAN ' }], banks });
  assert.equal((await pn.raise({ bank: null, influencer: { id: INF, name: 'Sandhya Mohan', pan: null } })).body.data.payee_code, 'PAY-0208');
  const diff = world({ payees: [{ id: 1, payee_code: 'PAY-0208', name: 'Riya Sen', pan: 'ZZZZZ9999Z' }] });
  const r3 = await diff.raise();
  assert.notEqual(r3.body.data.payee_code, 'PAY-0208'); assert.equal(diff.db.payment_payees.length, 2);
});

test('I: ambiguous (two payees, or person_name and channel_name hitting different payees) → payee_ambiguous, nothing written', async () => {
  const a = world({ payees: [{ id: 1, payee_code: 'PAY-0224', name: 'By_ahana' }, { id: 2, payee_code: 'PAY-0225', name: 'by_ahana' }] });
  const r = await a.raise({ influencer: { id: INF, name: 'Ahana', channel_name: 'BY_AHANA', pan: null } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'payee_ambiguous');
  assert.deepEqual(r.body.candidates.sort(), ['PAY-0224', 'PAY-0225']); noWrites(a); assert.deepEqual(a.log.seq, []);
  const b = world({ payees: [{ id: 1, payee_code: 'PAY-0300', name: 'Arjun' }, { id: 2, payee_code: 'PAY-0301', name: 'Vyre' }] });
  const r2 = await b.raise({ influencer: { id: INF, name: 'arjun', channel_name: 'vyre', pan: null } });
  assert.equal(r2.body.error, 'payee_ambiguous'); assert.deepEqual(r2.body.candidates.sort(), ['PAY-0300', 'PAY-0301']); noWrites(b);
});

test('no-bank refusal: no match + no bank, and matched payee without an active bank → no_bank_details, no request', async () => {
  const w1 = world();
  const r1 = await w1.raise({ bank: null });
  assert.equal(r1.body.error, 'no_bank_details'); assert.deepEqual(w1.log.seq, []); assert.equal(w1.db.payment_payees.length, 0);
  const w2 = world({ payees: [{ id: 1, payee_code: 'PAY-0171', name: 'Riya Sen' }],
                     banks: [{ id: 11, payee_id: 1, account_number: '1', ifsc: 'ICIC0000001', is_active: false }] });
  assert.equal((await w2.raise({ bank: null })).body.error, 'no_bank_details'); assert.equal(w2.db.payment_requests.length, 0);
});

test('no response (success, replay, conflict, error, status read) contains the account number or the PAN', async () => {
  const w = world();
  const outs = [await w.raise(), await w.raise(), await w.raise({ amount_to_pay: 1 }), await w.raise({ source_ref: 'dpr-9', influencer: { id: 'nope' } }),
                await w.call('ignitionGetPaymentStatus', { source_refs: ['dpr-1'] })];
  for (const o of outs) {
    const s = JSON.stringify(o.body);
    assert.ok(!s.includes(ACCT) && !s.includes(PAN) && !/account_number|"pan"/.test(s), s);
  }
});

// ── status read ──
test('ignitionGetPaymentStatus: one IN query, the mirror fields, ≤200 refs', async () => {
  const w = world();
  await w.raise();
  const before = w.log.all.length;
  const r = await w.call('ignitionGetPaymentStatus', { source_refs: ['dpr-1', 'dpr-x', 'dpr-1'] });
  assert.equal(w.log.all.length - before, 1);
  assert.deepEqual(Object.keys(r.body.data.requests[0]).sort(),
    ['held_reason', 'paid_amount', 'paid_at', 'payment_ref', 'rejection_note', 'request_id', 'request_no', 'source_ref', 'status', 'tds_amount']);
  assert.deepEqual(r.body.data.missing, ['dpr-x']);
  assert.equal((await w.call('ignitionGetPaymentStatus', { source_refs: Array.from({ length: 201 }, (_, i) => 'r' + i) })).status, 400);
});

// ── auth ──
test('401: unset secret, missing bearer and wrong bearer all refuse before anything is read', async () => {
  const w = world();
  for (const [token, e] of [[null, w.env], ['nope', w.env], ['tok', { SUPABASE_SERVICE_KEY: 'k' }], ['', { SUPABASE_SERVICE_KEY: 'k', IGNITION_INTERNAL_TOKEN: '' }], ['tokX', w.env], ['to', w.env]]) {
    const r = await w.call('ignitionRaisePayment', raiseInput(), { token, e });
    assert.equal(r.status, 401, String(token));
  }
  assert.deepEqual(w.log.all, []);
  assert.match(src, /return !!want && timingSafeEqualStr\(bearer, want\);/);
});

// ── status push, through the real user path ──
test('push: holding an Ignition request POSTs snorkelStatusChanged to IGNITIONOPS; a non-Ignition hold does not', async () => {
  const mk = source => world({ requests: [{ id: 5, request_no: 'PAY-0500', status: 'approved', requested_by_user_id: USER,
    ...(source ? { source_system: 'ignition', source_ref: 'dpr-1' } : { source_system: null, source_ref: null }) }] });
  for (const source of [true, false]) {
    const w = mk(source);
    const calls = [], waits = [];
    const env = { ...w.env, IGNITIONOPS: { fetch: async (u, o) => { calls.push([u, o]); return new Response('{}'); } } };
    const res = await worker.fetch(new Request('https://snorkelops.test/', { method: 'POST', headers: { Authorization: 'Bearer user-jwt' },
      body: JSON.stringify({ action: 'holdPaymentRequest', data: { id: 5, held_reason: 'GSTIN mismatch' } }) }), env, { waitUntil: p => waits.push(p) });
    assert.equal(res.status, 200, await res.clone().text());
    await Promise.all(waits);
    if (!source) { assert.equal(calls.length, 0); continue; }
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://ignitionops/internal/snorkel-status');
    assert.equal(calls[0][1].headers.Authorization, 'Bearer tok');
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body.action, 'snorkelStatusChanged'); assert.equal(body.status, 'held'); assert.equal(body.held_reason, 'GSTIN mismatch');
    assert.equal(body.source_ref, 'dpr-1'); assert.equal(body.request_id, 5);
  }
});

test('push: unbound binding is skipped and a throwing binding never fails the action', async () => {
  for (const IGNITIONOPS of [undefined, { fetch: () => { throw new Error('boom'); } }]) {
    const w = world({ requests: [{ id: 5, request_no: 'PAY-0500', status: 'approved', requested_by_user_id: USER, source_system: 'ignition', source_ref: 'dpr-1' }] });
    const waits = [];
    const res = await worker.fetch(new Request('https://snorkelops.test/', { method: 'POST', headers: { Authorization: 'Bearer user-jwt' },
      body: JSON.stringify({ action: 'holdPaymentRequest', data: { id: 5, held_reason: 'x' } }) }), { ...w.env, IGNITIONOPS }, { waitUntil: p => waits.push(p) });
    assert.equal(res.status, 200);
    await Promise.all(waits);
  }
});

// ── wiring the behavioural tests cannot see ──
test('push is wired on EVERY payment_requests status-writing site, after its PATCH', () => {
  const sites = { approvePaymentRequests: 'movedRows', rejectPaymentRequest: 'rej', holdPaymentRequest: 'row',
                  releasePaymentRequest: 'row', markPaymentPaid: 'moved', cancelPaymentRequest: 'r.data', updatePaymentRef: 'r.data' };
  for (const [name, v] of Object.entries(sites)) {
    const b = caseBody(name);
    const patch = b.indexOf("await update('payment_requests'"), push = b.indexOf(`pushIgnitionStatus(env, ctx, ${v})`);
    assert.ok(patch > 0 && push > patch, `${name}: push after the PATCH`);
  }
  assert.equal(src.split("await update('payment_requests'").length - 1, Object.keys(sites).length, 'a new status-writing site must also push');
  assert.equal((src.match(/^\s+pushIgnitionStatus\(env, ctx, /gm) || []).length, Object.keys(sites).length, 'one push per site');
});

test('createPaymentRequest delegates to the shared core, can never set a source, and keeps one PAY minting site', () => {
  const b = caseBody('createPaymentRequest');
  assert.match(b, /await createPaymentRequestCore\(body\.data \|\| \{\},\s*\{ userId, name: authResult\?\.fullName \|\| null, role: postRole \}\);/);
  assert.equal((src.match(/await nextSeq4\('pay_request'/g) || []).length, 1);
});
