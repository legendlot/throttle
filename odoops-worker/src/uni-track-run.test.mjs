import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrackingPages, trackingWindow, UNI_TRACK_RUN_BUDGET } from './uni-track-run.mjs';

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
