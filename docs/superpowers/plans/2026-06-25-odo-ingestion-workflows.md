# Odo Ingestion on Cloudflare Workflows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `odoops` connector ingestion off the single shared-budget cron loop onto Cloudflare Workflows — one durable `ConnectorWorkflow` instance per connector, each step getting its own 50-subrequest budget — so no connector starves another.

**Architecture:** The hourly cron becomes a thin producer that single-flight-spawns one `ConnectorWorkflow` per enabled connector. The workflow loops one window of work per `step.do()` (each a fresh execution), reusing the existing idempotent `executeRun` unchanged-in-spirit; it `step.sleep`s when an async report is still processing. Manual `refreshNow`/`backfill` route through the same workflow. Design: `docs/superpowers/specs/2026-06-25-odo-ingestion-workflows-design.md`.

**Tech Stack:** Cloudflare Workers + Workflows (`cloudflare:workers` `WorkflowEntrypoint`), single-file JS worker `05_Throttle/odoops-worker/src/index.js`, Supabase `sales` schema, wrangler.

**Verification model (read first):** This worker has **no unit-test harness** — it is a single-file Cloudflare worker verified by bundle dry-run + deploy + diagnostic probes + SQL on `sales.connector_runs`/`connector_config` (the pattern used by `amazonProbe`/`uniwareProbe`/`financeProbe`). Each task below therefore verifies via `wrangler deploy --dry-run`, SQL, and probe calls — **not** Jest. Do not invent a test framework.

**Deploy sequence (every task that changes the worker):** edit → `git add` → `git commit` → `git push` → `cd 05_Throttle/odoops-worker && npx wrangler deploy`. Intermediate states are safe to deploy: an exported `ConnectorWorkflow` class that nothing calls, and a `[[workflows]]` binding that nothing uses, are both inert until the producer (Task 6) switches over.

---

## File Structure

- **Modify** `05_Throttle/odoops-worker/src/index.js`:
  - top: add `import { WorkflowEntrypoint } from 'cloudflare:workers';` + `MAX_WINDOWS` const.
  - `executeRun` (~1293): return a richer small summary.
  - new module helpers: `loadConnectorCfg`, `startConnectorWf`.
  - new `export class ConnectorWorkflow` (after the helpers, before/after `export default`).
  - `scheduled()` (~1362): rewrite as producer.
  - `refreshNow` + `backfill` POST cases (~1626/1636): route to workflow.
  - GET switch: add `wfProbe` case.
- **Modify** `05_Throttle/odoops-worker/wrangler.toml`: add `[[workflows]]` binding (⚠️ requires explicit user permission — confirm before Task 5).
- **DB migration** `odo_connector_wf_single_flight_v1` (additive column).

---

### Task 1: DB migration — single-flight column

**Files:** Supabase migration `odo_connector_wf_single_flight_v1` (via `apply_migration`).

- [ ] **Step 1: Verify current schema**

Run (Supabase MCP `execute_sql`, project `jkxcnjabmrkteanzoofj`):
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='sales' AND table_name='connector_config' ORDER BY ordinal_position;
```
Expected: `channel_id, adapter_kind, enabled, cursor, schedule_note, last_ok_at, last_error, config` (no `wf_instance_id`).

- [ ] **Step 2: Apply the migration**

Run (`apply_migration`, name `odo_connector_wf_single_flight_v1`):
```sql
ALTER TABLE sales.connector_config ADD COLUMN IF NOT EXISTS wf_instance_id text;
```

- [ ] **Step 3: Verify the column exists**

Run (`execute_sql`):
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='sales' AND table_name='connector_config' AND column_name='wf_instance_id';
```
Expected: one row, `wf_instance_id | text`.

---

### Task 2: Extend `executeRun` to return a workflow-friendly summary

**Files:** Modify `05_Throttle/odoops-worker/src/index.js:1293-1327`.

- [ ] **Step 1: Replace the success + error returns**

Find the success tail of `executeRun` (the block from `const okPatch = { last_ok_at: nowISO(), last_error: null };` through `return { subreqs };`) and replace with:

```js
    const okPatch = { last_ok_at: nowISO(), last_error: null };
    if (cursorAfter) okPatch.cursor = cursorAfter;
    await sbSales(`/rest/v1/connector_config?channel_id=eq.${cfg.channel_id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(okPatch) });
    // Workflow loop hints (small, serializable — never return row arrays):
    //  partial   → more work remains for this connector (another window, or a pending report)
    //  waitMs    → an async report is still processing (partial + no rows + no cursor advance);
    //              the workflow step.sleeps this long instead of hot-looping. 0 = continue now.
    const waitMs = (partial && rows.length === 0 && !cursorAfter) ? 10 * 60 * 1000 : 0;
    return { subreqs, partial: !!partial, cursorAfter: cursorAfter || null, status: partial ? 'partial' : 'ok', rows: rows.length, waitMs };
  } catch (e) {
    await finishRun(runId, { status: 'error', error: String(e?.message || e) });
    await sbSales(`/rest/v1/connector_config?channel_id=eq.${cfg.channel_id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ last_error: String(e?.message || e) }) });
    return { subreqs: 0, partial: false, cursorAfter: null, status: 'error', rows: 0, waitMs: 0, error: String(e?.message || e) };
  }
}
```

(The lines above `const okPatch` — fetch/stage/recompute/finishRun — are unchanged.)

- [ ] **Step 2: Bundle dry-run**

Run: `cd 05_Throttle/odoops-worker && npx wrangler deploy --dry-run 2>&1 | tail -5`
Expected: `Total Upload: …` with no syntax/bundle error.

- [ ] **Step 3: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/src/index.js
git commit -m "odoops: executeRun returns workflow loop summary (partial/waitMs/cursorAfter)"
git push
```

---

### Task 3: Add the `ConnectorWorkflow` class + spawn helpers

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` (top import + new helpers + new exported class).

- [ ] **Step 1: Add the import + constant at the top of the file**

After the existing header comment block / before `const SUPABASE_URL` (line ~20), add:
```js
import { WorkflowEntrypoint } from 'cloudflare:workers';
// Max windows a single ConnectorWorkflow instance pulls before ending (a still-backfilling
// connector simply continues on the next cron tick). Bounds instance lifetime.
const MAX_WINDOWS = 24;
```

- [ ] **Step 2: Add helpers next to `runChannel` (after line ~1331)**

```js
// Load one connector's live config row (fresh — picks up a cursor advanced by a prior step).
async function loadConnectorCfg(channelId) {
  const r = await sbSales(`/rest/v1/connector_config?channel_id=eq.${channelId}&select=*`);
  return (r.ok && r.data[0]) ? r.data[0] : null;
}
// Spawn a ConnectorWorkflow instance for one connector and record its id for single-flight.
async function startConnectorWf(env, channelId, trigger, cursorOverride) {
  const id = `${channelId}-${Date.now()}`;
  await env.CONNECTOR_WF.create({ id, params: { channelId, trigger, cursorOverride: cursorOverride || null } });
  await sbSales(`/rest/v1/connector_config?channel_id=eq.${channelId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ wf_instance_id: id }) });
  return id;
}
```

- [ ] **Step 3: Add the exported workflow class (place it immediately before `export default {`)**

```js
// One instance per connector. Each step.do() is a fresh execution with its own 50-subreq
// budget; the loop drains windows until the adapter reports no more work (partial=false),
// sleeping when an async report is still processing (waitMs>0). executeRun is idempotent,
// so any step retry is safe.
export class ConnectorWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    SUPABASE_SERVICE_KEY = this.env.SUPABASE_SERVICE_KEY || '';
    _channels = null;
    const { channelId, trigger = 'cron', cursorOverride = null } = event.payload || {};
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const res = await step.do(
        `window-${i}`,
        { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        async () => {
          SUPABASE_SERVICE_KEY = this.env.SUPABASE_SERVICE_KEY || '';
          _channels = null;
          const cfg = await loadConnectorCfg(channelId);
          if (!cfg || !cfg.enabled) return { partial: false, status: 'skipped', rows: 0, waitMs: 0, subreqs: 0, cursorAfter: null };
          const ov = (i === 0 && cursorOverride) ? cursorOverride : undefined;
          const runId = await startRun(cfg, trigger, null, ov);
          return await executeRun({ ...cfg, started_by: null }, runId, this.env, { budget: 50, cursorOverride: ov });
        }
      );
      if (!res || !res.partial) break;
      if (res.waitMs) await step.sleep(`wait-${i}`, res.waitMs);
    }
    return { channelId, windows: 'done' };
  }
}
```

- [ ] **Step 4: Bundle dry-run**

Run: `cd 05_Throttle/odoops-worker && npx wrangler deploy --dry-run 2>&1 | tail -8`
Expected: bundles cleanly. (It may warn that `CONNECTOR_WF` is referenced but not bound — that binding is added in Task 5. The bundle itself must succeed with no syntax error.)

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/src/index.js
git commit -m "odoops: add ConnectorWorkflow + startConnectorWf/loadConnectorCfg helpers"
git push
```

---

### Task 4: Add `wfProbe` diagnostic (GET)

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` (GET `switch (action)` block, near the other `get*` cases ~1399+).

- [ ] **Step 1: Add the case**

Inside the `if (request.method === 'GET') { … switch (action) {` block, add a case (e.g. after `getBootstrap`):
```js
          case 'wfProbe': {
            if (!canConnector(P)) return err('No permission', 403);
            const cid = url.searchParams.get('channel_id');
            if (!cid) return err('channel_id required');
            const cfgR = await sbSales(`/rest/v1/connector_config?channel_id=eq.${cid}&select=wf_instance_id,cursor,last_ok_at,last_error`);
            const cfg = (cfgR.ok && cfgR.data[0]) ? cfgR.data[0] : null;
            let status = null;
            if (cfg?.wf_instance_id) {
              try { status = await (await env.CONNECTOR_WF.get(cfg.wf_instance_id)).status(); }
              catch (e) { status = { error: String(e?.message || e) }; }
            }
            return ok({ channel_id: cid, wf_instance_id: cfg?.wf_instance_id || null, cursor: cfg?.cursor || null, last_ok_at: cfg?.last_ok_at || null, last_error: cfg?.last_error || null, status });
          }
```

- [ ] **Step 2: Bundle dry-run**

Run: `cd 05_Throttle/odoops-worker && npx wrangler deploy --dry-run 2>&1 | tail -5`
Expected: bundles cleanly.

- [ ] **Step 3: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/src/index.js
git commit -m "odoops: add wfProbe diagnostic (inspect a connector's workflow instance status)"
git push
```

---

### Task 5: Add the Workflows binding to wrangler.toml ⚠️ NEEDS USER PERMISSION

**Files:** Modify `05_Throttle/odoops-worker/wrangler.toml`.

> The project rule forbids editing `wrangler.toml` without explicit permission. Confirm with the user before this task. The class (Task 3) must already be exported.

- [ ] **Step 1: Append the binding (after the `[triggers]` block)**

```toml
[[workflows]]
name = "odoops-connector"
binding = "CONNECTOR_WF"
class_name = "ConnectorWorkflow"
```

- [ ] **Step 2: Dry-run to confirm the binding resolves to the exported class**

Run: `cd 05_Throttle/odoops-worker && npx wrangler deploy --dry-run 2>&1 | tail -10`
Expected: bundles cleanly; no "class_name ConnectorWorkflow not found" error; binding `CONNECTOR_WF` listed.

- [ ] **Step 3: Deploy (registers the Workflow; producer still on the old loop until Task 6)**

Run: `cd 05_Throttle/odoops-worker && npx wrangler deploy 2>&1 | tail -8`
Expected: `Deployed odoops` + a Workflow `odoops-connector` registered. The worker is still functionally identical (nothing calls the workflow yet).

- [ ] **Step 4: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/wrangler.toml
git commit -m "odoops: bind ConnectorWorkflow (CONNECTOR_WF) in wrangler.toml"
git push
```

---

### Task 6: Switch the cron producer + manual triggers to Workflows

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` — `scheduled()` (~1362) and the `refreshNow`/`backfill` POST cases (~1626/1636).

- [ ] **Step 1: Replace the body of `scheduled()`**

Replace the current `scheduled(event, env, ctx)` body (the `try { … for (const cfg …) … }` budget loop) with:

```js
  async scheduled(event, env, ctx) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    _channels = null;
    try {
      // PRODUCER: spawn one ConnectorWorkflow per enabled connector. Single-flight — skip a
      // connector whose previous instance is still in flight (long backfill), so we never
      // run two instances for the same connector concurrently. Each instance gets its own
      // per-step subrequest budget, so connectors no longer compete for one shared budget.
      const r = await sbSales('/rest/v1/connector_config?enabled=eq.true&select=channel_id,wf_instance_id');
      for (const cfg of (r.ok ? r.data : [])) {
        if (cfg.wf_instance_id) {
          try {
            const st = await (await env.CONNECTOR_WF.get(cfg.wf_instance_id)).status();
            if (['queued', 'running', 'waiting', 'paused'].includes(st?.status)) continue; // already in flight
          } catch { /* unknown/expired instance id → safe to start a new one */ }
        }
        try { await startConnectorWf(env, cfg.channel_id, 'cron', null); }
        catch (e) { console.error('odoops producer: failed to start', cfg.channel_id, e?.message || e); }
      }
    } catch (e) { console.error('odoops cron (producer) failed:', e?.message || e); }
  },
```

- [ ] **Step 2: Replace the `refreshNow` case**

```js
          case 'refreshNow': {
            if (!canRefresh(P)) return err('No permission', 403);
            const one = d.channel_id;
            const cfgR = await sbSales(`/rest/v1/connector_config?enabled=eq.true${one ? `&channel_id=eq.${one}` : ''}&select=channel_id`);
            const cfgs = cfgR.ok ? cfgR.data : [];
            if (!cfgs.length) return err('No enabled connector for that channel', 404);
            const ids = [];
            for (const c of cfgs) ids.push(await startConnectorWf(env, c.channel_id, 'manual', null));
            return ok({ instances: ids, started: cfgs.length });
          }
```

- [ ] **Step 3: Replace the `backfill` case**

```js
          case 'backfill': {
            if (!canConnector(P)) return err('No permission', 403);
            if (!d.channel_id) return err('channel_id required');
            const cfgR = await sbSales(`/rest/v1/connector_config?channel_id=eq.${d.channel_id}&select=channel_id`);
            if (!cfgR.ok || !cfgR.data[0]) return err('Connector not found', 404);
            const cursorOverride = d.from ? (d.from.length === 10 ? d.from + 'T00:00:00Z' : d.from) : BACKFILL_START;
            const instance = await startConnectorWf(env, d.channel_id, 'backfill', cursorOverride);
            return ok({ instance });
          }
```

- [ ] **Step 4: Bundle dry-run**

Run: `cd 05_Throttle/odoops-worker && npx wrangler deploy --dry-run 2>&1 | tail -5`
Expected: bundles cleanly.

- [ ] **Step 5: Deploy**

Run: `cd 05_Throttle/odoops-worker && npx wrangler deploy 2>&1 | tail -8`
Expected: `Deployed odoops` + Workflow `odoops-connector` listed.

- [ ] **Step 6: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/src/index.js
git commit -m "odoops: cron producer + refreshNow/backfill spawn ConnectorWorkflow instances (per-connector budget isolation)"
git push
```

---

### Task 7: Live verification

**Files:** none (runtime verification).

- [ ] **Step 1: Trigger one cheap connector manually and confirm an instance is created**

As a signed-in admin (or via a stored JWT), POST `refreshNow` with `{ channel_id: <Blinkit id> }` to `https://odoops.afshaan.workers.dev`. Then probe:

Run (`execute_sql`):
```sql
SELECT c.name, cc.wf_instance_id, cc.last_ok_at, cc.last_error
FROM sales.connector_config cc JOIN public.dispatch_channels c ON c.id=cc.channel_id
WHERE c.name='Blinkit';
```
Expected: `wf_instance_id` is set to a `<uuid>-<ms>` id; after the instance runs, `last_ok_at` is current and `last_error` is null.

- [ ] **Step 2: Confirm per-window run rows are being written**

Run (`execute_sql`):
```sql
SELECT adapter_kind, status, rows_fetched, subrequests_used, started_at
FROM sales.connector_runs
WHERE started_at > now() - interval '15 minutes'
ORDER BY started_at DESC LIMIT 20;
```
Expected: fresh rows for the triggered connector (and, after the next cron tick, for every enabled connector) — one row per window, status `ok`/`partial`.

- [ ] **Step 3: Confirm the cron producer fans out to all connectors (after the next top-of-hour tick)**

Run (`execute_sql`):
```sql
SELECT c.name, cc.adapter_kind, cc.last_ok_at
FROM sales.connector_config cc JOIN public.dispatch_channels c ON c.id=cc.channel_id
WHERE cc.enabled=true ORDER BY cc.last_ok_at DESC NULLS LAST;
```
Expected: **every** enabled connector — including the previously-starved Website/Blinkit/Zepto/Instamart/GT/MT/Amazon-Ads — has a `last_ok_at` within the last ~1–2 hours. No connector stuck days behind.

- [ ] **Step 4: Confirm a backfilling connector advances across windows/ticks**

Run (`execute_sql`) twice, ~1h apart, for Google Ads / Meta Ads:
```sql
SELECT c.name, cc.cursor, cc.last_ok_at
FROM sales.connector_config cc JOIN public.dispatch_channels c ON c.id=cc.channel_id
WHERE c.name IN ('Google Ads','Meta Ads');
```
Expected: `cursor` moves forward from `2025-04-01` toward today between checks (the backfill is now draining in its own instances, not blocking the daily connectors).

- [ ] **Step 5: Confirm single-flight (no duplicate concurrent instances)**

Run `wfProbe` GET (`?action=wfProbe&channel_id=<a backfilling channel>`); confirm `status.status` is a single live instance (`running`/`waiting`), and that the cron did not spawn a second one while it was in flight (re-check `wf_instance_id` is unchanged across a tick where status was `running`).

---

## Self-Review

**Spec coverage:**
- Per-connector instance + per-step budget → Task 3 (class) + Task 6 (producer). ✓
- `executeRun` summary (`partial`/`waitMs`/`cursorAfter`) → Task 2. ✓
- Single-flight via `wf_instance_id` + `.status()` → Task 1 (column) + Task 6 (producer) + Task 3 (`startConnectorWf` records id). ✓
- Manual `refreshNow`/`backfill` through the workflow → Task 6. ✓
- `wfProbe` observability → Task 4. ✓
- wrangler binding + module global set in `run()` → Task 5 + Task 3 (`SUPABASE_SERVICE_KEY = this.env…`). ✓
- Migration + rollback (revert `scheduled()` to the S169 loop) → Task 1 + documented in spec. ✓

**Placeholder scan:** no TBD/placeholder steps; every code step shows complete code.

**Type/name consistency:** `CONNECTOR_WF` (binding), `ConnectorWorkflow` (class_name), `startConnectorWf`, `loadConnectorCfg`, `wf_instance_id`, `MAX_WINDOWS`, summary keys `{subreqs, partial, cursorAfter, status, rows, waitMs}` — used identically across Tasks 2/3/4/5/6.

## Notes & risks
- **Workers Paid confirmed** (user) — Workflows requires it. ✓
- **Blast radius:** Odo only. The dashboard read paths (`getSales`/`getBootstrap`/…) are untouched.
- **Rollback:** revert `scheduled()` to the S169 staleness-ordered loop (`git revert`/cherry-pick the prior body) and redeploy; adapters + `executeRun` are unchanged, so no data path breaks. The `[[workflows]]` binding and class can remain (inert).
- **Deferred (not in this plan):** lifting the Amazon create→poll→download `pending_report_id` state into discrete workflow steps (the central `waitMs` heuristic already gives durable polling); Cloudflare Queues for cross-connector rate-limiting.
