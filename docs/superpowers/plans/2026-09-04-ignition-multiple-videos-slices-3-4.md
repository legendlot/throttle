# Ignition — Multiple videos per deal, slices 3 + 4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deal can carry 2–6 video takes; per-video metrics are written on `ignition.engagement_videos`, the deal's own metric columns become a worker-owned ROLLUP of its videos, and the monthly views tiles/drill-down attribute each video's views to the month THAT video posted.

**Architecture:** The worker (`ignitionops-worker/src/index.js`, single-file Cloudflare Worker) gains two pure functions (`rollupVideos`, `bucketVideoViewsByMonth`) exported for tests, plus three handlers (`setEngagementVideo`, `deleteEngagementVideo`, internal `recomputeVideoRollup`). Per-video metric keys leave `ENGAGEMENT_FIELDS` so the ONLY writer of deal-level `views`/`likes`/… is the rollup. The app's Performance card becomes tabbed (one tab per video, "+ Add video" capped at 6); the deal-level fields that are NOT per-video (`sessions`, `orders`, `conversions_value`) stay on `updateEngagement`. Slice 4 rewires `getMonthlyTargets` + `getMonthlyBreakdown` onto video rows through the shared bucketing function so the drill-down keeps summing to the tile by construction.

**Tech Stack:** Cloudflare Worker (ESM, PostgREST via `sb()`), Next.js app `apps/ignition`, `node:test` for the two pure functions (the worker has no suite today — this plan adds `ignitionops-worker/test/`).

**Spec:** The decision record is `backlog/ignition.md` (item "Multiple videos per deal", S343/S346 notes) + `reference/db-schema.md` §`ignition.engagement_videos` + `archive/BACKLOG_ARCHIVE.md` S343 entries in the root knowledge repo (`/Users/afshaansiddiqui/Documents/Claude`). No separate spec file exists; the rules below are copied from those records.

## Global Constraints

- Shape decided (Afshaan 2026-09-04): a CHILD TABLE `ignition.engagement_videos`, never `video_link_2/3` columns.
- `engagement_videos.seq` has `CHECK (seq BETWEEN 1 AND 6)` + `UNIQUE (engagement_id, seq)`. **The Add-video control and the handler MUST refuse a 7th video** — the 7th insert 23514s on a live deal.
- Every deal already has exactly one row at `seq = 1`, backfilled from `engagements.video_link/post_date` and the deal's metrics (411 rows, 2026-09-04). Slice 1 snapshot: `ignition.safety_engagements_2026_09_04`.
- `follower_count_at_post` is PER-VIDEO (point-in-time, not backfillable). Deal-level `follower_count_at_post` = the seq-1 video's value (a mirror, not an aggregate) so `deriveMetrics` ratios keep their base.
- `post_date` and `video_link` at deal level = the seq-1 video's (the primary take). They are mirrored both ways: writing them on the deal writes seq 1; writing seq 1 writes the deal.
- **Ship slices 3 and 4 in ONE worker deploy** (this plan's tasks 1–5 are one commit + one `npx wrangler deploy`), and the app change in the same push. Never deploy the ENGAGEMENT_FIELDS trim ahead of the rollup, and never expose "Add video" ahead of Task 5.
- Attribution rules that already exist and must not change: spend attributes to the deal's `post_date` month, else to the `unallocated` bucket; conversions to the deal's `post_date` month; `EXCLUDE_NON_SPEND` applies to every aggregate. Only VIEWS move to per-video dates.
- Deploy sequence (CLAUDE.md): edit → commit → push (must succeed) → `cd 05_Throttle/ignitionops-worker && npx wrangler deploy`. Pages deploy of `apps/ignition` follows the push; verify with `tools/wait-deploy.sh ignition <sha>` from the root repo, run alone in the background.
- `apps/ignition` has no test runner; the worker gains `node --test`. Read `npx turbo build --filter=@throttle/ignition` output for "Attempted import error" (a runtime crash) and confirm `Tasks: 1 successful, 1 total`.
- No SQL migration is needed: every column used below exists (`reference/db-schema.md` §`ignition.engagement_videos`: `id, engagement_id, seq, video_link, post_date, views, organic_views, paid_views, likes, comments, shares, reposts, saves, impressions, followers_gained, follower_count_at_post, metric_gaps jsonb NOT NULL DEFAULT '{}', note, created_at, updated_at, created_by`).

---

## File structure

| File | Responsibility |
|---|---|
| `ignitionops-worker/src/index.js` | Worker. Adds `export function rollupVideos(videos)`, `export function bucketVideoViewsByMonth(engagements, videos)`, `recomputeVideoRollup(env, id)`, handlers `setEngagementVideo` / `deleteEngagementVideo`, the `updateEngagement` seq-1 mirror, the `ENGAGEMENT_FIELDS` trim, and rewires the two monthly handlers. |
| `ignitionops-worker/test/rollup.test.mjs` | `node:test` for `rollupVideos`. |
| `ignitionops-worker/test/month-bucket.test.mjs` | `node:test` for `bucketVideoViewsByMonth` — proves tile = Σ drill-down. |
| `ignitionops-worker/package.json` | Adds `"test": "node --test test/"`. |
| `apps/ignition/src/app/(auth)/engagements/detail/page.js` | `PerformanceCard` becomes tabbed per video (+ add/delete); `VideosCard` becomes the read-only rollup summary; `PostLiveCard` unchanged (its write is mirrored by the worker). |
| `apps/ignition/src/app/(auth)/targets/page.js` | Drill-down Views table shows the take number when a deal has more than one. |
| `apps/ignition/docs/manual/content/work-engagementdetail.html` (+ `manual.json`, generated `src/data/manual.json`, PDFs) | Manual chapter for the Videos/Performance change. |

---

### Task 1: `rollupVideos` — the pure rollup rule, with tests

**Files:**
- Modify: `ignitionops-worker/src/index.js` (add the export next to `getEngagementVideos`, ~line 744)
- Create: `ignitionops-worker/test/rollup.test.mjs`
- Modify: `ignitionops-worker/package.json` (add the `test` script)

**Interfaces:**
- Produces: `export function rollupVideos(videos: Array<VideoRow>) : RollupPatch` where `RollupPatch` has keys `views, likes, comments, shares, reposts, saves, impressions, followers_gained` (number or null), `follower_count_at_post, post_date, video_link` (seq-1 mirror or null), `metric_gaps` (object). Later tasks PATCH this object straight onto `engagements`.

- [ ] **Step 1: Add the test script**

In `ignitionops-worker/package.json` add to `"scripts"`:
```json
"test": "node --test test/"
```

- [ ] **Step 2: Write the failing test**

Create `ignitionops-worker/test/rollup.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { rollupVideos } from '../src/index.js';

const v = (seq, o = {}) => ({ seq, video_link: null, post_date: null, views: null, likes: null, comments: null,
  shares: null, reposts: null, saves: null, impressions: null, followers_gained: null,
  follower_count_at_post: null, metric_gaps: {}, ...o });

test('sums the eight SUM metrics across takes, null only when every take is null', () => {
  const r = rollupVideos([v(1, { views: 1000, likes: 10 }), v(2, { views: 250, likes: null, comments: 3 })]);
  assert.equal(r.views, 1250);
  assert.equal(r.likes, 10);
  assert.equal(r.comments, 3);
  assert.equal(r.shares, null);
});

test('post_date, video_link and follower_count_at_post mirror seq 1 only', () => {
  const r = rollupVideos([
    v(2, { post_date: '2026-10-03', video_link: 'https://b', follower_count_at_post: 900 }),
    v(1, { post_date: '2026-09-28', video_link: 'https://a', follower_count_at_post: 800 }),
  ]);
  assert.equal(r.post_date, '2026-09-28');
  assert.equal(r.video_link, 'https://a');
  assert.equal(r.follower_count_at_post, 800);
});

test('metric_gaps keeps a reason only where the rolled metric is still null', () => {
  const r = rollupVideos([
    v(1, { views: 100, metric_gaps: { views: 'late', likes: 'platform_hides' } }),
    v(2, { metric_gaps: { likes: 'not_yet' } }),
  ]);
  assert.deepEqual(r.metric_gaps, { likes: 'platform_hides' });
});

test('empty input yields an all-null patch and an empty gaps object', () => {
  const r = rollupVideos([]);
  assert.equal(r.views, null);
  assert.equal(r.post_date, null);
  assert.deepEqual(r.metric_gaps, {});
});

test('string numbers from PostgREST are summed as numbers, whitespace is not a value', () => {
  const r = rollupVideos([v(1, { views: '12' }), v(2, { views: ' ' })]);
  assert.equal(r.views, 12);
});
```

- [ ] **Step 3: Run it to see it fail**

Run from `05_Throttle/ignitionops-worker`: `npm test`
Expected: FAIL — `rollupVideos` is not exported (`SyntaxError: The requested module ... does not provide an export named 'rollupVideos'`).

- [ ] **Step 4: Implement `rollupVideos`**

In `ignitionops-worker/src/index.js`, directly above `async function getEngagementVideos`, add:
```js
// ── Multiple videos per deal (Reann #10) — slice 3: the ROLLUP RULE ─────────────────────────
// The deal-level metric columns on `engagements` are a worker-owned rollup of its
// `engagement_videos` rows. Nothing else may write them (they left ENGAGEMENT_FIELDS in S351).
// SUM metrics: null only when EVERY take is null — a real 0 on one take is a real 0.
// post_date / video_link / follower_count_at_post MIRROR seq 1 (the primary take): they are
// point-in-time facts, not aggregates — a later take has a different follower base.
// metric_gaps keeps a per-video reason only where the rolled-up metric is STILL null; a reason
// sitting behind a real number reads as "unknown" and is stale the moment a take has data.
const VIDEO_SUM_METRICS = ['views','likes','comments','shares','reposts','saves','impressions','followers_gained'];
const VIDEO_MIRROR_FIELDS = ['post_date','video_link','follower_count_at_post'];
const vnum = (x) => {
  if (x == null || typeof x === 'boolean' || typeof x === 'object') return null;
  const s = typeof x === 'string' ? x.trim() : x;
  return s === '' || !Number.isFinite(Number(s)) ? null : Number(s);
};
export function rollupVideos(videos) {
  const rows = [...(videos || [])].sort((a, b) => Number(a.seq) - Number(b.seq));
  const out = {};
  for (const k of VIDEO_SUM_METRICS) {
    let sum = null;
    for (const r of rows) { const n = vnum(r[k]); if (n != null) sum = (sum ?? 0) + n; }
    out[k] = sum;
  }
  const first = rows[0] || {};
  out.post_date = first.post_date || null;
  out.video_link = first.video_link || null;
  out.follower_count_at_post = vnum(first.follower_count_at_post);
  const gaps = {};
  for (const r of rows) {
    for (const [k, reason] of Object.entries(r.metric_gaps || {})) {
      if (out[k] == null && reason && !gaps[k]) gaps[k] = reason;
    }
  }
  out.metric_gaps = gaps;
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test` (in `ignitionops-worker`). Expected: 5 passing. If `node --test` refuses the ESM import because `package.json` lacks `"type": "module"`, add `"type": "module"` to `ignitionops-worker/package.json` (wrangler bundles ESM regardless) and re-run.

- [ ] **Step 6: Commit**

```bash
git -C 05_Throttle add ignitionops-worker/src/index.js ignitionops-worker/test/rollup.test.mjs ignitionops-worker/package.json
git -C 05_Throttle commit -m "S351 [ignition]: rollupVideos — the pure per-video → deal rollup rule, with tests (slice 3, part 1)"
```
Do NOT push or deploy yet — Tasks 1–5 ship together.

---

### Task 2: `recomputeVideoRollup` + `setEngagementVideo` + `deleteEngagementVideo`

**Files:**
- Modify: `ignitionops-worker/src/index.js` — new functions below `rollupVideos`; register in `POST_ACTIONS` (~line 3927, next to `updateEngagement`).

**Interfaces:**
- Consumes: `rollupVideos(videos)` (Task 1); `recomputeCpm(env, engagementId)` (~line 1737, existing); `sb`, `requirePerm`, `err`, `ok`, `nowIso` (existing).
- Produces: POST actions `setEngagementVideo` `{ engagement_id, seq?, video_link?, post_date?, views?, organic_views?, paid_views?, likes?, comments?, shares?, reposts?, saves?, impressions?, followers_gained?, follower_count_at_post?, metric_gaps?, note? }` → `{ video, rollup }`; `deleteEngagementVideo` `{ engagement_id, seq }` → `{ deleted: true, rollup }`; internal `recomputeVideoRollup(env, engagementId) → RollupPatch`.

- [ ] **Step 1: Add the rollup writer and the two handlers**

Below `rollupVideos`, add:
```js
const VIDEO_FIELDS = ['video_link','post_date','views','organic_views','paid_views','likes','comments','shares',
  'reposts','saves','impressions','followers_gained','follower_count_at_post','metric_gaps','note'];
const VIDEO_NUMERIC = ['views','organic_views','paid_views','likes','comments','shares','reposts','saves',
  'impressions','followers_gained','follower_count_at_post'];
const VIDEO_MAX_SEQ = 6;   // engagement_videos.seq CHECK (seq BETWEEN 1 AND 6) — refuse BEFORE the insert

// Re-derive the deal's metric columns from its video rows and write them. The ONLY writer of
// deal-level views/likes/… since S351. Then CPM, exactly as updateEngagement always did.
async function recomputeVideoRollup(env, engagementId) {
  const vr = await sb(`/rest/v1/engagement_videos?engagement_id=eq.${engagementId}&select=*&order=seq.asc`, env);
  const patch = rollupVideos(vr.ok ? vr.data || [] : []);
  patch.updated_at = nowIso();
  const r = await sb(`/rest/v1/engagements?id=eq.${engagementId}`, env, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`rollup_db_error: ${JSON.stringify(r.data)}`);
  await recomputeCpm(env, engagementId);
  return patch;
}

// Upsert ONE video take (seq 1..6) and roll the deal up. seq omitted = the lowest free seq
// (deletions leave holes; a deal may hold at most 6 rows at a time, not 6 ever).
async function setEngagementVideo(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const existing = await sb(`/rest/v1/engagement_videos?engagement_id=eq.${body.engagement_id}&select=id,seq&order=seq.asc`, env);
  const taken = new Set((existing.ok ? existing.data || [] : []).map(v => Number(v.seq)));
  let seq = body.seq == null ? null : Number(body.seq);
  if (seq == null) { for (let s = 1; s <= VIDEO_MAX_SEQ; s++) if (!taken.has(s)) { seq = s; break; } }
  if (seq == null) return err(`a deal holds at most ${VIDEO_MAX_SEQ} videos`, 400);
  if (!Number.isInteger(seq) || seq < 1 || seq > VIDEO_MAX_SEQ) return err(`seq must be 1..${VIDEO_MAX_SEQ}`, 400);

  const row = { engagement_id: body.engagement_id, seq };
  for (const k of VIDEO_FIELDS) if (k in body) row[k] = body[k];
  for (const k of VIDEO_NUMERIC) if (k in row) {
    const n = vnum(row[k]);
    if (row[k] != null && String(row[k]).trim() !== '' && n == null) return err(`${k} must be a number`, 400);
    if (n != null && n < 0) return err(`${k} cannot be negative`, 400);
    row[k] = n;
  }
  if ('post_date' in row && row.post_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.post_date))) return err('post_date must be YYYY-MM-DD', 400);
  if ('metric_gaps' in row && (row.metric_gaps == null || typeof row.metric_gaps !== 'object' || Array.isArray(row.metric_gaps))) row.metric_gaps = {};
  // Reann #7 hard stop, server side: a take with views recorded must carry its follower base.
  if (vnum(row.views) > 0 && !(vnum(row.follower_count_at_post) > 0)) return err('follower_count_at_post is required once views are entered', 400);
  row.updated_at = nowIso();
  if (!taken.has(seq)) row.created_by = auth.userId || null;

  const up = await sb(`/rest/v1/engagement_videos?on_conflict=engagement_id,seq`, env, {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: JSON.stringify([row]),
  });
  if (!up.ok) return err(`db_error: ${JSON.stringify(up.data)}`, 400);
  let rollup;
  try { rollup = await recomputeVideoRollup(env, body.engagement_id); }
  catch (e) { return err(String(e.message || e), 500); }
  return ok({ video: up.data?.[0] || row, rollup });
}

// Remove a take. seq 1 is the primary (its post_date/video_link ARE the deal's) and cannot be
// deleted while other takes exist — delete the others first, or edit seq 1 in place.
async function deleteEngagementVideo(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id || body.seq == null) return err('engagement_id and seq required', 400);
  const seq = Number(body.seq);
  const existing = await sb(`/rest/v1/engagement_videos?engagement_id=eq.${body.engagement_id}&select=seq`, env);
  const count = existing.ok ? (existing.data || []).length : 0;
  if (seq === 1 && count > 1) return err('delete the other takes first; #1 is the primary', 400);
  const del = await sb(`/rest/v1/engagement_videos?engagement_id=eq.${body.engagement_id}&seq=eq.${seq}`, env, {
    method: 'DELETE', prefer: 'return=minimal',
  });
  if (!del.ok) return err(`db_error: ${JSON.stringify(del.data)}`, 400);
  let rollup;
  try { rollup = await recomputeVideoRollup(env, body.engagement_id); }
  catch (e) { return err(String(e.message || e), 500); }
  return ok({ deleted: true, rollup });
}
```

- [ ] **Step 2: Register the actions**

In the `POST_ACTIONS` map (grep `updateEngagement,` around line 3927) add on the next lines:
```js
  setEngagementVideo,
  deleteEngagementVideo,
```

- [ ] **Step 3: Syntax-check**

Run from `05_Throttle`:
```bash
cp ignitionops-worker/src/index.js /tmp/ignitionops-check.mjs && node --check /tmp/ignitionops-check.mjs && echo SYNTAX-OK
```
(`node --check` on the `.js` path fails on `export default` because the package is not marked ESM — the `.mjs` copy is the check.) Then `npm test` in `ignitionops-worker` still passes 5.

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add ignitionops-worker/src/index.js
git -C 05_Throttle commit -m "S351 [ignition]: setEngagementVideo / deleteEngagementVideo + recomputeVideoRollup (slice 3, part 2)"
```

---

### Task 3: Deal-level writes — mirror seq 1, and trim `ENGAGEMENT_FIELDS`

**Files:**
- Modify: `ignitionops-worker/src/index.js:1550-1578` (`ENGAGEMENT_FIELDS`), `:1780-1795` (`updateEngagement`).

**Interfaces:**
- Consumes: `recomputeVideoRollup` (Task 2).
- Produces: `updateEngagement` no longer accepts `views, likes, comments, shares, impressions, saves, reposts, followers_gained, follower_count_at_post, metric_gaps` (they are silently dropped by `pickPatch`); a `post_date` or `video_link` in the patch is also written to the deal's seq-1 video.

- [ ] **Step 1: Trim the allowlist**

In `ENGAGEMENT_FIELDS` replace the block
```js
  'views','likes','comments','shares','impressions','sessions','orders',
  // Reann 2026-08-10 #1 — the four capture fields the ratio framework needs.
  // follower_count_at_post is point-in-time and NOT backfillable (see the column comment).
  'saves','reposts','followers_gained','follower_count_at_post',
  // Reann #2 — per-metric "why is this blank" reasons; distinguishes a real 0 from unknown.
  'metric_gaps',
```
with
```js
  // S351 (multiple videos, slice 3): views / likes / comments / shares / impressions / saves /
  // reposts / followers_gained / follower_count_at_post / metric_gaps are PER-VIDEO now and the
  // deal-level columns are a worker-owned rollup (recomputeVideoRollup). They are deliberately
  // NOT in this allowlist: a PATCH here would be reverted by the next rollup, which reads to
  // the user as "my edit didn't save". Write them via setEngagementVideo.
  'sessions','orders',
```

- [ ] **Step 2: Mirror post_date / video_link to seq 1**

In `updateEngagement`, after the successful PATCH and before `await recomputeCpm(...)`, add:
```js
  // S351: post_date / video_link at deal level ARE the seq-1 take's. Keep the two in step so
  // the per-video card and the Post-live card never disagree (PostLiveCard + AdvanceModal both
  // still write the deal). Upsert so a deal that somehow lacks its seq-1 row gets one.
  if ('post_date' in patch || 'video_link' in patch) {
    const mirror = { engagement_id: body.engagement_id, seq: 1, updated_at: nowIso() };
    if ('post_date' in patch) mirror.post_date = patch.post_date;
    if ('video_link' in patch) mirror.video_link = patch.video_link;
    await sb(`/rest/v1/engagement_videos?on_conflict=engagement_id,seq`, env, {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify([mirror]),
    });
  }
```

- [ ] **Step 3: Check every other writer of the trimmed keys**

Run from `05_Throttle`:
```bash
grep -n "views\b" ignitionops-worker/src/index.js | grep -iE "patch|body\.|PATCH" | grep -v engagement_videos
grep -n "follower_count_at_post\|followers_gained\|metric_gaps" ignitionops-worker/src/index.js | grep -v "VIDEO_\|rollupVideos\|engagement_videos"
```
Expected: no remaining direct writer of those keys onto `engagements` other than `recomputeVideoRollup`. If the advance-to-live path (`advanceEngagement`, grep `stage: 'live'`) writes `video_link`/`post_date` directly rather than through `updateEngagement`, add the same seq-1 mirror block there (it is the PATTERN-218 "N−1 of N sites" trap — reconcile the count before moving on).

- [ ] **Step 4: Syntax-check + tests, commit**

```bash
cp ignitionops-worker/src/index.js /tmp/ignitionops-check.mjs && node --check /tmp/ignitionops-check.mjs && (cd ignitionops-worker && npm test)
git -C 05_Throttle add ignitionops-worker/src/index.js
git -C 05_Throttle commit -m "S351 [ignition]: per-video metrics leave ENGAGEMENT_FIELDS; deal post_date/video_link mirror seq 1 (slice 3, part 3)"
```

---

### Task 4: `bucketVideoViewsByMonth` — the shared attribution function, with tests (slice 4, part 1)

**Files:**
- Modify: `ignitionops-worker/src/index.js` (add the export above `getMonthlyBreakdown`, ~line 3240)
- Create: `ignitionops-worker/test/month-bucket.test.mjs`

**Interfaces:**
- Produces: `export function bucketVideoViewsByMonth(engagements, videos) : { byMonth: {[YYYY-MM]: number}, rows: Array<{engagement_id, seq, post_date, month, views}> }` — `rows` is the itemised list, `byMonth` its sum per month; a deal with NO video rows falls back to its own `post_date`/`views` as `seq: null`.

- [ ] **Step 1: Write the failing test**

Create `ignitionops-worker/test/month-bucket.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketVideoViewsByMonth } from '../src/index.js';

const deals = [
  { id: 'A', post_date: '2026-09-28', views: 1250 },
  { id: 'B', post_date: '2026-09-10', views: 400 },
  { id: 'C', post_date: null, views: 0 },
];
const videos = [
  { engagement_id: 'A', seq: 1, post_date: '2026-09-28', views: 1000 },
  { engagement_id: 'A', seq: 2, post_date: '2026-10-03', views: 250 },
  // B has no video rows (a deal created before slice 1 could, in theory) → falls back to the deal
];

test('a second take posted next month lands in NEXT month, not the deal post_date month', () => {
  const { byMonth } = bucketVideoViewsByMonth(deals, videos);
  assert.equal(byMonth['2026-09'], 1000 + 400);
  assert.equal(byMonth['2026-10'], 250);
});

test('tile equals the sum of its drill-down rows, for every month', () => {
  const { byMonth, rows } = bucketVideoViewsByMonth(deals, videos);
  for (const m of Object.keys(byMonth)) {
    assert.equal(byMonth[m], rows.filter(r => r.month === m).reduce((t, r) => t + r.views, 0));
  }
});

test('a take with no post_date or zero views contributes no row', () => {
  const { rows } = bucketVideoViewsByMonth([{ id: 'D', post_date: '2026-09-01', views: 5 }],
    [{ engagement_id: 'D', seq: 1, post_date: null, views: 5 }, { engagement_id: 'D', seq: 2, post_date: '2026-09-02', views: 0 }]);
  assert.deepEqual(rows, []);
});

test('the fallback row is marked seq null and uses the deal date', () => {
  const { rows } = bucketVideoViewsByMonth(deals, videos);
  const b = rows.find(r => r.engagement_id === 'B');
  assert.deepEqual(b, { engagement_id: 'B', seq: null, post_date: '2026-09-10', month: '2026-09', views: 400 });
});
```

- [ ] **Step 2: Run it to see it fail**

`npm test` in `ignitionops-worker` → FAIL: `bucketVideoViewsByMonth` not exported.

- [ ] **Step 3: Implement**

Above `getMonthlyBreakdown` add:
```js
// ── Slice 4: views attribute to the month EACH TAKE posted ───────────────────────────────────
// Before this, a deal's whole views figure sat on its single post_date: take 1 on 28 Sep and take
// 2 on 3 Oct overstated September and nothing errored. Both monthly handlers call THIS function
// for views so the drill-down sums to the tile by construction (their own comments demand it).
// Spend and conversions are deal-level and keep the deal post_date rule — only views move.
export function bucketVideoViewsByMonth(engagements, videos) {
  const n = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const byDeal = new Map();
  for (const v of (videos || [])) {
    if (!byDeal.has(v.engagement_id)) byDeal.set(v.engagement_id, []);
    byDeal.get(v.engagement_id).push(v);
  }
  const rows = [], byMonth = {};
  const push = (engagement_id, seq, post_date, views) => {
    const month = String(post_date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month) || n(views) <= 0) return;
    rows.push({ engagement_id, seq, post_date, month, views: n(views) });
    byMonth[month] = (byMonth[month] || 0) + n(views);
  };
  for (const e of (engagements || [])) {
    const takes = byDeal.get(e.id);
    if (takes && takes.length) for (const t of takes) push(e.id, Number(t.seq), t.post_date, t.views);
    else push(e.id, null, e.post_date, e.views);
  }
  return { byMonth, rows };
}
```

- [ ] **Step 4: Run the tests, commit**

`npm test` → 9 passing.
```bash
git -C 05_Throttle add ignitionops-worker/src/index.js ignitionops-worker/test/month-bucket.test.mjs
git -C 05_Throttle commit -m "S351 [ignition]: bucketVideoViewsByMonth — per-take month attribution, tile = Σ drill-down by construction (slice 4, part 1)"
```

---

### Task 5: Rewire `getMonthlyTargets` and `getMonthlyBreakdown` onto video rows, then SHIP the worker

**Files:**
- Modify: `ignitionops-worker/src/index.js:3246-3300` (`getMonthlyBreakdown`), `:3362-3400` (`getMonthlyTargets`).

**Interfaces:**
- Consumes: `bucketVideoViewsByMonth` (Task 4).
- Produces: `getMonthlyBreakdown` `views` rows gain `seq` (number or null) and `take_post_date`; `getMonthlyTargets` `actual_views` per month now sums takes.

- [ ] **Step 1: `getMonthlyTargets`**

Replace the `er` fetch + the views line. After `const er = await sb(... engagements ...)` add a second fetch and change the loop:
```js
  const er = await sb(`/rest/v1/engagements?${EXCLUDE_NON_SPEND}&select=id,post_date,created_at,views,total_cost,payment_amount,ad_spend,commission_amount&limit=5000`, env);
  // Slice 4: views come from the takes. One fetch, paged at db-max-rows (5,000; 411 rows today,
  // 6 per deal at most → ~2,500 at 411 deals). Order by a unique pair so paging cannot skip.
  const vr = await sb(`/rest/v1/engagement_videos?select=engagement_id,seq,post_date,views&order=engagement_id.asc,seq.asc&limit=5000`, env);
  const { byMonth: viewsByMonth } = bucketVideoViewsByMonth(er.ok ? er.data || [] : [], vr.ok ? vr.data || [] : []);
  for (const [m, v] of Object.entries(viewsByMonth)) bucket(m).actual_views += v;
```
and DELETE the two lines inside the loop that did `const postMonth = ...; if (/^\d{4}-\d{2}$/.test(postMonth)) bucket(postMonth).actual_views += num(e.views);` (keep the spend/unallocated logic exactly as it is). `select=` must now include `id` (it did not) — `bucketVideoViewsByMonth` keys on `e.id`.

- [ ] **Step 2: `getMonthlyBreakdown`**

Fetch the takes for the returned deals and replace the views push:
```js
  const r = await sb(`/rest/v1/engagements?${EXCLUDE_NON_SPEND}&select=${encodeURIComponent(sel)}&limit=5000`, env);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const vr = await sb(`/rest/v1/engagement_videos?select=engagement_id,seq,post_date,views&order=engagement_id.asc,seq.asc&limit=5000`, env);
  const takeRows = bucketVideoViewsByMonth(r.data || [], vr.ok ? vr.data || [] : []).rows.filter(t => t.month === month);
  const dealById = new Map((r.data || []).map(e => [e.id, e]));
```
Then remove `if (num(e.views) > 0) views.push({ ...base, views: num(e.views) });` from the loop and, after the loop, add:
```js
  // Views are itemised PER TAKE (slice 4) so a deal with a take in September and one in October
  // shows one row in each month, and each month's rows still sum to its tile.
  if (!isUnalloc) for (const t of takeRows) {
    const e = dealById.get(t.engagement_id); if (!e) continue;
    const who = e.influencer || {};
    views.push({
      engagement_id: e.id, engagement_no: e.engagement_no, stage: e.stage, engagement_type: e.engagement_type,
      campaign_tag: e.campaign_tag || null, influencer_id: who.id || null, influencer_code: who.influencer_code || null,
      influencer_name: who.channel_name || who.person_name || null, channel_link: who.channel_link || null,
      platform: who.channel_platform || null, post_date: e.post_date || null,
      seq: t.seq, take_post_date: t.post_date, views: t.views,
    });
  }
```
Leave the conversions and spend pushes untouched.

- [ ] **Step 3: Prove tile = drill-down on live data (read-only) before deploying**

From the root repo, one SQL against the same rule (`SPEND_EXCLUDED_STAGES` — copy the list from `index.js:~305`):
```sql
select to_char(v.post_date,'YYYY-MM') m, sum(v.views) take_views,
       (select sum(e2.views) from ignition.engagements e2 where e2.stage not in (<SPEND_EXCLUDED_STAGES>) and to_char(e2.post_date,'YYYY-MM') = to_char(v.post_date,'YYYY-MM')) deal_views
from ignition.engagement_videos v join ignition.engagements e on e.id = v.engagement_id
where e.stage not in (<SPEND_EXCLUDED_STAGES>) and v.post_date is not null group by 1 order by 1 desc limit 6;
```
Expected TODAY: `take_views = deal_views` on every month (every deal has exactly one take, seq 1, mirrored). Write the numbers into the commit message. Any month that differs means the seq-1 backfill drifted — stop and reconcile before deploying.

- [ ] **Step 4: Tests, syntax, commit, push, deploy (worker ships here — slices 3+4 together)**

```bash
cp ignitionops-worker/src/index.js /tmp/ignitionops-check.mjs && node --check /tmp/ignitionops-check.mjs && (cd ignitionops-worker && npm test)
git -C 05_Throttle add ignitionops-worker/src/index.js
git -C 05_Throttle commit -m "S351 [ignition]: monthly views tiles + drill-down attribute per TAKE (slice 4, part 2) — ships with slice 3"
git -C 05_Throttle pull --rebase origin main && git -C 05_Throttle push origin main
cd 05_Throttle/ignitionops-worker && npx wrangler deploy
```
The push MUST succeed before the deploy (a rejected push + deploy silently reverts a parallel lane's live change). Then, from the root: `curl`-free check — open `https://ignition.legendoftoys.com/targets` in the in-app browser after Task 6 ships; until then, verify the worker via the app's existing Targets page still loading (no 500) and the monthly numbers unchanged from before (single-take world).

---

### Task 6: App — per-video Performance tabs, Add/Delete video, rollup summary

**Files:**
- Modify: `apps/ignition/src/app/(auth)/engagements/detail/page.js` — `VideosCard` (~line 933), `METRIC_FIELDS` + `PerformanceCard` (~line 964–1015), the call site `<PerformanceCard … />` (~line 251) and `<VideosCard videos={…} />`.

**Interfaces:**
- Consumes: `ignitionopsPost('setEngagementVideo', { engagement_id, seq, ...fields }, session)` and `ignitionopsPost('deleteEngagementVideo', { engagement_id, seq }, session)` (Task 2); `data.videos` already returned by `getEngagement`; `updateEngagement` for `sessions/orders/conversions_value` only (Task 3).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Split the metric lists**

Replace `METRIC_FIELDS` with two lists:
```js
// S351 — per-VIDEO metrics (written with setEngagementVideo; the deal column is a rollup)…
const VIDEO_METRIC_FIELDS = [
  ['views', 'Views'], ['organic_views', 'Organic views'], ['paid_views', 'Paid views'],
  ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'],
  ['reposts', 'Reposts'], ['saves', 'Saves'], ['followers_gained', 'Followers gained'],
  ['follower_count_at_post', 'Followers at post date'], ['impressions', 'Impressions'],
];
// …and the deal-level ones that are NOT per-video (written with updateEngagement, as before).
const DEAL_METRIC_FIELDS = [['sessions', 'Sessions'], ['orders', 'Orders'], ['conversions_value', 'Conversions ₹']];
```
Anything else that referenced `METRIC_FIELDS` (grep the file) uses `[...VIDEO_METRIC_FIELDS, ...DEAL_METRIC_FIELDS]` for labels.

- [ ] **Step 2: Rewrite `PerformanceCard` as a tabbed card**

Replace the whole `PerformanceCard` function with:
```js
const MAX_VIDEOS = 6;   // engagement_videos.seq CHECK (1..6) — the 7th insert 23514s; refuse here first

function PerformanceCard({ e, videos, canEdit, session, onSaved, platform, gapReasons }) {
  const { showToast: toast } = useToast();
  const takes = [...(videos || [])].sort((a, b) => Number(a.seq) - Number(b.seq));
  const [tab, setTab] = useState(takes[0]?.seq ?? 1);          // seq of the take being viewed
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [gaps, setGaps] = useState({});
  const [busy, setBusy] = useState(false);
  const current = takes.find(t => Number(t.seq) === Number(tab)) || null;

  const applicable = ([k]) => isMetricApplicable(k, platform);
  const shownVideo = VIDEO_METRIC_FIELDS.filter(applicable);
  const derived = deriveMetrics(e, platform);                   // deal-level ratios off the ROLLUP
  const unexplained = unexplainedGaps(e, platform);
  const missingRequired = editing && current ? missingRequiredMetrics(form, platform) : [];
  const requiredLabels = missingRequired.map(k => (VIDEO_METRIC_FIELDS.find(([mk]) => mk === k) || [k, k])[1]);

  function startEdit() {
    if (!current) return;
    const f = { video_link: current.video_link ?? '', post_date: current.post_date ?? '' };
    for (const [k] of shownVideo) f[k] = current[k] ?? '';
    setForm(f); setGaps({ ...(current.metric_gaps || {}) }); setEditing(true);
  }
  async function saveTake() {
    if (missingRequired.length) { toast(`${requiredLabels.join(', ')} is required before performance can be saved`, 'error'); return; }
    setBusy(true);
    try {
      const patch = { engagement_id: e.id, seq: current.seq,
        video_link: form.video_link === '' ? null : form.video_link,
        post_date: form.post_date === '' ? null : form.post_date };
      for (const [k] of shownVideo) patch[k] = form[k] === '' ? null : Number(form[k]);
      const cleaned = {};
      for (const [k] of shownVideo) if (patch[k] == null && gaps[k]) cleaned[k] = gaps[k];
      patch.metric_gaps = cleaned;
      await ignitionopsPost('setEngagementVideo', patch, session);
      toast(`Video #${current.seq} updated`, 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function addTake() {
    if (takes.length >= MAX_VIDEOS) { toast(`A deal holds at most ${MAX_VIDEOS} videos`, 'error'); return; }
    setBusy(true);
    try {
      const r = await ignitionopsPost('setEngagementVideo', { engagement_id: e.id }, session);   // worker picks the lowest free seq
      toast(`Video #${r.video.seq} added`, 'success');
      setTab(r.video.seq);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function removeTake() {
    if (!current || Number(current.seq) === 1) return;
    if (!window.confirm(`Remove video #${current.seq}? Its numbers leave the deal's totals.`)) return;
    setBusy(true);
    try {
      await ignitionopsPost('deleteEngagementVideo', { engagement_id: e.id, seq: current.seq }, session);
      toast(`Video #${current.seq} removed`, 'success');
      setTab(1); setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const tabStyle = (active) => ({
    padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
    background: active ? 'var(--surface-3)' : 'transparent', color: active ? 'var(--text-1)' : 'var(--text-3)',
    border: '1px solid', borderColor: active ? 'var(--border-2)' : 'transparent', borderRadius: 'var(--radius-sm)',
  });

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Performance</h2>
        <div role="tablist" aria-label="Video takes" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {takes.map(t => (
            <button key={t.seq} role="tab" aria-selected={Number(t.seq) === Number(tab)} style={tabStyle(Number(t.seq) === Number(tab))}
              onClick={() => { setTab(t.seq); setEditing(false); }}>Video #{t.seq}</button>
          ))}
          {canEdit && takes.length < MAX_VIDEOS && (
            <button onClick={addTake} disabled={busy} style={tabStyle(false)} title="Add another take of this video">+ Add video</button>
          )}
        </div>
        {canEdit && current && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>

      {!current && <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No video on this deal yet.</div>}

      {current && !editing && (
        <>
          <KV label="Link" value={current.video_link ? <a href={current.video_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{current.video_link}</a> : '—'} />
          <KV label="Posted" value={current.post_date || '—'} />
          {shownVideo.map(([k, label]) => (
            <KV key={k} label={label} value={current[k] != null ? Number(current[k]).toLocaleString() : (current.metric_gaps?.[k] ? `— (${current.metric_gaps[k]})` : '—')} />
          ))}
        </>
      )}

      {current && editing && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--text-3)' }}>Link
            <input value={form.video_link} onChange={ev => setForm({ ...form, video_link: ev.target.value })} style={{ width: '100%' }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-3)' }}>Posted
            <input type="date" value={form.post_date} onChange={ev => setForm({ ...form, post_date: ev.target.value })} style={{ width: '100%' }} />
          </label>
          {shownVideo.map(([k, label]) => (
            <label key={k} style={{ fontSize: 12, color: 'var(--text-3)' }}>{label}{REQUIRED_METRICS.includes(k) ? ' *' : ''}
              <input type="number" min="0" value={form[k]} onChange={ev => setForm({ ...form, [k]: ev.target.value })} style={{ width: '100%' }} />
              {form[k] === '' && gapReasons && (
                <select value={gaps[k] || ''} onChange={ev => setGaps({ ...gaps, [k]: ev.target.value })} style={{ width: '100%', marginTop: 2 }}>
                  <option value="">why blank?</option>
                  {Object.entries(GAP_REASONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              )}
            </label>
          ))}
          {missingRequired.length > 0 && <div style={{ gridColumn: '1 / -1', color: 'var(--state-danger-fg)', fontSize: 12 }}>{requiredLabels.join(', ')} is required.</div>}
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {Number(current.seq) !== 1 && <button onClick={removeTake} disabled={busy} style={{ marginRight: 'auto', color: 'var(--state-danger-fg)', background: 'transparent', border: '1px solid currentColor', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>Remove video #{current.seq}</button>}
            <button onClick={() => setEditing(false)} disabled={busy} style={{ padding: '4px 10px', fontSize: 11 }}>Cancel</button>
            <button onClick={saveTake} disabled={busy || missingRequired.length > 0} style={{ padding: '4px 10px', fontSize: 11, background: '#FF6B00', color: '#fff', border: 0, borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>Save video #{current.seq}</button>
          </div>
        </div>
      )}

      <DealTotals e={e} derived={derived} unexplained={unexplained} takes={takes} canEdit={canEdit} session={session} onSaved={onSaved} platform={platform} />
    </section>
  );
}
```
Keep whatever the existing card rendered for the derived ratios and the `unexplained` warning: move that JSX into a new `DealTotals` component below, which also owns the `DEAL_METRIC_FIELDS` editor (its `save()` is the OLD `save()` with `shown = DEAL_METRIC_FIELDS.filter(applicable)` and no `metric_gaps`, still calling `updateEngagement`). It renders a heading "Deal totals (N videos)" and the rolled-up `e.views` etc. read-only. The import line must add `REQUIRED_METRICS` if it is not already imported (it is — line 13).

- [ ] **Step 3: Wire `videos` into the card and demote `VideosCard`**

At the call site (~line 251) pass `videos={data.videos}` (the name the page holds `getEngagement`'s payload under — grep `videos` in the file, slice 2 already reads it for `<VideosCard videos=…>`). Delete the `<VideosCard …>` element and the `VideosCard` function: the tab strip replaces it.

- [ ] **Step 4: Build, read the output**

```bash
cd 05_Throttle && npx turbo build --filter=@throttle/ignition 2>&1 | grep -E "Attempted import|Tasks:|rror"
```
Expected: no "Attempted import error", `Tasks: 1 successful, 1 total`.

- [ ] **Step 5: Commit + push (the app half of the same ship)**

```bash
git -C 05_Throttle add "apps/ignition/src/app/(auth)/engagements/detail/page.js"
git -C 05_Throttle commit -m "S351 [ignition]: Performance card is per-video — tabs, Add video (max 6), remove take; deal totals are the rollup (slice 3 UI)"
git -C 05_Throttle pull --rebase origin main && git -C 05_Throttle push origin main
```
Then from the root repo, in the background and alone: `tools/wait-deploy.sh ignition <sha>` — read its `VERDICT:` line.

---

### Task 7: Targets drill-down shows the take

**Files:**
- Modify: `apps/ignition/src/app/(auth)/targets/page.js` — the `MonthBreakdown` Views table (~line 251, columns Influencer / Posted / Views).

- [ ] **Step 1: Show the take number and the take's own date**

In the Views table row render, replace the Posted cell value `r.post_date` with `r.take_post_date || r.post_date` and, after the influencer name, append `{r.seq != null && r.seq > 1 ? <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginLeft: 6 }}>#{r.seq}</span> : null}`. Nothing else changes: the tile above is already the sum of these rows (Task 5).

- [ ] **Step 2: Build, commit, push**

```bash
cd 05_Throttle && npx turbo build --filter=@throttle/ignition 2>&1 | grep -E "Attempted import|Tasks:|rror"
git -C 05_Throttle add "apps/ignition/src/app/(auth)/targets/page.js"
git -C 05_Throttle commit -m "S351 [ignition]: targets drill-down names the take when a deal has more than one (slice 4 UI)"
git -C 05_Throttle pull --rebase origin main && git -C 05_Throttle push origin main
```

---

### Task 8: Live smoke, manual, close

**Files:**
- Modify: `apps/ignition/docs/manual/content/work-engagementdetail.html`, `apps/ignition/docs/manual/manual.json` (version bump), `apps/ignition/docs/manual/CHANGELOG.md`; regenerate `apps/ignition/src/data/manual.json` + both PDFs.
- Root repo: `backlog/ignition.md` (delete the item), `archive/BACKLOG_ARCHIVE.md` (entry), `systems/ignition.md` (rollup rule + attribution rule).

- [ ] **Step 1: Smoke on a THROWAWAY deal, never a live one** (in-app browser first; a login wall means stop and ask Afshaan)

1. Pick a `proposed`/test deal (or create one titled "S351 smoke"). Open its page: Performance shows tab "Video #1" only, "+ Add video" present.
2. Click "+ Add video" → a "Video #2" tab appears. Edit it: Posted = first of NEXT month, Views = 250, Followers at post date = 100, Save. Toast "Video #2 updated".
3. Deal totals now show views = (video 1 views) + 250. Check `ignition.engagements.views` for the deal in SQL — equals the total; `cpm` recomputed.
4. Open `/targets`: the NEXT month's Actual views includes 250; expand it: one row for this deal marked `#2`. The current month's tile did NOT gain 250.
5. Click "+ Add video" until 6 tabs exist: the button disappears at 6. (Do NOT try a 7th through the API.)
6. Remove videos #6…#2 (Remove is only on non-primary tabs). Deal totals return to video 1's numbers.
7. Post-live card: change Posted date → the Video #1 tab shows the same date (the mirror).
8. Delete the throwaway deal if you created one. Console: no error-level entries.
Screenshot each step for the archive entry.

- [ ] **Step 2: Manual**

Dispatch the `manual-builder` agent with: the tabbed Performance card, Add video (max 6), remove a take, "deal totals are the sum of the takes; the deal's own numbers can no longer be typed directly", the primary take rule (Video #1's link and date are the deal's), and the targets change ("views count in the month each video posted"). Bump the version (currently 1.10.0 → 1.11.0), rebuild PDF + in-app data, commit the generated files with the content.

- [ ] **Step 3: Close the item**

In the root repo: delete the "Multiple videos per deal" item from `backlog/ignition.md`; append an `## S351 (date) — [ignition] CLOSED: multiple videos per deal (slices 3+4)` entry to `archive/BACKLOG_ARCHIVE.md` with the smoke proof, the tile = drill-down SQL numbers from Task 5, the commit shas and the worker version id; add the rollup + attribution rules to `systems/ignition.md`; run `python3 tools/backlog-counts.py`; commit path-scoped; push.

---

## Self-review (done at write time)

- **Spec coverage:** child table only ✔ (no new columns anywhere) · seq capped at 6 in the handler AND the UI ✔ (Task 2 refuses, Task 6 hides the button) · follower_count_at_post per video, deal = seq-1 mirror ✔ (Task 1) · allowlist trim ships in the same worker deploy as the rollup ✔ (Tasks 1–5 = one deploy in Task 5) · Add-video not exposed before the worker ships ✔ (Task 6 after Task 5's deploy) · slice 4 in the same ship ✔ · drill-down sums to tile by construction ✔ (Task 4 test 2) · views only move, spend/conversions/unallocated unchanged ✔ (Task 5 leaves those lines).
- **Placeholders:** none — every code step is complete; the one judgement left to the executor is Task 3 Step 3 (whether the advance-to-live path writes `video_link`/`post_date` directly), with the exact grep to settle it.
- **Type consistency:** `rollupVideos(videos)` → object with `metric_gaps` (Task 1) is what `recomputeVideoRollup` PATCHes (Task 2); `bucketVideoViewsByMonth(engagements, videos)` → `{ byMonth, rows }` (Task 4) is consumed as such in Task 5; breakdown rows carry `seq` + `take_post_date` (Task 5) and Task 7 reads exactly those; the UI calls `setEngagementVideo` with `{ engagement_id, seq?, …VIDEO_FIELDS }` and `deleteEngagementVideo` with `{ engagement_id, seq }` (Task 2 ↔ Task 6).
- **Known limit, not a gap:** both monthly handlers fetch `engagement_videos` with `limit=5000`; PostgREST caps at 5,000 regardless. 411 rows today, hard ceiling 6 × deals. Page when deals × 6 approaches 5,000 (~830 deals) — note carried in the code comment.
