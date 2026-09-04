// Node unit tests for the Shopify customer TAG re-pull (S352).
// Run: node test/shopify-tag-sync.test.js
//
// The behaviour worth protecting here is the WATERMARK, not the paging: every way this can go
// wrong silently is a watermark bug. Advancing past rows a truncated run never read skips them
// for good; advancing to the last row seen on a complete run re-reads a window forever;
// treating an unset or unreadable watermark as "from the beginning" pages all ~92k customers on
// a five-minute cron. Each of those is a test below.
const assert = require('assert');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
async function run() {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ', name); }
    catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
  }
}

const A = require('../src/auth.js');
const SHOP = require('../src/shopify.js');
const realSb = A.sbComms;
const realFetch = SHOP.fetchCustomerPageByQuery;
const realApply = SHOP.applyNodes;

let settingsRow, patched, fetchCalls, applied, pagesToServe;

function stub() {
  settingsRow = { shopify_tag_sync_at: null };
  patched = [];
  fetchCalls = [];
  applied = [];
  pagesToServe = [];
  A.sbComms = async (path, env, opts) => {
    if (path.startsWith('/rest/v1/settings') && (!opts || !opts.method)) {
      return { ok: true, data: [settingsRow] };
    }
    if (path.startsWith('/rest/v1/settings') && opts?.method === 'PATCH') {
      patched.push(JSON.parse(opts.body));
      return { ok: true, data: [] };
    }
    return { ok: true, data: [] };
  };
  SHOP.fetchCustomerPageByQuery = async (env, args) => {
    fetchCalls.push(args);
    return pagesToServe.shift() || { customers: [], hasNext: false, cursor: null };
  };
  SHOP.applyNodes = async (env, nodes) => {
    applied.push(nodes);
    return { profiles: nodes.length, consent: 0, skipped: 0 };
  };
}
function restore() { A.sbComms = realSb; SHOP.fetchCustomerPageByQuery = realFetch; SHOP.applyNodes = realApply; }

const TS = require('../src/shopify-tag-sync.js');
const ENV = { SHOPIFY_STORE_DOMAIN: 'ed7e3f-cf.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec' };
const NOW = Date.parse('2026-09-04T12:00:00Z');
function cust(id, updatedAt) { return { id, updatedAt, email: `${id}@x.com`, tags: ['back-in-stock'] }; }

// ── fail-closed contracts ──
t('does nothing when Shopify is not configured', async () => {
  stub();
  const r = await TS.runTagSync({}, NOW);
  assert.strictEqual(r.skipped, 'shopify_not_configured');
  assert.strictEqual(fetchCalls.length, 0);
  restore();
});

t('a static SHOPIFY_ACCESS_TOKEN counts as configured — the S352 silent-skip regression', async () => {
  // The first cut of runTagSync required CLIENT_ID + CLIENT_SECRET and so skipped EVERY tick on
  // a deployment authenticating with a static access token, while shopifyGraphQL was perfectly
  // happy. The predicate now lives once, in shopify.js. This test exists so the duplicate cannot
  // come back: a quiet skip is invisible, which is what made it cost a deploy to notice.
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() };
  pagesToServe = [{ customers: [cust('c1', '2026-09-04T11:00:00Z')], hasNext: false, cursor: null }];
  const r = await TS.runTagSync(
    { SHOPIFY_STORE_DOMAIN: 'ed7e3f-cf.myshopify.com', SHOPIFY_ACCESS_TOKEN: 'shpat_x' }, NOW);
  assert.notStrictEqual(r.skipped, 'shopify_not_configured');
  assert.strictEqual(r.customers, 1);
  restore();
});

t('a store domain alone is NOT configured', async () => {
  stub();
  const r = await TS.runTagSync({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com' }, NOW);
  assert.strictEqual(r.skipped, 'shopify_not_configured');
  restore();
});

t('FAILS CLOSED when the watermark is unset — never pulls everything', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: null };
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.skipped, 'not_armed');
  assert.strictEqual(fetchCalls.length, 0, 'an unarmed sync must not touch Shopify at all');
  restore();
});

t('FAILS CLOSED when the settings read fails — not treated as never-synced', async () => {
  stub();
  A.sbComms = async () => ({ ok: false, data: null });
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.skipped, 'settings_read_failed');
  assert.strictEqual(fetchCalls.length, 0);
  restore();
});

t('FAILS CLOSED on an unparseable watermark', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: 'not a date' };
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.skipped, 'bad_watermark');
  assert.strictEqual(fetchCalls.length, 0);
  restore();
});

// ── self-gating ──
t('skips when the watermark is younger than the interval', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 10 * 60 * 1000).toISOString() };
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.skipped, 'too_soon');
  assert.strictEqual(fetchCalls.length, 0);
  restore();
});

t('runs once the watermark is older than the interval', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() };
  pagesToServe = [{ customers: [cust('c1', '2026-09-04T11:00:00Z')], hasNext: false, cursor: null }];
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.customers, 1);
  assert.strictEqual(fetchCalls.length, 1);
  restore();
});

// ── the query ──
t('queries updated_at from the watermark MINUS the overlap', async () => {
  stub();
  const wm = new Date(NOW - 2 * 60 * 60 * 1000);
  settingsRow = { shopify_tag_sync_at: wm.toISOString() };
  pagesToServe = [{ customers: [], hasNext: false, cursor: null }];
  await TS.runTagSync(ENV, NOW);
  const expected = new Date(wm.getTime() - TS.OVERLAP_MS).toISOString();
  assert.strictEqual(fetchCalls[0].query, `updated_at:>='${expected}'`,
    'the overlap exists so a row updated mid-run cannot fall into the gap');
  restore();
});

// ── watermark advance: the failure modes that are silent ──
t('a COMPLETE run advances to the run START, not the last row seen', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() };
  pagesToServe = [{ customers: [cust('c1', '2026-09-04T09:00:00Z')], hasNext: false, cursor: null }];
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.advanced_to, new Date(NOW).toISOString());
  assert.strictEqual(patched[0].shopify_tag_sync_at, new Date(NOW).toISOString(),
    'advancing to the last row instead would re-read that window on every future run');
  restore();
});

t('a TRUNCATED run advances only to the last row it actually applied', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 5 * 60 * 60 * 1000).toISOString() };
  // Serve more pages than MAX_PAGES so the loop stops with hasNext still true.
  for (let i = 0; i < TS.MAX_PAGES + 5; i++) {
    pagesToServe.push({
      customers: [cust(`c${i}`, new Date(Date.parse('2026-09-04T06:00:00Z') + i * 60000).toISOString())],
      hasNext: true, cursor: `cur-${i}`,
    });
  }
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.pages, TS.MAX_PAGES, 'the page cap must bound one run');
  const lastSeen = new Date(Date.parse('2026-09-04T06:00:00Z') + (TS.MAX_PAGES - 1) * 60000).toISOString();
  assert.strictEqual(r.advanced_to, lastSeen);
  assert.notStrictEqual(r.advanced_to, new Date(NOW).toISOString(),
    'advancing past unread rows would skip them permanently');
  restore();
});

t('a truncated run that applied NOTHING does not advance at all', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 5 * 60 * 60 * 1000).toISOString() };
  for (let i = 0; i < TS.MAX_PAGES + 2; i++) {
    pagesToServe.push({ customers: [], hasNext: true, cursor: `cur-${i}` });
  }
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.advanced_to, null);
  assert.strictEqual(patched.length, 0, 'no write at all — the unread remainder must stay in range');
  restore();
});

// ── paging ──
t('follows the cursor across pages and applies every one', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() };
  pagesToServe = [
    { customers: [cust('a', '2026-09-04T09:00:00Z')], hasNext: true, cursor: 'cur-1' },
    { customers: [cust('b', '2026-09-04T09:30:00Z')], hasNext: true, cursor: 'cur-2' },
    { customers: [cust('c', '2026-09-04T09:45:00Z')], hasNext: false, cursor: null },
  ];
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.pages, 3);
  assert.strictEqual(r.customers, 3);
  assert.strictEqual(fetchCalls[1].after, 'cur-1');
  assert.strictEqual(fetchCalls[2].after, 'cur-2');
  assert.strictEqual(applied.length, 3);
  restore();
});

t('stops when a page returns no cursor, even if hasNext lies', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() };
  pagesToServe = [{ customers: [cust('a', '2026-09-04T09:00:00Z')], hasNext: true, cursor: null }];
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.pages, 1, 'a null cursor with hasNext:true would otherwise loop on page 1');
  restore();
});

t('an empty result set is a clean complete run', async () => {
  stub();
  settingsRow = { shopify_tag_sync_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() };
  pagesToServe = [{ customers: [], hasNext: false, cursor: null }];
  const r = await TS.runTagSync(ENV, NOW);
  assert.strictEqual(r.customers, 0);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.advanced_to, new Date(NOW).toISOString());
  restore();
});

// ── the shared path used by the manual pull ──
t('syncByQuery passes an arbitrary query through untouched', async () => {
  stub();
  pagesToServe = [{ customers: [cust('a', '2026-09-04T09:00:00Z')], hasNext: false, cursor: null }];
  const r = await TS.syncByQuery(ENV, { query: 'tag:back-in-stock' });
  assert.strictEqual(fetchCalls[0].query, 'tag:back-in-stock');
  assert.strictEqual(r.customers, 1);
  assert.strictEqual(r.truncated, false);
  restore();
});

t('syncByQuery honours a caller page cap', async () => {
  stub();
  for (let i = 0; i < 10; i++) pagesToServe.push({ customers: [cust(`c${i}`, '2026-09-04T09:00:00Z')], hasNext: true, cursor: `c-${i}` });
  const r = await TS.syncByQuery(ENV, { query: 'tag:x', maxPages: 3 });
  assert.strictEqual(r.pages, 3);
  assert.strictEqual(r.truncated, true);
  restore();
});

t('updatedSinceQuery renders Shopify search grammar', () => {
  assert.strictEqual(TS.updatedSinceQuery('2026-09-04T10:00:00.000Z'),
    "updated_at:>='2026-09-04T10:00:00.000Z'");
});

run().then(() => {
  restore();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
