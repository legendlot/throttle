# Odo Ingestion on Cloudflare Workflows — Design

> Date: 2026-06-25 (Session 169). System: Odo (`odoops` worker). Status: design.
> Supersedes the in-tick budget scheduler for connector ingestion. Blast radius: Odo only.

## Problem

`odoops` ingests ~13 sales/marketing/traffic connectors via an hourly cron
(`scheduled()` in `odoops-worker/src/index.js`). All connectors run **inside one cron
invocation** and share **one ~45-subrequest budget** (Cloudflare's hard cap is 50 per
invocation). The loop processes connectors and `break`s when the budget is exhausted.

Multi-month historical backfills (Google Ads + Meta Ads, both at cursor `2025-04-01`;
Amazon SP-API finance, reset to `2025-04-01`) consume the entire budget every tick, so
the cheap daily sell-out connectors (Website, Blinkit, Zepto, Instamart, GT, MT, Amazon
Ads) at the tail of the loop were **deferred every hour** and went stale for ~2 days
(S166/S168 onward). A staleness-first ordering fix shipped S169 (commit `d0aa7e3`) as an
interim — it shares the one budget fairly but does not add capacity.

**Root constraint:** the 50-subrequest limit is **per Worker invocation**, and all
connectors share one invocation. The durable fix is to give **each connector its own
invocation(s)** so each gets its own fresh budget.

## Decision

Adopt **Cloudflare Workflows**. The hourly cron becomes a thin producer that spawns **one
`ConnectorWorkflow` instance per enabled connector**. Each instance runs durably, looping
one window of work per **step** — and each `step.do()` is a separate execution with its
**own fresh 50-subrequest budget**. Workflows adds, for free, what the worker currently
hand-rolls: durable continuation across windows, per-step retries with backoff, durable
sleep between async-report polls, and crash/deploy resumption.

Queues were considered and rejected as the *primary* mechanism: they isolate per-message
budget but still leave backfill-chaining and report-poll waits as hand-rolled state — the
exact fragility (cursor juggling, `pending_report_id` state, "stuck at Nov 2025" bug) we
want to retire. Queues remain a *future* option purely for centralized rate-limiting if
connector breadth grows. Supabase Edge Functions + pg_cron were rejected: no durable
sleep/checkpointing (same hand-rolled poller problem) and they abandon the existing
Cloudflare adapter code.

## Why this is low-risk: `executeRun` already fits a step

`executeRun(cfg, runId, env, {budget, cursorOverride})` (index.js:1293) is already the
atomic single-window unit and is **idempotent + retry-safe**:
- fetch → stage (upsert on source line id) → `recompute_facts` (delete+reinsert per
  channel/date) → `finishRun` → PATCH `connector_config` (advance `cursor`, stamp
  `last_ok_at`, clear `last_error`).
- Re-running it re-stages the same window and recomputes the same dates — totals are
  byte-identical (RULE-SALES-001 idempotency). So a Workflows step retry is safe.
- Adapters page strictly forward and persist their own `config` state (Amazon via
  `patchConnectorConfig`), so each call resumes from the persisted cursor.

Therefore **one generic `ConnectorWorkflow` wraps `executeRun`** — no per-adapter
workflow, and the adapters themselves are untouched.

## Architecture

```
scheduled() (hourly, "0 * * * *")        // PRODUCER — does ~no ingestion itself
  ├─ list enabled connector_config
  └─ for each: single-flight check → env.CONNECTOR_WF.create({ id, params:{channelId, trigger:'cron'} })

ConnectorWorkflow.run(event, step)        // one instance PER connector
  loop i = 0..MAX_WINDOWS:
    res = step.do(`window-${i}`, {retries, timeout}, () =>
            executeRunWF(channelId, trigger, cursorOverride if i==0, budget:50))
            // fetch+stage+recompute+advance cursor for ONE window; returns a SMALL summary
    if !res.partial: break          // caught up
    if res.waitMs:  step.sleep(`wait-${i}`, res.waitMs)   // async report still processing
    // else: more history ready now → next step, fresh budget
```

### Generic, adapter-agnostic
The workflow only knows `channelId` + `trigger`. It re-loads `connector_config` fresh
inside each step (so the cursor advanced by the previous step is picked up), calls the
existing `executeRun`, and reads back a small summary. Works identically for every
`adapter_kind`.

### `executeRun` return shape (the only change to the core)
Today `executeRun` returns `{ subreqs }`. Extend it to return a **small, serializable**
summary (well under the 1 MiB step-output cap):
```js
{ subreqs, partial, cursorAfter, status, rows, waitMs }
```
- `partial` — already computed by adapters; drives the loop.
- `waitMs` — **central heuristic** (no adapter change): for the async-report pollers, a
  "report still processing" turn returns `partial:true` with `rows:[]` and **no**
  `cursorAfter`. In that case `waitMs = 10*60*1000` so the workflow sleeps ~10 min instead
  of hot-looping; otherwise `waitMs = 0` (more data ready now → continue immediately).
- Existing non-workflow caller (`ingestUpload` path) ignores the extra fields.

### Single-flight (no overlapping instances per connector)
A long backfill instance may still be running when the next hourly cron fires. To prevent
two instances pulling the same connector concurrently:
- Add column `sales.connector_config.wf_instance_id text`.
- Producer, per connector: if `wf_instance_id` is set, call
  `env.CONNECTOR_WF.get(wf_instance_id).status()`; if status ∈
  {`queued`,`running`,`waiting`,`paused`} → **skip** (already in flight). Otherwise create
  a new instance and store its id.
- Instance id = `${channelId}-${Date.now()}` (≤100 chars; unique per trigger — Workflows
  forbids reusing an id, so a per-channel constant id cannot be used).
- `.get()` on an expired/unknown id throws → caught → treated as "not in flight, proceed".

### Manual triggers route through the same workflow
`refreshNow` and `backfill` HTTP actions (index.js:1626/1636) currently
`ctx.waitUntil(executeRun(...))`. They become thin wrappers that spawn a `ConnectorWorkflow`
instance (trigger `'manual'` / `'backfill'`, passing `cursorOverride` for backfill). Same
durable looping + budget isolation as the cron path. `uploadReport` (QC CSV) stays as-is
(synchronous, bounded, no paging).

## Worker runtime details (must-haves)
- Import: `import { WorkflowEntrypoint } from 'cloudflare:workers';` at the top of
  `odoops-worker/src/index.js`. Export `export class ConnectorWorkflow extends
  WorkflowEntrypoint { async run(event, step) {…} }` alongside `export default {…}`.
- **Set the module global inside `run()`**: `SUPABASE_SERVICE_KEY = this.env.SUPABASE_SERVICE_KEY`
  at the start of every workflow run (a workflow can execute in a fresh isolate where the
  global set by `scheduled()`/`fetch()` is not present). Reset `_channels = null` too.
- `this.env` / `this.ctx` are available on the entrypoint instance; steps call the existing
  module-scope helpers (`startRun`, `executeRun`, `sbSales`, …) directly.
- Plain JS is fully supported (no TS required).
- `wrangler.toml` binding (⚠️ requires explicit permission to edit):
  ```toml
  [[workflows]]
  name = "odoops-connector"
  binding = "CONNECTOR_WF"
  class_name = "ConnectorWorkflow"
  ```
- No new `compatibility_flags` needed; `compatibility_date = 2026-05-28` supports Workflows.

## Limits (verified 2026-06-25, Workers Paid)
- Steps/workflow: up to 10,000 (default) — we cap at `MAX_WINDOWS = 24` per instance to
  bound an instance; a still-backfilling connector simply continues on the next cron tick.
- Step output: 1 MiB — our summary is tiny; **never return row arrays from a step.**
- step.sleep: up to 365 days; sleeping instances **don't count toward concurrency.**
- Concurrent instances: 50,000; creation 100/s per workflow — we create ≤13/hour. Ample.
- State retention: 30 days.

## Step retry policy
`step.do(name, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
timeout: '5 minutes' }, cb)`. Because `executeRun` is idempotent, a transient API/DB error
retries the window safely. After 3 failures the step (and instance) errors; `executeRun`
already PATCHes `last_error` on its own catch, so the failure is visible in
`connector_config.last_error` + `connector_runs.status='error'`.

## Observability
- `connector_runs` already logs one row per window (per step) — unchanged, now more
  granular (one row per window instead of one per cron tick).
- Add a `wfProbe` diagnostic GET action (`canConnector`-gated): for a given `channel_id`,
  return `connector_config.wf_instance_id` + `env.CONNECTOR_WF.get(id).status()` so we can
  inspect a live instance's state/step without the Cloudflare dashboard.
- `getBootstrap`/Connectors page need no change (they read `connector_config` +
  `connector_runs`, both still populated).

## Migration & rollback
- DB migration `odo_connector_wf_single_flight_v1`: `ALTER TABLE sales.connector_config ADD
  COLUMN IF NOT EXISTS wf_instance_id text;` (additive, non-destructive).
- Rollback: the S169 staleness-ordered `scheduled()` loop is the fallback. If the workflow
  path misbehaves, revert `scheduled()` to the loop (kept in git history) and redeploy —
  the adapters/`executeRun` are unchanged, so no data path breaks.

## Out of scope
- Cloudflare Queues (future rate-limiting only).
- Refactoring the Amazon adapters' internal create→poll→download into discrete steps — the
  central `waitMs` heuristic already gives them durable polling without touching them. A
  later refinement could lift `pending_report_id` state into workflow steps, but it is not
  required and is explicitly deferred.

## Verification model
This worker has **no unit-test harness** (single-file Cloudflare worker; verification is by
bundle dry-run + deploy + diagnostic probes + `connector_runs`/`connector_config`
inspection, matching `amazonProbe`/`uniwareProbe`/`financeProbe`). The plan uses:
1. `npx wrangler deploy --dry-run` — bundles the worker, proves the WorkflowEntrypoint +
   binding compile.
2. Deploy; `wfProbe` + a manual `refreshNow` on one cheap connector → confirm an instance
   is created, loops, and `connector_config.last_ok_at` advances.
3. SQL on `connector_runs` (per-window rows appear) + `connector_config` (`wf_instance_id`
   set, `cursor`/`last_ok_at` advancing) for a backfilling connector across two cron ticks.
4. Confirm the previously-starved connectors all reach a current `last_ok_at`.
