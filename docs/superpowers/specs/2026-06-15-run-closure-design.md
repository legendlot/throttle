# Run Closure v1 — derive-and-day-close + partial / finishing model

> Status: **DESIGN APPROVED IN PRINCIPLE — PARKED before implementation.** Resume from "Build sequence" once the open decisions are confirmed. Do NOT start the build off this doc without re-reading the open decisions with Afshaan.
> Date: 2026-06-15 (Session 139)
> System: Redline / Garage / Scanner cluster (lotopsproxy). Schema `store.production_runs`, `public.scans`/`units`, RPC `get_plan_vs_actual`.
> Scope: #1 (run closure) + #3 (exec card relabel — same screen/metric). #2 (Redline SOPs) is a SEPARATE spec.

---

## 1. Problem

Production runs pile up unclosed. As of 2026-06-15:

- **58 in-house runs sit in `Issued`**, spanning `2026-05-19 → 2026-06-16`.
- **The last in-house run ever marked `Completed` was 2026-05-26.** Closure today depends on someone manually hitting `completeProductionRun` or a line-flush side-effect; when that stopped happening, runs just accumulated. There is no data-driven close.

### Root cause — nothing produced is attributed to a run
- `units.production_run_id` is **NULL on all 80,315 units** (the INW handler tries `production_run_id: d.plan_id` but the scanner never sends `plan_id`).
- `scans.plan_id` is **NULL on all ~256k scans**.
- A run is only `(product, line_no, run_date, shift)`. Units flow INW→QC→PKG→PKG OUT→dispatch attributed **only to a line**, never to the run that authorised them.

So "is this run done?" had no data answer → the manual fallback → bloat.

### The break that makes it tractable
`public.get_plan_vs_actual(from,to,line)` **already derives per-run output** by joining each run `(run_date, product, line_no)` to scan actuals `(scan_date, product, line)`. It returns `target_qty`, `actual_qc_pass`, `actual_rtr`, `actual_rte`, and `total_dispatched = rtr+rte`. That `total_dispatched` **is PKG OUT** (see §2). The attribution we need already exists and is already computed per run.

### Output-marker fact (resolved with Afshaan)
- There is **no `PKG_OUT` scan activity.** The PKG OUT station writes **`RTE` (ready-to-ecom)** / **`RTR` (ready-to-retail)**. `RTE+RTR ≈ 40,458` ≈ `PKG` (40,598).
- **PKG OUT is a PRODUCTION scan, not dispatch.** Dispatch responsibility starts at the **`DTK`** scan. So a run's true output = `RTE + RTR`, and it happens on-shift (won't lag overnight → safe to use for same-day labelling).
- Consequence for #3: the exec card labelled **"Dispatched"** is *already* `rtr+rte` = PKG OUT; it is **mislabelled**. Real dispatch-out (`DOUT`, ~14k scans) is not projected on these cards.

### Uniqueness fact (validated)
`(product, line_no, run_date)` is **unique across all history except one case** (Rumble L1 2026-05-22: RUN-090 + RUN-094 both Issued). So a **pure-derived, by-key** closure is safe, with a flag for the rare collision. No scan-path change required.

---

## 2. Model (agreed)

- **Every run is bound to a day. Carry-over is killed.** Steady state: a run starts and finishes the same day. No multi-day runs, no suspend/extend, no material carry-forward.
- **All runs close by the day** via a nightly job. The close timestamp = the **last production scan that day** for the run's `(line, product)`; if zero scans → end of run-date.
- We **accept** zero-unit runs and partial runs as a transitional reality — the system *measures the mess* (a floor-health KPI) instead of pretending it's clean. When the floor is streamlined, the same machinery just reports clean same-day runs; nothing changes.
- A run that didn't finish its material is **closed anyway** (for its day). The remaining material stays physically on the floor as WIP. To finish it, production creates a **finishing run** on a later day — a run type that **requires no new store issue** and is **optionally linked** to the partial run it continues.

### Why finishing-runs need no issue (the material-traceability resolution)
The kit was issued and costed **once**, on the original partial run. The finishing run consumes WIP already on the floor → it debits no stock and demands no pick. Because output is attributed by **date**, the finishing run's day is credited with the real PKG OUT, while the partial run shows prep only. The **link** (`continues_run_no`) is what lets the pair reconcile to a true combined yield.

---

## 3. Design

### A. Attribution — reuse, extend, do NOT touch the scan path
- Output `produced = actual_rtr + actual_rte` (PKG OUT), keyed by `(run_date, product, line_no)` — already in `get_plan_vs_actual`.
- **Extend** the `actuals` CTE (or a closure-specific RPC) to also count **INW** and **PKG** so we can diagnose *how far* a partial got (raw → inwarded → QC'd → packed → out). Cars only (`component_type <> 'remote'` / `= 'car'`, matching the existing RPC convention).
- **No change to `02_scanner` or the worker INW handler.** This keeps the feature off the 3-system-blast-radius scan path entirely. (Tagging units/scans to runs is explicitly a **v2** robustness item — see §7.)
- The single `(product,line,date)` collision is **detected and flagged** (`needs_review`), never silently merged.

### B. Closure engine — one nightly job (mirror attendance auto-close)
A Supabase `pg_cron` job `auto_close_production_runs`, ~1 AM IST (same shape as the live `auto_close_open_attendance`). For every **prior-day** in-house run still `Issued`/`In Progress`:
1. **Snapshot** derived actuals onto the run row (`produced_qty`, `inwarded_qty`, `qc_pass_qty`, `packaged_qty`, `target_qty_snapshot`) — freezes the numbers so a later straggler scan / return can't rewrite a closed run's history (the live RPC stays live; the row is the frozen record).
2. Stamp `completed_at` = the last production scan that day (INW/QC_PASS/PKG/RTE/RTR) for `(line, product)`; if zero scans → end of `run_date` (e.g. 23:59 IST).
3. Set `status='Completed'`, `close_reason='day_close'`.

Only touches `run_date < today`, so a run opened today is left alone. Steady state: the Issued list drains every night unconditionally.

### C. Classification — two independent axes, both derived from the snapshot
- **Output axis:** `produced_qty (PKG OUT) > 0` → **Output run**; `= 0` → **Partial / prep run**.
- **Completeness axis** (output runs only): `produced ≥ target − tolerance` → **Complete**; else **Short**.
- Resulting label set: **Complete · Short · Partial · Zero**. Computed in a read RPC → badges in Redline. No manual state.
- **Keep the two axes separate** — a 340/350 run is "Output, Short", NOT "Partial". Partial = zero output.

### D. Finishing run — first-class, issue-exempt run type
- New `run_type = 'finishing'`.
- **No store issue**: no planned-WO pick demand in the Garage Issue Queue, no stock debit, skipped by producibility / `checkRunBomStock`. Must be made first-class in **every** path where a run touches stock/issue (issueAgainstRun, line flush, short-issue WOs, Issue Queue, producibility) — a half-wired no-issue type is where silent bugs breed (cf. the `wo_type` CHECK omissions in history).
- **Optional, prompted link** to a partial run: `continues_run_no text`. On create, surface open partial runs for that `(product, line)` to pick from. The link is *prompted* (not buried, not silently optional) because yield only reconciles via it (a finishing run shows PKG OUT > its own INW — only sensible paired with its partial).
- Output attributes to the finishing run's own day automatically (date-keyed derivation) → real output on the finishing run, prep-only on the partial.

### E. Schema (all additive)
On `store.production_runs`:
`produced_qty int`, `inwarded_qty int`, `qc_pass_qty int`, `packaged_qty int`, `target_qty_snapshot int`, `close_reason text`, `continues_run_no text`, `needs_review boolean default false`.
- Widen the `run_type` CHECK to allow `'finishing'` (in the **same** migration that introduces the value).
- New `close_production_run()` SQL fn (single-run close, used by the cron + manual "Close now") + the `pg_cron` job + a read RPC returning the classified list.
- **No change to `public.units` / `public.scans`.** Snapshot table before backfill (RULE-005 discipline / reversibility).

### F. Backfill — one-time
On first run, the same job closes the **58 stuck prior-day runs** with their derived actuals, flagging the single collision (RUN-090/094) and any zero/short for review. Snapshot the affected rows first (`store.safety_run_closure_backfill_2026_06_15`). Reversible.

### G. Redline surfacing
- **Recent Runs** (in `apps/redline/(auth)/new-run`, or the new `/production-history`): **Output / Short / Partial / Zero** badges + made/target, and a filter for partial/zero.
- **Finishing-run create** flow: the partial-run link picker for `(product, line)`.
- Keep manual **Close now** (existing `completeProductionRun`) + add **Reopen** for the rare wrong-close — overrides, not the primary path.

### H. #3 — exec card relabel (same screen, same metric)
- The exec **"Dispatched"** card is already `rtr+rte` = PKG OUT → **relabel "PKG Out"**; keep its monthly projection (already PKG-OUT-based).
- The **"Pkg Out 418 · Units at RTD"** card is a *stock snapshot* (`dispatch_stock`), not flow → **relabel "At RTD"** so it stops reading as output.
- No DOUT / dispatch figure on the production cards.
- Files: `apps/redline/src/app/(auth)/exec/page.js` (KpiTile labels ~582/589). Frontend-only; no worker change for #3.

---

## 4. Goals / non-goals

**Goals:** data-driven, self-healing run closure that drains the Issued list nightly; an honest, derived partial/output record; a no-issue finishing-run path that keeps both the run list and the issue queue clean without losing material traceability; consistent PKG-OUT semantics on the exec dashboard.

**Non-goals (v1):** overflow attribution (two same-product runs on one line in a day — flagged, not split); multi-day runs / suspend / extend; tagging units or scans to runs at scan time (deferred to v2); intra-day closure (target-met / supersede) — v1 closes purely by day.

---

## 5. Risks / arguments-against (kept on record)

1. **"Run" now means "a day's work on a line+product", not "a production order."** A multi-day order shows as partial + finishing runs against one plan. Accepted, by design (daily granularity is wanted); the link reconciles it.
2. **Yield must roll up the chain, never per-run** — a finishing run shows PKG OUT > its own INW (>100% in isolation). Per-run yield is meaningless for finishing runs; use the link. Reporting must respect this.
3. **Link discipline** — orphan partials look like waste; orphan finishing runs look like free output. Mitigated by prompting the link on create + a "open partial runs" surface. Data is never lost, but the *story* fragments without the link.
4. **Issue-exempt run type must be thorough** — see §3.D. A partial implementation is the main build risk.
5. **Zero-scan runs** still need the nightly job (they close with `produced=0`, `close_reason=day_close`) — confirmed acceptable; they're the transitional KPI.
6. **One-(line,product)-per-day is an assumption** — true for all history but one row; guarded by `needs_review` flag, not silent merge.

---

## 6. Open decisions (proposed defaults — CONFIRM on resume)

1. **Complete tolerance** — count `produced ≥ target` as Complete, with a small under-band also Complete (proposed: within **2% or 5 units**, whichever larger) so 348/350 isn't nagged Short. *Default: yes, 2%/5-unit band.*
2. **Do finishing-run outputs count in the daily / MTD PKG-OUT KPI?** *Default: **yes** — it's real output; just flagged `finishing` for drill-down.*
3. **#2 (Redline SOPs)** kept as a separate spec. *Default: yes.*

---

## 7. v2 / later (explicitly deferred)
- **Tag units (or scans) to their run at scan time** to make attribution exact even when `(product,line,date)` is not unique, and to survive any future relaxation of the one-run-per-day rule. Small additive worker change at INW (resolve the open run for line+product, stamp a new typed column — note `units.production_run_id` is `uuid` vs `production_runs.id` `bigint`, so add a new `run_no`/bigint column rather than reuse it). Pure-derivation covers v1 steady state.
- Overflow attribution; intra-day target-met / supersede close; per-chain combined yield reporting.

---

## 8. Build sequence (high level — NOT the implementation plan; run writing-plans on resume)
1. Migration: additive columns on `production_runs` + widen `run_type` CHECK + snapshot table.
2. Extend `get_plan_vs_actual` (or a sibling RPC) with INW + PKG counts; add the classified-list read RPC.
3. `close_production_run()` fn + `auto_close_production_runs` cron (~1 AM IST). Backfill the 58 on first run.
4. lotopsproxy: finishing run type made first-class & issue-exempt across all run/stock/issue paths; manual Close-now/Reopen actions; classified-list endpoint.
5. Redline: Recent Runs badges + filters; finishing-run create + link picker; exec #3 relabel.
6. Live floor smoke; manual update.
