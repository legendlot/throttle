// Run: node --test docketops-worker/test/*.test.mjs
// F9 R7b — the reminder cron end to end through the worker's scheduled() against a stubbed Supabase + Slack:
// mode gating (off sends nothing and reads no one; test DMs only the test people; live everyone), claim-before-send
// (a double fire or a retry never DMs twice; a row already there means no DM), empty → skipped_empty with no DM,
// no Slack user → unmapped, one recipient failing doesn't stop the rest, rendering AS each recipient (their own
// tasks; founders-only slots never reach anyone else; the chase at two levels), and slackReminderPreview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a', SLACK_DOCKET_BOT_TOKEN: 'xoxb-zz' };
// FOU = a founder (plan admin), ASSOC = a Founders' Associate (docket_review), OWN = an owner, NL = an owner with no login.
const P = {
  FOU:   { id: U(1), auth_user_id: U(11), full_name: 'Zz Founder', work_email: 'zz.founder@legendoftoys.com', department_id: U(90), status: 'active', role: 'super', slack: 'UFOU0001' },
  ASSOC: { id: U(2), auth_user_id: U(12), full_name: 'Zz Assoc', work_email: 'zz.assoc@legendoftoys.com', department_id: U(90), status: 'active', role: 'review', slack: 'UASC0001' },
  OWN:   { id: U(3), auth_user_id: U(13), full_name: 'Zz Owner', work_email: 'zz.owner@legendoftoys.com', department_id: U(91), status: 'active', role: null, slack: 'UOWN0001' },
  NL:    { id: U(4), auth_user_id: null, full_name: 'Zz Nologin', work_email: 'zz.nl@legendoftoys.com', department_id: U(91), status: 'active', role: null, slack: 'UNLX0001' },
};
const PEOPLE = Object.values(P);
const G = U(50), FS = U(51), PRIV = U(52);
const ist = (d, hm) => Date.parse(`${d}T${hm}:00+05:30`);
const MON9 = ist('2026-11-16', '09:00'), MON930 = ist('2026-11-16', '09:30'), THU17 = ist('2026-11-19', '17:00'), FRI18 = ist('2026-11-20', '18:00');
const SLOTS = { owner_daily: { time: '09:00', days: 'working' }, chase: { time: '09:30', days: 'working' },
  review_tomorrow: { time: '17:00', dow: 4 }, review_pack: { time: '18:00', dow: 4 }, catchup_prep: { time: '18:00', dow: 5 } };
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: P.OWN.id,
  assignee_employee_id: null, created_by_user_id: P.OWN.auth_user_id, department_id: U(91), deadline: null, revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, created_at: '2026-10-01T00:00:00Z', is_recurring: false, archived_at: null,
  handoff_to_department_id: null, handoff_to_employee_id: null, ...o });

function stub({ mode = 'live', testIds = [], tasks = [], identities = [], log = [], fresh = [], slackDown = [], lookupMiss = [], lookupErr = {}, stranger = [], claimDown = false, authTestDown = false, score = [], now = MON9 } = {}) {
  const db = { log: log.map(r => ({ ...r })), identities: identities.map(r => ({ ...r })) };
  const calls = [], dms = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search);
    const q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const raw = init.body ? String(init.body) : '';
    const reqBody = raw ? (/^[[{"]/.test(raw.trim()) ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : null;
    calls.push({ method, p, body: reqBody, host: u.host });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.host === 'slack.com') {
      const m = u.pathname.replace('/api/', '');
      if (m === 'auth.test') return authTestDown ? body({ ok: false, error: 'invalid_auth' }) : body({ ok: true, team_id: 'TLOT' });
      if (m === 'users.lookupByEmail') {
        const e = PEOPLE.find(x => x.work_email === reqBody.email);
        if (e && lookupErr[e.id] === 'ratelimited') return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 429, headers: { 'retry-after': '0' } });
        if (e && lookupErr[e.id]) return body({ ok: false, error: lookupErr[e.id] });
        if (e && stranger.includes(e.id)) return body({ ok: true, user: { id: e.slack, team_id: 'TLOT', is_stranger: true, profile: { email: e.work_email } } });
        return body(e && !lookupMiss.includes(e.id) ? { ok: true, user: { id: e.slack, team_id: 'TLOT', profile: { email: e.work_email } } } : { ok: false, error: 'users_not_found' });
      }
      if (m === 'conversations.open') return body({ ok: true, channel: { id: 'D' + reqBody.users } });
      if (m === 'chat.postMessage') {
        const to = PEOPLE.find(x => 'D' + x.slack === reqBody.channel);
        if (to && slackDown.includes(to.id)) return body({ ok: false, error: 'channel_not_found' });
        dms.push({ to: to ? to.id : reqBody.channel, text: reqBody.text, blocks: reqBody.blocks }); return body({ ok: true });
      }
      return body({ ok: true });
    }
    // settings
    if (p.startsWith('/rest/v1/settings?key=eq.slack_reminders')) return body([{ value: { mode, test_employee_ids: testIds, slots: SLOTS } }]);
    if (p.startsWith('/rest/v1/settings?')) return body([]);
    // the log (claim = insert … on conflict do nothing)
    if (u.pathname === '/rest/v1/slack_reminder_log' && method === 'POST') {
      if (claimDown) return body({ message: 'zz db down' }, 503);
      assert.equal(q.get('on_conflict'), 'slot,run_date,employee_id');
      assert.match(init.headers?.Prefer || '', /resolution=ignore-duplicates/);
      const out = [];
      for (const r of reqBody) {
        if (db.log.some(x => x.slot === r.slot && x.run_date === r.run_date && x.employee_id === r.employee_id)) continue;
        db.log.push({ ...r }); out.push(r);
      }
      return body(out, 201);
    }
    if (u.pathname === '/rest/v1/slack_reminder_log' && method === 'PATCH') {
      const row = db.log.find(x => x.slot === eq('slot') && x.run_date === eq('run_date') && x.employee_id === eq('employee_id'));
      if (row) Object.assign(row, reqBody);
      return new Response(null, { status: 204 });
    }
    // identities
    if (u.pathname === '/rest/v1/slack_identities' && method === 'GET') return body(db.identities.filter(r => inIds(q.get('employee_id')).includes(r.employee_id)));
    if (u.pathname === '/rest/v1/slack_identities' && method === 'DELETE') { db.identities = db.identities.filter(x => x.slack_user_id !== eq('slack_user_id')); return new Response(null, { status: 204 }); }
    if (u.pathname === '/rest/v1/slack_identities' && method === 'POST') { for (const r of reqBody) { db.identities = db.identities.filter(x => x.employee_id !== r.employee_id); db.identities.push(r); } return new Response(null, { status: 201 }); }
    // people + roles
    const strip = ({ slack, role, ...e }) => e;
    if (p.startsWith('/rest/v1/users_profile?id=eq.')) return body([{ role: 'viewer', full_name: 'zz', active: true }]);
    if (p.startsWith('/rest/v1/users_profile?')) return body([]);
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) { const e = PEOPLE.find(x => x.auth_user_id === eq('user_id')); return body(e?.role ? [{ role_key: e.role }] : []); }
    if (p.startsWith('/rest/v1/docket_user_roles?')) return body(PEOPLE.filter(e => e.role).map(e => ({ user_id: e.auth_user_id, role_key: e.role })));
    if (p.startsWith('/rest/v1/docket_roles?role_key=eq.')) return body([{ role_key: eq('role_key'), permissions: eq('role_key') === 'super' ? { docket_plan_admin: true } : { docket_review: true, docket_view_all: true } }]);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'super', permissions: { docket_plan_admin: true } }, { role_key: 'review', permissions: { docket_review: true, docket_view_all: true } }, { role_key: 'zz_none', permissions: {} }]);
    if (p.includes('/employees?auth_user_id=eq.')) return body(PEOPLE.filter(e => e.auth_user_id === eq('auth_user_id')).map(strip));
    if (p.includes('/employees?auth_user_id=in.')) return body(PEOPLE.filter(e => inIds(q.get('auth_user_id')).includes(e.auth_user_id)).map(strip));
    if (p.includes('/employees?id=in.')) return body(PEOPLE.filter(e => inIds(q.get('id')).includes(e.id)).map(strip));
    if (p.includes('/employees?id=eq.')) return body(PEOPLE.filter(e => e.id === eq('id')).map(strip));
    if (p.includes('/employees')) return body(PEOPLE.map(strip));
    if (p.includes('/departments')) return body([{ id: U(90), name: 'ZZ Founders team' }, { id: U(91), name: 'ZZ Ops' }]);
    // spaces
    if (p.startsWith('/rest/v1/spaces?is_founders=eq.true')) return body([{ id: FS }]);
    if (p.startsWith('/rest/v1/spaces?is_default=eq.true')) return body([{ id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false }]);
    if (p.startsWith('/rest/v1/spaces?or=')) return body([{ id: FS, archived_at: null, is_founders: true }]);
    if (p.startsWith('/rest/v1/spaces?archived_at=not.is.null')) return body([]);
    if (p.startsWith('/rest/v1/spaces?')) return body([{ id: G, name: 'General', is_default: true, is_private: false, is_founders: false, owner_user_id: null },
      { id: FS, name: 'Founders', is_default: false, is_private: true, is_founders: true, owner_user_id: P.FOU.auth_user_id },
      { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, is_founders: false, owner_user_id: U(99) }].filter(s => !q.get('id') || inIds(q.get('id')).includes(s.id) || eq('id') === s.id));
    if (p.startsWith('/rest/v1/space_members?')) return body([]);
    // tasks
    if (p.includes('/rpc/list_my_tasks')) return body(tasks.filter(t => t.owner_employee_id === reqBody.p_employee));
    if (p.includes('/rpc/week_score')) return body({ week_end: '2026-11-22', week_start: '2026-11-16', opened: true, final: false, tasks: score });
    if (p.includes('/rpc/')) return body([]);
    if (u.pathname === '/rest/v1/task_history' && method === 'GET') return body(fresh.filter(id => inIds(q.get('task_id')).includes(id)).map(task_id => ({ task_id })));
    if (u.pathname === '/rest/v1/task_comments' && method === 'GET') return body([]);
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('owner_employee_id') === 'not.is.null') return body(tasks.filter(t => ['not_started', 'in_progress', 'blocked'].includes(t.status)).map(t => ({ owner_employee_id: t.owner_employee_id })));
      if (q.get('id')?.startsWith('in.')) return body(tasks.filter(t => inIds(q.get('id')).includes(t.id)));
      if (q.get('and') && q.get('status') === 'neq.abandoned') return body(tasks.filter(t => !t.parent_task_id));   // the plan-weeks window read
      return body([]);
    }
    return body([]);
  };
  return { fn, calls, dms, db };
}
async function fire(s, at, w = worker) {
  const real = globalThis.fetch; globalThis.fetch = s.fn;
  const jobs = [];
  try { await w.scheduled({ scheduledTime: at, cron: '0,30 * * * *' }, ENV, { waitUntil: (p) => jobs.push(p) }); await Promise.all(jobs); }
  finally { globalThis.fetch = real; }
}
const DUE = (d) => new Date(ist(d, '18:00')).toISOString();
// Messages render against the real clock (the cron's scheduledTime only picks the slot): dates relative to now.
const TODAY_IST = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const PAST = new Date(Date.now() - 2 * 86400000).toISOString();
const LATER_TODAY = new Date(Date.parse(`${TODAY_IST}T23:59:00+05:30`)).toISOString();
const FAR = new Date(Date.now() + 40 * 86400000).toISOString();
const OWNED = [T(1, { deadline: PAST }), T(2, { deadline: LATER_TODAY }),
  T(3, { owner_employee_id: P.NL.id }), T(4, { owner_employee_id: P.FOU.id, deadline: PAST })];
const MAPPED = PEOPLE.filter(p => p.id !== P.NL.id).map(p => ({ employee_id: p.id, slack_user_id: p.slack, resolved_at: new Date().toISOString() }));
const logOf = (s) => s.db.log.map(r => `${r.slot}:${PEOPLE.find(p => p.id === r.employee_id)?.full_name.split(' ')[1]}:${r.status}${r.error_code ? '/' + r.error_code : ''}`).sort();

test('mode off: nothing is read beyond the settings, nobody is DMed', async () => {
  const s = stub({ mode: 'off', tasks: OWNED, identities: MAPPED });
  await fire(s, MON9);
  assert.equal(s.dms.length, 0);
  assert.equal(s.db.log.length, 0);
  assert.ok(s.calls.every(c => c.p.startsWith('/rest/v1/settings')), JSON.stringify(s.calls.map(c => c.p)));
});

test('mode test: only the test person gets a DM — the same one they would get live; no one else is rendered or logged', async () => {
  const s = stub({ mode: 'test', testIds: [P.FOU.id], tasks: OWNED, identities: MAPPED });
  await fire(s, MON9);
  assert.deepEqual(s.dms.map(d => d.to), [P.FOU.id]);
  assert.match(s.dms[0].text, /1 overdue/);
  assert.ok(JSON.stringify(s.dms[0].blocks).includes(U(104)) && !JSON.stringify(s.dms[0].blocks).includes(U(101)), 'their own tasks only');
  assert.deepEqual(logOf(s), ['owner_daily:Founder:sent']);
  const t = stub({ mode: 'test', testIds: [U(77)], tasks: OWNED, identities: MAPPED });   // a test id who isn't a recipient
  await fire(t, MON9);
  assert.equal(t.dms.length, 0);
  assert.equal(t.db.log.length, 0);
});

test('mode live, 09:00: each owner gets their own; no login → unmapped; the run goes on past a failed DM', async () => {
  const s = stub({ mode: 'live', tasks: OWNED, identities: MAPPED, slackDown: [P.FOU.id] });
  await fire(s, MON9);
  assert.deepEqual(s.dms.map(d => d.to), [P.OWN.id]);
  const own = s.dms[0];
  assert.match(own.text, /^Docket: 1 overdue, 1 due today\.$/);
  assert.ok(own.blocks.some(b => b.type === 'actions' && b.elements.map(e => e.action_id).join() === 'docket_done,docket_move,docket_comment'));
  assert.ok(!JSON.stringify(own.blocks).includes(U(104)), "not the founder's task");
  assert.deepEqual(logOf(s), ['owner_daily:Founder:failed/channel_not_found', 'owner_daily:Nologin:unmapped/no_docket_login', 'owner_daily:Owner:sent']);
});

test('claim before send: a second fire (or a retry) sends nothing; a row already there means no DM', async () => {
  const s = stub({ mode: 'live', tasks: OWNED, identities: MAPPED });
  await fire(s, MON9);
  const n = s.dms.length;
  assert.ok(n >= 2);
  await fire(s, MON9);
  await fire(s, MON9 + 10 * 60000);   // same half-hour, late
  assert.equal(s.dms.length, n, 'never twice');
  const t = stub({ mode: 'live', tasks: OWNED, identities: MAPPED,
    log: [{ slot: 'owner_daily', run_date: '2026-11-16', employee_id: P.OWN.id, status: 'failed', error_code: 'in_flight' }] });
  await fire(t, MON9);
  assert.ok(!t.dms.some(d => d.to === P.OWN.id), 'an in-flight claim from another run blocks the DM');
  // the claim is written BEFORE the DM goes out
  const u = stub({ mode: 'test', testIds: [P.OWN.id], tasks: OWNED, identities: MAPPED });
  await fire(u, MON9);
  const iClaim = u.calls.findIndex(c => c.p.startsWith('/rest/v1/slack_reminder_log') && c.method === 'POST');
  const iSend = u.calls.findIndex(c => c.p === '/api/chat.postMessage');
  assert.ok(iClaim >= 0 && iSend > iClaim, `claim ${iClaim} before send ${iSend}`);
  assert.equal(u.db.log[0].status, 'sent');
});

test('empty → skipped_empty, no DM; nobody on Slack → unmapped, saved when found', async () => {
  const quiet = [T(1, { deadline: FAR })];
  let s = stub({ mode: 'live', tasks: quiet, identities: MAPPED, fresh: [U(101)] });   // updated recently, due far off
  await fire(s, MON9);
  assert.equal(s.dms.length, 0);
  assert.deepEqual(logOf(s), ['owner_daily:Owner:skipped_empty']);
  s = stub({ mode: 'live', tasks: [T(1, { deadline: PAST })], identities: [], lookupMiss: [P.OWN.id] });
  await fire(s, MON9);
  assert.equal(s.dms.length, 0);
  assert.deepEqual(logOf(s), ['owner_daily:Owner:unmapped/no_slack_user']);
  s = stub({ mode: 'live', tasks: [T(1, { deadline: PAST })], identities: [] });   // found by email → saved, DMed
  await fire(s, MON9);
  assert.deepEqual(s.dms.map(d => d.to), [P.OWN.id]);
  assert.deepEqual(s.db.identities.map(r => [r.employee_id, r.slack_user_id]), [[P.OWN.id, 'UOWN0001']]);
});

const row = (t, o = {}) => ({ task_id: t.id, task_no: t.task_no, title: t.title, owner_employee_id: t.owner_employee_id, status: 'in_progress',
  effective_deadline: DUE('2026-11-20'), committed_deadline: DUE('2026-11-20'), outcome: 'due', department_id: U(91), ...o });
test('Thursday 17:00 review tomorrow: the owner\'s committed rows not done; a Founders\'-space row stays out of Slack', async () => {
  const tasks = [T(1), T(2), T(5, { space_id: FS }), T(6, { owner_employee_id: P.FOU.id, space_id: FS, department_id: U(90) })];
  const s = stub({ mode: 'live', tasks, identities: MAPPED, score: [row(tasks[0]), row(tasks[1], { status: 'done' }), row(tasks[2]),
    row(tasks[3], { owner_employee_id: P.FOU.id })] });
  await fire(s, THU17);
  const own = s.dms.find(d => d.to === P.OWN.id);
  assert.match(own.text, /1 committed task not done/);
  const j = JSON.stringify(own.blocks);
  assert.ok(j.includes(U(101)) && !j.includes(U(102)) && !j.includes(U(105)) && !j.includes(U(106)), j);
  assert.ok(!/Founders' space/.test(j), "a space the owner can't open isn't even counted");
  // the founder (who owns that space) has only a Founders'-space row: kept out of Slack, but counted
  const f = s.dms.find(d => d.to === P.FOU.id);
  assert.ok(!f, 'nothing listable → no DM');
  assert.ok(logOf(s).includes('review_tomorrow:Founder:skipped_empty'), JSON.stringify(logOf(s)));
});

test('C1: review tomorrow gates a plan admin by space too — a committed task now in a space they can\'t open never leaks', async () => {
  const tasks = [T(7, { owner_employee_id: P.FOU.id, department_id: U(90) }), T(8, { owner_employee_id: P.FOU.id, department_id: U(90), space_id: PRIV, title: 'ZZ secret' })];
  const s = stub({ mode: 'live', tasks, identities: MAPPED, score: tasks.map(t => row(t, { owner_employee_id: P.FOU.id })) });
  await fire(s, THU17);
  const f = s.dms.find(d => d.to === P.FOU.id);
  const j = JSON.stringify(f.blocks);
  assert.ok(j.includes(U(107)), j);
  assert.ok(!j.includes(U(108)) && !j.includes('ZZ secret'), j);
  assert.match(f.text, /1 committed task not done/);
});

test('C2: review tomorrow goes to the owner AT COMMIT TIME, even after they handed their last open task on', async () => {
  // the task now belongs to the founder; the frozen cohort still has OWN as its owner (who the review scores)
  const tasks = [T(9, { owner_employee_id: P.FOU.id })];
  const s = stub({ mode: 'live', tasks, identities: MAPPED, score: [row(tasks[0], { owner_employee_id: P.OWN.id })] });
  await fire(s, THU17);
  const own = s.dms.find(d => d.to === P.OWN.id);
  assert.ok(own, JSON.stringify(logOf(s)));
  assert.ok(JSON.stringify(own.blocks).includes(U(109)));
  assert.ok(!s.dms.some(d => d.to === P.FOU.id), 'not the current owner — they did not commit to it');
});

test('Friday 18:00 catch-up goes to founders only', async () => {
  const s = stub({ mode: 'live', tasks: OWNED, identities: MAPPED });
  await fire(s, FRI18);
  assert.deepEqual(s.dms.map(d => d.to), [P.FOU.id]);
  assert.match(JSON.stringify(s.dms[0].blocks), /Founders' catch-up/);
  assert.match(JSON.stringify(s.dms[0].blocks), /review\/founders/);
});

test('09:30 chase: the Associate gets the list, the founder one line, a plain owner nothing; nothing due → skipped', async () => {
  const SOON = new Date(Date.now() + 3600000).toISOString();
  const s = stub({ mode: 'live', tasks: [T(1, { deadline: SOON }), T(2, { deadline: FAR })], identities: MAPPED });
  await fire(s, MON930);
  assert.ok(!s.dms.some(d => d.to === P.OWN.id || d.to === P.NL.id));
  const a = s.dms.find(d => d.to === P.ASSOC.id), f = s.dms.find(d => d.to === P.FOU.id);
  assert.ok(a && f, JSON.stringify(logOf(s)));
  assert.match(a.text, /^Chase: 1 task due soon/);
  assert.ok(JSON.stringify(a.blocks).includes(U(101)) && !JSON.stringify(a.blocks).includes(U(102)));
  assert.equal(f.blocks.length, 1);
  assert.match(f.text, /^Chase: 1 task due in the next 2 working days/);
  assert.ok(!f.text.includes('DKT-1'));
  const t = stub({ mode: 'live', tasks: [T(2, { deadline: FAR })], identities: MAPPED });
  await fire(t, MON930);
  assert.equal(t.dms.length, 0);
  assert.deepEqual(logOf(t), ['chase:Assoc:skipped_empty', 'chase:Founder:skipped_empty']);
});

async function preview(s, slot, who = P.FOU) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.pathname === '/auth/v1/user') return new Response(JSON.stringify({ id: who.auth_user_id, email: who.work_email }));
    return s.fn(input, init);
  };
  try {
    const res = await worker.fetch(new Request('https://docketops.test/', { method: 'POST', headers: { Authorization: 'Bearer zz', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'slackReminderPreview', slot }) }), ENV);
    return { status: res.status, j: await res.json() };
  } finally { globalThis.fetch = real; }
}
test('slackReminderPreview: plan admin only; DMs the caller their own version now; no log row; whatever the mode', async () => {
  let s = stub({ mode: 'off', tasks: OWNED, identities: MAPPED });
  let r = await preview(s, 'owner_daily');
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data, { slot: 'owner_daily', sent: true });
  assert.deepEqual(s.dms.map(d => d.to), [P.FOU.id]);
  assert.match(s.dms[0].text, /^\[Preview\] Docket: 1 overdue/);
  assert.equal(s.db.log.length, 0);
  r = await preview(s, 'owner_daily', P.OWN);
  assert.equal(r.status, 403);
  r = await preview(s, 'nope');
  assert.equal(r.status, 400);
  s = stub({ mode: 'off', tasks: [], identities: MAPPED });
  r = await preview(s, 'owner_daily');
  assert.deepEqual(r.j.data, { slot: 'owner_daily', sent: false, empty: true });
  assert.equal(s.dms.length, 0);
});

// ── review findings ──
const quietLog = async (f) => { const ce = console.error, cl = console.log, logged = { error: [], log: [] };
  console.error = (...a) => logged.error.push(a); console.log = (...a) => logged.log.push(a);
  try { await f(); } finally { console.error = ce; console.log = cl; } return logged; };
const ONE = [T(1, { deadline: PAST })];

test('H1: only "no such user" / a refused identity is unmapped; a rate limit or other error is failed (with its code), retried once', async () => {
  let s = stub({ mode: 'live', tasks: ONE, identities: [], lookupErr: { [P.OWN.id]: 'ratelimited' } });
  await fire(s, MON9);
  assert.deepEqual(logOf(s), ['owner_daily:Owner:failed/ratelimited']);
  assert.equal(s.calls.filter(c => c.p === '/api/users.lookupByEmail').length, 2, 'Retry-After honoured once, then given up');
  assert.equal(s.dms.length, 0);
  s = stub({ mode: 'live', tasks: ONE, identities: [], lookupErr: { [P.OWN.id]: 'fatal_error' } });
  await fire(s, MON9);
  assert.deepEqual(logOf(s), ['owner_daily:Owner:failed/fatal_error']);
  s = stub({ mode: 'live', tasks: ONE, identities: [], lookupMiss: [P.OWN.id] });
  await fire(s, MON9);
  assert.deepEqual(logOf(s), ['owner_daily:Owner:unmapped/no_slack_user']);
  s = stub({ mode: 'live', tasks: ONE, identities: [], stranger: [P.OWN.id] });
  await fire(s, MON9);
  assert.deepEqual(logOf(s), ['owner_daily:Owner:unmapped/slack_identity_refused']);
  assert.equal(s.db.identities.length, 0);
});

test('H1: auth.test failing (a fresh isolate) is failed/auth_test_failed, not unmapped', async () => {
  const fresh = (await import('data:text/javascript,' + encodeURIComponent(code + '\n// isolate 2'))).default;
  const s = stub({ mode: 'live', tasks: ONE, identities: [], authTestDown: true });
  await fire(s, MON9, fresh);
  assert.deepEqual(logOf(s), ['owner_daily:Owner:failed/auth_test_failed']);
});

test('H1: a row older than its 6–8 day re-check is looked up again; a fresh one is not', async () => {
  const old = new Date(Date.now() - 9 * 86400000).toISOString(), recent = new Date(Date.now() - 5 * 86400000).toISOString();
  let s = stub({ mode: 'live', tasks: ONE, identities: [{ employee_id: P.OWN.id, slack_user_id: P.OWN.slack, resolved_at: old }] });
  await fire(s, MON9);
  assert.equal(s.calls.filter(c => c.p === '/api/users.lookupByEmail').length, 1);
  s = stub({ mode: 'live', tasks: ONE, identities: [{ employee_id: P.OWN.id, slack_user_id: P.OWN.slack, resolved_at: recent }] });
  await fire(s, MON9);
  assert.equal(s.calls.filter(c => c.p === '/api/users.lookupByEmail').length, 0);
  assert.deepEqual(s.dms.map(d => d.to), [P.OWN.id]);
});

test('H2: a failed claim write sends nothing, is logged, and counts as claim_failed (not "already"); scheduled() logs the counts', async () => {
  const s = stub({ mode: 'live', tasks: ONE, identities: MAPPED, claimDown: true });
  const logged = await quietLog(() => fire(s, MON9));
  assert.equal(s.dms.length, 0);
  assert.ok(logged.error.some(a => a[0] === 'docketops reminder claim failed'));
  const line = logged.log.find(a => a[0] === 'docketops reminders');
  assert.ok(line, JSON.stringify(logged.log));
  const c = JSON.parse(line[1]);
  assert.deepEqual([c.slot, c.claim_failed, c.already, c.sent], ['owner_daily', 1, 0, 0]);
});

test('H4: two employees on one Slack account get one DM; the second is unmapped/duplicate_slack_user', async () => {
  const tasks = [T(1, { deadline: PAST }), T(2, { deadline: PAST, owner_employee_id: P.FOU.id })];
  const ids = [{ employee_id: P.OWN.id, slack_user_id: 'USAME001', resolved_at: new Date().toISOString() },
    { employee_id: P.FOU.id, slack_user_id: 'USAME001', resolved_at: new Date().toISOString() }];
  const s = stub({ mode: 'live', tasks, identities: ids });
  await fire(s, MON9);
  assert.equal(s.calls.filter(c => c.p === '/api/chat.postMessage').length, 1);
  assert.equal(logOf(s).filter(x => x.endsWith(':sent')).length, 1);
  assert.equal(logOf(s).filter(x => x.endsWith(':unmapped/duplicate_slack_user')).length, 1);
});
