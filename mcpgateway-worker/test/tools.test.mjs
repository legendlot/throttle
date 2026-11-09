import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, toolsFor, findTool } from '../src/tools/index.js';
import { parseReportArgs, T } from '../src/tools/build.js';
import { capPayload, getAs } from '../src/workers.js';

const NOW = Date.parse('2026-11-09T12:00:00Z'); // 17:30 IST
const view = { systems: ['odo'], odo_perms: { sales_view: true } };
const sup = { systems: ['odo'], odo_perms: { sales_view: true, salesops_super_admin: true } };

test('every tool parse() returns { ok, value } on success (the shape the core passes to run)', () => {
  const ok = { whoami: {}, odo_sales_summary: { from: '2026-11-01' }, odo_sales: { report: 'breakdown' }, odo_marketing: { report: 'spend' }, odo_dyno: { report: 'angles' },
    odo_funnel: { report: 'history' }, odo_amazon: { report: 'geo' }, odo_inventory: { report: 'thresholds' }, odo_pnl: { report: 'product_costs' }, odo_lookup: { report: 'channels' } };
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
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} must be read-only`);
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
