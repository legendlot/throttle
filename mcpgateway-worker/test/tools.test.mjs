import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, toolsFor, findTool } from '../src/tools/index.js';
import { parseReportArgs, T } from '../src/tools/build.js';
import { capPayload, getAs } from '../src/workers.js';

const NOW = Date.parse('2026-11-09T12:00:00Z'); // 17:30 IST
const U = '0f3c6a2e-1b2c-4d5e-8f90-123456789abc';
const view = { systems: ['odo'], odo_perms: { sales_view: true } };
const sup = { systems: ['odo'], odo_perms: { sales_view: true, salesops_super_admin: true } };

test('every tool parse() returns { ok, value } on success (the shape the core passes to run)', () => {
  const ok = { whoami: {}, odo_sales_summary: { from: '2026-11-01' }, odo_sales: { report: 'breakdown' }, odo_marketing: { report: 'spend' }, odo_dyno: { report: 'angles' },
    odo_funnel: { report: 'history' }, odo_amazon: { report: 'geo' }, odo_inventory: { report: 'thresholds' }, odo_pnl: { report: 'product_costs' }, odo_lookup: { report: 'channels' },
    docket_tasks: { report: 'my_tasks' }, docket_create_task: { title: 'x' }, docket_update_task: { id: U, priority: 'P1' }, docket_set_status: { id: U, status: 'done' },
    docket_revise_deadline: { id: U, new_deadline: '2026-11-20', reason: 'r' }, docket_add_comment: { id: U, body: 'b' }, docket_abandon_task: { id: U, reason: 'r' },
    docket_plan: { report: 'themes' },
    snorkel_procurement: { report: 'pos' }, snorkel_requests: { report: 'requests', mine: true }, snorkel_sales: { report: 'orders' }, snorkel_assets: { report: 'assets', category_id: 3 },
    garage_store: { report: 'stock', q: 'screw' }, redline_production: { report: 'dashboard' }, depot_dispatch: { report: 'pipeline' } };
  for (const t of TOOLS) {
    assert.ok(t.name in ok, `add ${t.name} to this test`);
    const p = t.parse(ok[t.name], NOW);
    assert.equal(p.ok, true, t.name);
    assert.ok(p.value && typeof p.value === 'object', `${t.name} parse must return value`);
  }
});
test('registry: unique names, every tool well-formed', () => {
  assert.equal(new Set(TOOLS.map(t => t.name)).size, TOOLS.length);
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{2,40}$/);
    assert.equal(typeof t.parse, 'function'); assert.equal(typeof t.run, 'function');
    assert.equal(t.inputSchema.type, 'object'); assert.equal(t.inputSchema.additionalProperties, false);
    // Read-only everywhere except the Docket write tools, which must say so (Claude asks before a write).
    if (t.write) { assert.equal(t.system, 'docket', `${t.name}: only Docket writes`); assert.equal(t.annotations.readOnlyHint, false); }
    else assert.equal(t.annotations.readOnlyHint, true, `${t.name} must be read-only`);
  }
});
test('visibility: no grant → whoami only; view → no P&L; super admin → P&L', () => {
  assert.deepEqual(toolsFor({ systems: [], odo_perms: { sales_view: true, salesops_super_admin: true } }).map(t => t.name), ['whoami']);
  assert.deepEqual(toolsFor({ systems: ['odo'], odo_perms: {} }).map(t => t.name), ['whoami']);
  const v = toolsFor(view).map(t => t.name);
  assert.ok(v.includes('odo_sales_summary') && v.includes('odo_marketing') && !v.includes('odo_pnl'));
  assert.ok(toolsFor(sup).map(t => t.name).includes('odo_pnl'));
  for (const t of toolsFor(sup)) assert.equal(t.visible, undefined, 'internal fields never leave');
  assert.equal(findTool('odo_pnl').deny(view), 'odo pnl denied');
  assert.equal(findTool('odo_pnl').deny(sup), null);
  assert.equal(findTool('odo_sales').deny({ odo_perms: {} }), 'odo denied');
});
test('only read actions are reachable: no probe/sync/send/search/export/write actions', () => {
  const actions = TOOLS.flatMap(t => Object.values(t.reports || {}).map(r => r.action));
  for (const a of actions) assert.doesNotMatch(a, /Probe|Now$|^send|^search|Export|^post|^set|^update|^delete|^create|Peek|^preview/i, a);
  assert.ok(actions.length >= 30);
});
test('report args: whitelist, types, rename, ranges', () => {
  const reps = findTool('odo_sales').reports;
  assert.deepEqual(parseReportArgs(reps, { report: 'breakdown', from: '2026-11-01', to: '2026-11-08', group: 'channel' }, NOW),
    { ok: true, report: 'breakdown', params: { from: '2026-11-01', to: '2026-11-08', group: 'channel' } });
  const ch = parseReportArgs(reps, { report: 'breakdown', channel_ids: ['0f3c6a2e-1b2c-4d5e-8f90-123456789abc'] }, NOW);
  assert.equal(ch.params.channel_id, '0f3c6a2e-1b2c-4d5e-8f90-123456789abc');
  assert.equal(ch.params.channel_ids, undefined);
  assert.deepEqual([ch.params.from, ch.params.to], ['2026-11-09', '2026-11-09']);
  for (const bad of [
    { report: 'nope' }, {}, { report: 'breakdown', action: 'sendStockAlertsNow' }, { report: 'breakdown', group: 'x' },
    { report: 'breakdown', channel_ids: ['not-a-uuid'] }, { report: 'breakdown', from: '2026-11-10' },
    { report: 'breakdown', from: '2025-01-01', to: '2026-11-01' }, { report: 'breakdown', product_code: 'a&action=x' },
    { report: 'live_website', from: '2026-11-01' }, { report: 'order_lines', limit: 100000 },
    { report: '__proto__' }, { report: 'constructor' }, { report: 'toString' }, { report: 'breakdown', constructor: 'x' }, JSON.parse('{"report":"breakdown","__proto__":"x"}'),
  ]) assert.equal(parseReportArgs(reps, bad, NOW).ok, false, JSON.stringify(bad));
  assert.equal(parseReportArgs(findTool('odo_dyno').reports, { report: 'decisions' }, NOW).ok, false); // required
  assert.equal(T.text.check('a\nb').ok, false);
});
test('capPayload: cuts long arrays with a note, bounds size', () => {
  const big = { rows: Array.from({ length: 1000 }, (_, i) => ({ i, pad: 'x'.repeat(50) })) };
  const r = capPayload(big);
  assert.ok(r.data.rows.length <= 300);
  assert.match(r.truncated[0], /rows: showing \d+ of 1000/);
  assert.ok(JSON.stringify(r.data).length <= 90000);
  assert.deepEqual(capPayload({ a: [1, 2] }), { data: { a: [1, 2] }, truncated: [] });
  assert.equal(capPayload({ s: 'x'.repeat(200000) }).data, null);
});
test('getAs: 400 with a message is a user error, not a refusal', async () => {
  const b = { fetch: async () => new Response(JSON.stringify({ ok: false, error: 'bad group' }), { status: 400 }) };
  assert.deepEqual(await getAs(b, 'J', 'getSales', {}), { ok: false, userError: 'bad group' });
  assert.deepEqual(await getAs(undefined, 'J', 'getSales', {}), { ok: false, reason: 'unreachable' });
});
test('report tool run: one action, as the person, params only from the whitelist', async () => {
  const seen = [];
  const env = { ODOOPS: { fetch: async (u, init) => { seen.push([new URL(u), init.headers.Authorization]); return new Response(JSON.stringify({ ok: true, data: { rows: [1] } }), { status: 200 }); } } };
  const t = findTool('odo_amazon');
  const p = t.parse({ report: 'returns', from: '2026-11-01', to: '2026-11-02', group: 'product' }, NOW);
  assert.equal(p.ok, true);
  const r = await t.run({ env, sbAccess: 'JWT', input: p.value });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], 'Bearer JWT');
  assert.deepEqual(Object.fromEntries(seen[0][0].searchParams), { action: 'getAmazonReturns', from: '2026-11-01', to: '2026-11-02', group: 'product' });
});

import { scrub } from '../src/workers.js';
test('scrub: signed links always, emails when asked', () => {
  const d = { rows: [{ img: 'https://x.supabase.co/storage/v1/object/sign/lab-creatives/a.png?token=eyJ.abc', note: 'see https://s3.aws.com/b?X-Amz-Signature=ff&x=1 ok', plain: 'https://legendoftoys.com/p/1' }], err: 'no mail for ops@legendoftoys.com' };
  const a = scrub(d, { emails: true });
  assert.equal(a.rows[0].img, '[signed link removed]');
  assert.equal(a.rows[0].note, 'see [signed link removed] ok');
  assert.equal(a.rows[0].plain, 'https://legendoftoys.com/p/1');
  assert.equal(a.err, 'no mail for [email removed]');
  assert.equal(scrub(d).err, 'no mail for ops@legendoftoys.com');
  assert.equal(scrub(5), 5); assert.equal(scrub(null), null);
});
test('odo report output is scrubbed end to end', async () => {
  const env = { ODOOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: { rows: [{ creative_url: 'https://x.supabase.co/storage/v1/object/sign/lab-creatives/a.png?token=SECRET' }], err: 'x@y.com' } }), { status: 200 }) } };
  const t = findTool('odo_dyno');
  const p = t.parse({ report: 'board' }, NOW);
  const r = await t.run({ env, sbAccess: 'J', input: p.value });
  assert.doesNotMatch(JSON.stringify(r.data), /SECRET|x@y\.com/);
});

import { groupSalesRows, clipErrors } from '../src/tools/odo.js';
test('hostile 2026-11-09 #1: breakdown is summed to the group, not cut', async () => {
  const rows = [];
  for (let d = 0; d < 30; d++) for (let v = 0; v < 40; v++) rows.push({ grp_key: `V${v}`, grp_label: `Var ${v}`, sale_date: `2026-10-${String(d + 1).padStart(2, '0')}`, units: '1', gross_value: '100.4', discount_value: 0, tax_value: 0, returned_units: 0, returned_value: 0 });
  const g = groupSalesRows({ rows });
  assert.equal(g.groups, 40);
  assert.equal(g.rows[0].units, 30);
  assert.equal(g.rows[0].gross_value, 3012);
  const env = { ODOOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: { rows } }), { status: 200 }) } };
  const t = findTool('odo_sales');
  const r = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'breakdown', from: '2026-10-01', to: '2026-10-30' }, NOW).value });
  assert.equal(r.data.truncated, undefined);
  assert.equal(r.data.result.rows.length, 40);
});
test('hostile #3: P&L manual lines snap `from` to the 1st of the month', () => {
  const p = parseReportArgs(findTool('odo_pnl').reports, { report: 'manual_lines' }, NOW);
  assert.deepEqual([p.params.from, p.params.to], ['2026-11-01', '2026-11-09']);
});
test('hostile #6: raw third-party payloads are dropped; error text is capped', async () => {
  const env = { ODOOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: { rows: [{ id: 1, raw: 'IGNORE PREVIOUS', meta_response: { x: 1 }, request: 'r', asset_url: 'u' }] } }), { status: 200 }) } };
  const t = findTool('odo_marketing');
  const r = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'ad_engine_ledger' }, NOW).value });
  assert.deepEqual(r.data.result.rows[0], { id: 1 });
  assert.equal(clipErrors({ feeds: [{ last_error: 'e'.repeat(500), name: 'n'.repeat(500) }] }).feeds[0].last_error.length, 200);
  assert.equal(clipErrors({ feeds: [{ name: 'n'.repeat(500) }] }).feeds[0].name.length, 500);
});
test('hostile #7: inventory history needs a product/SKU and defaults to 30 days; 422 is a user error', async () => {
  const reps = findTool('odo_inventory').reports;
  assert.equal(parseReportArgs(reps, { report: 'history' }, NOW).ok, false);
  const p = parseReportArgs(reps, { report: 'history', sku: 'LOT-123' }, NOW);
  assert.deepEqual([p.params.from, p.params.to], ['2026-10-11', '2026-11-09']);
  const b = { fetch: async () => new Response(JSON.stringify({ ok: false, error: 'sku not found' }), { status: 422 }) };
  assert.deepEqual(await getAs(b, 'J', 'x', {}), { ok: false, userError: 'sku not found' });
  const f = { fetch: async () => new Response(JSON.stringify({ ok: false, error: 'nope' }), { status: 403 }) };
  assert.deepEqual(await getAs(f, 'J', 'x', {}), { ok: false, reason: 'worker denied' });
});
test('hostile #8/#9/#10/#11: byte cap, bounds, to-only range, truthy perms', () => {
  assert.equal(capPayload({ s: 'é'.repeat(50000) }).data, null); // 100 KB in UTF-8, 50k chars
  const dy = findTool('odo_dyno').reports;
  assert.equal(parseReportArgs(dy, { report: 'board', recent_days: 31 }, NOW).ok, false);
  assert.equal(parseReportArgs(findTool('odo_inventory').reports, { report: 'alerts', limit: 201 }, NOW).ok, false);
  const p = parseReportArgs(findTool('odo_sales').reports, { report: 'breakdown', to: '2026-11-03' }, NOW);
  assert.deepEqual([p.params.from, p.params.to], ['2026-11-03', '2026-11-03']);
  assert.ok(toolsFor({ systems: ['odo'], odo_perms: { sales_view: 1, salesops_super_admin: 'true' } }).map(t => t.name).includes('odo_pnl'));
});

// ---- Docket (read + write), 2026-11-09
const docketEnv = seen => ({ DOCKETOPS: { fetch: async (u, init = {}) => { seen.push({ u: new URL(u), init }); return new Response(JSON.stringify({ ok: true, data: { id: U, status: 'done' } }), { status: 200 }); } } });
test('docket: visible only with a docket grant; writes are the only non-read tools', () => {
  const names = toolsFor({ systems: ['docket'] }).map(t => t.name);
  assert.ok(names.includes('docket_tasks') && names.includes('docket_create_task') && !names.includes('odo_sales'));
  assert.ok(!toolsFor({ systems: ['odo'], odo_perms: { sales_view: true } }).map(t => t.name).some(n => n.startsWith('docket_')));
  const writes = TOOLS.filter(t => t.write).map(t => t.name).sort();
  assert.deepEqual(writes, ['docket_abandon_task', 'docket_add_comment', 'docket_create_task', 'docket_revise_deadline', 'docket_set_status', 'docket_update_task']);
  assert.equal(findTool('docket_abandon_task').annotations.destructiveHint, true);
});
test('docket writes: one fixed action, POST {action,data}, as the person, fields whitelisted', async () => {
  const seen = [];
  const t = findTool('docket_set_status');
  const p = t.parse({ id: U, status: 'done', note: 'shipped' }, NOW);
  const r = await t.run({ env: docketEnv(seen), sbAccess: 'JWT', input: p.value });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer JWT');
  assert.deepEqual(JSON.parse(seen[0].init.body), { action: 'changeStatus', data: { id: U, status: 'done', note: 'shipped' } });
  assert.deepEqual(r.data, { done: 'docket_set_status', result: { id: U, status: 'done' } });
  for (const bad of [
    { id: U, status: 'abandoned' }, { id: 'DKT-105', status: 'done' }, { status: 'done' }, { id: U, status: 'done', action: 'bulkUpdateTasks' },
    { id: U, status: 'done', data: {} }, JSON.parse(`{"id":"${U}","status":"done","__proto__":{"x":1}}`), { id: U, status: 'done', constructor: 'x' },
  ]) assert.equal(t.parse(bad, NOW).ok, false, JSON.stringify(bad));
});
test('docket create: self-assigned by default; owner given → not; title required and bounded', () => {
  const c = findTool('docket_create_task');
  assert.deepEqual(c.parse({ title: '  Ship it ' }, NOW).value, { title: 'Ship it', assign_self: true });
  assert.deepEqual(c.parse({ title: 'x', owner_employee_id: U }, NOW).value, { title: 'x', owner_employee_id: U });
  for (const bad of [{}, { title: '   ' }, { title: 'x'.repeat(201) }, { title: 'x', priority: 'P9' }, { title: 'x', deadline: '2026-02-30' }, { title: 'x', is_recurring: true }, { title: 'x', collaborators: [U] }])
    assert.equal(c.parse(bad, NOW).ok, false, JSON.stringify(bad));
});
test('docket update needs a field; revise/abandon need a reason', () => {
  assert.equal(findTool('docket_update_task').parse({ id: U }, NOW).ok, false);
  assert.equal(findTool('docket_update_task').parse({ id: U, status: 'done' }, NOW).ok, false); // status is not editable here
  assert.equal(findTool('docket_revise_deadline').parse({ id: U, new_deadline: '2026-11-20' }, NOW).ok, false);
  assert.equal(findTool('docket_abandon_task').parse({ id: U }, NOW).ok, false);
  assert.equal(findTool('docket_abandon_task').parse({ id: U, reason: ' ' }, NOW).ok, false);
});
// GET (the guard's getTask) answers with `task`; POST (the write) answers with `post`.
const routed = (task, post, seen = []) => ({ DOCKETOPS: { fetch: async (u, init = {}) => {
  seen.push({ u: new URL(u), init });
  if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify({ ok: true, data: task }), { status: 200 });
  return new Response(JSON.stringify(post.body), { status: post.status });
} } });
const OPEN = { id: U, status: 'in_progress', deadline: null };
test('docket write errors: 403 → task rule, 404/422 → user error, 401 → session, *_failed/{json} → plain words, lost reply → check first', async () => {
  const t = findTool('docket_add_comment'); const v = t.parse({ id: U, body: 'hi' }, NOW).value;
  const run = (status, body) => t.run({ env: routed(OPEN, { status, body }), sbAccess: 'J', input: v });
  assert.deepEqual(await run(403, { ok: false, error: 'forbidden' }), { ok: false, reason: 'docket denied' });
  assert.deepEqual(await run(404, { ok: false, error: 'not_found' }), { ok: false, userError: 'not_found' });
  assert.deepEqual(await run(422, { ok: false, error: 'one_level_only: parent is already a sub-task' }), { ok: false, userError: 'one_level_only: parent is already a sub-task' });
  assert.deepEqual(await run(401, { ok: false }), { ok: false, reason: 'session expired' });
  for (const e of ['comment_failed: {"code":"23503","message":"fk","details":"Key (owner_employee_id)"}', 'db_error: x', 'weird {json}']) {
    const r = await run(400, { ok: false, error: e });
    assert.equal(r.ok, false); assert.doesNotMatch(r.userError, /23503|fk|Key|json|db_error/);
  }
  assert.deepEqual(await run(500, { ok: false, error: 'server_error: boom' }), { ok: false, reason: 'write unconfirmed' });
  const lost = { DOCKETOPS: { fetch: async () => { throw new Error('reset'); } } };
  assert.deepEqual(await findTool('docket_create_task').run({ env: lost, sbAccess: 'J', input: { title: 'x', assign_self: true } }), { ok: false, reason: 'write unconfirmed' });
  const { refusalText } = await import('../src/checks.js');
  assert.match(refusalText('write unconfirmed').text, /Check the task with docket_tasks before trying again/);
  assert.match(refusalText('docket denied').text, /owner, creator/);
  assert.equal(refusalText('no docket grant').fault, false);
});
test('hostile 2026-11-09: abandoned tasks are read-only; a second deadline is refused before writing', async () => {
  const AB = { id: U, status: 'abandoned', deadline: '2026-11-01' };
  for (const [name, args] of [['docket_update_task', { id: U, priority: 'P1' }], ['docket_revise_deadline', { id: U, new_deadline: '2026-11-20', reason: 'r' }], ['docket_abandon_task', { id: U, reason: 'r' }]]) {
    const seen = []; const t = findTool(name);
    const r = await t.run({ env: routed(AB, { status: 200, body: { ok: true, data: {} } }, seen), sbAccess: 'J', input: t.parse(args, NOW).value });
    assert.equal(r.ok, false, name); assert.ok(r.userError, name);
    assert.ok(seen.every(x => (x.init.method || 'GET') === 'GET'), `${name} must not write`);
  }
  const seen = []; const up = findTool('docket_update_task');
  const r = await up.run({ env: routed({ ...OPEN, deadline: '2026-11-15' }, { status: 200, body: { ok: true, data: {} } }, seen), sbAccess: 'J', input: up.parse({ id: U, deadline: '2026-11-20' }, NOW).value });
  assert.match(r.userError, /docket_revise_deadline/); assert.equal(seen.length, 1);
  // set_status is the way back out of abandoned: no guard.
  const st = findTool('docket_set_status'); const seen2 = [];
  assert.equal((await st.run({ env: routed(AB, { status: 200, body: { ok: true, data: { id: U, status: 'in_progress' } } }, seen2), sbAccess: 'J', input: st.parse({ id: U, status: 'in_progress' }, NOW).value })).ok, true);
  assert.equal(seen2.length, 1);
});
test('the write actions are exactly these six; reads drop LOT user ids', async () => {
  assert.deepEqual(Object.fromEntries(TOOLS.filter(t => t.write).map(t => [t.name, t.action])), {
    docket_create_task: 'createTask', docket_update_task: 'updateTask', docket_set_status: 'changeStatus',
    docket_revise_deadline: 'reviseDeadline', docket_add_comment: 'addComment', docket_abandon_task: 'abandonTask' });
  const rd = findTool('docket_tasks');
  const mk = d => ({ DOCKETOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: d }), { status: 200 }) } });
  const people = await rd.run({ env: mk([{ id: U, full_name: 'A B', department_id: null, auth_user_id: 'secret-uid' }]), sbAccess: 'J', input: rd.parse({ report: 'people' }, NOW).value });
  assert.deepEqual(people.data.result, { people: [{ id: U, name: 'A B', department_id: null }] });
  const task = await rd.run({ env: mk({ id: U, created_by_user_id: 'u1', creator_name: 'C', comments: [{ body: 'x', author_user_id: 'u2', author_name: 'D' }], history: [{ actor_user_id: 'u3', actor_name: 'E' }] }), sbAccess: 'J', input: rd.parse({ report: 'task', id: U }, NOW).value });
  assert.doesNotMatch(JSON.stringify(task.data), /u1|u2|u3/); assert.match(JSON.stringify(task.data), /"D"/);
  const seen = []; const mt = rd.parse({ report: 'my_tasks', overdue: true, status: 'blocked' }, NOW);
  await rd.run({ env: docketEnv(seen), sbAccess: 'J', input: mt.value });
  assert.deepEqual(Object.fromEntries(seen[0].u.searchParams), { action: 'getMyTasks', overdue: 'true', status: 'blocked' });
  assert.equal(seen[0].init.method, undefined); // reads are GETs
});
test('comment: a task you cannot open (private space) is refused before writing', async () => {
  const seen = []; const t = findTool('docket_add_comment');
  const env = { DOCKETOPS: { fetch: async (u, init = {}) => { seen.push(init.method || 'GET'); return new Response(JSON.stringify({ ok: false, error: 'forbidden_space' }), { status: 403 }); } } };
  assert.deepEqual(await t.run({ env, sbAccess: 'J', input: t.parse({ id: U, body: 'hi' }, NOW).value }), { ok: false, reason: 'docket denied' });
  assert.deepEqual(seen, ['GET']);
});
test('Codex 2026-11-09: empty description clears; empty id means not given', async () => {
  assert.deepEqual(findTool('docket_update_task').parse({ id: U, description: '' }, NOW).value, { id: U, description: '' });
  assert.equal(findTool('docket_create_task').parse({ title: 'x', owner_employee_id: '' }, NOW).ok, true);
});

// ---- Snorkel (read-only), 2026-11-09. Role permission sets copied from live store.snorkel_roles.
const SROLE = {
  requester: { payment_request: true },
  sales_rep: { sales_view: true, payment_request: true, sales_order_manage: true, sales_partner_manage: true },
  store: { sales_view: true, payment_request: true, procurement_view: true },
  approver: { asset_view: true, po_approve: true, payment_request: true, procurement_view: true },
  jarvis_ro: { asset_view: true, sales_view: true, procurement_view: true },
};
const snk = perms => toolsFor({ systems: ['snorkel'], snorkel_perms: perms }).map(t => t.name).filter(n => n.startsWith('snorkel_')).sort();
test('snorkel: each role sees exactly the areas its Snorkel role gates', () => {
  assert.deepEqual(snk({}), []);
  assert.deepEqual(snk(SROLE.requester), ['snorkel_requests']);
  assert.deepEqual(snk(SROLE.sales_rep), ['snorkel_requests', 'snorkel_sales']);
  assert.deepEqual(snk(SROLE.store), ['snorkel_procurement', 'snorkel_requests', 'snorkel_sales']);
  assert.deepEqual(snk(SROLE.approver), ['snorkel_assets', 'snorkel_procurement', 'snorkel_requests']);
  assert.deepEqual(snk(SROLE.jarvis_ro), ['snorkel_assets', 'snorkel_procurement', 'snorkel_requests', 'snorkel_sales']);
  assert.deepEqual(toolsFor({ systems: ['odo'], snorkel_perms: SROLE.jarvis_ro, odo_perms: {} }).map(t => t.name), ['whoami']);
  assert.equal(findTool('snorkel_procurement').deny({ snorkel_perms: SROLE.sales_rep }), 'snorkel denied');
  assert.equal(findTool('snorkel_procurement').deny({ snorkel_perms: SROLE.store }), null);
  assert.equal(findTool('snorkel_sales').deny({ snorkel_perms: SROLE.requester }), 'snorkel denied');
  assert.equal(findTool('snorkel_assets').deny({ snorkel_perms: { asset_manage: true } }), null);
});
test('snorkel: no payment, bank, payee, export, diag, admin, address or download action is reachable', () => {
  const acts = TOOLS.filter(t => t.system === 'snorkel').flatMap(t => Object.values(t.reports).map(r => r.action));
  for (const a of acts) assert.doesNotMatch(a, /Payment|Bank|Payee|Finance|Export|diag|Download|DocUrl|SnorkelUsers|SnorkelRoles|Address|PrintPO|Invoice|Admin/i, a);
  assert.ok(acts.length >= 30);
});
test('snorkel: contacts, addresses, bank and payment fields and user ids are dropped at any depth', async () => {
  const data = { rows: [{ po_number: 'PO-1', vendor_name: 'V', raised_by_name: 'R', raised_by_user_id: 'uid', payment_status: 'paid', payment_note: 'utr 123', paid_by: 'x', payment_routed_to: 'y',
    vendor: { vendor_code: 'V1', contact_name: 'N', contact_phone: '98', contact_email: 'a@b.co', address: 'addr', gstin: '27AAA', bank_account: '123', ifsc_code: 'X', udyam_number: 'U' },
    sales_partners: { name: 'P', phone: '9', email: 'p@q.in', billing_address: 'b', shipping_address: 's', pincode: '400001', contact_person: 'c' }, notes: 'mail me at z@lot.com' }] };
  const env = { SNORKELOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data }), { status: 200 }) } };
  const t = findTool('snorkel_procurement');
  const r = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'po', po_number: 'PO-1' }, NOW).value });
  const row = r.data.result.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['payment_status', 'po_number', 'raised_by_name', 'sales_partners', 'vendor', 'vendor_name']);
  assert.deepEqual(row.vendor, { vendor_code: 'V1', gstin: '27AAA' });
  assert.deepEqual(row.sales_partners, { name: 'P' });
});
test('snorkel: stock filters at the gateway; requests `mine` sends 1; asset ids are integers', async () => {
  const seen = [];
  const env = { SNORKELOPS: { fetch: async u => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: [{ product: 'VX', part_code: 'A' }, { product: 'MC', part_code: 'B' }, { product: 'vx', part_code: 'C' }] }), { status: 200 }); } } };
  const t = findTool('snorkel_procurement');
  const r = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'stock', product: 'VX' }, NOW).value });
  assert.deepEqual(r.data.result, { rows: [{ product: 'VX', part_code: 'A' }, { product: 'vx', part_code: 'C' }], count: 2 });
  const q = findTool('snorkel_requests').parse({ report: 'requests', mine: true }, NOW).value;
  assert.equal(q.params.mine, '1');
  assert.equal(findTool('snorkel_assets').parse({ report: 'assets', category_id: 'abc' }, NOW).ok, false);
  assert.equal(findTool('snorkel_assets').parse({ report: 'assets', category_id: 4 }, NOW).value.params.category_id, '4');
});

test('snorkel reviews 2026-11-09: receipts, snapshots, free text and uuid *_by ids never leave; names stay', async () => {
  const uid = '11111111-2222-4333-8444-555555555555';
  const data = { id: U, status: 'confirmed', created_by: uid, created_by_name: 'Asha', confirmed_by: uid, cancel_reason: 'call 9820012345', raised_by: 'Ravi',
    payments: [{ amount: '1000', reference: 'UTR123', note: 'acct 1234' }], revisions: [{ revision: 2, snapshot: '{"payment_note":"paid via HDFC 0012"}' }],
    lines: [{ part_code: 'A', qty: '2', details: 'x', rejection_note: 'y' }], tracking_url: 'https://t/1' };
  const env = { SNORKELOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data }), { status: 200 }) } };
  const t = findTool('snorkel_sales');
  const r = await t.run({ env, sbAccess: 'J', gate: { snorkel_perms: SROLE.sales_rep }, input: t.parse({ report: 'order', id: U }, NOW).value });
  assert.deepEqual(r.data.result, { id: U, status: 'confirmed', created_by_name: 'Asha', raised_by: 'Ravi', revisions: [{ revision: 2 }], lines: [{ part_code: 'A', qty: '2' }] });
});
test('snorkel: per-screen gates (vendors, channels, credit notes, balances) refuse before calling the worker', async () => {
  let calls = 0;
  const env = { SNORKELOPS: { fetch: async () => { calls++; return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 }); } } };
  const run = (tool, args, perms) => { const t = findTool(tool); return t.run({ env, sbAccess: 'J', gate: { snorkel_perms: perms }, input: t.parse(args, NOW).value }); };
  assert.deepEqual(await run('snorkel_procurement', { report: 'vendors' }, SROLE.store), { ok: false, reason: 'snorkel denied' });
  assert.deepEqual(await run('snorkel_procurement', { report: 'forwarders' }, SROLE.jarvis_ro), { ok: false, reason: 'snorkel denied' });
  assert.deepEqual(await run('snorkel_sales', { report: 'channels' }, SROLE.store), { ok: false, reason: 'snorkel denied' });
  assert.deepEqual(await run('snorkel_sales', { report: 'credit_notes' }, { sales_order_manage: true }), { ok: false, reason: 'snorkel denied' });
  assert.deepEqual(await run('snorkel_sales', { report: 'party_balances' }, { sales_partner_manage: true }), { ok: false, reason: 'snorkel denied' });
  assert.equal(calls, 0);
  assert.equal((await run('snorkel_procurement', { report: 'vendors' }, { procurement_view: true, vendor_manage: true })).ok, true);
  assert.equal((await run('snorkel_sales', { report: 'credit_notes' }, SROLE.sales_rep)).ok, true);
});
test('snorkel: removed reports are gone; catalogue reads need a filter; vendors_for_product needs po_category', async () => {
  const acts = TOOLS.filter(t => t.system === 'snorkel').flatMap(t => Object.values(t.reports).map(r => r.action));
  for (const a of ['getPendingInward', 'getPOLinesBulk', 'getSalesOrderLinesBulk', 'getSalesCollections']) assert.ok(!acts.includes(a), a);
  const pr = findTool('snorkel_procurement');
  assert.equal(pr.parse({ report: 'materials' }, NOW).ok, false);
  assert.equal(pr.parse({ report: 'vendors_for_product', product: 'VX' }, NOW).ok, false);
  const env = { SNORKELOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: [{ part_code: 'LB-WD-PINE-3', part_name: 'Pine wood', part_category: 'Raw' }, { part_code: 'SC-1', part_name: 'Screw', part_category: 'Hardware' }] }), { status: 200 }) } };
  const r = await pr.run({ env, sbAccess: 'J', gate: { snorkel_perms: SROLE.store }, input: pr.parse({ report: 'materials', q: 'pine' }, NOW).value });
  assert.deepEqual(r.data.result, { rows: [{ part_code: 'LB-WD-PINE-3', part_name: 'Pine wood', part_category: 'Raw' }], count: 1 });
});

// ---- Garage / Redline / Depot (read-only, lotopsproxy), 2026-11-09. Role sets from live store.roles.
const OROLE = {
  viewer: { dashboard: true },
  stock_viewer: { dashboard: true, stock: 'view' },
  store_associate: { dashboard: true, reports: true, returns: 'write', stock: 'view', stock_issue: 'view' },
  gate_ops: { gate_pass: true, users_manage: true },
  admin: { dashboard: true, deviation_propose: true, gate_pass: true, grn: 'write', receiving: 'write', reports: true, returns: 'write', run_request: true, stock: 'write', stock_issue: 'write' },
};
const allowed = (tool, perms) => Object.entries(findTool(tool).reports).filter(([, r]) => r.allow({ ops_perms: perms })).map(([k]) => k).sort();
test('ops: tools need the system grant; reports follow the app screen gates per role', () => {
  assert.deepEqual(toolsFor({ systems: ['garage'], ops_perms: OROLE.admin }).map(t => t.name), ['whoami', 'garage_store']);
  assert.deepEqual(toolsFor({ systems: ['garage', 'redline', 'depot'], ops_perms: {} }).map(t => t.name), ['whoami']);
  assert.deepEqual(allowed('garage_store', OROLE.viewer), ['alerts', 'bom', 'producibility']);
  assert.deepEqual(allowed('garage_store', OROLE.stock_viewer), ['alerts', 'bom', 'producibility', 'stock']);
  assert.deepEqual(allowed('garage_store', OROLE.store_associate), ['alerts', 'bom', 'issue_lines', 'issues', 'producibility', 'return_pools', 'return_shipments', 'returns_summary', 'stock']);
  assert.deepEqual(allowed('garage_store', OROLE.gate_ops), ['gate_passes']);
  assert.deepEqual(allowed('redline_production', OROLE.viewer), ['dashboard', 'repair_queue', 'unit_trace']);
  assert.deepEqual(allowed('depot_dispatch', OROLE.gate_ops), []);
  assert.equal(findTool('depot_dispatch').deny({ ops_perms: OROLE.gate_ops }), 'ops denied');
  assert.equal(findTool('garage_store').deny({ ops_perms: OROLE.gate_ops }), null);
});
test('ops: a report outside the role is refused before calling lotopsproxy', async () => {
  let calls = 0;
  const env = { LOTOPS: { fetch: async () => { calls++; return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 }); } } };
  const t = findTool('garage_store');
  assert.deepEqual(await t.run({ env, sbAccess: 'J', gate: { ops_perms: OROLE.viewer }, input: t.parse({ report: 'grns' }, NOW).value }), { ok: false, reason: 'ops denied' });
  assert.equal(calls, 0);
  assert.equal((await t.run({ env, sbAccess: 'J', gate: { ops_perms: OROLE.admin }, input: t.parse({ report: 'grns' }, NOW).value })).ok, true);
});
test('ops: no admin, export, download, print, cost, address, vendor or PO action is reachable', () => {
  const acts = TOOLS.filter(t => ['garage', 'redline', 'depot'].includes(t.system)).flatMap(t => Object.values(t.reports).map(r => r.action));
  for (const a of acts) assert.doesNotMatch(a, /User|Role|Device|ActivityLog|[dD]ownload|Export|Print|Cost|Address|Vendor|getPOs|Price|Settings|calcKit|AuditProvenance|Url$/, a);
  assert.ok(acts.length >= 35);
});
test('ops: ranges renamed for lotopsproxy; gate-pass PII and free text dropped', async () => {
  const seen = [];
  const env = { LOTOPS: { fetch: async u => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: [{ gate_pass_no: 'GP-1', person_name: 'Raju', person_phone: '9820012345', to_address: 'Plot 4', remarks: 'call me', void_reason: 'x', created_by: '11111111-2222-4333-8444-555555555555', created_by_name: 'Asha' }] }), { status: 200 }); } } };
  const t = findTool('garage_store');
  const r = await t.run({ env, sbAccess: 'J', gate: { ops_perms: OROLE.admin }, input: t.parse({ report: 'gate_passes', from: '2026-11-01', direction: 'outbound' }, NOW).value });
  assert.deepEqual(Object.fromEntries(seen[0].searchParams), { action: 'getGatePasses', direction: 'outbound', date_from: '2026-11-01', date_to: '2026-11-09' });
  assert.deepEqual(r.data.result, [{ gate_pass_no: 'GP-1', person_name: 'Raju', created_by_name: 'Asha' }]);
  const c = findTool('depot_dispatch').parse({ report: 'challans', to: '2026-11-05' }, NOW).value.params;
  assert.deepEqual(c, { from_date: '2026-10-07', to_date: '2026-11-05' });
  assert.equal(findTool('garage_store').parse({ report: 'issues', from: '2026-09-01', to: '2026-11-01' }, NOW).ok, false); // 31-day cap
});

test('ops reviews 2026-11-09: money, vendors, warehouse/ship-to text, descriptions and operator ids never leave', async () => {
  const row = { shipment_no: 'DS-1', status: 'shipped', units: 40, unit_cost: '12.5', po_value: '9000', invoice_value: '1', invoice_number: 'INV-1', payment_terms: '30d', vendor_name: 'V',
    destination_warehouse: 'Plot 4, Bhiwandi 421302', so_ship_city: 'Pune', so_ship_state: 'MH', subtotal: '100', gst_amount: '18', total_amount: '118', current_state: 'packed',
    lines: [{ sku: 'VX-1', qty: 2, rate: '50', amount: '100', description: 'call 98200', total_value: '1' }], material_description: 'x', assigned_to: 'u', operator_id: 'o',
    order_link: { order_no: 'SO-1', collectable_amount: '500' } };
  const env = { LOTOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: [row] }), { status: 200 }) } };
  const t = findTool('depot_dispatch');
  const r = await t.run({ env, sbAccess: 'J', gate: { ops_perms: OROLE.viewer }, input: t.parse({ report: 'shipments' }, NOW).value });
  assert.deepEqual(r.data.result, [{ shipment_no: 'DS-1', status: 'shipped', units: 40, current_state: 'packed', lines: [{ sku: 'VX-1', qty: 2 }], order_link: { order_no: 'SO-1' } }]);
});
test('ops reviews: query syntax cannot ride a text filter; stock needs a filter; PO-data report removed; app hasPermission semantics', () => {
  const d = findTool('depot_dispatch');
  for (const bad of ['draft&limit=1', 'a=b', 'x,y', 'in.(a)', "o'r", 'a%26b', 'a#b'])
    assert.equal(d.parse({ report: 'shipments', status: bad }, NOW).ok, false, bad);
  assert.equal(d.parse({ report: 'shipments', status: 'ready to ship' }, NOW).ok, true);
  assert.equal(d.parse({ report: 'challans', q: 'a,b)' }, NOW).ok, false);
  const g = findTool('garage_store');
  assert.equal(g.parse({ report: 'stock' }, NOW).ok, false);
  assert.ok(!Object.values(g.reports).some(r => r.action === 'getUpcomingShipments'));
  assert.deepEqual(allowed('garage_store', { dashboard: 'view' }), []);            // flag key must be exactly true
  assert.deepEqual(allowed('garage_store', { dashboard: true, stock: 'none' }), ['alerts', 'bom', 'producibility']);
  assert.ok(allowed('garage_store', { stock: 'view' }).includes('stock'));        // level key: any value but 'none'
});

// ---- Docket F9 R2: plan links + docket_plan (2026-11-11)
test('docket plan links: plan_item_id is whitelisted on create/update; null clears; not a bulk or new write', () => {
  const c = findTool('docket_create_task'), u = findTool('docket_update_task');
  assert.deepEqual(c.parse({ title: 'x', plan_item_id: U }, NOW).value, { title: 'x', plan_item_id: U, assign_self: true });
  assert.equal(c.parse({ title: 'x', plan_item_id: 'M01' }, NOW).ok, false);   // ids only, never a code
  assert.deepEqual(u.parse({ id: U, plan_item_id: null }, NOW).value, { id: U, plan_item_id: null });   // clears
  assert.deepEqual(u.parse({ id: U, plan_item_id: U }, NOW).value, { id: U, plan_item_id: U });
  assert.equal(u.parse({ id: U, title: null }, NOW).ok, false);   // null still means "not given" elsewhere → no field
  assert.ok(u.inputSchema.properties.plan_item_id.type.includes('null'));
  assert.equal(findTool('docket_plan').write, undefined);
  assert.equal(findTool('docket_plan').annotations.readOnlyHint, true);
});
test('docket_plan: three reports → getPlan / getPlanItem as the person, ids dropped like task reads', async () => {
  const t = findTool('docket_plan');
  assert.deepEqual(Object.fromEntries(Object.entries(t.reports).map(([k, r]) => [k, r.action])), { themes: 'getPlan', items: 'getPlan', item: 'getPlanItem' });
  assert.equal(t.parse({ report: 'item' }, NOW).ok, false);                  // id required
  assert.equal(t.parse({ report: 'themes', id: U }, NOW).ok, false);         // not a param of themes
  const seen = [];
  const env = { DOCKETOPS: { fetch: async (u, init = {}) => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: {
    items: [{ id: U, kind: 'theme', code: 'T01', title: 'Growth', level: 'T' }, { id: 'm', kind: 'milestone', code: 'M01', title: 'Mine', level: 'O' }],
    item: { id: U }, history: [{ actor_user_id: 'secret-uid', actor_name: 'A' }] } }), { status: 200 }); } } };
  const th = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'themes' }, NOW).value });
  assert.deepEqual(th.data.result.themes.map(x => x.code), ['T01']);
  const it = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'item', id: U }, NOW).value });
  assert.doesNotMatch(JSON.stringify(it.data), /secret-uid/);
  assert.deepEqual(Object.fromEntries(seen[1].searchParams), { action: 'getPlanItem', id: U });
});
