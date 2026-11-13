// Self-serve authorization audit (2026-11-14): S1 cycle budget, S2 settings bands, S3 id validation, S4 own-ledger
// self-block, S5 candidate bank tier. Pure projections + mocked fetch + a static sweep. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  projectSettings, SETTINGS_HR_COMP_FIELDS, cycleForViewer, bankVisible,
  getEmployee, getSettings, getAppraisal, setOpeningBalance, adjustLeave,
  getAppraisalCycles, getAppraisalCycle, getCycleOverview, getAppraisals, getEnrollmentPreview, createAppraisalCycle,
  verifyJWT, employeeSearchFilter, EMPLOYEE_SEARCH_COLUMNS,
} from '../src/index.js';

const SRC = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const ME = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const APPR = '33333333-3333-4333-8333-333333333333';
const VIEW = { userId: 'u-view', permissions: { podium_view: true } };
const HR = { userId: 'u-hr', permissions: { podium_hr: true } };
const COMP = { userId: 'u-comp', permissions: { podium_view: true }, compAccess: true };

async function withFetch(route, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (u, o = {}) => {
    const path = String(u).replace(ENV.SUPABASE_URL, '');
    calls.push({ path, method: o.method || 'GET' });
    const r = route(path, o);
    return new Response(JSON.stringify(r?.body ?? []), { status: r?.status ?? 200 });
  };
  try { const res = await fn(); return { res, body: await res.json(), calls }; } finally { globalThis.fetch = real; }
}

// ── S2 ──
test('S2 projectSettings: bands + PIP threshold only for HR / comp (the getAppraisalConfig line)', () => {
  const row = { id: 1, comp_vault_enabled: true, min_tenure_days: 90, increment_bands: [{ min: 1 }], pip_rating_threshold: 2 };
  const v = projectSettings(row, VIEW);
  for (const f of SETTINGS_HR_COMP_FIELDS) assert.ok(!(f in v), f);
  assert.equal(v.min_tenure_days, 90);
  assert.deepEqual(projectSettings(row, HR), row);
  assert.deepEqual(projectSettings(row, COMP), row);
  assert.equal(projectSettings(null, VIEW), null);
  assert.ok('increment_bands' in row, 'the source row is not mutated');
});
test('S2 getSettings: a podium_view caller never receives increment_bands', async () => {
  const { body } = await withFetch(() => ({ body: [{ id: 1, increment_bands: [{ min: 1 }], pip_rating_threshold: 2, min_tenure_days: 90 }] }),
    () => getSettings(new URL('https://w/'), VIEW, ENV));
  assert.equal(body.data.increment_bands, undefined);
  assert.equal(body.data.min_tenure_days, 90);
});

// ── S1 ──
test('S1 cycleForViewer: budget_type / budget_value only when shown', () => {
  const c = { id: 'c', name: 'FY', appraisal_date: '2026-04-01', budget_type: 'pct', budget_value: 8 };
  assert.deepEqual(cycleForViewer(c, false), { id: 'c', name: 'FY', appraisal_date: '2026-04-01' });
  assert.deepEqual(cycleForViewer(c, true), c);
  assert.equal(cycleForViewer(null, false), null);
});
test('S1 getAppraisal: the subject view carries the cycle without the company budget', async () => {
  const auth = { userId: 'u-me', permissions: {} };
  const { body } = await withFetch((p) => {
    if (p.startsWith('/rest/v1/appraisals?id=eq.')) return { body: [{ id: APPR, employee_id: ME, manager_id: null, status: 'self_review',
      cycle: { id: 'c', name: 'FY', appraisal_date: '2026-04-01', budget_type: 'amount', budget_value: 5000000 } }] };
    if (p.startsWith('/rest/v1/employees?select=id,manager_id')) return { body: [{ id: ME, manager_id: null, auth_user_id: 'u-me' }] };
    return { body: [] };
  }, () => getAppraisal(new URL(`https://w/?id=${APPR}`), auth, ENV));
  assert.equal(body.data._role, 'subject');
  assert.equal(body.data.cycle.name, 'FY');
  assert.equal(body.data.cycle.budget_type, undefined);
  assert.equal(body.data.cycle.budget_value, undefined);
});

// ── S3 ──
test('S3 getEmployee: an id that is not a uuid never reaches PostgREST (codes: test/router-hardening.test.mjs)', async () => {
  for (const q of [`id=${encodeURIComponent(`${EMP}&select=*`)}`, 'id=abc']) {
    const { res, calls } = await withFetch(() => ({ body: [] }), () => getEmployee(new URL(`https://w/?${q}`), VIEW, ENV));
    assert.equal(res.status, 400, q);
    assert.equal(calls.length, 0, q);
  }
});
test('S3 getAppraisal: a smuggled select in the id → 400, no read', async () => {
  const { res, calls } = await withFetch(() => ({ body: [] }),
    () => getAppraisal(new URL(`https://w/?id=${encodeURIComponent(`${APPR}&select=*`)}`), VIEW, ENV));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});
// The static sweep: every client value (url.searchParams / d.* / body.*) interpolated into a /rest/v1 path is guarded
// earlier in its handler by isUuid / UUID_RE / encodeURIComponent / isIsoDay / isMonth / a regex / an allow-list.
test('S3 sweep: no unvalidated client value is interpolated into a PostgREST path', () => {
  const L = SRC.split('\n');
  const starts = [];
  L.forEach((l, i) => { if (/^(export )?(async )?function \w+\(/.test(l)) starts.push(i); });
  starts.push(L.length);
  const bad = [];
  for (let s = 0; s < starts.length - 1; s++) {
    const body = L.slice(starts[s], starts[s + 1]);
    const name = body[0].match(/function (\w+)\(/)[1];
    const src = {};
    body.forEach((l, k) => {
      for (const m of l.matchAll(/(?:const|let) (\w+) = (?:url\.searchParams\.get\('\w+'\)|(?:d|body)\.\w+\b)/g)) src[m[1]] = k;
    });
    body.forEach((l, k) => {
      if (!l.includes('rest/v1') && !(k && body[k - 1].includes('rest/v1'))) return;
      for (const m of l.matchAll(/\$\{((?:d|body)\.\w+|\w+)\}/g)) {
        const x = m[1];
        if (!(x.startsWith('d.') || x.startsWith('body.') || x in src) || (x in src && src[x] > k)) continue;
        const pre = body.slice(0, k + 1).join('\n');
        const xe = x.replace(/[.$]/g, '\\$&');
        const guarded = new RegExp(`(isUuid|UUID_RE\\.test|isIsoDay|isMonth|encodeURIComponent)\\(\\s*${xe}\\s*\\)`).test(pre)
          || new RegExp(`/\\^[^/]*\\$/\\.test\\(\\s*${xe}`).test(pre) || new RegExp(`\\.includes\\(\\s*${xe}\\s*\\)`).test(pre);
        if (!guarded) bad.push(`${name}:${starts[s] + k + 1} \${${x}}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

// ── S4 ──
for (const [name, fn, extra] of [['setOpeningBalance', setOpeningBalance, { days: 5 }], ['adjustLeave', adjustLeave, { delta: 1, note: 'x' }]]) {
  test(`S4 ${name}: HR cannot write their OWN leave ledger (no_self_approval, nothing written)`, async () => {
    const auth = { userId: 'u-hr', permissions: { podium_hr: true } };
    const { body, calls } = await withFetch((p) => (p.startsWith('/rest/v1/employees?select=id,manager_id')
      ? { body: [{ id: ME, manager_id: null, auth_user_id: 'u-hr' }] } : { body: [] }),
    () => fn({ data: { employee_id: ME, leave_type: 'PL', ...extra } }, auth, ENV));
    assert.equal(body.error, 'no_self_approval');
    assert.ok(!calls.some(c => c.method === 'POST'), 'no ledger write');
  });
  test(`S4 ${name}: the org read failing fails closed (500, nothing written)`, async () => {
    const { res, calls } = await withFetch((p) => (p.startsWith('/rest/v1/employees?select=id,manager_id') ? { status: 500, body: {} } : { body: [] }),
      () => fn({ data: { employee_id: EMP, leave_type: 'PL', ...extra } }, HR, ENV));
    assert.equal(res.status, 500);
    assert.ok(!calls.some(c => c.method === 'POST'));
  });
}

// ── S5 ──
test('S5 bankVisible: the bank document tier (HR) + the salary allow-list; an opening manager gets bank: null', () => {
  assert.equal(bankVisible(HR), true);
  assert.equal(bankVisible(COMP), true);
  assert.equal(bankVisible({ userId: 'u-mgr', permissions: { podium_hiring: true } }), false);
  assert.equal(bankVisible(VIEW), false);
  assert.match(SRC, /const bank = bankVisible\(auth\) && b \?/);
  assert.match(SRC, /return \{ emails, responses, acceptance, joining, bank, has_bank: !!b \};/);
});

// ── S1 (every action that returns an appraisal_cycles row) ──
const CYC = '44444444-4444-4444-8444-444444444444';
const CYCLE_ROW = { id: CYC, name: 'FY', appraisal_date: '2026-04-01', period_start: '2025-10-01', eligibility_cutoff_date: '2026-01-01',
  status: 'active', budget_type: 'pct', budget_value: 8 };
const CAL = { userId: 'u-cal', permissions: { podium_view: true }, isSuperAdmin: true };            // calibrator, no comp
const CAL_COMP = { ...CAL, compAccess: true };
const cycleRoute = (p) => (p.startsWith('/rest/v1/appraisal_cycles') ? { body: [CYCLE_ROW] } : { body: [] });
const S1_CASES = [
  ['getAppraisalCycles', (a) => getAppraisalCycles(new URL('https://w/'), a, ENV), (d) => d.cycles[0]],
  ['getAppraisalCycle', (a) => getAppraisalCycle(new URL(`https://w/?id=${CYC}`), a, ENV), (d) => d.cycle],
  ['getCycleOverview', (a) => getCycleOverview(new URL(`https://w/?cycle_id=${CYC}`), a, ENV), (d) => d.cycle],
  ['getAppraisals', (a) => getAppraisals(new URL(`https://w/?cycle_id=${CYC}`), a, ENV), (d) => d.cycle],
  ['getEnrollmentPreview', (a) => getEnrollmentPreview(new URL(`https://w/?cycle_id=${CYC}`), a, ENV), (d) => d.cycle],
  ['createAppraisalCycle', (a) => createAppraisalCycle({ data: { appraisal_date: '2026-04-01' } }, a, ENV), (d) => d],
];
for (const [name, call, pick] of S1_CASES) {
  test(`S1 ${name}: a calibrator WITHOUT comp gets the cycle without budget_type / budget_value`, async () => {
    const { body } = await withFetch(cycleRoute, () => call(CAL));
    const c = pick(body.data);
    assert.equal(c.name, 'FY');
    assert.ok(!('budget_type' in c) && !('budget_value' in c), JSON.stringify(c));
  });
}
test('S1 getCycleOverview / getAppraisalCycles: a calibrator WITH comp still gets the budget', async () => {
  const ov = await withFetch(cycleRoute, () => getCycleOverview(new URL(`https://w/?cycle_id=${CYC}`), CAL_COMP, ENV));
  assert.equal(ov.body.data.cycle.budget_type, 'pct');
  const ls = await withFetch(cycleRoute, () => getAppraisalCycles(new URL('https://w/'), CAL_COMP, ENV));
  assert.equal(ls.body.data.cycles[0].budget_value, 8);
});
// ── verifyJWT: a rejected lookup fails CLOSED and quiet ──
async function jwtWith(route) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const path = String(u).replace(ENV.SUPABASE_URL, '');
    if (path.startsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: ME, email: 'x@example.com' }));
    const r = route(path);
    if (r === 'throw') throw new Error('network down');
    return new Response(JSON.stringify(r.body ?? []), { status: r.status ?? 200 });
  };
  try { return await verifyJWT('Bearer t', ENV); } finally { globalThis.fetch = real; }
}
const ACTIVE = { body: [{ role: 'super_admin', full_name: 'T', active: true }] };
test('verifyJWT: a rejecting role read → null (401), not a throw', async () => {
  assert.equal(await jwtWith((p) => (p.startsWith('/rest/v1/podium_user_roles') ? 'throw' : p.startsWith('/rest/v1/users_profile') ? ACTIVE : { body: [] })), null);
});
test('verifyJWT: a rejecting comp read → null (401), not a throw', async () => {
  assert.equal(await jwtWith((p) => (p.startsWith('/rest/v1/comp_access') ? 'throw' : p.startsWith('/rest/v1/users_profile') ? ACTIVE : { body: [] })), null);
});
test('verifyJWT: an inactive profile + rejecting role and comp reads → null', async () => {
  assert.equal(await jwtWith((p) => (p.startsWith('/rest/v1/users_profile') ? { body: [{ role: 'user', full_name: 'T', active: false }] } : 'throw')), null);
});
test('verifyJWT: never fails open — non-ok role / comp responses give no role and no comp', async () => {
  const a = await jwtWith((p) => (p.startsWith('/rest/v1/users_profile') ? ACTIVE : { status: 500, body: [{ role_key: 'admin', auth_user_id: ME }] }));
  assert.equal(a.podiumRole, null);
  assert.deepEqual(a.permissions, {});
  assert.equal(a.compAccess, false);
});

// ── Search filter injection ──
const branches = (f) => {
  assert.ok(f.startsWith('or=(') && f.endsWith(')'), f);
  // What PostgREST sees: the value decoded once, then split on the top-level commas of or=( … ).
  return decodeURIComponent(f.slice(4, -1)).split(',');
};
test('employeeSearchFilter: hostile terms stay inside the five intended ilike branches', () => {
  for (const term of ['a,pan_number.like.A*', 'x)', '*', '"', '%2C', 'zzz*,pan_number.like.ABC*', 'a),or(date_of_birth.eq.1990-01-01', 'a\\,b', 'Doe, John']) {
    const bs = branches(employeeSearchFilter(term));
    assert.equal(bs.length, EMPLOYEE_SEARCH_COLUMNS.length, term);
    bs.forEach((b, i) => {
      assert.ok(b.startsWith(`${EMPLOYEE_SEARCH_COLUMNS[i]}.ilike.*`) && b.endsWith('*'), `${term} → ${b}`);
      assert.ok(!/[()"\\]/.test(b) && !/\*.*\*.*\*/.test(b), `${term} → ${b}`);
    });
  }
  assert.equal(employeeSearchFilter('a.b@x.com'), 'or=(full_name.ilike.*a.b%40x.com*,preferred_name.ilike.*a.b%40x.com*,employee_code.ilike.*a.b%40x.com*,work_email.ilike.*a.b%40x.com*,job_title.ilike.*a.b%40x.com*)');
});
// Inside or=( … ) encodeURIComponent is NOT a guard (PostgREST decodes %2C): every value interpolated into an or=()
// filter must come from cleanSearch, be a server-side id / constant, or be quoted+stripped (the dedupe in.() lists).
test('or=() sweep: no request value reaches an or=() filter without cleanSearch', () => {
  const L = SRC.split('\n');
  const bad = [];
  let fnStart = 0;
  L.forEach((l, i) => {
    if (/^(export )?(async )?function \w+\(/.test(l)) fnStart = i;
    if (!/or=\(/.test(l) || !/like\./.test(l)) return;
    const fn = L.slice(fnStart, i + 1).join('\n');
    for (const m of l.matchAll(/\$\{(\w+)\}/g)) {
      const v = m[1];
      if (new RegExp(`_COLUMNS\\.map\\(${v} =>`).test(l)) continue;   // a column name from a constant list
      if (!new RegExp(`(?:const|let) ${v} = cleanSearch\\(`).test(fn)) bad.push(`${i + 1} \${${v}}`);
    }
  });
  assert.deepEqual(bad, []);
});
