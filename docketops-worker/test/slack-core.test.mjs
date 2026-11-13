// Run: node --test docketops-worker/test/*.test.mjs
// F9 R7a — the pure Slack cores (src/slack-core.mjs): form bodies, /docket parsing, proposals, message titles,
// payload routing, modals, submission validation, /docket mine, plain-words errors, the Web API helper and the
// Slack user → Docket person mapping (fetch / deps stubbed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseForm, parseCommand, proposalFrom, titleFromMessage, routeInteraction, taskModal, moveModal, commentModal,
  validateTaskSubmission, validateMoveSubmission, validateCommentSubmission, deadlineIso, istToday, mineSections, mineMessage,
  friendlyError, slackApi, slackRespond, resolveSlackPerson, slackEmployee, slackUserEmail, addReply, planOptions, lookupEmail, parseQuickAdd, UNLINKED, USAGE } from '../src/slack-core.mjs';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A fixed clock: Thu 12 Nov 2026, 11:30 IST (LATE = 18:30 IST, past the 18:00 date-only deadline).
const NOW = Date.parse('2026-11-12T06:00:00Z'), LATE = Date.parse('2026-11-12T13:00:00Z');
const TODAY = istToday(NOW);
const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test('parseForm decodes a slash-command body (+ and %XX)', () => {
  const f = parseForm('command=%2Fdocket&text=add+call+Riya+%40riya+fri&user_id=U0ABC&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2Fx');
  assert.deepEqual([f.command, f.text, f.user_id, f.response_url], ['/docket', 'add call Riya @riya fri', 'U0ABC', 'https://hooks.slack.com/commands/x']);
  assert.deepEqual(parseForm(''), {});
});

test('parseCommand: add / mine / propose / help / unknown', () => {
  assert.deepEqual(parseCommand('add  ship the cards  '), { sub: 'add', text: 'ship the cards' });
  assert.deepEqual(parseCommand('ADD x'), { sub: 'add', text: 'x' });
  assert.deepEqual(parseCommand('mine'), { sub: 'mine', text: '' });
  assert.deepEqual(parseCommand('propose a | b'), { sub: 'propose', text: 'a | b' });
  assert.equal(parseCommand('').sub, 'help');
  assert.equal(parseCommand('help').sub, 'help');
  assert.equal(parseCommand('add').sub, 'help');
  assert.equal(parseCommand('add   ').sub, 'help');
  assert.deepEqual(parseCommand('frobnicate it'), { sub: 'unknown', text: 'frobnicate it' });
  assert.match(USAGE, /\/docket add/);
});

test('proposalFrom: title | why; no bar → both; limits', () => {
  assert.deepEqual(proposalFrom('New SKU line | Q1 gap'), { title: 'New SKU line', why: 'Q1 gap' });
  assert.deepEqual(proposalFrom('Just a line'), { title: 'Just a line', why: 'Just a line' });
  assert.equal(proposalFrom(' | why').error, 'title_required');
  assert.equal(proposalFrom('t | ').error, 'why_required');
  assert.equal(proposalFrom('x'.repeat(201) + ' | y').error, 'text_too_long');
});

test('the quick-add parser is the app\'s own (shared, not forked)', () => {
  const now = new Date('2026-11-12T06:00:00Z');   // Thu 11:30 IST
  const q = parseQuickAdd('call vendor @zz !p1 tomorrow', { people: [{ id: U(1), full_name: 'ZZ Person' }], now });
  assert.equal(q.title, 'call vendor');
  assert.equal(q.owner_employee_id, U(1));
  assert.equal(q.priority, 'P1');
  assert.equal(q.deadline, '2026-11-13T12:30:00.000Z');   // tomorrow 18:00 IST
});

test('titleFromMessage unwraps Slack markup and truncates at a word', () => {
  assert.equal(titleFromMessage('<@U123|riya> pls send <https://x.io/a|the deck> to <#C1|ops>  &amp; <!here>'), '@riya pls send the deck to #ops &');
  assert.equal(titleFromMessage('see <https://x.io>'), 'see https://x.io');
  const t = titleFromMessage(('word ').repeat(100), 200);
  assert.ok(t.length <= 200 && t.endsWith('…') && !t.includes('  '));
  assert.equal(titleFromMessage(''), '');
});

test('routeInteraction: shortcuts, submissions, buttons; junk ignored', () => {
  const m = routeInteraction({ type: 'message_action', callback_id: 'docket_add_from_message', trigger_id: 'tr', user: { id: 'U1AA' },
    channel: { id: 'C1' }, message: { ts: '1.2', text: 'hello <@U9|zz>' }, response_url: 'https://hooks.slack.com/x' });
  assert.deepEqual([m.kind, m.title, m.channel, m.ts, m.user], ['open_task', 'hello @zz', 'C1', '1.2', 'U1AA']);
  assert.deepEqual(routeInteraction({ type: 'shortcut', callback_id: 'docket_new_task', trigger_id: 't', user: { id: 'U1AA' } }).title, '');
  const s = routeInteraction({ type: 'view_submission', user: { id: 'U1AA' }, view: { callback_id: 'docket_move', private_metadata: JSON.stringify({ task_id: U(5) }), state: { values: { a: 1 } } } });
  assert.deepEqual([s.kind, s.meta.task_id, s.values.a], ['submit_move', U(5), 1]);
  assert.equal(routeInteraction({ type: 'view_submission', view: { callback_id: 'docket_task', private_metadata: '{bad' } }).meta.constructor, Object);
  for (const [id, kind] of [['docket_done', 'done'], ['docket_move', 'open_move'], ['docket_comment', 'open_comment'], ['docket_accept', 'accept']]) {
    const b = routeInteraction({ type: 'block_actions', user: { id: 'U1AA' }, trigger_id: 't', response_url: 'r', actions: [{ action_id: id, value: U(7).toUpperCase() }] });
    assert.deepEqual([b.kind, b.task_id], [kind, U(7)]);
  }
  assert.equal(routeInteraction({ type: 'block_actions', actions: [{ action_id: 'docket_done', value: 'not-a-uuid' }] }).kind, 'ignore');
  assert.equal(routeInteraction({ type: 'block_actions', actions: [{ action_id: 'other', value: U(1) }] }).kind, 'ignore');
  assert.equal(routeInteraction({ type: 'shortcut', callback_id: 'nope' }).kind, 'ignore');
  assert.equal(routeInteraction(null).kind, 'ignore');
});

test('modals: the task modal (owner defaults to the invoker; plan field only with options); move / comment carry the task', () => {
  const v = taskModal({ title: 'x'.repeat(300), ownerSlackId: 'U1AA', meta: { channel: 'C1', ts: '1.2' } });
  assert.equal(v.callback_id, 'docket_task');
  const ids = v.blocks.map(b => b.block_id).filter(Boolean);
  assert.deepEqual(ids, ['title', 'owner', 'deadline', 'handoff']);
  assert.equal(v.blocks[0].element.initial_value.length, 200);
  assert.equal(v.blocks[1].element.initial_user, 'U1AA');
  assert.equal(v.blocks[2].element.type, 'datepicker');
  assert.deepEqual(JSON.parse(v.private_metadata), { channel: 'C1', ts: '1.2' });
  const withPlan = taskModal({ planOptions: [{ id: U(3), label: 'T1 Thing' }] });
  const plan = withPlan.blocks.find(b => b.block_id === 'plan');
  assert.deepEqual([plan.optional, plan.element.options[0].value], [true, U(3)]);
  assert.equal(JSON.parse(moveModal(U(4), { response_url: 'r' }).private_metadata).task_id, U(4));
  assert.equal(JSON.parse(commentModal(U(4)).private_metadata).task_id, U(4));
  assert.ok(moveModal(U(4)).blocks.every(b => !b.optional), 'date + reason are both required');
});

const vals = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { v }]));
test('validateTaskSubmission: title, owner, date not past, plan uuid, hand-off ≠ owner', () => {
  const good = validateTaskSubmission(vals({ title: { value: '  ship  it ' }, owner: { selected_user: 'U1AA' }, deadline: { selected_date: TODAY },
    plan: { selected_option: { value: U(3) } }, handoff: { selected_user: 'U2BB' } }), NOW);
  assert.deepEqual(good.value, { title: 'ship it', owner: 'U1AA', date: TODAY, plan: U(3), handoff: 'U2BB' });
  assert.deepEqual(validateTaskSubmission(vals({ title: { value: 'a' }, owner: { selected_user: 'U1AA' } }), NOW).value,
    { title: 'a', owner: 'U1AA', date: null, plan: null, handoff: null });
  const bad = validateTaskSubmission(vals({ title: { value: ' ' }, deadline: { selected_date: addD(TODAY, -1) }, plan: { selected_option: { value: 'x' } } }), NOW);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['deadline', 'owner', 'plan', 'title']);
  assert.ok(validateTaskSubmission(vals({ title: { value: 'a' }, owner: { selected_user: 'U1AA' }, handoff: { selected_user: 'U1AA' } }), NOW).errors.handoff);
  assert.ok(validateTaskSubmission(vals({ title: { value: 'a' }, owner: { selected_user: 'U1AA' }, deadline: { selected_date: '2026-02-30' } }), NOW).errors.deadline);
});

test('move needs a date (not past) and a reason; comment needs a body', () => {
  assert.deepEqual(validateMoveSubmission(vals({ date: { selected_date: TODAY }, reason: { value: ' vendor late ' } }), NOW).value, { date: TODAY, reason: 'vendor late' });
  assert.deepEqual(Object.keys(validateMoveSubmission(vals({ date: { selected_date: addD(TODAY, -1) }, reason: { value: '' } }), NOW).errors).sort(), ['date', 'reason']);
  assert.deepEqual(validateCommentSubmission(vals({ body: { value: ' hi ' } })).value, { body: 'hi' });
  assert.ok(validateCommentSubmission(vals({ body: { value: '  ' } })).errors.body);
});

test('deadlineIso = 18:00 IST (DatePicker\'s default)', () => {
  assert.equal(deadlineIso('2026-11-20'), '2026-11-20T12:30:00.000Z');
});

test('mine: overdue · due today · next 7 days; done/abandoned/undated out; buttons carry the task id', () => {
  const now = Date.parse('2026-11-12T06:00:00Z');   // 11:30 IST
  const at = (iso) => new Date(Date.parse(iso)).toISOString();
  const T = (n, o) => ({ id: U(n), task_no: `DKT-${n}`, title: `ZZ <t${n}>`, status: 'in_progress', deadline: null, revised_deadline: null, ...o });
  const tasks = [T(1, { deadline: at('2026-11-10T12:30:00Z') }), T(2, { deadline: at('2026-11-12T12:30:00Z') }),
    T(3, { deadline: at('2026-11-14T12:30:00Z') }), T(4, { deadline: at('2026-11-30T12:30:00Z') }),
    T(5, { deadline: at('2026-11-01T12:30:00Z'), status: 'done' }), T(6, {}), T(7, { deadline: at('2026-11-01T12:30:00Z'), revised_deadline: at('2026-11-13T12:30:00Z') }),
    T(8, { deadline: at('2026-11-12T05:00:00Z') })];
  const s = mineSections(tasks, now);
  assert.deepEqual([s.overdue.map(t => t.task_no), s.today.map(t => t.task_no), s.next.map(t => t.task_no), s.undated], [['DKT-1', 'DKT-8'], ['DKT-2'], ['DKT-7', 'DKT-3'], 1]);
  const m = mineMessage(tasks, now);
  assert.match(m.text, /2 overdue, 1 due today, 2 in the next 7 days/);
  const btns = m.blocks.filter(b => b.type === 'actions');
  assert.equal(btns.length, 5);
  assert.deepEqual(btns[0].elements.map(e => [e.action_id, e.value]), [['docket_done', U(1)], ['docket_move', U(1)], ['docket_comment', U(1)]]);
  assert.ok(m.blocks.some(b => b.text && b.text.text.includes('ZZ &lt;t1&gt;')), 'titles are escaped');
  assert.match(mineMessage([], now).text, /^Nothing overdue/);
});

test('friendlyError never echoes raw text', () => {
  assert.equal(friendlyError('unauthorized'), UNLINKED);
  assert.match(friendlyError('forbidden'), /permission/);
  assert.match(friendlyError('waiting_on', { blockers: [{}, {}], hidden_open: 1 }), /3 open tasks/);
  assert.match(friendlyError('abandoned_read_only: reactivate the task first'), /read-only/);
  const raw = friendlyError('server_error: relation "docket.zz" does not exist');
  assert.ok(!raw.includes('relation') && !raw.includes('docket.zz'));
  assert.ok(!friendlyError('update_failed: {"code":"23514"}').includes('23514'));
});

test('planOptions: only linkable (F/O/T, R theme; proposed/agreed), by code, ≤100', () => {
  const items = [{ id: U(1), level: 'T', state: 'agreed', code: 'T10', title: 'b' }, { id: U(2), level: 'T', state: 'agreed', code: 'T9', title: 'a' },
    { id: U(3), level: 'L', state: 'agreed', code: 'X' }, { id: U(4), level: 'O', state: 'done', code: 'O1' }, { id: U(5), level: 'R', kind: 'theme', state: 'proposed', code: 'R1', title: 'th' },
    { id: U(6), level: 'R', kind: 'milestone', state: 'agreed', code: 'R2' }];
  assert.deepEqual(planOptions(items).map(o => o.label), ['R1 th', 'T9 a', 'T10 b']);
  assert.equal(planOptions(Array.from({ length: 150 }, (_, i) => ({ id: U(1000 + i), level: 'T', state: 'agreed', code: `T${i}` }))).length, 100);
});

test('lookupEmail: a plain address, lower-cased; anything with wildcards refused', () => {
  assert.equal(lookupEmail(' Zz.Me@LegendOfToys.com '), 'zz.me@legendoftoys.com');
  assert.equal(lookupEmail('a_b@x.com'), 'a_b@x.com');
  for (const e of ['a%b@x.com', 'a*b@x.com', 'no-at', '', null, 'a,b@x.com']) assert.equal(lookupEmail(e), null, String(e));
});

test('slackApi: bearer token, form for scalars / JSON for objects, ok:false is an error, no token → refused', async () => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(url.endsWith('users.info') ? { ok: true, user: {} } : { ok: false, error: 'invalid_auth' })); };
  const env = { SLACK_DOCKET_BOT_TOKEN: 'xoxb-zz' };
  assert.equal((await slackApi('users.info', { user: 'U1AA' }, env, f)).ok, true);
  assert.equal(seen[0].url, 'https://slack.com/api/users.info');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer xoxb-zz');
  assert.equal(seen[0].init.body, 'user=U1AA');
  const r = await slackApi('views.open', { trigger_id: 't', view: { a: 1 } }, env, f);
  assert.deepEqual(r, { ok: false, error: 'invalid_auth' });
  assert.match(seen[1].init.headers['Content-Type'], /json/);
  assert.deepEqual((await slackApi('x', {}, {}, f)), { ok: false, error: 'not_configured' });
  assert.deepEqual(await slackApi('x', {}, env, async () => { throw new Error('boom'); }), { ok: false, error: 'network' });
});

test('slackRespond only posts to Slack\'s hooks host', async () => {
  let hit = 0;
  const f = async () => { hit++; return new Response('ok'); };
  assert.equal((await slackRespond('https://evil.test/x', { text: 'a' }, f)).ok, false);
  assert.equal((await slackRespond('https://hooks.slack.com/commands/1', { text: 'a' }, f)).ok, true);
  assert.equal(hit, 1);
});

test('H6: after 18:00 IST "today" is refused (it would be a past deadline); tomorrow is fine', () => {
  const mv = validateMoveSubmission(vals({ date: { selected_date: TODAY }, reason: { value: 'r' } }), LATE);
  assert.match(mv.errors.date, /pick tomorrow or later/);
  assert.ok(validateMoveSubmission(vals({ date: { selected_date: addD(TODAY, 1) }, reason: { value: 'r' } }), LATE).value);
  assert.ok(validateMoveSubmission(vals({ date: { selected_date: TODAY }, reason: { value: 'r' } }), NOW).value, 'before 18:00 today is fine');
  const tk = validateTaskSubmission(vals({ title: { value: 'a' }, owner: { selected_user: 'U1AA' }, deadline: { selected_date: TODAY } }), LATE);
  assert.match(tk.errors.deadline, /pick tomorrow or later/);
});

test('H2: /docket mine stays ≤ 50 blocks, says how many it hides, and always ends with the Docket link', () => {
  const at = (h) => new Date(NOW + h * 3600000).toISOString();
  const T = (n, h) => ({ id: U(5000 + n), task_no: `DKT-${n}`, title: 't', status: 'in_progress', deadline: at(h), revised_deadline: null });
  const tasks = [...Array.from({ length: 30 }, (_, i) => T(i, -24 - i)), ...Array.from({ length: 30 }, (_, i) => T(100 + i, 1)),
    ...Array.from({ length: 30 }, (_, i) => T(200 + i, 48))];
  const m = mineMessage(tasks, NOW);
  assert.ok(m.blocks.length <= 50, String(m.blocks.length));
  assert.equal(m.text, '30 overdue (showing 8), 30 due today (showing 8), 30 in the next 7 days (showing 5).');
  assert.match(m.blocks.at(-1).elements[0].text, /All your tasks in Docket/);
  assert.equal(m.blocks.filter(b => b.type === 'actions').length, 21);
});

test('H3: the /docket add reply names the owner and any @name it could not place', () => {
  const people = [{ id: U(1), full_name: 'Riya Sharma' }, { id: U(2), full_name: 'Riyaz Khan' }, { id: U(3), full_name: 'Me Self' }];
  const task = { id: U(9), task_no: 'DKT-9' };
  const own = parseQuickAdd('call vendor @riya', { people, now: new Date(NOW) });
  assert.match(addReply('call vendor @riya', own, task, people, U(3)), /— call vendor — owner Riya Sharma\.$/);
  const mine = parseQuickAdd('call vendor', { people, now: new Date(NOW) });
  assert.match(addReply('call vendor', mine, task, people, U(3)), /— yours\.$/);
  assert.match(addReply('call vendor', mine, { ...task, space_is_personal: true }, people, U(3)), /— yours, in your Personal space\.$/);   // P2
  const amb = parseQuickAdd('call @ri', { people, now: new Date(NOW) });
  const r = addReply('call @ri', amb, task, people, U(3));
  assert.match(r, /— yours\.\n@ri matched more than one person — kept as yours\./);
  const none = parseQuickAdd('call @zed', { people, now: new Date(NOW) });
  assert.match(addReply('call @zed', none, task, people, U(3)), /@zed matched no one — kept as yours\./);
});

// ── identity ──
test('H7: slackUserEmail refuses strangers, other workspaces, bots, deleted users — and an unknown bot team', () => {
  const info = (u) => ({ ok: true, user: { id: 'U1AA', team_id: 'TLOT', profile: { email: 'ZZ.me@legendoftoys.com' }, ...u } });
  assert.equal(slackUserEmail(info({}), 'TLOT'), 'zz.me@legendoftoys.com');
  for (const [name, u, team] of [['stranger', { is_stranger: true }, 'TLOT'], ['other team', { team_id: 'TOTHER' }, 'TLOT'], ['bot', { is_bot: true }, 'TLOT'],
    ['deleted', { deleted: true }, 'TLOT'], ['no bot team', {}, null], ['no email', { profile: {} }, 'TLOT']]) assert.equal(slackUserEmail(info(u), team), null, name);
  assert.equal(slackUserEmail({ ok: false, error: 'user_not_found' }, 'TLOT'), null);
});

const DAY = 86400000;
function deps({ cached = null, email = 'zz.me@legendoftoys.com', emps, auth, authBy } = {}) {
  const log = { saved: [], forgot: [], emailCalls: 0, authFor: [] };
  let row = cached;
  return { log, d: {
    cached: async () => row,
    forget: async (sid) => { log.forgot.push(sid); row = null; },
    slackEmail: async () => { log.emailCalls++; return email; },
    employeesByEmail: async () => emps ?? [{ id: U(2), auth_user_id: U(1), status: 'active', work_email: 'ZZ.me@legendoftoys.com' }],
    save: async (r) => { log.saved.push(r); row = { ...r, resolved_at: new Date(NOW).toISOString() }; },
    authForUser: async (uid) => {
      log.authFor.push(uid);
      if (authBy) return authBy(uid);
      return auth === undefined ? { userId: uid, employeeId: U(2), employeeActive: true, source: 'app' } : auth;
    },
  } };
}
const fresh = (o) => ({ employee_id: U(2), auth_user_id: U(1), resolved_at: new Date(NOW - DAY).toISOString(), ...o });
test('identity: a fresh cached row skips Slack; source = slack', async () => {
  const { d, log } = deps({ cached: fresh() });
  const r = await resolveSlackPerson('U1AA', d, NOW);
  assert.deepEqual([r.employeeId, r.auth.source, log.emailCalls, log.saved.length, log.forgot.length, log.authFor[0]], [U(2), 'slack', 0, 0, 0, U(1)]);
});
test('identity: first time → email → the one active employee → their login; the row is saved', async () => {
  const { d, log } = deps();
  const r = await resolveSlackPerson('U1AA', d, NOW);
  assert.equal(r.employeeId, U(2));
  assert.deepEqual(log.saved, [{ employee_id: U(2), slack_user_id: 'U1AA', auth_user_id: U(1) }]);
});
test('H1: a row older than 7 days is re-resolved from Slack (and the new mapping wins)', async () => {
  const { d, log } = deps({ cached: fresh({ employee_id: U(7), auth_user_id: U(8), resolved_at: new Date(NOW - 8 * DAY).toISOString() }) });
  const r = await resolveSlackPerson('U1AA', d, NOW);
  assert.equal(r.employeeId, U(2));
  assert.deepEqual([log.forgot, log.emailCalls, log.saved.length], [['U1AA'], 1, 1]);
  assert.ok(!log.authFor.includes(U(8)), 'a stale row is not even tried');
});
test('H1: a refused cache hit recovers — forgotten, re-resolved once, saved', async () => {
  // the cached login is now someone else's (re-linked) / inactive / the employee exited since: each recovers
  for (const bad of [{ employeeId: U(9), employeeActive: true }, null, { employeeId: U(2), employeeActive: false }]) {
    const { d, log } = deps({ cached: fresh({ auth_user_id: U(5) }), authBy: (uid) => (uid === U(5) ? bad : { employeeId: U(2), employeeActive: true }) });
    const r = await resolveSlackPerson('U1AA', d, NOW);
    assert.equal(r.employeeId, U(2), JSON.stringify(bad));
    assert.deepEqual([log.forgot, log.emailCalls, log.saved.length, log.authFor], [['U1AA'], 1, 1, [U(5), U(1)]]);
  }
  // …and if Slack no longer maps to anyone, the row is gone and the person is refused (not locked to the old row)
  const { d, log } = deps({ cached: fresh(), auth: null, emps: [] });
  assert.deepEqual(await resolveSlackPerson('U1AA', d, NOW), { error: 'unlinked' });
  assert.deepEqual([log.forgot, log.saved.length], [['U1AA'], 0]);
});
test('identity: every gap is refused, never provisioned', async () => {
  const cases = [
    ['bad slack id', 'nope', deps()],
    ['no email', 'U1AA', deps({ email: null })],
    ['no employee', 'U1AA', deps({ emps: [] })],
    ['exited employee', 'U1AA', deps({ emps: [{ id: U(2), auth_user_id: U(1), status: 'exited', work_email: 'zz.me@legendoftoys.com' }] })],
    ['ilike near-miss', 'U1AA', deps({ emps: [{ id: U(2), auth_user_id: U(1), status: 'active', work_email: 'zzxme@legendoftoys.com' }] })],
    ['two employees', 'U1AA', deps({ emps: [{ id: U(2), auth_user_id: U(1), status: 'active', work_email: 'zz.me@legendoftoys.com' }, { id: U(3), auth_user_id: U(4), status: 'active', work_email: 'zz.me@legendoftoys.com' }] })],
    ['no login', 'U1AA', deps({ emps: [{ id: U(2), auth_user_id: null, status: 'active', work_email: 'zz.me@legendoftoys.com' }] })],
    ['login inactive', 'U1AA', deps({ auth: null })],
    ['login is someone else', 'U1AA', deps({ auth: { employeeId: U(9), employeeActive: true } })],
  ];
  for (const [name, sid, { d, log }] of cases) {
    assert.deepEqual(await resolveSlackPerson(sid, d, NOW), { error: 'unlinked' }, name);
    assert.equal(log.saved.length, 0, name);
  }
});
test('H4: an owner / receiver pick needs only an active employee (no login, no authForUser)', async () => {
  const { d, log } = deps({ emps: [{ id: U(6), auth_user_id: null, status: 'active', work_email: 'zz.me@legendoftoys.com' }] });
  assert.deepEqual(await slackEmployee('U1AA', d), { employeeId: U(6), authUserId: null });
  assert.equal(log.authFor.length, 0);
  assert.deepEqual(await slackEmployee('U1AA', deps({ emps: [] }).d), { error: 'unlinked' });
  assert.deepEqual(await slackEmployee('U1AA', deps({ email: null }).d), { error: 'unlinked' });
});
