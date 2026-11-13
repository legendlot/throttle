// Run: node --test docketops-worker/test/*.test.mjs
// P4 announcements (migration 0040) — the pure rules: settings parse / validate, create / update validation,
// visibility, ordering, audience, unread, the Slack mirror's targets and messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnouncementSettings, validateAnnouncementSettings, validateCreate, validateUpdate, parseExpiry, isLive,
  canSeeAnnouncement, canManageAnnouncement, sortAnnouncements, audienceOf, unreadCount, mirrorTargets, announcementMessage,
  testDmMessage, mirrorSummary, cleanBody, CHANNEL_RE, deptTree, ancestors, descendants, headedTeams, readerTeams, postableTeams,
  bodySections } from '../src/announcements-core.mjs';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DA = U(10), DB = U(11), NOW = Date.parse('2026-11-14T06:00:00Z');

test('settings: parsed leniently — unknown mode is off, bad channels / ids dropped', () => {
  assert.deepEqual(parseAnnouncementSettings(null), { mode: 'off', org_channel: null, team_channels: {}, test_employee_ids: [] });
  const s = parseAnnouncementSettings({ mode: 'LIVE', org_channel: 'c123', team_channels: { [DA]: 'C0ZZTEAMA', zz: 'C0ZZTEAMB', [DB]: '#zz' }, test_employee_ids: [U(2), 'zz', U(2)] });
  assert.equal(s.mode, 'off'); assert.equal(s.org_channel, null);
  assert.deepEqual(s.team_channels, { [DA]: 'C0ZZTEAMA' }); assert.deepEqual(s.test_employee_ids, [U(2)]);
  assert.equal(parseAnnouncementSettings({ mode: 'test' }).mode, 'test');
});
test('settings save: strict channel ids (^[CG][A-Z0-9]{6,}$), trimmed + upper-cased; omitted fields kept; blank clears', () => {
  for (const bad of ['C12345', 'D0ZZZZZZ', 'C0ZZ-ZZZ', '#general', 'U0ZZZZZZZ']) {
    assert.equal(validateAnnouncementSettings({ org_channel: bad }, null).error, 'bad_channel', bad);
  }
  assert.ok(CHANNEL_RE.test('G0ZZZZZZ'));
  const cur = { mode: 'test', org_channel: 'C0ZZORG01', team_channels: { [DA]: 'C0ZZTEAMA' }, test_employee_ids: [U(2)] };
  let v = validateAnnouncementSettings({ org_channel: ' c0zzorg02 ' }, cur);
  assert.deepEqual(v.value, { ...cur, org_channel: 'C0ZZORG02' });
  v = validateAnnouncementSettings({ team_channels: { [DA]: '', [DB]: 'C0ZZTEAMB' }, org_channel: null }, cur);
  assert.deepEqual(v.value.team_channels, { [DB]: 'C0ZZTEAMB' }); assert.equal(v.value.org_channel, null);
  assert.equal(validateAnnouncementSettings({ team_channels: { [DA]: 'zz' } }, cur).field, 'team_channels.' + DA);
  assert.equal(validateAnnouncementSettings({ team_channels: { zz: 'C0ZZTEAMB' } }, cur).error, 'bad_team');
  assert.equal(validateAnnouncementSettings({ mode: 'loud' }, cur).error, 'bad_mode');
  assert.equal(validateAnnouncementSettings({ test_employee_ids: ['zz'] }, cur).error, 'bad_test_employee_ids');
  assert.equal(validateAnnouncementSettings({ test_employee_ids: U(2) }, cur).error, 'bad_test_employee_ids');
});

const FOUNDER = { everyone: true, department_ids: [DA, DB] }, HEAD = { everyone: false, department_ids: [DA] };
test('create: posting rules — head to own team only (403 not_your_team), founder everyone / any active team', () => {
  const base = { title: 'ZZ t', body: 'ZZ b' };
  assert.equal(validateCreate({ ...base, audience: 'everyone' }, HEAD).error, 'forbidden_everyone');
  assert.equal(validateCreate({ ...base, audience: 'everyone' }, HEAD).status, 403);
  assert.deepEqual(validateCreate({ ...base, audience: 'teams', team_ids: [DB] }, HEAD), { error: 'not_your_team', status: 403 });
  assert.deepEqual(validateCreate({ ...base, audience: 'teams', team_ids: [DA, DB] }, HEAD), { error: 'not_your_team', status: 403 });
  assert.deepEqual(validateCreate({ ...base, audience: 'teams', team_ids: [] }, HEAD), { error: 'teams_required', status: 422 });
  assert.deepEqual(validateCreate({ ...base, audience: 'teams' }, FOUNDER), { error: 'teams_required', status: 422 });
  assert.deepEqual(validateCreate({ ...base, audience: 'teams', team_ids: [U(99)] }, FOUNDER), { error: 'unknown_team', status: 422 });
  assert.equal(validateCreate({ ...base, audience: 'teams', team_ids: ['zz'] }, FOUNDER).error, 'bad_team');
  assert.deepEqual(validateCreate({ ...base, audience: 'teams', team_ids: [DA.toUpperCase(), DA] }, HEAD).value.team_ids, [DA]);
  const v = validateCreate({ ...base, audience: 'everyone', pinned: 'true' }, FOUNDER).value;
  assert.deepEqual(v, { title: 'ZZ t', body: 'ZZ b', audience: 'everyone', team_ids: [], pinned: true, expires_at: null });
});
test('create: input validation — title 1–200, body 1–5000 (line breaks kept), audience, expiry', () => {
  const r = (o) => validateCreate({ title: 'ZZ t', body: 'ZZ b', audience: 'everyone', ...o }, FOUNDER, NOW);
  assert.equal(r({ title: '   ' }).error, 'title_required');
  assert.equal(r({ title: 'z'.repeat(201) }).error, 'title_too_long');
  assert.equal(r({ title: 'z'.repeat(200) }).error, undefined);
  assert.equal(r({ body: '\n \n' }).error, 'body_required');
  assert.equal(r({ body: 'z'.repeat(5001) }).error, 'body_too_long');
  assert.equal(r({ audience: 'all' }).error, 'bad_audience');
  assert.equal(r({ body: '\r\nZZ one\r\n\r\nZZ two  \n' }).value.body, 'ZZ one\n\nZZ two');
  assert.equal(r({ expires_at: '2026-11-13' }).error, 'expires_in_past');
  assert.equal(r({ expires_at: 'zz' }).error, 'bad_expires_at');
  assert.equal(r({ expires_at: '2026-11-20' }).value.expires_at, '2026-11-20T18:29:59.000Z');   // end of that IST day
  assert.equal(r({ expires_at: '' }).value.expires_at, null);
  assert.equal(parseExpiry('2026-11-14', NOW).value, '2026-11-14T18:29:59.000Z');   // today still counts
});
test('update: only title / body / pinned / expires_at; nothing → 422; expiry can be cleared', () => {
  assert.deepEqual(validateUpdate({ id: U(1), audience: 'everyone' }), { error: 'nothing_to_update', status: 422 });
  assert.deepEqual(validateUpdate({ pinned: false, expires_at: null }, NOW), { patch: { pinned: false, expires_at: null } });
  assert.equal(validateUpdate({ title: '' }).error, 'title_required');
  assert.equal(validateUpdate({ body: 'z'.repeat(5001) }).error, 'body_too_long');
  assert.deepEqual(validateUpdate({ title: ' ZZ  new ', body: 'ZZ a\nZZ b' }).patch, { title: 'ZZ new', body: 'ZZ a\nZZ b' });
});

const A = (o) => ({ id: U(50), title: 'ZZ', body: 'ZZ', audience: 'everyone', author_user_id: U(7), pinned: false,
  expires_at: null, archived_at: null, created_at: '2026-11-10T00:00:00Z', announcement_teams: [], ...o });
test('visibility: everyone-posts, a team in my reader set, my own; founders all. Manage = author or founder', () => {
  const me = { userId: U(1), teams: new Set([DA]), founder: false };
  assert.ok(canSeeAnnouncement(A(), me));
  assert.ok(canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: DA }] }), me));
  assert.ok(!canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: DB }] }), me));
  assert.ok(canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: DB }], author_user_id: U(1) }), me));
  assert.ok(!canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: DA }] }), { ...me, teams: new Set() }));
  assert.ok(canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: DA.toUpperCase() }] }), me));
  assert.ok(canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: DB }] }), { ...me, founder: true }));
  assert.ok(!canManageAnnouncement(A(), me));
  assert.ok(canManageAnnouncement(A({ author_user_id: U(1) }), me));
  assert.ok(canManageAnnouncement(A(), { ...me, founder: true }));
});
test('live, ordering, audience, unread', () => {
  assert.ok(isLive(A(), NOW));
  assert.ok(!isLive(A({ archived_at: '2026-11-12T00:00:00Z' }), NOW));
  assert.ok(!isLive(A({ expires_at: '2026-11-14T05:00:00Z' }), NOW));
  assert.ok(isLive(A({ expires_at: '2026-11-14T07:00:00Z' }), NOW));
  const rows = [A({ id: 'a', created_at: '2026-11-01' }), A({ id: 'b', created_at: '2026-11-03' }), A({ id: 'c', pinned: true, created_at: '2026-10-01' })];
  assert.deepEqual(sortAnnouncements(rows).map(r => r.id), ['c', 'b', 'a']);
  const people = [{ auth_user_id: 'p1', department_id: DA }, { auth_user_id: 'p2', department_id: DB }, { auth_user_id: 'p3', department_id: null }];
  assert.equal(audienceOf(A(), people).length, 3);
  assert.deepEqual(audienceOf(A({ audience: 'teams', announcement_teams: [{ department_id: DB }] }), people).map(p => p.auth_user_id), ['p2']);
  const me = { userId: U(1), teams: new Set([DA]), founder: false };
  const live = [A({ id: 'x' }), A({ id: 'y', announcement_seen: [{ user_id: U(1) }] }), A({ id: 'z', audience: 'teams', announcement_teams: [{ department_id: DB }] }),
    A({ id: 'w', expires_at: '2026-11-01T00:00:00Z' })];
  assert.equal(unreadCount(live, me, NOW), 1);
  assert.equal(unreadCount(live, { ...me, founder: true }, NOW), 2);
});
test('mirror: targets by audience; a team with no channel stays, channel null', () => {
  const s = parseAnnouncementSettings({ mode: 'live', org_channel: 'C0ZZORG01', team_channels: { [DA]: 'C0ZZTEAMA' } });
  assert.deepEqual(mirrorTargets(A(), [], s), [{ target: 'everyone', channel: 'C0ZZORG01' }]);
  assert.deepEqual(mirrorTargets(A({ audience: 'teams' }), [DA, DB], s), [{ target: DA, channel: 'C0ZZTEAMA' }, { target: DB, channel: null }]);
  assert.deepEqual(mirrorTargets(A(), [], parseAnnouncementSettings({ mode: 'live' })), [{ target: 'everyone', channel: null }]);
  assert.deepEqual(mirrorSummary(s, mirrorTargets(A({ audience: 'teams' }), [DA, DB], s)), { mode: 'live', channels: [{ target: DA, channel: 'C0ZZTEAMA' }], skipped: [DB] });
  assert.deepEqual(mirrorSummary({ ...s, mode: 'off' }, []), { mode: 'off', channels: [], skipped: [] });
});
test('message: bold title, body, context line with author · audience · Open in Docket; text escaped, no @channel', () => {
  const a = A({ id: U(50), title: 'ZZ <b> & co', body: 'ZZ hi <!channel>\nZZ line two' });
  const m = announcementMessage(a, { authorName: 'ZZ Author' });
  assert.equal(m.blocks[0].text.text, '*ZZ &lt;b&gt; &amp; co*');
  assert.equal(m.blocks[1].text.text, 'ZZ hi &lt;!channel&gt;\nZZ line two');
  assert.equal(m.blocks[2].type, 'context');
  assert.equal(m.blocks[2].elements[0].text, `ZZ Author · Everyone · <https://docket.legendoftoys.com/announcements?id=${U(50)}|Open in Docket>`);
  // the text fallback is escaped too (hostile review P4 #1): no raw <!channel> / <!here> / <@U…> anywhere
  assert.equal(m.text, 'ZZ &lt;b&gt; &amp; co\nZZ hi &lt;!channel&gt;\nZZ line two');
  const pings = announcementMessage(A({ title: 'ZZ <!here>', body: 'ZZ <@U0ZZZZZZ> <!channel>' }), {});
  for (const raw of ['<!here>', '<@U0ZZZZZZ>', '<!channel>']) assert.ok(!JSON.stringify(pings).includes(raw), raw);
  assert.ok(!testDmMessage(pings, [{ target: 'everyone', channel: null }]).text.includes('<!'));
  assert.ok(!JSON.stringify(m.blocks).includes('<!channel>'));
  const t = announcementMessage(A({ audience: 'teams' }), { authorName: 'ZZ Author', teamNames: ['ZZ Ops', 'ZZ Design'] });
  assert.match(t.blocks.at(-1).elements[0].text, /^ZZ Author · ZZ Ops, ZZ Design · </);
  // a 5,000-char body splits into ≤ 2,900-char sections
  const long = announcementMessage(A({ body: ('z'.repeat(99) + '\n').repeat(50) }), {});
  assert.ok(long.blocks.length >= 4 && long.blocks.every(b => b.type !== 'section' || b.text.text.length <= 2900));
  assert.equal(cleanBody('  a\r\nb  '), 'a\nb');
});
test('test DM: the message plus one line per target — the channel it would post to, or that live would skip it', () => {
  const m = announcementMessage(A(), { authorName: 'ZZ' });
  const d = testDmMessage(m, [{ target: DA, channel: 'C0ZZTEAMA' }, { target: DB, channel: null }], { [DA]: 'ZZ Team A', [DB]: 'ZZ <Team> B' });
  assert.ok(d.text.startsWith('[Test] '));
  assert.equal(d.blocks.length, m.blocks.length + 1);
  const line = d.blocks.at(-1).elements[0].text;
  assert.match(line, /• ZZ Team A: would post to <#C0ZZTEAMA>/);
  assert.match(line, /• ZZ &lt;Team&gt; B: no channel set, live would skip this/);
  const none = testDmMessage(m, [{ target: 'everyone', channel: null }]).blocks.at(-1).elements[0].text;
  assert.match(none, /• Everyone: no org channel set, live would skip this/);
});

// ── hostile review P4 fixes ──
const P = U(20), C1 = U(21), C2 = U(22), GC = U(23), OFF = U(24), UNDER = U(25), CYA = U(26), CYB = U(27);
const ROWS = [
  { id: P, parent_department_id: null, head_employee_id: 'h-p' },
  { id: C1, parent_department_id: P, head_employee_id: 'h-c1' },
  { id: C2, parent_department_id: P, head_employee_id: null },
  { id: GC, parent_department_id: C1, head_employee_id: null },
  { id: OFF, parent_department_id: P, head_employee_id: 'h-p', active: false },   // inactive: out of the tree
  { id: UNDER, parent_department_id: OFF, head_employee_id: null },               // active, but under an inactive team
  { id: CYA, parent_department_id: CYB, head_employee_id: null },                  // a two-team cycle
  { id: CYB, parent_department_id: CYA, head_employee_id: 'h-cy' },
];
test('tree (#2): ancestors / descendants over active teams only, cycle-guarded', () => {
  const t = deptTree(ROWS);
  assert.ok(!t.ids.has(OFF) && t.ids.has(UNDER));
  assert.deepEqual(ancestors(t, GC), [C1, P]);
  assert.deepEqual(ancestors(t, UNDER), [], 'an inactive parent cuts the chain');
  assert.deepEqual([...descendants(t, [P])].sort(), [P, C1, C2, GC].sort(), 'not the inactive team or what hangs under it');
  assert.deepEqual(ancestors(t, CYA), [CYB]);
  assert.deepEqual([...descendants(t, [CYA])].sort(), [CYA, CYB].sort());
  assert.deepEqual(headedTeams(t, ROWS, 'h-p'), [P], 'the inactive team it also heads is dropped');
});
test('tree (#2): reader set = own team + ancestors + headed + their subtree; a head posts to their subtree', () => {
  const t = deptTree(ROWS);
  assert.deepEqual([...readerTeams(t, { departmentId: GC })].sort(), [GC, C1, P].sort());
  assert.deepEqual([...readerTeams(t, { departmentId: C2, headOf: ['h-c1'].flatMap(h => headedTeams(t, ROWS, h)) })].sort(), [C2, P, C1, GC].sort());
  assert.deepEqual([...readerTeams(t, {})], []);
  assert.deepEqual(postableTeams(t, [C1]).sort(), [C1, GC].sort());
  assert.deepEqual(postableTeams(t, [P]).sort(), [P, C1, C2, GC].sort());
  // a post to the parent reaches someone in a grandchild team; a post to a child does not reach the parent
  const reader = { userId: 'zz', founder: false, teams: readerTeams(t, { departmentId: GC }) };
  assert.ok(canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: P }] }), reader));
  assert.ok(!canSeeAnnouncement(A({ audience: 'teams', announcement_teams: [{ department_id: C2 }] }), reader));
  const people = [{ auth_user_id: 'a', department_id: GC }, { auth_user_id: 'b', department_id: C2 }, { auth_user_id: 'c', department_id: UNDER }];
  assert.deepEqual(audienceOf(A({ audience: 'teams', announcement_teams: [{ department_id: P }] }), people, t).map(p => p.auth_user_id), ['a', 'b']);
  assert.deepEqual(audienceOf(A({ audience: 'teams', announcement_teams: [{ department_id: C1 }] }), people, t).map(p => p.auth_user_id), ['a']);
});
test('expiry (#7): impossible dates refused; a timestamp needs an explicit offset; a bare date = 23:59:59 IST', () => {
  for (const bad of ['2027-02-30', '2027-13-01', '2027-02-30T10:00:00Z', '2027-03-01T10:00:00', '2027-03-01 10:00:00Z', '2027-03-01T10:00Z+']) {
    assert.equal(parseExpiry(bad, NOW).error, 'bad_expires_at', bad);
  }
  assert.equal(parseExpiry('2028-02-29', NOW).value, '2028-02-29T18:29:59.000Z');
  assert.equal(parseExpiry('2027-03-01T10:00:00+05:30', NOW).value, '2027-03-01T04:30:00.000Z');
  assert.equal(parseExpiry('2027-03-01T10:00:00.123Z', NOW).value, '2027-03-01T10:00:00.123Z');
  assert.equal(validateCreate({ title: 'ZZ', body: 'ZZ', audience: 'everyone', expires_at: '2027-02-30' }, FOUNDER, NOW).status, 422);
});
test('body sections (#8): the raw text is cut, then escaped — no section splits an entity or runs over the cap', () => {
  const body = '&'.repeat(700) + '<'.repeat(700);   // escapes to 7,000 chars
  const parts = bodySections(body);
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(p.length <= 2900, p.length);
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(p), 'a bare & = a split entity');
    assert.ok(!/&(amp|lt|gt)?$/.test(p.slice(-4)) || /&(amp|lt|gt);$/.test(p.slice(-5)), 'no entity cut at the end');
  }
  assert.equal(parts.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<'), body);
  assert.deepEqual(bodySections('ZZ a\nZZ b'), ['ZZ a\nZZ b']);
});
