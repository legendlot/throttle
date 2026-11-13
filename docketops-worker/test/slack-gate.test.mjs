// Run: node --test docketops-worker/test/*.test.mjs
// F9 R7a — /slack/commands and /slack/interactive end to end through the worker against a stubbed Supabase + Slack:
// the signature gate (503 with no secret, 401 unsigned / forged), help answered at once, the Slack user mapped to
// a Docket person (cached row / first-time users.info → work email → login, saved; unmapped → plain words and
// nothing written; no self-provision), and each action running AS that person through the app's own handler with
// history source 'slack': /docket add · mine · propose, Done, Move date, Comment, Accept, the task modal (views.open
// at once, permalink saved as a link, unmapped owner = field error) — and the slow part handed to ctx.waitUntil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'zz-signing';
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a', SLACK_DOCKET_SIGNING_SECRET: SECRET, SLACK_DOCKET_BOT_TOKEN: 'xoxb-zz' };
// ME = auth user of employee MEE (Slack UME). OTHER = an employee with a login (Slack UOT). NOLOGIN has none (UNL).
const ME = U(1), MEE = U(2), OTH = U(3), OTE = U(4), NLE = U(5), G = U(20), PERS = U(27), D1 = U(10), D2 = U(11), TASK = U(100), PLAN = U(30);
const EMPS = [
  { id: MEE, full_name: 'Zzme Me', department_id: D1, auth_user_id: ME, status: 'active', work_email: 'zz.me@legendoftoys.com', slack: 'UME0001' },
  { id: OTE, full_name: 'Zzother Other', department_id: D2, auth_user_id: OTH, status: 'active', work_email: 'zz.other@legendoftoys.com', slack: 'UOT0001' },
  { id: NLE, full_name: 'Zznologin Nologin', department_id: D2, auth_user_id: null, status: 'active', work_email: 'zz.nologin@legendoftoys.com', slack: 'UNL0001' },
];
const TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');

function stub({ cached = [], tasks = [], profileActive = true, hooksDown = false, hold = null } = {}) {
  const db = { identities: cached.map(r => ({ ...r })), tasks: tasks.map(t => ({ ...t })) };
  const calls = [], history = [], posted = [], patches = [], slack = [], responds = [], docs = [], comments = [], rpcs = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search);
    const q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const isJson = init.body && String(init.body).trim().match(/^[[{"]/);
    const reqBody = init.body ? (isJson ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : null;
    if (hold) await hold;   // C1: every I/O waits here until the test lets it go
    calls.push({ method, p, body: reqBody, host: u.host });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.host === 'hooks.slack.com') { if (hooksDown) return new Response('expired_url', { status: 404 }); responds.push(reqBody); return new Response('ok'); }
    if (u.host === 'slack.com') {
      const m = u.pathname.replace('/api/', '');
      slack.push({ m, body: reqBody, auth: init.headers.Authorization });
      if (m === 'auth.test') return body({ ok: true, team_id: 'TLOT' });
      if (m === 'conversations.open') return body({ ok: true, channel: { id: 'D' + reqBody.users } });
      if (m === 'users.info') {
        // UFX0001 / UST0001: a guest from another org — Me's email, but another team / a stranger (H7)
        if (reqBody.user === 'UFX0001') return body({ ok: true, user: { id: 'UFX0001', team_id: 'TOTHER', profile: { email: EMPS[0].work_email } } });
        if (reqBody.user === 'UST0001') return body({ ok: true, user: { id: 'UST0001', team_id: 'TLOT', is_stranger: true, profile: { email: EMPS[0].work_email } } });
        const e = EMPS.find(x => x.slack === reqBody.user);
        return body(e ? { ok: true, user: { id: e.slack, team_id: 'TLOT', profile: { email: e.work_email.toUpperCase() } } } : { ok: true, user: { id: reqBody.user, team_id: 'TLOT', profile: { email: 'zz.stranger@gmail.com' } } });
      }
      if (m === 'views.open') return body({ ok: true, view: { id: 'V1', hash: 'h1' } });
      if (m === 'chat.getPermalink') return body({ ok: true, permalink: 'https://legendoftoys.slack.com/archives/C1/p12' });
      return body({ ok: true });
    }
    if (u.pathname === '/auth/v1/user') return body({}, 401);   // no JWT on any Slack path
    if (p.startsWith('/rest/v1/slack_identities?slack_user_id=eq.') && method === 'GET') return body(db.identities.filter(r => r.slack_user_id === eq('slack_user_id')));
    if (u.pathname === '/rest/v1/slack_identities' && method === 'DELETE') { db.identities = db.identities.filter(x => x.slack_user_id !== eq('slack_user_id')); return new Response(null, { status: 204 }); }
    if (u.pathname === '/rest/v1/slack_identities' && method === 'POST') {
      assert.equal(q.get('on_conflict'), 'employee_id');
      // slack_user_id is UNIQUE: on another employee's row it would 409 (H1 — the worker clears it first)
      if (reqBody.some(r => db.identities.some(x => x.slack_user_id === r.slack_user_id && x.employee_id !== r.employee_id))) return body({ code: '23505' }, 409);
      for (const r of reqBody) { db.identities = db.identities.filter(x => x.employee_id !== r.employee_id); db.identities.push(r); }
      return new Response(null, { status: 201 });
    }
    if (p.startsWith('/rest/v1/employees?work_email=ilike.')) {
      assert.match(p, /status=eq\.active/);
      const want = q.get('work_email').replace(/^ilike\./, '').replace(/\\_/g, '_');
      return body(EMPS.filter(e => e.work_email.toLowerCase() === want.toLowerCase()).map(({ slack, ...e }) => e));
    }
    if (p.startsWith('/rest/v1/users_profile?id=eq.')) return body([{ role: 'viewer', full_name: 'ZZ', active: profileActive }]);
    if (u.pathname === '/rest/v1/users_profile' && method === 'POST') { posted.push({ provision: reqBody }); return body([]); }
    if (p.startsWith('/rest/v1/users_profile?')) return body([]);
    if (p.startsWith('/rest/v1/docket_user_roles?')) return body([]);
    if (p.includes('/employees?auth_user_id=eq.')) return body(EMPS.filter(e => e.auth_user_id === eq('auth_user_id')).map(({ slack, ...e }) => e));
    if (p.includes('/employees?status=eq.active')) return body(EMPS.map(({ slack, work_email, ...e }) => e));
    if (p.includes('/employees?id=eq.')) return body(EMPS.filter(e => e.id === eq('id')).map(({ slack, ...e }) => e));
    if (p.includes('/employees?id=in.')) return body(EMPS.filter(e => inIds(q.get('id')).includes(e.id)).map(({ slack, ...e }) => e));
    if (p.includes('/departments')) return body([{ id: D1, name: 'ZZ one' }, { id: D2, name: 'ZZ two' }]);
    if (p.includes('/rpc/ensure_personal_space')) return body(PERS);
    if (p.includes('/rpc/next_task_seq')) return body('DKT-77');
    if (p.includes('/rpc/plan_propose')) { rpcs.push({ fn: 'plan_propose', body: reqBody }); return body({ ok: true, id: U(40) }); }
    if (p.includes('/rpc/task_set_deadline')) { rpcs.push({ fn: 'task_set_deadline', body: reqBody }); return body({ ok: true }); }
    if (p.includes('/rpc/plan_items_for')) return body([{ id: PLAN, level: 'T', state: 'agreed', code: 'T1', title: 'ZZ plan thing' }]);
    if (p.includes('/rpc/plan_links_for')) return body([{ id: PLAN, level: 'T', state: 'agreed' }]);
    if (p.includes('/rpc/list_my_tasks')) return body(db.tasks);
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/spaces?is_default=eq.true')) return body([{ id: G }]);
    if (p.startsWith('/rest/v1/spaces?id=eq.') || p.startsWith('/rest/v1/spaces?id=in.')) {
      const SP = { [G]: { id: G, name: 'General', is_default: true, is_private: false, is_founders: false, owner_user_id: null },
        [PERS]: { id: PERS, name: 'Personal', is_default: false, is_private: true, is_founders: false, is_personal: true, owner_user_id: ME } };
      return body(inIds(q.get('id').replace(/^eq\./, '')).map(id => SP[id]).filter(Boolean));
    }
    if (p.startsWith('/rest/v1/task_history') && method === 'POST') { history.push(...[].concat(reqBody)); return body([]); }
    if (p.startsWith('/rest/v1/task_documents') && method === 'POST') { docs.push(...reqBody); return body([]); }
    if (p.startsWith('/rest/v1/task_comments') && method === 'POST') { comments.push(...[].concat(reqBody)); return body([{ id: U(50), ...[].concat(reqBody)[0] }]); }
    if (u.pathname === '/rest/v1/tasks' && method === 'POST') { const row = { ...reqBody[0], id: U(199) }; posted.push(reqBody[0]); db.tasks.push(row); return body([row]); }
    if (u.pathname === '/rest/v1/tasks' && method === 'PATCH') {
      patches.push({ p, body: reqBody });
      const row = db.tasks.find(t => t.id === eq('id'));
      if (!row) return body([]);
      Object.assign(row, reqBody);
      return body([row]);
    }
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('id')?.startsWith('eq.')) return body(db.tasks.filter(t => t.id === eq('id')));
      if (q.get('id')?.startsWith('in.')) return body(db.tasks.filter(t => inIds(q.get('id')).includes(t.id)));
      return body([]);
    }
    return body([]);
  };
  return { fn, calls, history, posted, patches, slack, responds, docs, comments, rpcs, db };
}
const T = (o) => ({ id: TASK, task_no: 'DKT-5', title: 'ZZ task', status: 'in_progress', priority: 'P2', owner_employee_id: MEE, assignee_employee_id: null,
  created_by_user_id: ME, department_id: D1, deadline: new Date(Date.now() - 86400000).toISOString(), revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, archived_at: null, is_recurring: false, handoff_to_department_id: null, handoff_to_employee_id: null,
  handoff_accepted_at: null, handoff_accepted_by: null, ...o });
const FRESH = new Date(Date.now() - 86400000).toISOString();
const MAPPED = [{ employee_id: MEE, slack_user_id: 'UME0001', auth_user_id: ME, resolved_at: FRESH }];

function signed(path, raw, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  return new Request(`https://docketops.test${path}`, { method: 'POST', body: raw,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig } });
}
const cmdBody = (text, user = 'UME0001') => new URLSearchParams({ command: '/docket', text, user_id: user, response_url: 'https://hooks.slack.com/commands/T1/1/x', trigger_id: 't' }).toString();
const actBody = (payload) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
async function run(s, req, { env = ENV, ctx } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = s.fn;
  try {
    const res = await worker.fetch(req, env, ctx);
    if (ctx) await Promise.all(ctx.jobs);
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* empty ack */ }
    return { status: res.status, j, text };
  } finally { globalThis.fetch = real; }
}
const mkCtx = () => { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; };

// ── the gate ──
test('gate: no secret → 503, unsigned / forged / stale → 401, on both routes; nothing read', async () => {
  for (const path of ['/slack/commands', '/slack/interactive']) {
    const s = stub();
    const { SLACK_DOCKET_SIGNING_SECRET, ...noSecret } = ENV;
    assert.equal((await run(s, signed(path, cmdBody('help')), { env: noSecret })).status, 503);
    const raw = cmdBody('mine');
    assert.equal((await run(s, new Request(`https://docketops.test${path}`, { method: 'POST', body: raw }))).status, 401);
    assert.equal((await run(s, signed(path, raw, { secret: 'other' }))).status, 401);
    assert.equal((await run(s, signed(path, raw, { ts: Math.floor(Date.now() / 1000) - 400 }))).status, 401);
    // the signature covers the raw body: a body changed after signing is refused
    const good = signed(path, raw);
    const tampered = new Request(good.url, { method: 'POST', body: raw + '&x=1', headers: good.headers });
    assert.equal((await run(s, tampered)).status, 401);
    assert.equal(s.calls.length, 0);
  }
});

test('/docket help (and empty, and unknown) answers at once with usage; no identity lookup', async () => {
  for (const t of ['', 'help', 'zap it']) {
    const s = stub();
    const r = await run(s, signed('/slack/commands', cmdBody(t)));
    assert.equal(r.status, 200);
    assert.equal(r.j.response_type, 'ephemeral');
    assert.match(r.j.text, /\/docket add/);
    assert.equal(s.calls.length, 0);
  }
});

test('/docket add: as the mapped person, via createTask — quick-add tokens, self as owner, source slack, link back; work in waitUntil', async () => {
  const s = stub({ cached: MAPPED });
  const ctx = mkCtx();
  const r = await run(s, signed('/slack/commands', cmdBody('add ZZ ship the cards !p1 tomorrow')), { ctx });
  assert.equal(r.status, 200); assert.equal(r.text, '');
  assert.equal(ctx.jobs.length, 1);
  assert.equal(s.posted.length, 1);
  const t = s.posted[0];
  assert.deepEqual([t.title, t.owner_employee_id, t.priority, t.created_by_user_id], ['ZZ ship the cards', MEE, 'P1', ME]);
  assert.ok(t.deadline && Date.parse(t.deadline) > Date.now());
  assert.ok(s.history.length >= 1 && s.history.every(h => h.source === 'slack'), JSON.stringify(s.history));
  assert.match(s.responds[0].text, /docket\.legendoftoys\.com\/tasks\?task=/);
  assert.equal(s.responds[0].response_type, 'ephemeral');
  assert.ok(!s.calls.some(c => c.p.startsWith('/auth/v1/user')), 'no JWT round trip');
  assert.equal(s.slack.filter(x => x.m === 'users.info').length, 0, 'cached: Slack not asked');
});

test('/docket add @name sets the owner through the shared parser', async () => {
  const s = stub({ cached: MAPPED });
  await run(s, signed('/slack/commands', cmdBody('add ZZ brief @zzother')));
  assert.equal(s.posted[0].owner_employee_id, OTE);
  assert.equal(s.posted[0].title, 'ZZ brief');
  const s2 = stub({ cached: MAPPED });
  await run(s2, signed('/slack/commands', cmdBody('add ZZ brief @Zz')));   // ambiguous (three Zz… people) → text, owner self
  assert.equal(s2.posted[0].owner_employee_id, MEE);
  assert.equal(s2.posted[0].title, 'ZZ brief @Zz');
});

test('first use: users.info → work email (case-insensitive) → active employee → login; the mapping is saved', async () => {
  const s = stub();
  await run(s, signed('/slack/commands', cmdBody('add ZZ first')));
  assert.equal(s.slack.filter(x => x.m === 'users.info').length, 1);
  assert.equal(s.slack[0].auth, 'Bearer xoxb-zz');
  assert.deepEqual(s.db.identities.map(r => [r.employee_id, r.slack_user_id, r.auth_user_id]), [[MEE, 'UME0001', ME]]);
  assert.equal(s.posted.length, 1);
});

test('unmapped (no employee / no login / inactive profile): plain words, nothing written, never provisioned', async () => {
  for (const [user, opts] of [['UZZ0009', {}], ['UNL0001', {}], ['UME0001', { cached: MAPPED, profileActive: false }]]) {
    const s = stub(opts);
    const r = await run(s, signed('/slack/commands', cmdBody('add ZZ nope', user)));
    assert.equal(r.status, 200);
    assert.match(s.responds[0].text, /isn't linked to a Docket login/);
    assert.equal(s.posted.length, 0, user);
    assert.ok(!s.calls.some(c => c.method === 'POST' && c.p.startsWith('/rest/v1/users_profile')), 'no self-provision');
    if (user !== 'UME0001') assert.equal(s.db.identities.length, 0, user);
  }
});

test('/docket mine: their own open tasks, with buttons', async () => {
  const s = stub({ cached: MAPPED, tasks: [T(), T({ id: U(101), task_no: 'DKT-6', owner_employee_id: OTE })] });
  await run(s, signed('/slack/commands', cmdBody('mine')));
  const m = s.responds[0];
  assert.match(m.text, /1 overdue/);
  assert.ok(m.blocks.some(b => b.type === 'actions' && b.elements[0].value === TASK));
  assert.ok(!JSON.stringify(m.blocks).includes(U(101)), 'not an owner row');
});

test('/docket propose: the existing proposal action, as the person', async () => {
  const s = stub({ cached: MAPPED });
  await run(s, signed('/slack/commands', cmdBody('propose ZZ new line | ZZ the gap')));
  assert.equal(s.rpcs[0].fn, 'plan_propose');
  assert.deepEqual([s.rpcs[0].body.p_actor, s.rpcs[0].body.p_payload.title, s.rpcs[0].body.p_payload.why], [ME, 'ZZ new line', 'ZZ the gap']);
  assert.match(s.responds[0].text, /Proposed/);
  const s2 = stub({ cached: MAPPED });
  await run(s2, signed('/slack/commands', cmdBody('propose ' + 'x'.repeat(201) + ' | y')));
  assert.equal(s2.rpcs.length, 0);
  assert.match(s2.responds[0].text, /too long/);
});

const BTN = (action_id, user = 'UME0001') => ({ type: 'block_actions', user: { id: user }, trigger_id: 'tr', response_url: 'https://hooks.slack.com/actions/1',
  actions: [{ action_id, value: TASK }] });
test('Done button → changeStatus as the person (history source slack); someone else\'s task is refused in plain words', async () => {
  let s = stub({ cached: MAPPED, tasks: [T()] });
  let r = await run(s, signed('/slack/interactive', actBody(BTN('docket_done'))));
  assert.equal(r.status, 200);
  assert.equal(s.patches[0].body.status, 'done');
  assert.ok(s.history.some(h => h.event_type === 'status_changed' && h.source === 'slack'));
  assert.match(s.responds[0].text, /^Done/);
  s = stub({ cached: MAPPED, tasks: [T({ owner_employee_id: OTE, created_by_user_id: OTH, department_id: D2 })] });
  await run(s, signed('/slack/interactive', actBody(BTN('docket_done'))));
  assert.equal(s.patches.length, 0);
  assert.ok(!/server_error|forbidden|not_found/.test(s.responds[0].text), s.responds[0].text);
  s = stub({ tasks: [T()] });   // unmapped clicker
  await run(s, signed('/slack/interactive', actBody(BTN('docket_done', 'UZZ0009'))));
  assert.equal(s.patches.length, 0);
  assert.match(s.responds[0].text, /isn't linked/);
});

test('Move date / Comment buttons open a modal at once; submissions validate, then act via the app\'s handler', async () => {
  let s = stub({ cached: MAPPED, tasks: [T()] });
  await run(s, signed('/slack/interactive', actBody(BTN('docket_move'))));
  const open = s.slack.find(x => x.m === 'views.open');
  assert.equal(open.body.view.callback_id, 'docket_move');
  const meta = open.body.view.private_metadata;
  // missing reason → field error, nothing written
  const sub = (values, cb = 'docket_move', m = meta) => ({ type: 'view_submission', user: { id: 'UME0001' }, view: { callback_id: cb, private_metadata: m, state: { values } } });
  let r = await run(s, signed('/slack/interactive', actBody(sub({ date: { v: { selected_date: addD(TODAY, 3) } }, reason: { v: { value: ' ' } } }))));
  assert.equal(r.j.response_action, 'errors'); assert.ok(r.j.errors.reason);
  assert.equal(s.rpcs.length, 0);
  r = await run(s, signed('/slack/interactive', actBody(sub({ date: { v: { selected_date: addD(TODAY, 3) } }, reason: { v: { value: 'ZZ vendor late' } } }))));
  assert.equal(r.status, 200); assert.equal(r.text, '');
  const rd = s.rpcs.find(x => x.fn === 'task_set_deadline');
  assert.ok(rd, JSON.stringify(s.calls.map(c => c.p)));
  assert.equal(rd.body.p_source, 'slack');
  assert.match(s.responds.at(-1).text, /^Moved/);
  // comment
  s = stub({ cached: MAPPED, tasks: [T()] });
  r = await run(s, signed('/slack/interactive', actBody(sub({ body: { v: { value: '' } } }, 'docket_comment', JSON.stringify({ task_id: TASK })))));
  assert.ok(r.j.errors.body);
  await run(s, signed('/slack/interactive', actBody(sub({ body: { v: { value: 'ZZ on it' } } }, 'docket_comment', JSON.stringify({ task_id: TASK })))));
  assert.equal(s.comments[0].body, 'ZZ on it');
  assert.equal(s.slack.find(x => x.m === 'chat.postMessage').body.channel, 'DUME0001', 'no response_url → a DM (conversations.open)');
});

test('Accept hand-off button → acceptHandoff (its own checks decide)', async () => {
  const s = stub({ cached: [{ employee_id: OTE, slack_user_id: 'UOT0001', auth_user_id: OTH, resolved_at: FRESH }],
    tasks: [T({ handoff_to_department_id: D2, handoff_to_employee_id: OTE })] });
  await run(s, signed('/slack/interactive', actBody(BTN('docket_accept', 'UOT0001'))));
  assert.ok(s.patches.some(x => x.body.handoff_accepted_by === OTH || x.body.handoff_accepted_at), JSON.stringify(s.patches));
  assert.match(s.responds[0].text, /Hand-off accepted/);
});

test('Add to Docket: views.open at once (title from the message, owner = me); plan options then views.update', async () => {
  const s = stub({ cached: MAPPED });
  const ctx = mkCtx();
  const r = await run(s, signed('/slack/interactive', actBody({ type: 'message_action', callback_id: 'docket_add_from_message', trigger_id: 'tr9',
    user: { id: 'UME0001' }, channel: { id: 'C1' }, message: { ts: '12.34', text: 'pls send <https://x.io|the deck> to <@UOT0001|zz>' }, response_url: 'https://hooks.slack.com/a' })), { ctx });
  assert.equal(r.status, 200);
  assert.equal(s.slack[0].m, 'views.open', 'the modal opens before any lookup');
  assert.equal(s.slack[0].body.trigger_id, 'tr9');
  const v = s.slack[0].body.view;
  assert.equal(v.blocks[0].element.initial_value, 'pls send the deck to @zz');
  assert.equal(v.blocks[1].element.initial_user, 'UME0001');
  const upd = s.slack.find(x => x.m === 'views.update');
  assert.ok(upd.body.view.blocks.some(b => b.block_id === 'plan' && b.element.options[0].value === PLAN));
  assert.equal(upd.body.view_id, 'V1');
});

const TASKSUB = (values, meta = { channel: 'C1', ts: '12.34' }, user = 'UME0001') => ({ type: 'view_submission', user: { id: user },
  view: { callback_id: 'docket_task', private_metadata: JSON.stringify(meta), state: { values } } });
const tv = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { v }]));
test('task modal submit: pure field errors at once; an unmapped owner / receiver comes back by DM; else created as me with the permalink, DM confirm', async () => {
  let s = stub({ cached: MAPPED });
  let r = await run(s, signed('/slack/interactive', actBody(TASKSUB(tv({ title: { value: '' }, owner: { selected_user: 'UME0001' } })))));
  assert.deepEqual(Object.keys(r.j.errors), ['title']);
  assert.equal(s.calls.length, 0, 'field errors need no I/O');
  r = await run(s, signed('/slack/interactive', actBody(TASKSUB(tv({ title: { value: 'ZZ x' }, owner: { selected_user: 'UZZ0009' }, handoff: { selected_user: 'UFX0001' } })))));
  assert.equal(r.text, '', 'acked (modal closes) before the people are looked up');
  assert.equal(s.posted.length, 0);
  let dm = s.slack.find(x => x.m === 'chat.postMessage');
  assert.equal(dm.body.channel, 'DUME0001');
  assert.match(dm.body.text, /the owner and the hand-off receiver isn't an active Docket person/);

  s = stub({ cached: MAPPED });
  const date = addD(TODAY, 2);
  r = await run(s, signed('/slack/interactive', actBody(TASKSUB(tv({ title: { value: 'ZZ send deck' }, owner: { selected_user: 'UNL0001' },
    deadline: { selected_date: date }, plan: { selected_option: { value: PLAN } }, handoff: { selected_user: 'UME0001' } })))));
  assert.equal(r.status, 200); assert.equal(r.text, '', 'closes the modal');
  const t = s.posted[0];
  assert.deepEqual([t.title, t.owner_employee_id, t.created_by_user_id, t.plan_item_id, t.deadline],
    ['ZZ send deck', NLE, ME, PLAN, new Date(Date.parse(`${date}T18:00:00+05:30`)).toISOString()], 'H4: an owner with no Docket login is still an active employee');
  assert.equal(t.handoff_to_employee_id, MEE);
  assert.deepEqual(s.docs.map(d => [d.title, d.url]), [['Slack message', 'https://legendoftoys.slack.com/archives/C1/p12']]);
  assert.ok(s.history.every(h => h.source === 'slack'));
  dm = s.slack.find(x => x.m === 'chat.postMessage');
  assert.equal(dm.body.channel, 'DUME0001'); assert.match(dm.body.text, /^Added/);
  assert.equal(s.db.identities.length, 1, 'only the acting person is cached');
});

test('C1: the submission is acked while every lookup is still pending (pure validation only before the 200)', async () => {
  let release; const hold = new Promise(res => { release = res; });
  const s = stub({ cached: MAPPED, hold });
  const ctx = mkCtx();
  const real = globalThis.fetch; globalThis.fetch = s.fn;
  try {
    const res = await worker.fetch(signed('/slack/interactive', actBody(TASKSUB(tv({ title: { value: 'ZZ quick' }, owner: { selected_user: 'UME0001' } })))), ENV, ctx);
    assert.equal(res.status, 200); assert.equal(await res.text(), '');
    assert.equal(s.calls.length, 0, 'nothing has completed before the ack');
    assert.equal(ctx.jobs.length, 1);
    release();
    await Promise.all(ctx.jobs);
  } finally { globalThis.fetch = real; }
  assert.equal(s.posted[0].title, 'ZZ quick');
});

test('C2: an expired response_url falls back to a DM with the same words', async () => {
  const s = stub({ cached: MAPPED, tasks: [T()], hooksDown: true });
  await run(s, signed('/slack/interactive', actBody(BTN('docket_done'))));
  assert.equal(s.patches[0].body.status, 'done');
  assert.deepEqual(s.slack.filter(x => x.m === 'conversations.open' || x.m === 'chat.postMessage').map(x => x.m), ['conversations.open', 'chat.postMessage']);
  const dm = s.slack.find(x => x.m === 'chat.postMessage');
  assert.equal(dm.body.channel, 'DUME0001'); assert.match(dm.body.text, /^Done/);
  const s2 = stub({ cached: MAPPED, hooksDown: true });
  await run(s2, signed('/slack/commands', cmdBody('add ZZ late')));
  assert.match(s2.slack.find(x => x.m === 'chat.postMessage').body.text, /^Added/);
});

test('H1: a stale row is refreshed from Slack; a Slack id still on another employee\'s row is moved, not 409\'d', async () => {
  const OLD = new Date(Date.now() - 8 * 86400000).toISOString();
  let s = stub({ cached: [{ employee_id: MEE, slack_user_id: 'UME0001', auth_user_id: ME, resolved_at: OLD }] });
  await run(s, signed('/slack/commands', cmdBody('add ZZ a')));
  assert.equal(s.slack.filter(x => x.m === 'users.info').length, 1);
  assert.ok(Date.parse(s.db.identities[0].resolved_at) > Date.now() - 60000);
  assert.equal(s.posted.length, 1);
  // UME0001's fresh row is on another employee with a login that no longer resolves to them: the refused hit is
  // forgotten and re-resolved to Me — the Slack id moves rows (cleared first, so the UNIQUE never 409s)
  s = stub({ cached: [{ employee_id: OTE, slack_user_id: 'UME0001', auth_user_id: U(99), resolved_at: FRESH }] });
  await run(s, signed('/slack/commands', cmdBody('add ZZ b')));
  assert.deepEqual(s.db.identities.map(r => [r.employee_id, r.slack_user_id]), [[MEE, 'UME0001']]);
  assert.equal(s.posted[0].created_by_user_id, ME);
  const order = s.calls.filter(c => c.p.startsWith('/rest/v1/slack_identities') && c.method !== 'GET').map(c => c.method);
  assert.deepEqual(order.slice(-2), ['DELETE', 'POST'], 'the Slack id is cleared before the upsert');
});

test('H7: a guest from another workspace / a stranger with a matching email is not mapped', async () => {
  for (const u of ['UFX0001', 'UST0001']) {
    const s = stub();
    await run(s, signed('/slack/commands', cmdBody('add ZZ nope', u)));
    assert.equal(s.posted.length, 0, u);
    assert.equal(s.db.identities.length, 0, u);
    assert.match(s.responds[0].text, /isn't linked/);
  }
});

test('H5: a job that throws is logged and answered in plain words', async () => {
  const s = stub({ cached: MAPPED });
  const inner = s.fn;
  s.fn = async (input, init) => { const u = new URL(typeof input === 'string' ? input : input.url); if (u.pathname === '/rest/v1/slack_identities') throw new Error('boom'); return inner(input, init); };
  const logged = []; const ce = console.error; console.error = (...a) => logged.push(a);
  try { await run(s, signed('/slack/commands', cmdBody('mine'))); } finally { console.error = ce; }
  assert.equal(logged.length, 1);
  assert.equal(s.responds[0].text, "Docket couldn't finish that. Try it in Docket.");
});

test('verifyJWT still self-provisions for the app (the Slack path never does)', async () => {
  const s = stub();
  s.fn = ((inner) => async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.pathname === '/auth/v1/user') return new Response(JSON.stringify({ id: U(9), email: 'zz.new@legendoftoys.com' }));
    if (u.pathname === '/rest/v1/users_profile' && (init.method || 'GET') === 'GET') return new Response('[]');
    return inner(input, init);
  })(s.fn);
  const real = globalThis.fetch; globalThis.fetch = s.fn;
  try {
    const res = await worker.fetch(new Request('https://docketops.test/?action=getMe', { headers: { Authorization: 'Bearer zz' } }), ENV);
    assert.equal(res.status, 200);
  } finally { globalThis.fetch = real; }
  assert.equal(s.posted.filter(x => x.provision).length, 1);
});
