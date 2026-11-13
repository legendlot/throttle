// Read latency (2026-11-14): independent reads in the hot GET handlers now start together. These pin the one thing
// that must NOT move — error precedence. A read that used to run only after an earlier read passed its check may now
// run early, but its failure (even a thrown fetch) must not replace the earlier read's 404 / 500. Mocked fetch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deferThrow, getDepartments, getMyProfile, getOfferResponses, getTeamLeave } from '../src/index.js';
import { call, barrier, who, ME, OTHER, EDGE_ME, isEdges } from './router-harness.mjs';

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const AUTH = { userId: '11111111-1111-4111-8111-111111111111', permissions: {} };

// route(path) → { status, body } | 'throw'. Records every path asked for.
async function withFetch(route, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (u) => {
    const path = String(u).replace(ENV.SUPABASE_URL, '');
    calls.push(path);
    const r = route(path);
    if (r === 'throw') throw new Error('network down');
    return new Response(JSON.stringify(r.body ?? []), { status: r.status ?? 200 });
  };
  try { const res = await fn(); return { res, body: await res.json(), calls }; } finally { globalThis.fetch = real; }
}

test('deferThrow: never rejects; the value or the throw comes back only when called', async () => {
  const good = await deferThrow(Promise.resolve(7));
  assert.equal(good(), 7);
  const boom = new Error('x');
  const bad = await deferThrow(Promise.reject(boom));
  assert.throws(() => bad(), (e) => e === boom);
});

test('getDepartments: a failed departments read still answers 500 even when the headcount read throws', async () => {
  const { res, body } = await withFetch((p) => (p.startsWith('/rest/v1/departments') ? { status: 500, body: { message: 'x' } } : 'throw'),
    () => getDepartments(new URL('https://w/?action=getDepartments'), AUTH, ENV));
  assert.equal(res.status, 500);
  assert.equal(body.error, 'db_error');
});

test('getDepartments: happy path unchanged — headcount + founders', async () => {
  const { body } = await withFetch((p) => {
    if (p.startsWith('/rest/v1/departments')) return { body: [{ id: 'd1', name: 'A' }, { id: 'd2', name: 'B' }] };
    if (p.includes('employee_code=in.')) return { body: [{ id: 'f1', full_name: 'F', employee_code: 'X' }] };
    return { body: [{ department_id: 'd1' }, { department_id: 'd1' }, { department_id: null }] };
  }, () => getDepartments(new URL('https://w/'), AUTH, ENV));
  assert.deepEqual(body.data.departments.map(d => d.headcount), [2, 0]);
  assert.equal(body.data.founders.length, 1);
});

test('getMyProfile: the employee read 500 wins over a settings read that throws', async () => {
  const { res, body } = await withFetch((p) => (p.startsWith('/rest/v1/employees') ? { status: 500, body: {} } : 'throw'),
    () => getMyProfile(new URL('https://w/'), AUTH, ENV));
  assert.equal(res.status, 500);
  assert.equal(body.error, 'db_error');
});

test('getMyProfile: no employee row → employee null, even when the settings read throws', async () => {
  const { body } = await withFetch((p) => (p.startsWith('/rest/v1/employees') ? { body: [] } : 'throw'),
    () => getMyProfile(new URL('https://w/'), AUTH, ENV));
  assert.deepEqual(body.data, { employee: null });
});

test('getOfferResponses: the responses 500 / empty answer wins over an org-edges read that throws', async () => {
  const r500 = await withFetch((p) => (p.startsWith('/rest/v1/offer_responses') ? { status: 500, body: {} } : 'throw'),
    () => getOfferResponses(new URL('https://w/'), AUTH, ENV));
  assert.equal(r500.res.status, 500);
  const empty = await withFetch((p) => (p.startsWith('/rest/v1/offer_responses') ? { body: [] } : 'throw'),
    () => getOfferResponses(new URL('https://w/'), AUTH, ENV));
  assert.deepEqual(empty.body.data, { responses: [] });
});

test('getTeamLeave (HR): settings 500 wins over a team read that fails and a pending read that throws', async () => {
  const HR = { ...AUTH, permissions: { podium_hr: true } };
  const { res, body, calls } = await withFetch((p) => {
    if (p.startsWith('/rest/v1/employees?select=id,manager_id')) return { body: [] };   // the org edges
    if (p.startsWith('/rest/v1/leave_settings')) return { status: 500, body: {} };
    if (p.startsWith('/rest/v1/leave_requests')) return 'throw';
    return { status: 500, body: {} };
  }, () => getTeamLeave(new URL('https://w/'), HR, ENV));
  assert.equal(res.status, 500);
  assert.equal(body.error, 'db_error: leave settings');
  assert.ok(!calls.some(p => p.startsWith('/rest/v1/employee_exits')), 'applyOpenExits must not run before the settings check');
});

test('getTeamLeave (HR): settings fine → the team 500 still wins over a pending read that throws', async () => {
  const HR = { ...AUTH, permissions: { podium_hr: true } };
  const { res, body } = await withFetch((p) => {
    if (p.startsWith('/rest/v1/employees?select=id,manager_id')) return { body: [] };
    if (p.startsWith('/rest/v1/leave_settings')) return { body: [{ cutover_month: '2026-04' }] };
    if (p.startsWith('/rest/v1/leave_requests')) return 'throw';
    return { status: 500, body: {} };
  }, () => getTeamLeave(new URL('https://w/'), HR, ENV));
  assert.equal(res.status, 500);
  assert.equal(body.error, 'db_error: leave team');
});

// getMe and getDepartments are deliberately back to HEAD (serial) — no barrier for them; their HEAD behaviour is pinned below.
// ── Concurrency, proven: a barrier holds one read until its sibling has STARTED. The serial code (HEAD) can only get
// past it through the timeout and never overlaps; the parallel code overlaps. Through the real router.

const P = (prefix) => (p) => p.startsWith(prefix);
const withEdges = (extra = () => null) => (p) => extra(p) || (isEdges(p) ? { body: [EDGE_ME, { id: OTHER, manager_id: ME, auth_user_id: null }] } : { body: [] });
const BARRIERS = [
  ['getEmployees', 'GET', who.view, {}, P('/rest/v1/employee_exits?status=eq.open'), P('/rest/v1/employees?status=neq.exited&select=*')],
  ['getEmployee', 'GET', who.view, { id: OTHER }, P('/rest/v1/employees?manager_id=eq.'), P('/rest/v1/employee_exits?status=eq.open'),
    (p) => (p.startsWith(`/rest/v1/employees?id=eq.${OTHER}`) ? { body: [{ id: OTHER }] } : null)],
  ['getMyProfile', 'GET', who.self, {}, P('/rest/v1/employees?auth_user_id=eq.'), P('/rest/v1/settings?id=eq.1&select=profile_campaign')],
  ['getOfferResponses', 'GET', who.view, {}, P('/rest/v1/offer_responses?'), isEdges],
  ['getMyAppraisals', 'GET', who.self, {}, isEdges, P('/rest/v1/appraisal_cycles?')],
  ['getTeamActivity', 'GET', who.hr, {}, P('/rest/v1/employees?id=in.'), P('/rest/v1/observations?')],
  ['getTeamLeave', 'GET', who.hr, {}, P('/rest/v1/leave_settings?'), P('/rest/v1/leave_requests?status=eq.pending')],
];
for (const [action, method, as, query, a, b, extra] of BARRIERS) {
  test(`concurrency: ${action} starts both reads before either answers`, async () => {
    const st = barrier(a, b, withEdges(extra));
    await call(method, action, { as, query, route: st.route });
    assert.equal(st.overlap, true, `${action}: the two reads did not overlap`);
  });
}

// ── Error precedence = HEAD's: a read HEAD awaited first still decides the 500, even when a sibling started with it
// rejects EARLIER. The late read rejects after 25 ms, the early one at once.
const late = (msg) => ({ reject: msg, delay: 25 }), now = (msg) => ({ reject: msg });
const PRECEDENCE = [
  ['getMe: org-edges beats settings', 'getMe', who.view, (p) => (isEdges(p) ? late('edges down')
    : p.startsWith('/rest/v1/settings') ? now('settings down') : { body: [] }), 'edges down'],
  ['getEmployees: open-exits beats the employee list', 'getEmployees', who.view, (p) => (p.startsWith('/rest/v1/employee_exits') ? late('exits down')
    : p.startsWith('/rest/v1/employees?status=') || isEdges(p) ? now('list down') : { body: [] }), 'exits down'],
  ['getMyAppraisals: org-edges beats cycles', 'getMyAppraisals', who.self, (p) => (isEdges(p) ? late('edges down')
    : p.startsWith('/rest/v1/appraisal_cycles') ? now('cycles down') : { body: [] }), 'edges down'],
  ['getDepartments: departments beats headcount', 'getDepartments', who.view, (p) => (p.startsWith('/rest/v1/departments') ? late('departments down')
    : now('headcount down')), 'departments down'],
  ['getDepartments: headcount+founders is ONE group — its first rejection (founders) wins, as HEAD', 'getDepartments', who.view,
    (p) => (p.startsWith('/rest/v1/departments') ? { body: [] } : p.includes('employee_code=in.') ? now('founders down')
      : late('headcount down')), 'founders down'],
];
for (const [title, action, as, route, want] of PRECEDENCE) {
  test(`precedence: ${title}`, async () => {
    const { res, body } = await call('GET', action, { as, route });
    assert.equal(res.status, 500);
    assert.equal(body.error, `server_error: ${want}`);
  });
}

// ── getMe / getDepartments are HEAD's code again (the speed change was dropped for them): pin HEAD's behaviour.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
test('HEAD getDepartments: the departments read answers 500 while the secondaries would stall → db_error at once', async () => {
  const t0 = Date.now();
  const out = await Promise.race([
    call('GET', 'getDepartments', { route: (p) => (p.startsWith('/rest/v1/departments') ? { status: 500, body: {} } : new Promise(() => {})) }),
    sleep(500).then(() => 'stalled'),
  ]);
  assert.notEqual(out, 'stalled');
  assert.equal(out.res.status, 500);
  assert.equal(out.body.error, 'db_error');
  assert.ok(Date.now() - t0 < 400);
  assert.ok(!out.calls.some(c => c.path.startsWith('/rest/v1/employees')), 'no secondary read started');
});
test('HEAD getMe: edges ok at 40 ms, google rejects at 20 ms, hiring rejects at once → "hiring down"', async () => {
  const { res, body } = await call('GET', 'getMe', { as: who.view, route: async (p) => {
    if (isEdges(p)) { await sleep(40); return { body: [EDGE_ME] }; }
    if (p.startsWith('/rest/v1/google_admin_access')) return { reject: 'google down', delay: 20 };
    if (p.startsWith('/rest/v1/openings?or=')) return { reject: 'hiring down' };
    return { body: [] };
  } });
  assert.equal(res.status, 500);
  assert.equal(body.error, 'server_error: hiring down');
});
