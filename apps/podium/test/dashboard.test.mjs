import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardPeople, dashboardDepartments, peopleKey, istDate, istStamp, freshness,
  shouldRefreshOnReturn, DEPARTMENTS_KEY, cacheIdentities, purgeLegacyPeopleCache, msUntilNextIstMidnight,
} from '../src/lib/dashboard.mjs';
import { readCache, writeCache } from '../../../packages/db/queryCache.js';

const DAY = 86400000;
const NOW = Date.parse('2026-11-14T06:30:00Z'); // 12:00 IST
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const yearsAgo = (ms, y) => { const d = new Date(ms); d.setFullYear(d.getFullYear() - y); return iso(d.getTime()); };

// ── The dashboard page BEFORE instant load, verbatim except Date.now()/new Date() take `nowMs` ──
function tally(arr, keyFn) { const o = {}; for (const x of arr) { const k = keyFn(x); o[k] = (o[k] || 0) + 1; } return o; }
function withinDays(d, n, nowMs) {
  if (!d) return false;
  const dt = new Date(d); if (isNaN(dt)) return false;
  const days = Math.round((nowMs - dt.getTime()) / 86400000);
  return days >= 0 && days <= n;
}
function upcoming(arr, field, nowMs) {
  const now = new Date(nowMs);
  const out = [];
  for (const e of arr) {
    if (!e[field]) continue;
    const d = new Date(e[field]);
    if (isNaN(d)) continue;
    const next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
    if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next.setFullYear(now.getFullYear() + 1);
    const days = Math.round((next - now) / 86400000);
    if (days >= 0 && days <= 30) out.push({ ...e, _days: days, _when: days === 0 ? 'Today' : `in ${days}d` });
  }
  return out.sort((a, b) => a._days - b._days).slice(0, 6);
}
// Returns what the old page RENDERED: every tile value + sub, every bar, every list row's shown fields.
function oldRender(empsReply, deptReply, nowMs) {
  const emps = empsReply.employees || [];
  const depts = deptReply.departments || [];
  const active = emps.filter(e => e.status === 'active');
  const byStatus = tally(emps, e => e.status);
  const byType = tally(active, e => e.employment_type || 'unknown');
  const newCount = active.filter(e => withinDays(e.date_joined, 30, nowMs)).length;
  const recent = [...active].filter(e => e.date_joined)
    .sort((a, b) => (b.date_joined || '').localeCompare(a.date_joined || '')).slice(0, 6);
  const anniv = upcoming(active, 'date_joined', nowMs);
  const bdays = upcoming(active, 'date_of_birth', nowMs);
  const deptRows = depts.slice().sort((a, b) => (b.headcount || 0) - (a.headcount || 0));
  const maxHc = Math.max(1, ...deptRows.map(d => d.headcount || 0));
  const typeRows = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const typeMax = Math.max(1, ...typeRows.map(([, v]) => v));
  return {
    tiles: [
      ['Headcount', active.length, newCount ? `+${newCount} this month` : 'steady'],
      ['Departments', depts.length, `${deptRows.filter(d => (d.headcount || 0) > 0).length} active`],
      ['On Leave', byStatus.on_leave || 0, (byStatus.on_leave || 0) ? 'currently away' : 'none'],
      ['Notice', byStatus.notice || 0, (byStatus.notice || 0) ? 'serving notice' : 'none'],
      ['New · 30d', newCount, newCount ? 'onboarding' : 'none'],
    ],
    deptBars: deptRows.map(d => [d.id, d.name, d.headcount || 0, Math.round((d.headcount || 0) / maxHc * 100)]),
    recent: recent.map(e => [e.id, e.full_name, e.photo_url, e.job_title || '—', e.date_joined]),
    typeBars: typeRows.map(([k, v]) => [k, v, Math.round(v / typeMax * 100)]),
    anniv: anniv.map(e => [e.id, e.full_name, e.job_title, e._when]),
    bdays: bdays.map(e => [e.id, e.full_name, e.job_title, e._when]),
  };
}
// The same, rendered from the NEW cached shapes, the way the new page reads them.
function newRender(p, dp) {
  return {
    tiles: [
      ['Headcount', p.headcount, p.newCount ? `+${p.newCount} this month` : 'steady'],
      ['Departments', dp.count, `${dp.activeCount} active`],
      ['On Leave', p.onLeave, p.onLeave ? 'currently away' : 'none'],
      ['Notice', p.notice, p.notice ? 'serving notice' : 'none'],
      ['New · 30d', p.newCount, p.newCount ? 'onboarding' : 'none'],
    ],
    deptBars: dp.rows.map(d => [d.id, d.name, d.value, d.pct]),
    recent: p.recent.map(e => [e.id, e.full_name, e.photo_url, e.job_title || '—', e.date_joined]),
    typeBars: p.types.map(t => [t.key, t.value, t.pct]),
    anniv: p.anniversaries.map(e => [e.id, e.full_name, e.job_title, e.when]),
    bdays: p.birthdays.map(e => [e.id, e.full_name, e.job_title, e.when]),
  };
}

// A full employee row with every sensitive field the worker can send an HR caller.
const SENSITIVE = {
  date_of_birth: '1990-11-20', personal_email: 'secret.personal@example.com', work_email: 'secret.work@legendoftoys.com',
  phone: '+919999900001', emergency_contact_name: 'Secret Kin', emergency_contact_phone: '+919999900002',
  pan_number: 'ABCPE1234Z', address: '12 Secret Lane', current_address: '13 Secret Lane', permanent_address: '14 Secret Lane',
  ctc: 1234567, salary: 98765, compensation: { ctc: 1234567 }, bank_account_number: '000111222333', ifsc: 'SBIN0000001',
  gender: 'female', blood_group: 'O+', legal_entity: 'Fraternitas', razorpayx_employee_id: 'rzp_secret', google_user_id: 'g_secret',
  aadhaar_number: '999988887777', auth_user_id: 'auth-secret-uuid', exit_reason: 'secret reason',
};
const full = (o) => ({
  employee_code: 'LOT-X', preferred_name: 'Pref', department_id: 'd1', job_role_id: 'jr', manager_id: 'm', level_id: 'l',
  employment_type: 'permanent', work_location: 'Pune', probation_end_date: iso(NOW + 30 * DAY), created_at: '2026-01-01T00:00:00Z',
  department: { id: 'd1', name: 'Ops' }, manager: { id: 'm', full_name: 'Boss', job_title: 'Lead' }, on_notice: false,
  ...SENSITIVE, ...o,
});
const emps = [
  full({ id: 'e1', full_name: 'Asha', status: 'active', job_title: 'Engineer', photo_url: 'https://p/1.jpg', date_joined: iso(NOW - 5 * DAY), date_of_birth: iso(NOW + 3 * DAY).replace(/^\d{4}/, '1992') }),
  full({ id: 'e2', full_name: 'Bilal', status: 'active', job_title: null, date_joined: yearsAgo(NOW + 10 * DAY, 2), employment_type: 'contract', date_of_birth: iso(NOW).replace(/^\d{4}/, '1988') }),
  full({ id: 'e3', full_name: 'Chen', status: 'on_leave', job_title: 'Designer', date_joined: iso(NOW - 400 * DAY) }),
  full({ id: 'e4', full_name: 'Dev', status: 'exited', job_title: 'Ops', date_joined: iso(NOW - 10 * DAY) }),
  full({ id: 'e5', full_name: 'Esha', status: 'active', job_title: 'PM', date_joined: iso(NOW - 31 * DAY), employment_type: null, date_of_birth: 'not a date' }),
  full({ id: 'e6', full_name: 'Farid', status: 'active', on_notice: true, job_title: 'QA', date_joined: iso(NOW - 2 * DAY) }),
  full({ id: 'e7', full_name: 'Gita', status: 'active', job_title: 'HR', date_joined: null, date_of_birth: null }),
  ...Array.from({ length: 8 }, (_, i) => full({ id: `x${i}`, full_name: `X${i}`, status: 'active', job_title: 'Op', employment_type: i % 2 ? 'intern' : 'permanent',
    date_joined: iso(NOW - (i * 45 + 1) * DAY), date_of_birth: iso(NOW + (i * 5) * DAY).replace(/^\d{4}/, '1995') })),
  // a projected (restricted) row: no DOB, no employment_type
  { id: 'r1', full_name: 'Restricted', status: 'active', job_title: 'Tech', department_id: 'd2', photo_url: null, work_email: 'r@x', _restricted: true, on_notice: true },
];
const depts = [
  { id: 'd1', name: 'Ops', headcount: 5, head: { id: 'h', full_name: 'Head Person' }, founder_owner: { full_name: 'F' }, description: 'x' },
  { id: 'd2', name: 'Tech', headcount: 12 },
  { id: 'd3', name: 'Empty', headcount: 0 },
  { id: 'd4', name: 'NoCount' },
  { id: 'd5', name: 'Also12', headcount: 12 },
];

// Everything except the two deliberate fixes (Notice tile; anniversary/birthday day-counting) must match the
// old page exactly. The fixes are pinned by hand-written expectations below.
const unchanged = (r) => ({ ...r, tiles: r.tiles.filter(([label]) => label !== 'Notice'), anniv: undefined, bdays: undefined });

test('every unchanged tile, bar and list row is identical to the old page on the same data', () => {
  for (const nowMs of [NOW, Date.now(), Date.parse('2026-12-31T20:00:00Z'), Date.parse('2027-02-28T00:00:00Z')]) {
    const before = oldRender({ employees: emps }, { departments: depts }, nowMs);
    const after = newRender(dashboardPeople({ employees: emps }, nowMs), dashboardDepartments({ departments: depts }));
    assert.deepEqual(unchanged(after), unchanged(before));
  }
  assert.deepEqual(unchanged(newRender(dashboardPeople({ employees: [] }, NOW), dashboardDepartments({ departments: [] }))),
    unchanged(oldRender({ employees: [] }, { departments: [] }, NOW)));
});

test('the fixture exercises every section (so the equality above is not vacuous)', () => {
  const r = oldRender({ employees: emps }, { departments: depts }, NOW);
  assert.ok(r.recent.length === 6 && r.typeBars.length >= 3 && r.deptBars.length === 5);
  assert.ok(r.tiles.filter(([l]) => l !== 'Notice').every(([, v]) => v > 0));
});

// BEHAVIOUR CHANGE 1 — Notice counts the on_notice flag (an open exit), which getEmployees sets on every row.
test('Notice tile counts people with an open exit (on_notice), not a "notice" status', () => {
  const rows = [
    { id: 'a', full_name: 'A', status: 'active', on_notice: true },                  // serving notice
    { id: 'b', full_name: 'B', status: 'active', on_notice: false },
    { id: 'c', full_name: 'C', status: 'active', on_notice: true, _restricted: true }, // projected row still carries it
    { id: 'd', full_name: 'D', status: 'exited', on_notice: false },                 // exit closed
    { id: 'e', full_name: 'E', status: 'on_leave' },                                  // flag absent → not counted
  ];
  const p = dashboardPeople({ employees: rows }, NOW);
  assert.equal(p.notice, 2);
  assert.equal(oldRender({ employees: rows }, { departments: [] }, NOW).tiles.find(t => t[0] === 'Notice')[1], 0); // what it showed
  assert.equal(dashboardPeople({ employees: [{ id: 'z', status: 'active', on_notice: false }] }, NOW).notice, 0);
});

// BEHAVIOUR CHANGE 2 — anniversaries / birthdays count IST calendar days, whatever the time of day.
test('anniversaries and birthdays: same answer at 00:05, 12:30 and 23:55 IST on 14 Nov 2026', () => {
  const people = [
    { id: 'today', full_name: 'Today', job_title: 'T', status: 'active', date_of_birth: '1990-11-14', date_joined: '2024-11-14' },
    { id: 'tmrw', full_name: 'Tomorrow', job_title: 'M', status: 'active', date_of_birth: '1991-11-15', date_joined: '2023-11-15' },
    { id: 'yday', full_name: 'Yesterday', job_title: 'Y', status: 'active', date_of_birth: '1992-11-13', date_joined: '2022-11-13' },
    { id: 'd30', full_name: 'ThirtyDays', job_title: null, status: 'active', date_of_birth: '1993-12-14', date_joined: '2021-12-14' },
    { id: 'd31', full_name: 'ThirtyOne', job_title: 'X', status: 'active', date_of_birth: '1994-12-15', date_joined: '2020-12-15' },
    { id: 'gone', full_name: 'Exited', job_title: 'X', status: 'exited', date_of_birth: '1990-11-14', date_joined: '2024-11-14' },
  ];
  const expected = [
    { id: 'today', full_name: 'Today', job_title: 'T', when: 'Today' },
    { id: 'tmrw', full_name: 'Tomorrow', job_title: 'M', when: 'in 1d' },
    { id: 'd30', full_name: 'ThirtyDays', job_title: null, when: 'in 30d' },
  ];
  for (const at of ['2026-11-13T18:35:00Z', '2026-11-14T07:00:00Z', '2026-11-14T18:25:00Z']) { // 00:05, 12:30, 23:55 IST
    const p = dashboardPeople({ employees: people }, Date.parse(at));
    assert.deepEqual(p.birthdays, expected, at);
    assert.deepEqual(p.anniversaries, expected, at);
  }
  // 00:05 IST on the 15th: yesterday's "today" is gone, tomorrow's is now Today
  const next = dashboardPeople({ employees: people }, Date.parse('2026-11-14T18:35:00Z'));
  assert.deepEqual(next.birthdays.map(b => [b.id, b.when]), [['tmrw', 'Today'], ['d30', 'in 29d'], ['d31', 'in 30d']]);
});

test('no sensitive field or value survives into either payload the page holds', () => {
  const cached = JSON.stringify([dashboardPeople({ employees: emps }, NOW), dashboardDepartments({ departments: depts })]);
  for (const [k, v] of Object.entries(SENSITIVE)) {
    assert.ok(!cached.includes(`"${k}"`), `key ${k} leaked`);
    const vals = typeof v === 'object' ? Object.values(v) : [v];
    for (const x of vals) assert.ok(!cached.includes(String(x)), `value of ${k} leaked`);
  }
  const keys = new Set();
  const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) keys.add(k); walk(x); } };
  walk(JSON.parse(cached));
  const forbidden = /birth|email|phone|pan|address|ctc|salary|comp|bank|ifsc|aadhaar|gender|blood|manager|department_id|employment_type|on_notice|^head$|founder|status|code|legal|auth|google|razorpay/;
  keys.delete("birthdays"); // the list name itself; its rows are checked to hold id, full_name, job_title, when only
  for (const k of keys) assert.ok(!forbidden.test(k), `key ${k} leaked`);
  // DOB of a birthday person is not recoverable beyond the "in Nd" text the card shows
  assert.ok(!cached.includes('1992') && !cached.includes('1988') && !cached.includes('1995'));
});

test('the exact payload shape — only the rendered fields per listed person', () => {
  const p = dashboardPeople({ employees: emps }, NOW);
  assert.deepEqual(Object.keys(p).sort(), ['anniversaries', 'birthdays', 'headcount', 'newCount', 'notice', 'onLeave', 'recent', 'types']);
  for (const r of p.recent) assert.deepEqual(Object.keys(r).sort(), ['date_joined', 'full_name', 'id', 'job_title', 'photo_url']);
  for (const r of [...p.anniversaries, ...p.birthdays]) assert.deepEqual(Object.keys(r).sort(), ['full_name', 'id', 'job_title', 'when']);
  for (const t of p.types) assert.deepEqual(Object.keys(t).sort(), ['key', 'pct', 'value']);
  const d = dashboardDepartments({ departments: depts });
  assert.deepEqual(Object.keys(d).sort(), ['activeCount', 'count', 'rows']);
  for (const r of d.rows) assert.deepEqual(Object.keys(r).sort(), ['id', 'name', 'pct', 'value']);
});

test('a bad reply throws — never cached as zeros', () => {
  for (const bad of [null, undefined, {}, { employees: null }, { employees: {} }, []]) assert.throws(() => dashboardPeople(bad, NOW));
  for (const bad of [null, {}, { departments: 'x' }]) assert.throws(() => dashboardDepartments(bad));
});

test('keys: people named by IST date (never stored), departments fixed', () => {
  assert.equal(peopleKey(istDate(NOW)), 'podium:dashboard:people:2026-11-14');
  // 23:59 IST on the 14th vs 00:01 IST on the 15th (UTC still the 14th) → different keys
  assert.equal(istDate(Date.parse('2026-11-14T18:29:00Z')), '2026-11-14');
  assert.equal(istDate(Date.parse('2026-11-14T18:31:00Z')), '2026-11-15');
  assert.equal(DEPARTMENTS_KEY, 'podium:dashboard:departments');
});

test('freshness line', () => {
  const q = (o = {}) => ({ data: undefined, error: null, loading: false, refreshing: false, updatedAt: null, ...o });
  const at = Date.parse('2026-11-14T04:35:00Z'); // 10:05 IST
  assert.deepEqual(freshness([q({ loading: true }), q()], NOW), { text: 'Updating…', warn: false });
  assert.deepEqual(freshness([q({ refreshing: true, data: 1, updatedAt: at }), q({ data: 1, updatedAt: NOW })], NOW), { text: 'Updating… (showing 10:05)', warn: false });
  assert.deepEqual(freshness([q({ data: 1, updatedAt: at }), q({ data: 1, updatedAt: NOW })], NOW), { text: 'As of 10:05', warn: false });
  assert.deepEqual(freshness([q({ data: 1, updatedAt: at, error: new Error('x') }), q()], NOW), { text: "Couldn't refresh — showing 10:05", warn: true });
  assert.equal(istStamp(at - DAY, NOW), '13 Nov 10:05');
  assert.equal(shouldRefreshOnReturn(NOW - 61000, NOW), true);
  assert.equal(shouldRefreshOnReturn(NOW - 30000, NOW), false);
  assert.equal(shouldRefreshOnReturn(null, NOW), false);
});

// A sessionStorage stand-in for queryCache.
function memStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('after a full dashboard load, sessionStorage holds no person: the people query has no cache identity', () => {
  // The page builds both queries from cacheIdentities(); useCachedQuery seeds with readCache(identity, key) and,
  // after each fetch, writes with writeCache(identity, key, result). Run a full load through that path.
  for (const viewer of ['u-hr', 'u-manager', 'u-staff']) {
    const storage = memStorage();
    const ids = cacheIdentities(viewer);
    assert.equal(ids.people, null);
    assert.equal(ids.departments, viewer);
    const day = istDate(NOW);
    writeCache(ids.people, peopleKey(day), dashboardPeople({ employees: emps }, NOW), { storage });
    writeCache(ids.departments, DEPARTMENTS_KEY, dashboardDepartments({ departments: depts }), { storage });
    assert.equal(readCache(ids.people, peopleKey(day), { storage }), null);
    assert.deepEqual([...storage._m.keys()], ['lotq:v1:podium:dashboard:departments']);
    const stored = [...storage._m.values()].join('\n');
    for (const e of emps) {
      assert.ok(!stored.includes(e.full_name), `name ${e.full_name} stored`);
      for (const f of ['date_of_birth', 'date_joined']) if (e[f]) assert.ok(!stored.includes(e[f]), `${f} of ${e.full_name} stored`);
    }
    assert.ok(!stored.includes('Head Person') && !stored.includes('"F"'));   // department head / founder names dropped
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.parse(stored).d && JSON.stringify(JSON.parse(stored).d)));  // no date at all in the payload
  }
  assert.deepEqual(cacheIdentities(null), { people: null, departments: null });
});

test('legacy people cache entries are purged; nothing else is touched', () => {
  const storage = memStorage();
  storage.setItem('lotq:v1:podium:dashboard:people:hr:2026-11-14', '{"u":"u1"}');
  storage.setItem('lotq:v1:podium:dashboard:people:std:2026-11-13', '{"u":"u1"}');
  storage.setItem('lotq:v1:podium:dashboard:departments', '{"u":"u1"}');
  storage.setItem('throttle-brand-user', 'x');
  assert.equal(purgeLegacyPeopleCache(storage), 2);
  assert.deepEqual([...storage._m.keys()].sort(), ['lotq:v1:podium:dashboard:departments', 'throttle-brand-user']);
  assert.equal(purgeLegacyPeopleCache(null), 0);
});

test('ms until the next IST midnight', () => {
  const H = 3600000, M = 60000;
  assert.equal(msUntilNextIstMidnight(Date.parse('2026-11-14T18:29:00Z')), 1 * M);              // 23:59 IST
  assert.equal(msUntilNextIstMidnight(Date.parse('2026-11-14T18:30:00Z')), 24 * H);             // exactly 00:00 IST
  assert.equal(msUntilNextIstMidnight(Date.parse('2026-11-14T18:31:00Z')), 24 * H - 1 * M);     // 00:01 IST
  assert.equal(msUntilNextIstMidnight(Date.parse('2026-11-14T06:30:00Z')), 12 * H);             // 12:00 IST
  assert.equal(msUntilNextIstMidnight(Date.parse('2026-11-13T23:00:00Z')), 19 * H + 30 * M);    // 04:30 IST
  // landing on it: the date has changed by then
  const at = Date.parse('2026-11-14T10:17:23Z');
  assert.equal(istDate(at + msUntilNextIstMidnight(at)), '2026-11-15');
  assert.equal(istDate(at + msUntilNextIstMidnight(at) - 1), '2026-11-14');
});
