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
    docket_plan: { report: 'themes' }, docket_propose: { title: 'x', why: 'y' }, docket_founder_focus: { items: [] }, docket_accept_handoff: { id: U }, docket_apply_template: { id: U, anchor_id: U, anchor_date: '2026-11-20', roles: { Owner: U } },
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
  assert.deepEqual(writes, ['docket_abandon_task', 'docket_accept_handoff', 'docket_add_comment', 'docket_apply_template', 'docket_create_task', 'docket_founder_focus', 'docket_propose', 'docket_revise_deadline', 'docket_set_status', 'docket_update_task']);
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
test('the write actions are exactly these ten; reads drop LOT user ids', async () => {
  assert.deepEqual(Object.fromEntries(TOOLS.filter(t => t.write).map(t => [t.name, t.action])), {
    docket_create_task: 'createTask', docket_update_task: 'updateTask', docket_set_status: 'changeStatus',
    docket_revise_deadline: 'reviseDeadline', docket_add_comment: 'addComment', docket_abandon_task: 'abandonTask',
    docket_propose: 'proposePlanItem', docket_founder_focus: 'setFounderFocus', docket_accept_handoff: 'acceptHandoff',
    docket_apply_template: 'applyTemplate' });
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
test('F9 R4: docket_tasks takes a week filter (this/next/overdue/none/a date) and forwards it as is', async () => {
  const rd = findTool('docket_tasks');
  for (const w of ['this', 'next', 'overdue', 'none', '2026-11-18']) {
    const seen = []; const p = rd.parse({ report: 'space_tasks', week: w }, NOW);
    assert.equal(p.ok, true, w);
    await rd.run({ env: docketEnv(seen), sbAccess: 'J', input: p.value });
    assert.equal(seen[0].u.searchParams.get('week'), w);
  }
  for (const bad of ['last', '2026-02-30', "this'", 'x'.repeat(11)]) assert.equal(rd.parse({ report: 'my_tasks', week: bad }, NOW).ok, false, bad);
  assert.equal(rd.parse({ report: 'program_tasks', program_id: U, week: 'this' }, NOW).ok, false);   // not on program_tasks
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
test('docket_plan: its reports → getPlan / getPlanItem / getProposals / getWeekScore / getReviewPack / getFoundersReview as the person', async () => {
  const t = findTool('docket_plan');
  assert.deepEqual(Object.fromEntries(Object.entries(t.reports).map(([k, r]) => [k, r.action])), { themes: 'getPlan', items: 'getPlan', item: 'getPlanItem', proposals: 'getProposals', score: 'getWeekScore',
    review: 'getReviewPack', founders: 'getFoundersReview', templates: 'getTemplates', template: 'getTemplate',
    reached: 'getReachedTargets', trend: 'getScoreTrend', replan: 'getReplan' });
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

// ---- Docket plan R3, 2026-11-12: proposals
test('docket_propose: title + why required and bounded; kind milestone|risk; a single POST as the person', async () => {
  const t = findTool('docket_propose');
  assert.equal(t.annotations.readOnlyHint, false);
  assert.match(t.description, /nothing on the plan changes until a founder accepts/);
  assert.deepEqual(t.parse({ title: ' Ship ', why: ' because ', kind_hint: 'risk', suggested_theme_id: U, suggested_date: '2026-12-01' }, NOW).value,
    { title: 'Ship', why: 'because', kind_hint: 'risk', suggested_theme_id: U, suggested_date: '2026-12-01' });
  for (const bad of [{ title: 'x' }, { why: 'y' }, { title: 'x'.repeat(201), why: 'y' }, { title: 'x', why: 'y'.repeat(2001) }, { title: 'x', why: 'y', kind_hint: 'task' },
    { title: 'x', why: 'y', suggested_theme_id: 'T01' }, { title: 'x', why: 'y', suggested_date: '2026-02-30' }, { title: 'x', why: 'y', status: 'accepted' },
    { title: 'x', why: 'y', suggested_owner_employee_id: U }])
    assert.equal(t.parse(bad, NOW).ok, false, JSON.stringify(bad));
  const seen = [];
  const r = await t.run({ env: docketEnv(seen), sbAccess: 'JWT', input: t.parse({ title: 'x', why: 'y' }, NOW).value });
  assert.equal(r.ok, true); assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].init.body), { action: 'proposePlanItem', data: { title: 'x', why: 'y' } });
});
test('docket_plan report=proposals reads getProposals and drops LOT user ids', async () => {
  const rd = findTool('docket_plan');
  const p = rd.parse({ report: 'proposals' }, NOW);
  assert.equal(p.ok, true);
  const seen = [];
  const env = { DOCKETOPS: { fetch: async (u, init = {}) => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: { proposals: [{ id: U, title: 'x', status: 'submitted', actor_user_id: 'uid-1', proposer_user_id: 'uid-2', decided_by: 'uid-3' }], can_admin: false } }), { status: 200 }); } } };
  const r = await rd.run({ env, sbAccess: 'J', input: p.value });
  assert.equal(seen[0].searchParams.get('action'), 'getProposals');
  assert.deepEqual(r.data.result, { proposals: [{ id: U, title: 'x', status: 'submitted' }] });
});

// ---- Docket plan R5, 2026-11-12: the score
test('docket_plan report=score: week this|last|date only, read as the person, user ids dropped', async () => {
  const rd = findTool('docket_plan');
  for (const ok of [{}, { week: 'this' }, { week: 'last' }, { week: '2026-11-15' }])
    assert.equal(rd.parse({ report: 'score', ...ok }, NOW).ok, true, JSON.stringify(ok));
  for (const bad of [{ week: 'next' }, { week: 'overdue' }, { week: '2026-02-30' }, { week: 'x'.repeat(11) }])
    assert.equal(rd.parse({ report: 'score', ...bad }, NOW).ok, false, JSON.stringify(bad));
  assert.equal(rd.parse({ report: 'themes', week: 'this' }, NOW).ok, false);   // week belongs to score only
  const seen = [];
  const env = { DOCKETOPS: { fetch: async (u) => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: {
    week_end: '2026-11-15', final: false, totals: { cohort: 1 }, tasks: [{ task_id: U, task_no: 'DKT-1', actor_user_id: 'uid-9' }] } }), { status: 200 }); } } };
  const r = await rd.run({ env, sbAccess: 'J', input: rd.parse({ report: 'score', week: 'last' }, NOW).value });
  assert.deepEqual(Object.fromEntries(seen[0].searchParams), { action: 'getWeekScore', week: 'last' });
  assert.equal(r.data.result.week_end, '2026-11-15');
  assert.doesNotMatch(JSON.stringify(r.data), /uid-9/);
});
test('docket_update_task: a first deadline is refused when the task already has only a revised one', async () => {
  const u = findTool('docket_update_task');
  const envFor = (task, seen) => ({ DOCKETOPS: { fetch: async (url, init = {}) => { seen.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ ok: true, data: init.method === 'POST' ? { id: U } : task }), { status: 200 }); } } });
  const seen = [];
  const r = await u.run({ env: envFor({ id: U, status: 'in_progress', deadline: null, revised_deadline: '2026-11-13T12:30:00Z' }, seen), sbAccess: 'J',
    input: u.parse({ id: U, deadline: '2026-11-20' }, NOW).value });
  assert.equal(r.ok, false); assert.match(r.userError, /already has a deadline/);
  assert.equal(seen.filter(x => x.init.method === 'POST').length, 0);
  const seen2 = [];
  const r2 = await u.run({ env: envFor({ id: U, status: 'in_progress', deadline: null, revised_deadline: null }, seen2), sbAccess: 'J',
    input: u.parse({ id: U, deadline: '2026-11-20' }, NOW).value });
  assert.equal(r2.ok, true, JSON.stringify(r2));
});

// ---- Docket plan R6a/R6b, 2026-11-12: the review pack, the founders' catch-up, the top 5
test('docket_plan report=review: week + team (a uuid or all) forwarded as is; report=founders: week only; founder ids dropped', async () => {
  const rd = findTool('docket_plan');
  const seen = [];
  const env = { DOCKETOPS: { fetch: async (u) => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: {
    week: { week_end: '2026-11-15' }, focus: [{ founder_user_id: 'uid-7', founder_name: 'F', is_me: true, items: [] }] } }), { status: 200 }); } } };
  for (const team of ['all', U]) {
    const p = rd.parse({ report: 'review', week: 'last', team }, NOW);
    assert.equal(p.ok, true, team);
    await rd.run({ env, sbAccess: 'J', input: p.value });
  }
  assert.deepEqual(Object.fromEntries(seen[0].searchParams), { action: 'getReviewPack', week: 'last', team: 'all' });
  assert.equal(seen[1].searchParams.get('team'), U);
  for (const bad of [{ team: 'Sales' }, { week: 'next' }]) assert.equal(rd.parse({ report: 'review', ...bad }, NOW).ok, false, JSON.stringify(bad));
  assert.equal(rd.parse({ report: 'founders', team: 'all' }, NOW).ok, false);   // team is review's only
  const f = await rd.run({ env, sbAccess: 'J', input: rd.parse({ report: 'founders', week: '2026-11-14' }, NOW).value });
  assert.deepEqual(Object.fromEntries(seen[2].searchParams), { action: 'getFoundersReview', week: '2026-11-14' });
  assert.doesNotMatch(JSON.stringify(f.data), /uid-7/);
  assert.match(JSON.stringify(f.data), /"is_me":true/);
});
test('docket_founder_focus: one POST {action:setFounderFocus, data:{week, items}}; items shaped, ≤5, ranks 1–5', async () => {
  const t = findTool('docket_founder_focus');
  assert.equal(t.write, true); assert.equal(t.annotations.readOnlyHint, false);
  assert.match(t.description, /REPLACES your whole top 5/);
  const p = t.parse({ week: 'next', items: [{ rank: 1, plan_item_id: U, note: 'why' }, { rank: 2, task_id: U }, { rank: 3, note: 'call X', task_id: '' }] }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.value, { week: 'next', items: [{ rank: 1, plan_item_id: U, note: 'why' }, { rank: 2, task_id: U }, { rank: 3, note: 'call X' }] });
  assert.deepEqual(t.parse({ items: [] }, NOW).value, { items: [] });   // clears
  for (const bad of [{}, { items: 'x' }, { items: [{ rank: 1 }, { rank: 2 }, { rank: 3 }, { rank: 4 }, { rank: 5 }, { rank: 5 }] },
    { items: [{ rank: 0, note: 'x' }] }, { items: [{ rank: '1', note: 'x' }] }, { items: [{ rank: 1, plan_item_id: 'M01' }] },
    { items: [{ rank: 1, note: 'x'.repeat(501) }] }, { items: [{ rank: 1, owner: U }] }, { week: 'last', items: [] }, { items: [], extra: 1 }])
    assert.equal(t.parse(bad, NOW).ok, false, JSON.stringify(bad));
  const seen = [];
  const r = await t.run({ env: docketEnv(seen), sbAccess: 'JWT', input: p.value });
  assert.equal(r.ok, true); assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['X-LOT-Source'], 'connector');
  assert.deepEqual(JSON.parse(seen[0].init.body), { action: 'setFounderFocus', data: p.value });
});

test('docket_founder_focus: the write result never carries founder_user_id (DOCKET_DROP on writes too)', async () => {
  const t = findTool('docket_founder_focus');
  const env = { DOCKETOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: { focus: {
    founder_user_id: 'uid-7', founder_name: 'A', is_me: true, items: [{ rank: 1, note: 'x' }] } } }), { status: 200 }) } };
  const r = await t.run({ env, sbAccess: 'JWT', input: { items: [{ rank: 1, note: 'x' }] } });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r.data).includes('uid-7'), JSON.stringify(r.data));
  assert.ok(JSON.stringify(r.data).includes('founder_name'));
});

// ---- Docket R8, 2026-11-12: hand-offs
test('docket hand-off fields on create/update: uuid or null (clears), never the acceptance', async () => {
  const c = findTool('docket_create_task'), u = findTool('docket_update_task');
  assert.deepEqual(c.parse({ title: 'x', handoff_to_department_id: U, handoff_to_employee_id: U }, NOW).value,
    { title: 'x', handoff_to_department_id: U, handoff_to_employee_id: U, assign_self: true });
  assert.deepEqual(u.parse({ id: U, handoff_to_department_id: null }, NOW).value, { id: U, handoff_to_department_id: null });
  assert.deepEqual(u.parse({ id: U, handoff_to_employee_id: U }, NOW).value, { id: U, handoff_to_employee_id: U });
  for (const bad of [{ id: U, handoff_to_department_id: 'Sales' }, { id: U, handoff_accepted_at: '2026-11-12T00:00:00Z' },
    { id: U, handoff_accepted_by: U }]) assert.equal(u.parse(bad, NOW).ok, false, JSON.stringify(bad));
  assert.equal(c.parse({ title: 'x', handoff_accepted_at: 'now' }, NOW).ok, false);
  const seen = [];
  const env = { DOCKETOPS: { fetch: async (url, init = {}) => { seen.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ ok: true, data: init.method === 'POST' ? { id: U } : { id: U, status: 'in_progress' } }), { status: 200 }); } } };
  await u.run({ env, sbAccess: 'J', input: u.parse({ id: U, handoff_to_department_id: null }, NOW).value });
  const post = seen.find(x => x.init.method === 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { action: 'updateTask', data: { id: U, handoff_to_department_id: null } });
});
test('docket_accept_handoff: id only, one POST as the person; refusals surface plainly', async () => {
  const t = findTool('docket_accept_handoff');
  assert.equal(t.write, true); assert.equal(t.annotations.readOnlyHint, false); assert.equal(t.annotations.destructiveHint, false);
  assert.equal(t.parse({}, NOW).ok, false);
  assert.equal(t.parse({ id: U, handoff_to_employee_id: U }, NOW).ok, false);   // nothing but the id
  const seen = [];
  const r = await t.run({ env: docketEnv(seen), sbAccess: 'JWT', input: t.parse({ id: U }, NOW).value });
  assert.equal(r.ok, true); assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].init.body), { action: 'acceptHandoff', data: { id: U } });
  const env = (status, body) => ({ DOCKETOPS: { fetch: async () => new Response(JSON.stringify(body), { status }) } });
  assert.deepEqual(await t.run({ env: env(409, { ok: false, error: 'handoff_closed' }), sbAccess: 'J', input: { id: U } }), { ok: false, userError: 'handoff_closed' });
  assert.deepEqual(await t.run({ env: env(403, { ok: false, error: 'not_receiver' }), sbAccess: 'J', input: { id: U } }), { ok: false, reason: 'docket denied' });
});
test('docket_tasks report=incoming → getIncoming with scope me|team|all; handoff_accepted_by dropped, names kept', async () => {
  const rd = findTool('docket_tasks');
  assert.equal(rd.reports.incoming.action, 'getIncoming');
  for (const scope of ['me', 'team', 'all']) assert.equal(rd.parse({ report: 'incoming', scope }, NOW).ok, true, scope);
  assert.equal(rd.parse({ report: 'incoming', scope: 'everyone' }, NOW).ok, false);
  const seen = [];
  const env = { DOCKETOPS: { fetch: async (u) => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: {
    tasks: [{ id: U, title: 'x', handoff_accepted_by: 'uid-acc', handoff_accepted_by_name: 'Acc', giver_name: 'G' }], counts: { me: 1, team: 0, unaccepted: 0 } } }), { status: 200 }); } } };
  const r = await rd.run({ env, sbAccess: 'J', input: rd.parse({ report: 'incoming', scope: 'me' }, NOW).value });
  assert.deepEqual(Object.fromEntries(seen[0].searchParams), { action: 'getIncoming', scope: 'me' });
  assert.doesNotMatch(JSON.stringify(r.data), /uid-acc/);
  assert.match(JSON.stringify(r.data), /"handoff_accepted_by_name":"Acc"/);
});

// ---- Docket R9a, 2026-11-12: plan templates
test('docket_plan report=templates / template → getTemplates / getTemplate as the person; created_by dropped, names kept', async () => {
  const t = findTool('docket_plan');
  assert.equal(t.parse({ report: 'template' }, NOW).ok, false);                  // id required
  assert.equal(t.parse({ report: 'template', id: 'x' }, NOW).ok, false);
  assert.equal(t.parse({ report: 'templates', id: U }, NOW).ok, false);           // templates takes nothing
  const seen = [];
  const env = { DOCKETOPS: { fetch: async (u) => { seen.push(new URL(u)); return new Response(JSON.stringify({ ok: true, data: {
    template: { id: U, name: 'ZZ', created_by: 'uid-secret', created_by_name: 'ZZ Maker', roles: ['Owner'] }, nodes: [{ id: U, kind: 'task', title: 'x' }],
    templates: [{ id: U, created_by: 'uid-secret', created_by_name: 'ZZ Maker' }] } }), { status: 200 }); } } };
  const one = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'template', id: U }, NOW).value });
  assert.deepEqual(Object.fromEntries(seen[0].searchParams), { action: 'getTemplate', id: U });
  assert.doesNotMatch(JSON.stringify(one.data), /uid-secret/); assert.match(JSON.stringify(one.data), /ZZ Maker/);
  await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'templates' }, NOW).value });
  assert.deepEqual(Object.fromEntries(seen[1].searchParams), { action: 'getTemplates' });
});
test('docket_apply_template: id + anchor + date + roles (label → employee uuid), one POST as the person; refusals plain', async () => {
  const t = findTool('docket_apply_template');
  assert.equal(t.write, true); assert.equal(t.annotations.readOnlyHint, false); assert.equal(t.annotations.destructiveHint, false);
  assert.deepEqual(t.inputSchema.required, ['id', 'anchor_id', 'anchor_date', 'roles']);
  const good = { id: U, anchor_id: U, anchor_date: '2026-11-20', roles: { Owner: U, 'Helper ': U } };
  assert.deepEqual(t.parse(good, NOW).value, good);
  for (const bad of [{ ...good, anchor_date: '2026-02-30' }, { ...good, roles: [] }, { ...good, roles: {} }, { ...good, roles: { Owner: 'Asha' } },
    { ...good, roles: { [' ']: U } }, { ...good, roles: { ['x'.repeat(41)]: U } }, { ...good, anchor_id: 'M01' }, { ...good, nodes: [] }])
    assert.equal(t.parse(bad, NOW).ok, false, JSON.stringify(bad));
  // roles cap = the template's 200-step cap (every step can carry its own role)
  const many = (n) => ({ ...good, roles: Object.fromEntries(Array.from({ length: n }, (_, i) => [`R${i}`, U])) });
  assert.equal(t.parse(many(200), NOW).ok, true); assert.equal(t.parse(many(201), NOW).ok, false);
  assert.equal(t.inputSchema.properties.roles.maxProperties, 200);
  const seen = [];
  const r = await t.run({ env: docketEnv(seen), sbAccess: 'JWT', input: t.parse(good, NOW).value });
  assert.equal(r.ok, true); assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].init.body), { action: 'applyTemplate', data: good });
  const env = (status, body) => ({ DOCKETOPS: { fetch: async () => new Response(JSON.stringify(body), { status }) } });
  const refused = await t.run({ env: env(400, { ok: false, error: 'owner_inactive', message: 'That person has left', label: 'Owner' }), sbAccess: 'J', input: good });
  assert.equal(refused.ok, false);
});

// ---- Docket F9 R9b (2026-11-12): measure readings, the reached queue, the score trend, the re-plan (its Programs retirement reverted 2026-11-13)
test('R9b: docket_plan report=reached / trend / replan → getReachedTargets / getScoreTrend / getReplan as the person; params checked', async () => {
  const t = findTool('docket_plan');
  const seen = [];
  for (const [input, want] of [
    [{ report: 'reached' }, { action: 'getReachedTargets' }],
    [{ report: 'trend' }, { action: 'getScoreTrend' }],
    [{ report: 'trend', weeks: 12, team: 'all' }, { action: 'getScoreTrend', weeks: '12', team: 'all' }],
    [{ report: 'trend', team: U }, { action: 'getScoreTrend', team: U }],
    [{ report: 'replan' }, { action: 'getReplan' }],
    [{ report: 'replan', month: '2026-12' }, { action: 'getReplan', month: '2026-12' }],
  ]) {
    const p = t.parse(input, NOW);
    assert.equal(p.ok, true, JSON.stringify(input));
    await t.run({ env: docketEnv(seen), sbAccess: 'J', input: p.value });
    assert.deepEqual(Object.fromEntries(seen.at(-1).u.searchParams), want);
    assert.equal(seen.at(-1).init.method, undefined);
  }
  for (const bad of [{ report: 'trend', weeks: 0 }, { report: 'trend', weeks: 27 }, { report: 'trend', team: 'Sales' }, { report: 'replan', month: '2026-13' },
    { report: 'replan', month: '2026-12-01' }, { report: 'replan', month: "2026-1'" }, { report: 'reached', month: '2026-12' }, { report: 'trend', month: '2026-12' }])
    assert.equal(t.parse(bad, NOW).ok, false, JSON.stringify(bad));
});
test('R9b: items keep measure.reading (Docket attaches it at the levels that see the measure)', async () => {
  const t = findTool('docket_plan');
  const reading = { value: 98.4, window_from: '2026-10-13', window_to: '2026-11-11', checked_at: '2026-11-12T00:30:01Z', reached: true, target_parsed: true };
  const env = { DOCKETOPS: { fetch: async () => new Response(JSON.stringify({ ok: true, data: { items: [{ id: U, kind: 'milestone', level: 'O',
    measure: { system: 'redline', metric: 'redline.first_pass_yield', target: '≥ 98%', source_ok: true, reading } }] } }), { status: 200 }) } };
  const r = await t.run({ env, sbAccess: 'J', input: t.parse({ report: 'items' }, NOW).value });
  assert.deepEqual(r.data.result.items[0].measure.reading, reading);
});
test('Programs (restored 2026-11-13): program filter, program_tasks / programs reports and the program field on create / update', async () => {
  const rd = findTool('docket_tasks');
  assert.equal(rd.reports.program_tasks.action, 'getProgramTasks'); assert.equal(rd.reports.programs.action, 'getPrograms');
  for (const report of ['my_tasks', 'space_tasks']) assert.equal(rd.parse({ report, program_id: U }, NOW).ok, true, report);
  assert.equal(rd.parse({ report: 'my_tasks', program_id: 'x' }, NOW).ok, false);
  assert.equal(rd.parse({ report: 'program_tasks' }, NOW).ok, false);            // program_id required
  const seen = [];
  await rd.run({ env: docketEnv(seen), sbAccess: 'J', input: rd.parse({ report: 'program_tasks', program_id: U }, NOW).value });
  assert.deepEqual(Object.fromEntries(seen.at(-1).u.searchParams), { action: 'getProgramTasks', program_id: U });
  assert.equal(findTool('docket_create_task').parse({ title: 'x', program_id: U }, NOW).ok, true);
  assert.equal(findTool('docket_update_task').parse({ id: U, program_id: U }, NOW).ok, true);
  assert.equal(findTool('docket_update_task').parse({ id: U, program_id: 'nope' }, NOW).ok, false);
  // alongside, never instead of, the plan link
  assert.equal(findTool('docket_create_task').parse({ title: 'x', program_id: U, plan_item_id: U }, NOW).ok, true);
  assert.match(rd.reports.programs.about, /company-wide/);
});
test('docket_update_task: program_id null removes the program — the explicit null reaches docketops', async () => {
  const u = findTool('docket_update_task');
  const p = u.parse({ id: U, program_id: null }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.value, { id: U, program_id: null });
  assert.ok(u.inputSchema.properties.program_id.type.includes('null'));
  const seen = [];
  await u.run({ env: docketEnv(seen), sbAccess: 'J', input: p.value });
  const post = seen.find(x => x.init.method === 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { action: 'updateTask', data: { id: U, program_id: null } });
});

// ---- 2026-11-13: Mohit's 57-call loop (one breakdown per product per month). One call now answers it.
import { breakdownWorkerParams } from '../src/tools/odo.js';
test('breakdown variant_channel: one call, each product split by channel, products filter applied', async () => {
  const rows = [];
  const ch = [['c1', 'Amazon - FBA'], ['c2', 'Website']];
  for (let d = 1; d <= 3; d++) for (const [id, name] of ch) for (const pc of ['COBA', 'HCBA', 'GSRD']) {
    rows.push({ grp_key: id, grp_label: name, sale_date: `2026-10-0${d}`, channel_id: id, product_code: pc, units: '2', gross_value: '50', discount_value: 0, tax_value: 0, returned_units: 0, returned_value: 0 });
  }
  let asked;
  const env = { ODOOPS: { fetch: async u => { asked = new URL(u).searchParams; return new Response(JSON.stringify({ ok: true, data: { rows } }), { status: 200 }); } } };
  const t = findTool('odo_sales');
  const parsed = t.parse({ report: 'breakdown', from: '2026-10-01', to: '2026-10-31', group: 'variant_channel', products: ['COBA', 'HCBA'] }, NOW);
  assert.ok(parsed.ok, parsed.error);
  const r = await t.run({ env, sbAccess: 'J', input: parsed.value });
  assert.equal(asked.get('group'), 'channel');          // the worker is asked for channel rows
  assert.equal(asked.get('products'), null);            // never forwarded: the worker has no such filter
  assert.equal(asked.get('product_code'), null);        // two products: no single-product filter
  assert.equal(r.data.result.groups, 4);                 // 2 products x 2 channels
  const coAmz = r.data.result.rows.find(x => x.product_code === 'COBA' && x.channel === 'Amazon - FBA');
  assert.deepEqual([coAmz.units, coAmz.gross_value, coAmz.channel_id], [6, 150, 'c1']);
  assert.ok(!r.data.result.rows.some(x => x.product_code === 'GSRD'));
  assert.equal(r.data.params.group, 'variant_channel');  // what Claude asked for is echoed back
});
test('breakdown: products filter on the default grouping; one product uses the worker filter', () => {
  assert.deepEqual(breakdownWorkerParams({ from: 'a', to: 'b', products: 'COBA' }), { from: 'a', to: 'b', product_code: 'COBA' });
  assert.deepEqual(breakdownWorkerParams({ group: 'variant_channel', products: 'A,B' }), { group: 'channel' });
  assert.deepEqual(breakdownWorkerParams({ products: 'coba' }), { product_code: 'COBA' });
  const both = findTool('odo_sales').parse({ report: 'breakdown', product_code: 'X', products: ['Y'] }, NOW);
  assert.equal(both.ok, false); assert.match(both.error, /either `product_code` or `products`/);
  assert.equal(groupSalesRows({ rows: [{ grp_key: 'COBA', product_code: 'COBA', units: 1 }] }, { products: 'coba' }).groups, 1);
  const g = groupSalesRows({ rows: [{ grp_key: 'COBA', grp_label: 'Cobra', product_code: 'COBA', units: 1, gross_value: 9 }, { grp_key: 'HCBA', grp_label: 'H', product_code: 'HCBA', units: 1, gross_value: 9 }] }, { products: 'COBA' });
  assert.deepEqual(g.rows.map(x => x.key), ['COBA']);
  assert.equal(groupSalesRows({ rows: [{ grp_key: 'V', units: 1 }] }).groups, 1); // old call shape still works
});
