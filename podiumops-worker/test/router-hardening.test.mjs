// Router-level hardening (2026-11-14, Codex review): uuid canonicalisation before any handler, malicious ids rejected
// with no Supabase call, free-text employee codes, the bank tier on getOffer, the PIP threshold on getAppraisals.
// Everything goes through the real worker router (test/router-harness.mjs). Synthetic ids and names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, who, ME, OTHER, UID, EDGE_ME, isEdges } from './router-harness.mjs';
import { canonicalIds, canonicalizeUrlUuids } from '../src/index.js';

const UP = ME.toUpperCase();
const MIXED = ME.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
const BAD = [`${OTHER}&select=*`, 'not-a-uuid'];

// ── canonicalisation ──
test('canonicalIds: only id-bearing keys (id / ids / *_id / *_ids) are lowercased — in arrays and arrays of objects', () => {
  const path = `candidates/${UP}/cv/1_x.pdf`;
  const b = { id: UP, employee_id: MIXED, cycle_id: UP, employee_ids: [UP, MIXED], items: [{ id: UP, note: UP }], Parent_ID: UP,
    code: UP, employee_code: UP, job_title: UP, note: UP, token: UP, path, patch: { manager_id: UP, job_title: UP },
    deep: { list: [[{ application_id: UP }]] }, n: 3, nil: null };
  assert.equal(canonicalIds(b), true);
  assert.deepEqual(b, { id: ME, employee_id: ME, cycle_id: ME, employee_ids: [ME, ME], items: [{ id: ME, note: UP }], Parent_ID: ME,
    code: UP, employee_code: UP, job_title: UP, note: UP, token: UP, path, patch: { manager_id: ME, job_title: UP },
    deep: { list: [[{ application_id: ME }]] }, n: 3, nil: null });
  assert.equal(canonicalIds({ employee_id: `docs/${UP}` }), true);
});
test('canonicalIds: over the depth / node caps → false, never a throw', () => {
  let deep = {}; const root = deep;
  for (let i = 0; i < 12000; i++) { deep.x = {}; deep = deep.x; }
  assert.equal(canonicalIds(root), false);
  assert.equal(canonicalIds({ ids: Array.from({ length: 500001 }, () => 'x') }), false);
  // a realistic bulk body (2,000 rows × 30 fields = 60,000 values) is well inside the cap
  assert.equal(canonicalIds({ rows: Array.from({ length: 2000 }, (_, i) => Object.fromEntries(Array.from({ length: 30 }, (_, j) => ['f' + j, i]))) }), true);
  assert.equal(canonicalIds(null), true);
  assert.equal(canonicalIds([UP]), true);
});
test('canonicalizeUrlUuids: id-keyed query values lowercased (repeats kept); code and other keys untouched', () => {
  const u = new URL(`https://w/?action=a&id=${UP}&code=${UP}&p=${encodeURIComponent(`docs/${UP}.pdf`)}&employee_ids=${UP}&employee_ids=${MIXED}`);
  canonicalizeUrlUuids(u);
  assert.equal(u.searchParams.get('id'), ME);
  assert.equal(u.searchParams.get('code'), UP);
  assert.equal(u.searchParams.get('p'), `docs/${UP}.pdf`);
  assert.deepEqual(u.searchParams.getAll('employee_ids'), [ME, ME]);
});
test('router: a 12,000-deep body → 400 invalid_request, no throw, no Supabase call', async () => {
  let deep = {}; const root = deep;
  for (let i = 0; i < 12000; i++) { deep.x = {}; deep = deep.x; }
  const { res, body, calls } = await call('POST', 'updateEmployee', { as: who.hr, body: { employee_id: OTHER, patch: root } });
  assert.equal(res.status, 400);
  assert.equal(body.error, 'invalid_request');
  assert.deepEqual(calls, []);
});
test('router: an uppercase uuid-shaped code / job_title passes through unchanged', async () => {
  const g = await call('GET', 'getEmployee', { query: { code: UP } });
  assert.ok(g.calls.some(c => c.path.startsWith(`/rest/v1/employees?employee_code=eq.${UP}&`)), 'code kept upper case');
  const { calls } = await call('POST', 'updateEmployee', { as: who.hr, body: { employee_id: OTHER, patch: { job_title: UP } },
    route: () => ({ body: [{ id: OTHER }] }) });
  const patch = calls.find(c => c.method === 'PATCH' && c.path.startsWith(`/rest/v1/employees?id=eq.${OTHER}`));
  assert.equal(patch.body.job_title, UP);
});

// Self-blocks / ownership checks, through the router, with the caller's own id in CAPITALS / mixed case.
const meEdges = (p) => (isEdges(p) ? { body: [EDGE_ME, { id: OTHER, manager_id: ME, auth_user_id: null }] } : { body: [] });
for (const [action, extra] of [['adjustLeave', { delta: 1, note: 'x' }], ['setOpeningBalance', { days: 3 }]]) {
  for (const id of [UP, MIXED]) {
    test(`canonical: ${action} with the caller's own id as ${id === UP ? 'UPPER' : 'mixed'} case → no_self_approval, no write`, async () => {
      // The employee read answers nothing: without canonicalisation this would end as not_found, not the self-block.
      const { body, calls } = await call('POST', action, { as: who.hr, body: { data: { employee_id: id, leave_type: 'PL', ...extra } }, route: meEdges });
      assert.equal(body.error, 'no_self_approval');
      assert.ok(!calls.some(c => c.method === 'POST'));
    });
  }
}
test('canonical: grantLeave with the caller\'s own id in CAPITALS → no_self_approval', async () => {
  const { body, calls } = await call('POST', 'grantLeave', { as: who.hr,
    body: { data: { employee_id: UP, leave_type: 'MATERNITY', start_date: '2026-12-01', note: 'x' } }, route: meEdges });
  assert.equal(body.error, 'no_self_approval');
  assert.ok(!calls.some(c => c.method === 'POST'));
});
test('hrLedgerTarget: the self-block also holds on the LOADED row id (defence in depth)', async () => {
  // A handler path that skipped canonicalisation: call the handler directly with an upper-case id; the loaded row is ME.
  const { adjustLeave } = await import('../src/index.js');
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const p = String(u).replace('https://sb.test', '');
    if (isEdges(p)) return new Response(JSON.stringify([EDGE_ME]));
    if (p.startsWith('/rest/v1/employees?id=in.')) return new Response(JSON.stringify([{ id: ME, leave_policy: 'standard', status: 'active' }]));
    return new Response('[]');
  };
  try {
    const r = await adjustLeave({ data: { employee_id: UP, leave_type: 'PL', delta: 1, note: 'x' } },
      { userId: UID, permissions: { podium_hr: true } }, { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    assert.equal((await r.json()).error, 'no_self_approval');
  } finally { globalThis.fetch = real; }
});
test('canonical: updateEmployee — manager_id = the same person in CAPITALS is still "not your own manager"', async () => {
  const { calls } = await call('POST', 'updateEmployee', { as: who.hr,
    body: { employee_id: OTHER, patch: { manager_id: OTHER.toUpperCase(), job_title: 'T' } }, route: () => ({ body: [{ id: OTHER }] }) });
  const patch = calls.find(c => c.method === 'PATCH' && c.path.startsWith(`/rest/v1/employees?id=eq.${OTHER}`));
  assert.ok(patch, 'the employee PATCH ran');
  assert.equal(patch.body.manager_id, null);
});
test('canonical: getAccomplishments — your own id in CAPITALS is yours (can_add), not a 403', async () => {
  const { res, body } = await call('GET', 'getAccomplishments', { as: who.view, query: { employee_id: UP }, route: meEdges });
  assert.equal(res.status, 200);
  assert.equal(body.data.can_add, true);
});

// ── malicious ids: 400 and NO Supabase call ──
const MAL = [
  ['GET', 'getEmployees', who.view, (v) => ({ query: { department_id: v } })],
  ['GET', 'getEmployee', who.view, (v) => ({ query: { id: v } })],
  ['GET', 'getJobRole', who.view, (v) => ({ query: { id: v } })],
  ['GET', 'getCompensation', who.comp, (v) => ({ query: { employee_id: v } })],
  ['GET', 'getDocuments', who.hr, (v) => ({ query: { employee_id: v } })],
  ['GET', 'getObservations', who.hr, (v) => ({ query: { employee_id: v } })],
  ['GET', 'getAppraisal', who.view, (v) => ({ query: { id: v } })],
  ['GET', 'getObjective', who.view, (v) => ({ query: { id: v } })],
  ['GET', 'getTeamAppraisals', who.view, (v) => ({ query: { cycle_id: v } })],
  ['GET', 'getOkrCycle', who.view, (v) => ({ query: { id: v } })],
  ['GET', 'getAppraisalCycle', who.cal, (v) => ({ query: { id: v } })],
  ['POST', 'updateEmployee', who.hr, (v) => ({ body: { employee_id: v, patch: { job_title: 'x' } } })],
  ['POST', 'deleteDocument', who.hr, (v) => ({ body: { id: v } })],
  ['POST', 'submitSelfReview', who.view, (v) => ({ body: { data: { appraisal_id: v } } })],
  ['POST', 'updateObjective', who.view, (v) => ({ body: { data: { id: v, title: 'x' } } })],
  ['POST', 'setCycleBudget', { ...who.cal, comp: true }, (v) => ({ body: { data: { cycle_id: v, budget_type: 'pct', budget_value: 5 } } })],
  ['POST', 'enrollAppraisalCycle', who.cal, (v) => ({ body: { data: { cycle_id: OTHER, employee_ids: [ME, v] } } })],
  ['POST', 'shareAppraisal', who.cal, (v) => ({ body: { data: { appraisal_ids: [v] } } })],
];
for (const [method, action, as, mk] of MAL) {
  test(`malicious id: ${method} ${action} → 400, no Supabase call`, async () => {
    for (const v of BAD) {
      const { res, calls } = await call(method, action, { as, ...mk(v) });
      assert.equal(res.status, 400, `${action} ${v}`);
      assert.deepEqual(calls, [], `${action} ${v}`);
    }
  });
}
test('malicious id: saveKpiRatings skips a non-uuid KPI id (only the valid one is written)', async () => {
  const APPR = 'abcabcab-cabc-4abc-8abc-abcabcabcabc';
  const { res, calls } = await call('POST', 'submitSelfReview', { as: who.self,
    body: { data: { appraisal_id: APPR, self_overall_rating: 4, kpi_ratings: [{ id: `${OTHER}&select=*`, rating: 3 }, { id: 'x', rating: 2 }, { id: OTHER, rating: 4 }] } },
    route: (p) => (isEdges(p) ? { body: [EDGE_ME] }
      : p.startsWith('/rest/v1/appraisals?id=eq.') ? { body: [{ id: APPR, employee_id: ME, status: 'self_review', cycle: { status: 'active' } }] }
        : { body: [] }) });
  assert.equal(res.status, 200);
  const kpi = calls.filter(c => c.path.startsWith('/rest/v1/appraisal_kpi_ratings'));
  assert.deepEqual(kpi.map(c => c.path), [`/rest/v1/appraisal_kpi_ratings?id=eq.${OTHER}&appraisal_id=eq.${APPR}`]);
});

// ── getEmployee by code: free text, one whole-value-encoded equality ──
for (const code of ['CONTRACT-007', 'EMP-001&select=*', 'A,B', 'X)', 'EMP 9']) {
  test(`getEmployee code ${JSON.stringify(code)}: one encoded employee_code=eq lookup, nothing smuggled`, async () => {
    const { calls } = await call('GET', 'getEmployee', { query: { code } });
    const q = calls.find(c => c.path.includes('employee_code=eq.'));
    assert.ok(q, 'the lookup ran');
    assert.ok(q.path.startsWith(`/rest/v1/employees?employee_code=eq.${encodeURIComponent(code)}&select=*,`), q.path);
    assert.equal(new URL(`https://x${q.path}`).searchParams.get('employee_code'), `eq.${code}`);
    assert.equal(new URL(`https://x${q.path}`).searchParams.getAll('select').length, 1);
  });
}

// ── getAppraisals: the PIP threshold follows the getSettings line ──
test('getAppraisals: pip_rating_threshold only for HR / comp; a plain calibrator gets null', async () => {
  const route = (p) => (p.startsWith('/rest/v1/settings') ? { body: [{ pip_rating_threshold: 2.5, increment_bands: [] }] }
    : p.startsWith('/rest/v1/appraisal_cycles') ? { body: [{ id: OTHER, name: 'FY' }] } : { body: [] });
  const plain = await call('GET', 'getAppraisals', { as: who.cal, query: { cycle_id: OTHER }, route });
  assert.equal(plain.body.data.pip_rating_threshold, null);
  const hr = await call('GET', 'getAppraisals', { as: { ...who.cal, perms: { podium_view: true, podium_hr: true } }, query: { cycle_id: OTHER }, route });
  assert.equal(hr.body.data.pip_rating_threshold, 2.5);
  const comp = await call('GET', 'getAppraisals', { as: { ...who.cal, comp: true }, query: { cycle_id: OTHER }, route });
  assert.equal(comp.body.data.pip_rating_threshold, 2.5);
});

// ── S5: getOffer bank fields ──
const OFFER = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111', OPN = 'aaaabbbb-cccc-4ddd-8eee-ffff00002222';
const APP = 'aaaabbbb-cccc-4ddd-8eee-ffff00003333', CAND = 'aaaabbbb-cccc-4ddd-8eee-ffff00004444';
const offerRoute = (onChain) => (p) => {
  if (p.startsWith('/rest/v1/offers?id=eq.')) return { body: [{ id: OFFER, opening_id: OPN, application_id: APP, candidate_id: CAND, status: 'draft',
    offer_ref: 'OFR-001', revision: 1 }] };
  if (isEdges(p)) return { body: [EDGE_ME] };
  if (p.startsWith('/rest/v1/openings?id=in.')) return { body: [{ id: OPN, opening_code: 'OPN-001', designation: 'D', status: 'open',
    reporting_manager_employee_id: onChain ? ME : null, hiring_owner_employee_id: null }] };
  if (p.startsWith('/rest/v1/candidate_bank_details')) return { body: [{ bank_account_number: '000111222333', bank_ifsc: 'TEST0A1B2C3',
    bank_account_name: 'Test Person', bank_name: 'Test Bank', submitted_at: '2026-11-01T00:00:00Z', editable_until: null }] };
  return { body: [] };
};
test('S5 getOffer: an opening manager gets bank: null and no bank fields anywhere in the response', async () => {
  const { res, body } = await call('GET', 'getOffer', { as: who.view, query: { id: OFFER }, route: offerRoute(true) });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.data.bank, null);
  assert.ok(!('has_bank' in body.data));
  const text = JSON.stringify(body);
  for (const v of ['TEST0A1B2C3', 'Test Bank', 'Test Person', '2333']) assert.ok(!text.includes(v), v);
});
test('S5 getOffer: HR (the bank document tier) gets the masked bank card', async () => {
  const { body } = await call('GET', 'getOffer', { as: who.hr, query: { id: OFFER }, route: offerRoute(false) });
  assert.equal(body.data.bank.bank_ifsc, 'TEST0A1B2C3');
  assert.notEqual(body.data.bank.bank_account_number, '000111222333');
  assert.equal(body.data.can.allow_bank_update, true);
});
test('S5 getOffer: a comp caller on the chain gets the masked bank card (and Reveal)', async () => {
  const { body } = await call('GET', 'getOffer', { as: who.comp, query: { id: OFFER }, route: offerRoute(true) });
  assert.equal(body.data.bank.bank_name, 'Test Bank');
  assert.notEqual(body.data.bank.bank_account_number, '000111222333');
  assert.equal(body.data.can.reveal_bank, true);
});
