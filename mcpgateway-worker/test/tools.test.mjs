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
    docket_revise_deadline: { id: U, new_deadline: '2026-11-20', reason: 'r' }, docket_add_comment: { id: U, body: 'b' }, docket_abandon_task: { id: U, reason: 'r' } };
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
