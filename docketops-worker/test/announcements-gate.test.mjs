// Run: node --test docketops-worker/test/*.test.mjs
// P4 announcements (migration 0040), against a stubbed Supabase + Slack: who can post (founder → everyone / any
// active team; a team head → only the teams they head; nobody else), who sees what, update / archive rights, Seen
// idempotent, the Slack mirror by mode (off / test / live; a team with no channel skipped; not_in_channel recorded,
// never thrown; never on an edit), getMe's announcements_unread + can_announce, and the admin-only settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// ME (login) = employee MEE in team DA. DA is headed by MEE; DX (inactive) too. DB is someone else's team.
// Teams are a tree: DP (head PHE, who sits in DQ — not a member of what they head) ⊃ DA, DB; DD hangs under the
// inactive DX (cut off).
const ME = U(1), MEE = U(2), OTHER = U(7), DA = U(10), DB = U(11), DX = U(12), DP = U(14), DD = U(15), DQ = U(16), PHE = U(22);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a', SLACK_DOCKET_BOT_TOKEN: 'xoxb-zz' };
const DEPTS = [
  { id: DP, name: 'ZZ Parent', active: true, parent_department_id: null, head_employee_id: PHE },
  { id: DQ, name: 'ZZ Quality', active: true, parent_department_id: null, head_employee_id: null },
  { id: DA, name: 'ZZ Team A', active: true, parent_department_id: DP, head_employee_id: MEE },
  { id: DB, name: 'ZZ Team B', active: true, parent_department_id: DP, head_employee_id: U(20) },   // nobody in PEOPLE
  { id: DX, name: 'ZZ Old team', active: false, parent_department_id: DA, head_employee_id: MEE },
  { id: DD, name: 'ZZ Under old', active: true, parent_department_id: DX, head_employee_id: null },
];
// active employees with a login: ME + P2 in DA, P3 in DB; P4 has no login (never in an audience); P5 has left
const PEOPLE = [
  { id: MEE, auth_user_id: ME, full_name: 'ZZ Me', department_id: DA, status: 'active', work_email: 'zz.me@legendoftoys.com', slack: 'UZZME' },
  { id: U(3), auth_user_id: U(4), full_name: 'ZZ Two', department_id: DA, status: 'active', work_email: 'zz.two@legendoftoys.com', slack: 'UZZTWO' },
  { id: U(5), auth_user_id: U(6), full_name: 'ZZ Three', department_id: DB, status: 'active', work_email: 'zz.three@legendoftoys.com', slack: 'UZZTHREE' },
  { id: U(8), auth_user_id: null, full_name: 'ZZ NoLogin', department_id: DA, status: 'active', work_email: null },
  { id: U(9), auth_user_id: U(13), full_name: 'ZZ Left', department_id: DA, status: 'exited', work_email: null },
  { id: PHE, auth_user_id: U(23), full_name: 'ZZ Parent Head', department_id: DQ, status: 'active', work_email: 'zz.ph@legendoftoys.com', slack: 'UZZPH' },
];
const ORG = 'C0ZZORG01', CHA = 'C0ZZTEAMA', NOTIN = 'C0ZZNOTIN';
const DEFAULT_SETTINGS = { mode: 'test', org_channel: null, team_channels: {}, test_employee_ids: [] };
const day = (d) => new Date(Date.now() + d * 86400000).toISOString();
const POST = (id, o) => ({ id, title: 'ZZ post ' + id.slice(-2), body: 'ZZ body', audience: 'everyone', author_user_id: OTHER, author_employee_id: null,
  pinned: false, expires_at: null, archived_at: null, slack: [], created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z', team_ids: [], ...o });
// E everyone (OTHER) · TA team A · TB team B · MINE team B by ME · EXP expired · ARCH archived · PIN pinned old
const E = U(40), TA = U(41), TB = U(42), MINE = U(43), EXP = U(44), ARCH = U(45), PIN = U(46);
const BASE_POSTS = () => [
  POST(E, { created_at: '2026-11-12T00:00:00Z' }),
  POST(TA, { audience: 'teams', team_ids: [DA], created_at: '2026-11-11T00:00:00Z' }),
  POST(TB, { audience: 'teams', team_ids: [DB] }),
  POST(MINE, { audience: 'teams', team_ids: [DB], author_user_id: ME, author_employee_id: MEE, created_at: '2026-11-09T00:00:00Z' }),
  POST(EXP, { expires_at: day(-1) }),
  POST(ARCH, { archived_at: day(-2) }),
  POST(PIN, { pinned: true, created_at: '2026-11-01T00:00:00Z' }),
];

const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');
// A PostgREST filter, honestly applied: eq / is / gt / in / not.is.null on any column, and or=(…) of those.
function one(r, k, v) {
  if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
  if (v === 'is.null') return r[k] == null;
  if (v === 'not.is.null') return r[k] != null;
  if (v === 'is.true') return r[k] === true;
  if (v === 'is.false') return r[k] === false;
  if (v.startsWith('gt.')) return r[k] != null && Date.parse(r[k]) > Date.parse(v.slice(3));
  if (v.startsWith('in.')) return inIds(v).includes(String(r[k]));
  throw new Error('stub: unsupported filter ' + k + '=' + v);
}
// PostgREST's logic trees — or=(a,b) / and=(or(…),…), nested, `col.op.value` leaves (in.(…) kept whole).
function splitTop(str) {
  const out = []; let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function logic(r, op, inner) {
  const parts = splitTop(inner).map(p => {
    const m = /^(and|or)\((.*)\)$/.exec(p);
    if (m) return logic(r, m[1], m[2]);
    const i = p.indexOf('.');
    return one(r, p.slice(0, i), p.slice(i + 1));
  });
  return op === 'or' ? parts.some(Boolean) : parts.every(Boolean);
}
function filterRows(rows, q) {
  let out = rows.filter(r => {
    for (const [k, v] of q.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k) || k.includes('.')) continue;   // a.b = an embed filter
      if (k === 'or' || k === 'and') { if (!logic(r, k, v.replace(/^\(|\)$/g, ''))) return false; continue; }
      if (!one(r, k, v)) return false;
    }
    return true;
  });
  const off = Number(q.get('offset') || 0), lim = q.get('limit') ? Number(q.get('limit')) : Infinity;
  return out.slice(off, off + lim);
}
const pick = (r, select) => {
  if (!select || select === '*') return r;
  const cols = select.replace(/\w+\([^)]*\)/g, '').split(',').filter(Boolean);
  return Object.fromEntries(cols.map(c => [c, r[c]]));
};

function stub({ perms = {}, employee = PEOPLE[0], posts = BASE_POSTS(), seen = [], settings = DEFAULT_SETTINGS, slackErr = {}, teamsInsertFails = false } = {}) {
  const st = { posts, teams: [], seen: seen.slice(), settings, n: 0 };
  for (const p of posts) for (const d of p.team_ids) st.teams.push({ announcement_id: p.id, department_id: d });
  const calls = [], slack = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search), q = u.searchParams, path = u.pathname;
    const method = (init.method || 'GET').toUpperCase();
    const raw = init.body ? String(init.body) : '';
    const reqBody = raw ? (/^[[{"]/.test(raw.trim()) ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : null;
    calls.push({ method, p, path, body: reqBody, host: u.host, headers: init.headers || {} });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'slack.com') {
      const m = path.replace('/api/', '');
      slack.push({ m, body: reqBody });
      if (m === 'auth.test') return body({ ok: true, team_id: 'TLOT' });
      if (m === 'users.lookupByEmail') {
        const e = PEOPLE.find(x => x.work_email === reqBody.email);
        return body(e ? { ok: true, user: { id: e.slack, team_id: 'TLOT', profile: { email: e.work_email } } } : { ok: false, error: 'users_not_found' });
      }
      if (m === 'conversations.open') return body({ ok: true, channel: { id: 'D' + reqBody.users } });
      if (m === 'chat.postMessage') return body(slackErr[reqBody.channel] ? { ok: false, error: slackErr[reqBody.channel] } : { ok: true, ts: '1.' + reqBody.channel });
      return body({ ok: true });
    }
    if (path === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (p.startsWith('/rest/v1/users_profile?id=eq.') && method === 'GET') return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (path === '/rest/v1/users_profile') {
      const names = { [ME]: 'ZZ Me', [OTHER]: 'ZZ Other' };
      return body(inIds(q.get('id')).map(id => ({ id, full_name: names[id] || null })));
    }
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(Object.keys(perms).length ? [{ role_key: 'zz_role' }] : []);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_role', permissions: perms }]);
    if (path === '/rest/v1/employees' && q.get('auth_user_id') === 'eq.' + ME) return body(employee ? [employee] : []);
    if (path === '/rest/v1/employees') return body(filterRows(PEOPLE, q).map(r => pick(r, q.get('select'))));
    if (path === '/rest/v1/departments') return body(filterRows(DEPTS, q).map(r => pick(r, q.get('select'))));
    if (path === '/rest/v1/settings') {
      if (method === 'POST') { assert.equal(q.get('on_conflict'), 'key'); if (reqBody.key === 'announcements') st.settings = reqBody.value; return body([]); }
      if (q.get('key') === 'eq.announcements') return body(st.settings ? [{ value: st.settings }] : []);
      return body([]);
    }
    if (path === '/rest/v1/announcements') {
      if (method === 'GET') {
        const sel = q.get('select') || '';
        const seenUser = (q.get('announcement_seen.user_id') || '').replace(/^eq\./, '');
        return body(filterRows(st.posts, q).map(r => ({ ...pick(r, sel),
          ...(sel.includes('announcement_teams(') ? { announcement_teams: st.teams.filter(t => t.announcement_id === r.id).map(t => ({ department_id: t.department_id })) } : {}),
          ...(sel.includes('announcement_seen(') ? { announcement_seen: st.seen.filter(s => s.announcement_id === r.id && (!seenUser || s.user_id === seenUser)).map(s => ({ user_id: s.user_id })) } : {}) })));
      }
      if (method === 'POST') {
        const row = POST(U(900 + ++st.n), { ...reqBody, slack: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), team_ids: undefined });
        delete row.team_ids;
        st.posts.push(row); return body([row], 201);
      }
      const hit = filterRows(st.posts, q);
      if (method === 'PATCH') { hit.forEach(r => Object.assign(r, reqBody)); return body(hit); }
      if (method === 'DELETE') { st.posts = st.posts.filter(r => !hit.includes(r)); return body([]); }
    }
    if (path === '/rest/v1/announcement_teams' && method === 'GET') return body(filterRows(st.teams, q).map(r => pick(r, q.get('select'))));
    if (path === '/rest/v1/announcement_teams' && method === 'POST') {
      if (teamsInsertFails) return body({ message: 'zz down' }, 503);
      for (const t of reqBody) {
        const parent = st.posts.find(x => x.id === t.announcement_id);
        if (parent && parent.audience !== 'teams') return body({ message: 'announcement_audience' }, 400);
        st.teams.push(t);
      }
      return body([], 201);
    }
    if (path === '/rest/v1/announcement_seen') {
      if (method === 'GET') return body(filterRows(st.seen, q).map(r => pick(r, q.get('select'))));
      if (method === 'POST') {
        assert.equal(q.get('on_conflict'), 'announcement_id,user_id');
        assert.match(init.headers?.Prefer || '', /resolution=ignore-duplicates/);
        for (const s of reqBody) if (!st.seen.some(x => x.announcement_id === s.announcement_id && x.user_id === s.user_id)) st.seen.push({ ...s, seen_at: new Date().toISOString() });
        return body([], 201);
      }
    }
    if (path === '/rest/v1/slack_identities') return body([]);
    if (p.includes('/rpc/ensure_personal_space')) return body(U(99));
    if (p.includes('/rpc/')) return body([]);
    return body([]);
  };
  return { fn, calls, slack, st };
}
async function run(s, { get, post }, ctx) {
  const real = globalThis.fetch;
  globalThis.fetch = s.fn;
  try {
    const req = get
      ? new Request('https://docketops.test/?' + new URLSearchParams(get), { headers: { Authorization: 'Bearer zz' } })
      : new Request('https://docketops.test/', { method: 'POST', headers: { Authorization: 'Bearer zz', 'content-type': 'application/json' }, body: JSON.stringify(post) });
    const res = await worker.fetch(req, ENV, ctx);
    return { status: res.status, j: await res.json() };
  } finally { globalThis.fetch = real; }
}
const annWrites = (s) => s.calls.filter(c => c.method !== 'GET' && /^\/rest\/v1\/announcement/.test(c.path));
const posted = (s) => s.slack.filter(x => x.m === 'chat.postMessage');
const FOUNDER = { docket_plan_admin: true }, ADMIN = { docket_admin: true };
const NEW = (o = {}) => ({ action: 'createAnnouncement', title: 'ZZ hello', body: 'ZZ line one\nZZ line two', audience: 'everyone', ...o });

// ── who can post ──
test('post: nobody but founders and team heads — a plain employee (or no employee) gets 403, nothing written', async () => {
  for (const employee of [PEOPLE[2], null]) {   // ZZ Three heads no team; no employee at all
    const s = stub({ employee });
    for (const p of [NEW(), NEW({ audience: 'teams', team_ids: [DB] })]) {
      const r = await run(s, { post: p });
      assert.equal(r.status, 403, JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_announce');
    }
    assert.equal(annWrites(s).length, 0);
  }
  // a docket_admin who heads no team is not a poster either (admin ≠ founder)
  const s = stub({ perms: ADMIN, employee: PEOPLE[2] });
  const r = await run(s, { post: NEW() });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_announce');
});
test('post: a team head posts to the team they head only — another team 403 not_your_team, everyone 403, an empty list 422', async () => {
  let s = stub();
  let r = await run(s, { post: NEW({ audience: 'teams', team_ids: [DA], pinned: true, expires_at: day(3).slice(0, 10) }) });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.audience, 'teams'); assert.deepEqual(r.j.data.team_ids, [DA]); assert.equal(r.j.data.pinned, true);
  assert.equal(r.j.data.author_user_id, ME); assert.equal(r.j.data.author_employee_id, MEE);
  assert.deepEqual(s.st.teams.filter(t => t.announcement_id === r.j.data.id), [{ announcement_id: r.j.data.id, department_id: DA }]);
  assert.ok(s.st.seen.some(x => x.announcement_id === r.j.data.id && x.user_id === ME), 'the author has seen their own post');
  for (const [p, code, status] of [
    [NEW({ audience: 'teams', team_ids: [DB] }), 'not_your_team', 403],
    [NEW({ audience: 'teams', team_ids: [DA, DB] }), 'not_your_team', 403],
    [NEW({ audience: 'teams', team_ids: [DX] }), 'not_your_team', 403],   // heads it, but the team is inactive
    [NEW({ audience: 'teams', team_ids: [DD] }), 'not_your_team', 403],   // below the inactive team: cut off
    [NEW({ audience: 'teams', team_ids: [DP] }), 'not_your_team', 403],   // the parent of the team they head
    [NEW(), 'forbidden_everyone', 403],
    [NEW({ audience: 'teams', team_ids: [] }), 'teams_required', 422],
    [NEW({ audience: 'teams' }), 'teams_required', 422],
    [NEW({ title: ' ' }), 'title_required', 422],
    [NEW({ audience: 'teams', team_ids: [DA], body: 'z'.repeat(5001) }), 'body_too_long', 422],
    [NEW({ audience: 'teams', team_ids: [DA], expires_at: day(-2).slice(0, 10) }), 'expires_in_past', 422],
    [NEW({ audience: 'nobody' }), 'bad_audience', 422],
  ]) {
    s = stub();
    r = await run(s, { post: p });
    assert.equal(r.status, status, JSON.stringify([p, r.j])); assert.equal(r.j.error, code);
    assert.equal(annWrites(s).length, 0, code);
  }
});
test('post: a founder posts to everyone, or to any active team (not an inactive / unknown one)', async () => {
  let s = stub({ perms: FOUNDER, employee: PEOPLE[2] });
  let r = await run(s, { post: NEW() });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.audience, 'everyone');
  assert.equal(s.calls.filter(c => c.path === '/rest/v1/announcement_teams').length, 0, 'an everyone-post has no team rows');
  r = await run(s, { post: NEW({ audience: 'teams', team_ids: [DA, DB] }) });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.deepEqual(r.j.data.team_ids.sort(), [DA, DB].sort());
  for (const t of [DX, U(98)]) {
    s = stub({ perms: FOUNDER });
    r = await run(s, { post: NEW({ audience: 'teams', team_ids: [t] }) });
    assert.equal(r.status, 422); assert.equal(r.j.error, 'unknown_team');
  }
});
test('post: the team rows failing takes the post back (no teams post that reaches nobody)', async () => {
  const s = stub({ teamsInsertFails: true });
  const r = await run(s, { post: NEW({ audience: 'teams', team_ids: [DA] }) });
  assert.equal(r.status, 500); assert.equal(r.j.error, 'create_failed');
  assert.equal(s.st.posts.filter(p => p.title === 'ZZ hello').length, 0);
  assert.equal(posted(s).length + s.slack.length, 0);
});

// ── who sees what ──
test('see: everyone-posts, my team, my own; live only (pinned first, then newest); include_past adds expired, never archived', async () => {
  let s = stub({ seen: [{ announcement_id: E, user_id: ME }] });
  let r = await run(s, { get: { action: 'getAnnouncements' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.map(a => a.id), [PIN, E, TA, MINE]);
  const byId = Object.fromEntries(r.j.data.map(a => [a.id, a]));
  assert.equal(byId[E].seen_by_me, true); assert.equal(byId[TA].seen_by_me, false);
  assert.equal(byId[E].author_name, 'ZZ Other');
  assert.deepEqual(byId[TA].teams, [{ id: DA, name: 'ZZ Team A' }]);
  // counts + mirror results only on what I manage (my own post)
  assert.equal(byId[E].can_manage, false); assert.equal(byId[E].seen_count, undefined); assert.equal(byId[E].slack, undefined);
  assert.equal(byId[MINE].can_manage, true); assert.ok(Array.isArray(byId[MINE].slack));
  r = await run(s, { get: { action: 'getAnnouncements', include_past: '1' } });
  assert.deepEqual(r.j.data.map(a => a.id), [PIN, E, TA, EXP, MINE]);   // EXP (11-10) is newer than MINE (11-09)
  assert.equal(r.j.data.find(a => a.id === EXP).is_live, false);
  // someone in no team: no team posts at all
  s = stub({ employee: { ...PEOPLE[0], id: U(30), department_id: null } });   // heads nothing either
  r = await run(s, { get: { action: 'getAnnouncements' } });
  assert.deepEqual(r.j.data.map(a => a.id), [PIN, E, MINE]);
});
test('see: a founder sees every live post (any team) and manages each — counts = active logins in the audience', async () => {
  const s = stub({ perms: FOUNDER, seen: [{ announcement_id: E, user_id: U(4) }, { announcement_id: E, user_id: U(13) }, { announcement_id: TB, user_id: U(6) }] });
  const r = await run(s, { get: { action: 'getAnnouncements' } });
  assert.deepEqual(r.j.data.map(a => a.id), [PIN, E, TA, TB, MINE]);
  const byId = Object.fromEntries(r.j.data.map(a => [a.id, a]));
  assert.ok(r.j.data.every(a => a.can_manage));
  assert.equal(byId[E].audience_count, 4);   // ME, Two, Three, Parent Head — not the no-login or the leaver
  assert.equal(byId[E].seen_count, 1);       // the leaver's Seen doesn't count
  assert.equal(byId[TA].audience_count, 2); assert.equal(byId[TB].audience_count, 1); assert.equal(byId[TB].seen_count, 1);
});
test('getAnnouncementSeen: the author or a founder only — seen / not seen with name + team', async () => {
  let s = stub({ seen: [{ announcement_id: MINE, user_id: U(6), seen_at: '2026-11-12T00:00:00Z' }] });
  let r = await run(s, { get: { action: 'getAnnouncementSeen', id: MINE } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.seen, [{ employee_id: U(5), name: 'ZZ Three', team: 'ZZ Team B', seen_at: '2026-11-12T00:00:00Z' }]);
  assert.deepEqual(r.j.data.not_seen, []); assert.equal(r.j.data.audience_count, 1);
  r = await run(s, { get: { action: 'getAnnouncementSeen', id: E } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden');
  r = await run(s, { get: { action: 'getAnnouncementSeen', id: TB } });
  assert.equal(r.status, 404, 'a post I cannot see is not found');
  s = stub({ perms: FOUNDER });
  r = await run(s, { get: { action: 'getAnnouncementSeen', id: TA } });
  assert.equal(r.status, 200); assert.deepEqual(r.j.data.not_seen.map(p => p.name), ['ZZ Me', 'ZZ Two']);
});

// ── update / archive ──
test('update + archive: the author or a founder; others 403 (or 404 when they cannot see it); only the four fields; never mirrors', async () => {
  let s = stub();
  let r = await run(s, { post: { action: 'updateAnnouncement', id: E, title: 'ZZ x' } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden');
  r = await run(s, { post: { action: 'archiveAnnouncement', id: E } });
  assert.equal(r.status, 403);
  r = await run(s, { post: { action: 'updateAnnouncement', id: TB, title: 'ZZ x' } });
  assert.equal(r.status, 404);
  assert.equal(annWrites(s).length, 0);
  r = await run(s, { post: { action: 'updateAnnouncement', id: MINE, title: 'ZZ new', pinned: true, audience: 'everyone', author_user_id: OTHER, slack: [1] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const patch = s.calls.find(c => c.method === 'PATCH' && c.path === '/rest/v1/announcements').body;
  assert.deepEqual(Object.keys(patch).sort(), ['pinned', 'title', 'updated_at']);
  r = await run(s, { post: { action: 'updateAnnouncement', id: MINE } });
  assert.equal(r.status, 422); assert.equal(r.j.error, 'nothing_to_update');
  assert.equal(s.slack.length, 0, 'an edit never mirrors');
  s = stub({ perms: FOUNDER, settings: { mode: 'live', org_channel: ORG, team_channels: {}, test_employee_ids: [] } });
  r = await run(s, { post: { action: 'updateAnnouncement', id: E, body: 'ZZ edited', expires_at: null } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.slack.length, 0, 'an edit never mirrors, even live');
  r = await run(s, { post: { action: 'archiveAnnouncement', id: E } });
  assert.equal(r.status, 200); assert.ok(s.st.posts.find(p => p.id === E).archived_at);
  const before = s.calls.length;
  r = await run(s, { post: { action: 'archiveAnnouncement', id: E } });
  assert.equal(r.status, 200, 'archive is idempotent');
  assert.equal(s.calls.slice(before).filter(c => c.method === 'PATCH').length, 0);
  r = await run(s, { post: { action: 'updateAnnouncement', id: E, title: 'ZZ y' } });
  assert.equal(r.status, 409); assert.equal(r.j.error, 'archived');
});

// ── Seen ──
test('markAnnouncementSeen: idempotent; only a post I can see (else 404); not an archived one', async () => {
  const s = stub();
  for (let i = 0; i < 2; i++) {
    const r = await run(s, { post: { action: 'markAnnouncementSeen', id: TA } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
  }
  assert.equal(s.st.seen.filter(x => x.announcement_id === TA && x.user_id === ME).length, 1);
  for (const id of [TB, ARCH, U(97)]) {
    const r = await run(s, { post: { action: 'markAnnouncementSeen', id } });
    assert.equal(r.status, 404, id); assert.equal(r.j.error, 'not_found');
  }
  assert.equal(s.st.seen.filter(x => x.user_id === ME).length, 1);
  const r = await run(s, { post: { action: 'markAnnouncementSeen', id: 'zz' } });
  assert.equal(r.status, 400);
});

// ── the Slack mirror ──
const LIVE = { mode: 'live', org_channel: ORG, team_channels: { [DA]: CHA, [DB]: NOTIN }, test_employee_ids: [MEE] };
test('mirror off: nothing sent; each target recorded off', async () => {
  const s = stub({ perms: FOUNDER, settings: { ...LIVE, mode: 'off' } });
  const r = await run(s, { post: NEW() });
  assert.equal(r.status, 200); assert.deepEqual(r.j.data.mirror, { mode: 'off', channels: [], skipped: [] });
  assert.equal(s.slack.length, 0);
  assert.deepEqual(s.st.posts.find(p => p.id === r.j.data.id).slack.map(x => [x.target, x.status]), [['everyone', 'off']]);
});
test('mirror test (the default): no channel post; only the test recipients are DMed, with the channel it would have gone to', async () => {
  // the seeded default — test mode, no recipients, no channels — sends nothing at all
  let s = stub({ perms: FOUNDER });
  let r = await run(s, { post: NEW() });
  assert.equal(r.status, 200); assert.equal(r.j.data.mirror.mode, 'test');
  assert.equal(s.slack.length, 0);
  // channels set but no recipients: still nothing
  s = stub({ perms: FOUNDER, settings: { ...LIVE, mode: 'test', test_employee_ids: [] } });
  r = await run(s, { post: NEW() });
  assert.equal(s.slack.length, 0);
  // one recipient: one DM to them, never to the channel
  s = stub({ perms: FOUNDER, settings: { ...LIVE, mode: 'test' } });
  r = await run(s, { post: NEW() });
  assert.equal(r.status, 200);
  const msgs = posted(s);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].body.channel, 'DUZZME', 'a DM to the test recipient');
  assert.ok(!msgs.some(m => /^C/.test(m.body.channel)), 'no channel post in test mode');
  assert.ok(msgs[0].body.text.startsWith('[Test] ZZ hello'));
  assert.match(JSON.stringify(msgs[0].body.blocks), new RegExp(`would post to <#${ORG}>`));
  const rec = s.st.posts.find(p => p.id === r.j.data.id).slack;
  assert.deepEqual(rec.map(x => [x.target, x.status]), [['everyone', 'test'], ['test_dm', 'sent']]);
});
test('mirror live: everyone → the org channel; teams → each team channel; no channel → skipped; not_in_channel recorded, never thrown', async () => {
  let s = stub({ perms: FOUNDER, settings: LIVE });
  let r = await run(s, { post: NEW() });
  assert.equal(r.status, 200);
  assert.deepEqual(posted(s).map(m => m.body.channel), [ORG]);
  const m = posted(s)[0].body;
  assert.equal(m.blocks[0].text.text, '*ZZ hello*');
  assert.match(m.blocks.at(-1).elements[0].text, /^ZZ Me · Everyone · <https:\/\/docket\.legendoftoys\.com\/announcements\?id=/);
  assert.equal(m.unfurl_links, false);
  assert.ok(!JSON.stringify(m).includes('<!channel>') && !JSON.stringify(m).includes('@channel'));
  assert.equal(s.slack.filter(x => x.m === 'conversations.open').length, 0, 'live never DMs the test recipients');
  // a team with no channel is skipped; the bot not in a channel is recorded as failed, the create still succeeds
  s = stub({ perms: FOUNDER, settings: { ...LIVE, team_channels: { [DB]: NOTIN } }, slackErr: { [NOTIN]: 'not_in_channel' } });
  r = await run(s, { post: NEW({ audience: 'teams', team_ids: [DA, DB] }) });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.mirror, { mode: 'live', channels: [{ target: DB, channel: NOTIN }], skipped: [DA] });
  assert.deepEqual(posted(s).map(x => x.body.channel), [NOTIN]);
  const rec = Object.fromEntries(s.st.posts.find(p => p.id === r.j.data.id).slack.map(x => [x.target, x]));
  assert.equal(rec[DA].status, 'skipped'); assert.equal(rec[DA].error, 'no_channel');
  assert.equal(rec[DB].status, 'failed'); assert.equal(rec[DB].error, 'not_in_channel'); assert.equal(rec[DB].channel, NOTIN);
  // a head's team post goes to their team's channel
  s = stub({ settings: LIVE });
  r = await run(s, { post: NEW({ audience: 'teams', team_ids: [DA] }) });
  assert.deepEqual(posted(s).map(x => x.body.channel), [CHA]);
  assert.match(posted(s)[0].body.blocks.at(-1).elements[0].text, / · ZZ Team A · /);
  // no org channel: an everyone-post is not mirrored
  s = stub({ perms: FOUNDER, settings: { ...LIVE, org_channel: null } });
  r = await run(s, { post: NEW() });
  assert.equal(posted(s).length, 0); assert.deepEqual(r.j.data.mirror.skipped, ['everyone']);
});
test('mirror runs in ctx.waitUntil when the platform gives one', async () => {
  const s = stub({ perms: FOUNDER, settings: LIVE });
  const waits = [];
  const r = await run(s, { post: NEW() }, { waitUntil: (p) => waits.push(p) });
  // two: handlePost's presence ping (non-blocking since 2026-11-14) and the mirror
  assert.equal(r.status, 200); assert.equal(waits.length, 2);
  await Promise.all(waits);
  assert.deepEqual(posted(s).map(m => m.body.channel), [ORG]);
});

// ── getMe ──
test('getMe: announcements_unread (live, visible, not seen) and can_announce for a head, a founder, and anyone else', async () => {
  let s = stub({ seen: [{ announcement_id: E, user_id: ME }] });
  let r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.announcements_unread, 3);   // PIN, TA, MINE (E seen; TB not mine to see; EXP, ARCH not live)
  assert.deepEqual(r.j.data.can_announce, { everyone: false, department_ids: [DA] });
  s = stub({ perms: FOUNDER, employee: PEOPLE[2] });
  r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.j.data.announcements_unread, 5);
  assert.deepEqual(r.j.data.can_announce, { everyone: true, department_ids: [DP, DQ, DA, DB, DD] });   // every active team, by name
  s = stub({ employee: PEOPLE[2] });
  r = await run(s, { get: { action: 'getMe' } });
  assert.deepEqual(r.j.data.can_announce, { everyone: false, department_ids: [] });
  assert.equal(r.j.data.announcements_unread, 4);   // PIN, E, TB, + MINE (same login ME, so still its author)
  // three extra reads for a reader with a team (departments → announcement_teams → announcements), two for a founder
  const annReads = (x) => x.calls.filter(c => /^\/rest\/v1\/(announcements|announcement_teams|announcement_seen|departments)$/.test(c.path)).length;
  assert.equal(annReads(s), 3);
  s = stub({ perms: FOUNDER });
  await run(s, { get: { action: 'getMe' } });
  assert.equal(annReads(s), 2);
});

// ── settings ──
test('settings: docket_admin only; channel ids validated; teams / recipients must be active', async () => {
  let s = stub();
  let r = await run(s, { get: { action: 'getAnnouncementSettings' } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_docket_admin');
  r = await run(s, { post: { action: 'saveAnnouncementSettings', mode: 'live' } });
  assert.equal(r.status, 403);
  assert.equal(s.calls.filter(c => c.path === '/rest/v1/settings' && c.method === 'POST').length, 0);
  s = stub({ perms: ADMIN });
  r = await run(s, { get: { action: 'getAnnouncementSettings' } });
  assert.equal(r.status, 200); assert.deepEqual(r.j.data, DEFAULT_SETTINGS);
  for (const [p, code] of [
    [{ org_channel: '#zz-general' }, 'bad_channel'], [{ org_channel: 'C12' }, 'bad_channel'],
    [{ team_channels: { [DA]: 'zz' } }, 'bad_channel'], [{ mode: 'loud' }, 'bad_mode'],
    [{ team_channels: { [DX]: 'C0ZZTEAMX' } }, 'unknown_team'], [{ test_employee_ids: [U(9)] }, 'unknown_employee'],
  ]) {
    r = await run(s, { post: { action: 'saveAnnouncementSettings', ...p } });
    assert.equal(r.status, 422, JSON.stringify([p, r.j])); assert.equal(r.j.error, code);
  }
  assert.deepEqual(s.st.settings, DEFAULT_SETTINGS);
  r = await run(s, { post: { action: 'saveAnnouncementSettings', mode: 'live', org_channel: 'c0zzorg01', team_channels: { [DA]: CHA, [DB]: '' }, test_employee_ids: [MEE] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(s.st.settings, { mode: 'live', org_channel: ORG, team_channels: { [DA]: CHA }, test_employee_ids: [MEE] });
  r = await run(s, { post: { action: 'saveAnnouncementSettings', mode: 'off' } });   // omitted fields kept
  assert.deepEqual(s.st.settings, { mode: 'off', org_channel: ORG, team_channels: { [DA]: CHA }, test_employee_ids: [MEE] });
});

// ── hostile review P4 fixes ──
const TP = U(47), TD = U(48);
const TREE_POSTS = () => [...BASE_POSTS(), POST(TP, { audience: 'teams', team_ids: [DP], created_at: '2026-11-13T00:00:00Z' }),
  POST(TD, { audience: 'teams', team_ids: [DA], author_user_id: OTHER, created_at: '2026-11-13T01:00:00Z' })];
test('#2 subtree: a parent-team post reaches its sub-teams (list, badge, Seen); audience = logins anywhere below', async () => {
  let s = stub({ posts: TREE_POSTS() });
  let r = await run(s, { get: { action: 'getAnnouncements' } });
  assert.ok(r.j.data.some(a => a.id === TP), 'ME (in DA, under DP) sees the DP post');
  r = await run(s, { post: { action: 'markAnnouncementSeen', id: TP } });
  assert.equal(r.status, 200);
  s = stub({ perms: FOUNDER, posts: TREE_POSTS() });
  r = await run(s, { get: { action: 'getAnnouncements' } });
  assert.equal(r.j.data.find(a => a.id === TP).audience_count, 3, 'ME + Two (DA) + Three (DB); the DQ head is not in DP');
  r = await run(s, { get: { action: 'getAnnouncementSeen', id: TP } });
  assert.deepEqual([...r.j.data.not_seen.map(p => p.name)].sort(), ['ZZ Me', 'ZZ Three', 'ZZ Two']);
});
test('#2 heads: a head who is not a member posts to their team and everything below, and sees posts to it', async () => {
  const PH = PEOPLE.find(p => p.id === PHE);
  let s = stub({ employee: PH, posts: TREE_POSTS() });
  let r = await run(s, { get: { action: 'getMe' } });
  assert.deepEqual([...r.j.data.can_announce.department_ids].sort(), [DP, DA, DB].sort());
  assert.equal(r.j.data.can_announce.everyone, false);
  r = await run(s, { get: { action: 'getAnnouncements' } });
  const ids = r.j.data.map(a => a.id);
  for (const id of [TP, TD, TA, TB]) assert.ok(ids.includes(id), id);
  for (const t of [[DB], [DA, DP]]) {
    s = stub({ employee: PH });
    r = await run(s, { post: NEW({ audience: 'teams', team_ids: t }) });
    assert.equal(r.status, 200, JSON.stringify([t, r.j]));
  }
  s = stub({ employee: PH });
  r = await run(s, { post: NEW({ audience: 'teams', team_ids: [DQ] }) });   // their own team, which they don't head
  assert.equal(r.status, 403); assert.equal(r.j.error, 'not_your_team');
});
test('#3 exited: no posting (even a founder), no team visibility — everyone-posts (and their own) only', async () => {
  for (const perms of [{}, FOUNDER]) {
    const s = stub({ perms, employee: { ...PEOPLE[0], status: 'exited' }, posts: TREE_POSTS() });
    let r = await run(s, { get: { action: 'getMe' } });
    assert.deepEqual(r.j.data.can_announce, { everyone: false, department_ids: [] }, JSON.stringify(perms));
    r = await run(s, { get: { action: 'getAnnouncements' } });
    assert.deepEqual(r.j.data.map(a => a.id), [PIN, E, MINE], JSON.stringify(perms));
    r = await run(s, { post: NEW() });
    assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_announce');
    r = await run(s, { post: { action: 'markAnnouncementSeen', id: TA } });
    assert.equal(r.status, 404);
  }
});
test('#4 one query: badge and list read the same SQL-filtered set, same order and limit; founders unfiltered', async () => {
  const s = stub({ posts: TREE_POSTS(), seen: [{ announcement_id: E, user_id: ME }] });
  const me = await run(s, { get: { action: 'getMe' } });
  const list = await run(s, { get: { action: 'getAnnouncements' } });
  assert.equal(me.j.data.announcements_unread, list.j.data.filter(a => !a.seen_by_me).length);
  const reads = s.calls.filter(c => c.path === '/rest/v1/announcements' && c.method === 'GET');
  assert.equal(reads.length, 2);
  for (const c of reads) {
    assert.match(c.p, /&order=pinned\.desc,created_at\.desc&limit=200$/);
    assert.match(c.p, new RegExp(`or\\(audience\\.eq\\.everyone,author_user_id\\.eq\\.${ME},id\\.in\\.\\(`));
    assert.ok(!c.p.includes(TB), 'a team outside my set never enters the filter');
  }
  const f = stub({ perms: FOUNDER });
  await run(f, { get: { action: 'getAnnouncements' } });
  const fr = f.calls.find(c => c.path === '/rest/v1/announcements');
  assert.ok(!fr.p.includes('audience.eq.everyone'), 'a founder has no audience filter');
  assert.equal(f.calls.filter(c => c.path === '/rest/v1/announcement_teams').length, 0);
});
test('#5 test mode, recipients set but no channel anywhere: they still get the DM, each target saying live would skip it', async () => {
  const s = stub({ perms: FOUNDER, settings: { mode: 'test', org_channel: null, team_channels: {}, test_employee_ids: [MEE] } });
  let r = await run(s, { post: NEW() });
  assert.equal(r.status, 200);
  assert.equal(posted(s).length, 1); assert.equal(posted(s)[0].body.channel, 'DUZZME');
  assert.match(JSON.stringify(posted(s)[0].body.blocks), /Everyone: no org channel set, live would skip this/);
  r = await run(s, { post: NEW({ audience: 'teams', team_ids: [DA] }) });
  assert.match(JSON.stringify(posted(s)[1].body.blocks), /ZZ Team A: no channel set, live would skip this/);
});
