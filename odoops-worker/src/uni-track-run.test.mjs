import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrackingPages, trackingWindow, UNI_TRACK_RUN_BUDGET, isUntrackedChannel, dedupePackageRows } from './uni-track-run.mjs';

const page = (o = {}) => ({ window: ['a', 'b'], seen: 25, candidates: 20, fetched: 10, packages: 9,
  windowDone: false, caughtUp: false, cursor: 'c', ...o });

test('drains pages until the page fn reports caught up, and sums the counters', async () => {
  const script = [page(), page(), page({ seen: 3, fetched: 1, packages: 1, windowDone: true, caughtUp: true, cursor: 'z' })];
  let calls = 0;
  const r = await runTrackingPages(async () => script[calls++]);
  assert.equal(calls, 3);
  assert.equal(r.pages, 3);
  assert.equal(r.seen, 53);
  assert.equal(r.fetched, 21);
  assert.equal(r.packages, 19);
  assert.equal(r.stopped, 'caught_up');
  assert.equal(r.cursor, 'z');
});

test('a skipped (already caught up) first page ends the run with zero pages', async () => {
  let calls = 0;
  const r = await runTrackingPages(async () => { calls++; return { skipped: 'caught_up' }; });
  assert.equal(calls, 1);
  assert.equal(r.pages, 0);
  assert.equal(r.stopped, 'caught_up');
});

test('stops at the page budget — a finished window is NOT the same as caught up', async () => {
  let calls = 0;
  const r = await runTrackingPages(async () => { calls++; return page({ windowDone: true }); },
    { maxPages: 4, maxGets: 1e9, maxMs: 1e9 });
  assert.equal(calls, 4);
  assert.equal(r.stopped, 'max_pages');
});

test('stops at the get budget (the real Uniware cost)', async () => {
  let calls = 0;
  const r = await runTrackingPages(async () => { calls++; return page({ fetched: 25 }); },
    { maxPages: 1e9, maxGets: 60, maxMs: 1e9 });
  assert.equal(calls, 3);            // 25, 50, 75 ≥ 60 → no 4th page
  assert.equal(r.stopped, 'max_gets');
});

test('stops at the wall-clock budget', async () => {
  let t = 0, calls = 0;
  const r = await runTrackingPages(async () => { calls++; t += 100; return page(); },
    { maxPages: 1e9, maxGets: 1e9, maxMs: 250 }, () => t);
  assert.equal(calls, 3);            // 100, 200, 300 ≥ 250
  assert.equal(r.stopped, 'max_ms');
});

test('a page that throws propagates, carrying the progress already made', async () => {
  let calls = 0;
  await assert.rejects(
    runTrackingPages(async () => { if (++calls === 3) throw new Error('uniware 429'); return page(); }),
    (e) => e.message === 'uniware 429' && e.partial.pages === 2 && e.partial.seen === 50,
  );
});

test('a partial budget keeps the default guards (a missing key must not mean unlimited)', async () => {
  let calls = 0;
  const r = await runTrackingPages(async () => { calls++; return page({ fetched: 25 }); }, { maxPages: 1e9 });
  assert.equal(r.stopped, 'max_gets');
  assert.equal(calls, Math.ceil(UNI_TRACK_RUN_BUDGET.maxGets / 25));
});

test('a thrown primitive propagates as itself', async () => {
  await assert.rejects(runTrackingPages(async () => { throw 'boom'; }), (e) => e === 'boom');
});

// ── trackingWindow ────────────────────────────────────────────────────────────────────────
const H = 3600 * 1000;
const W = 6 * H, LAG = 2 * 60 * 1000;

test('window: far behind → a full window from the cursor, not the live edge', () => {
  const now = 100 * H;
  const w = trackingWindow({ cursor_ms: 10 * H }, now, W, LAG);
  assert.deepEqual(w, { winStart: 10 * H, winEnd: 16 * H, liveEdge: false, offset: 0 });
});

test('window: near the present → clamps to now minus the edge lag, flagged liveEdge', () => {
  const now = 100 * H;
  const w = trackingWindow({ cursor_ms: 99 * H }, now, W, LAG);
  assert.deepEqual(w, { winStart: 99 * H, winEnd: now - LAG, liveEdge: true, offset: 0 });
});

test('window: a frozen end is honoured while paginating and is never the live edge', () => {
  const now = 100 * H;
  const w = trackingWindow({ cursor_ms: 99 * H, win_end_ms: 99.5 * H, page_offset: 25 }, now, W, LAG);
  assert.deepEqual(w, { winStart: 99 * H, winEnd: 99.5 * H, liveEdge: false, offset: 25 });
});

test('window: cursor already at the lagged edge → empty (caught up), never a negative window', () => {
  const now = 100 * H;
  assert.equal(trackingWindow({ cursor_ms: now - LAG }, now, W, LAG).empty, true);
  assert.equal(trackingWindow({ cursor_ms: now - 1000 }, now, W, LAG).empty, true);
});

test('window: a stale frozen end at or before the cursor is ignored — and so is its page_offset', () => {
  const now = 100 * H;
  const w = trackingWindow({ cursor_ms: 50 * H, win_end_ms: 50 * H, page_offset: 75 }, now, W, LAG);
  assert.deepEqual(w, { winStart: 50 * H, winEnd: 56 * H, liveEdge: false, offset: 0 });
});

test('window: cold start walks from 3 days back', () => {
  const now = 100 * H;
  const w = trackingWindow({}, now, W, LAG);
  assert.equal(w.winStart, now - 3 * 24 * H);
});

// ── 2026-10-10 stall: one duplicated package_code on a page failed the bulk upsert (21000) ──

const row = (code, updated, o = {}) => ({ uniware_package_code: code, uniware_updated_at: updated, ...o });

test('dedupePackageRows: a duplicate in one page collapses to ONE row, the newest kept', () => {
  const page = [
    row('SP/26-1', '2026-10-10T00:20:48.000Z'),
    row('AMAZ00013', '2026-10-10T00:20:48.000Z', { uniware_order_code: 'A03303491SFLURBNGKG3M' }),
    row('SP/26-2', '2026-10-10T00:20:49.000Z'),
    row('AMAZ00013', '2026-10-10T00:20:54.000Z', { uniware_order_code: 'A04957509XMZFY02R52W' }),
  ];
  const { rows, dupes } = dedupePackageRows(page);
  assert.equal(rows.length, 3);
  assert.deepEqual(dupes, ['AMAZ00013']);
  assert.equal(new Set(rows.map((r) => r.uniware_package_code)).size, rows.length);   // upsert-safe
  assert.equal(rows.find((r) => r.uniware_package_code === 'AMAZ00013').uniware_order_code, 'A04957509XMZFY02R52W');
});

test('dedupePackageRows: an OLDER duplicate arriving later never overwrites the newer row', () => {
  const { rows } = dedupePackageRows([
    row('SP/26-9', '2026-10-12T10:00:00.000Z', { lifecycle: 'delivered' }),
    row('SP/26-9', '2026-10-11T10:00:00.000Z', { lifecycle: 'in_transit' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lifecycle, 'delivered');
});

test('dedupePackageRows: a tie (or missing stamps) keeps the later row; no dupes passes through untouched', () => {
  assert.equal(dedupePackageRows([row('X', null, { n: 1 }), row('X', null, { n: 2 })]).rows[0].n, 2);
  const clean = [row('A', '2026-10-10T00:00:00Z'), row('B', '2026-10-10T00:00:00Z')];
  const r = dedupePackageRows(clean);
  assert.deepEqual(r.rows, clean);
  assert.deepEqual(r.dupes, []);
  assert.deepEqual(dedupePackageRows([]).rows, []);
});

test('isUntrackedChannel: every Amazon FBA fulfilment centre is skipped, every tracked channel is not', () => {
  for (const c of ['AMAZON_FBA_IN_PNQ3', 'AMAZON_FBA_IN_XKPT', 'AMAZON_FBA_IN_HYD3', 'amazon_fba_in_blr8']) {
    assert.equal(isUntrackedChannel(c), true, c);
  }
  for (const c of ['LEGEND_OF_TOYS', 'CRED', 'AMAZON', 'AMAZON_FLEX_API', 'FLIPKART', 'FIRSTCRY', 'CUSTOM', '', null, undefined]) {
    assert.equal(isUntrackedChannel(c), false, String(c));
  }
});

test('wiring: every ecom_shipments upsert on uniware_package_code posts dedupePackageRows output', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const sites = [...src.matchAll(/on_conflict=uniware_package_code'[\s\S]{0,200}?body: JSON\.stringify\((\w+)\)/g)];
  assert.equal(sites.length, 3, 'page sync, reconcile apply, refreshUniwareOrder');
  for (const m of sites) {
    // the posted variable must be bound from dedupePackageRows(...) in the lines just above the upsert
    const above = src.slice(Math.max(0, m.index - 900), m.index);
    const bound = m[1] === 'rows' ? /const \{ rows \} = dedupePackageRows\(/ : new RegExp(`\\{ rows: ${m[1]}\\b[^}]*\\} = dedupePackageRows\\(`);
    assert.match(above, bound, `upsert posts ${m[1]} without dedupePackageRows`);
  }
  assert.match(src, /\.filter\(\(e\) => !isUntrackedChannel\(e\.channel\)\)/, 'FBA must be dropped before the saleorder/get');
});
