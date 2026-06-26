# FBU Unification · Plan 3 — Outsourced (Job-Work) Collapse

> **For agentic workers:** execute task-by-task. No unit-test harness — "verify" = live Supabase SQL / worker curl / authenticated browser smoke. Sequence per task: migration → worker (edit→commit→push→`cd 01_worker && npx wrangler deploy`) → scanner (`02_scanner/index.html`, deploy) → app → verify. **Snapshot before every data touch.** Builds on Plans 1-2 (FBU receipts + production both on `stock_ledger`; lotopsproxy `f8f58ce5`).

**Goal:** Collapse the outsourced (job-work) flow into the part flow: an `EXT-NNN` run **sends raw build materials out** and **receives built cars back as `<PROD>-CAR-01` stock** (`source='jobwork'`, tagged to the run for ITC-04); **finishing is an ordinary FBU run** consuming that stock. Kill the pooling + the separate vendor-inward scanner station that confuse the floor.

**Architecture:** The EXT run becomes "consume granular CKD car/remote build parts → produce the built-car part." Returns are a **count-based GRN of `<PROD>-CAR-01` tagged `ext_run_no=EXT-NNN`** (no per-unit UPC scan at return — units are serialized later on the finishing run's normal `INW`, exactly like CKD). `ext_summary` reconciles materials-out vs built-cars-in on the single EXT object (ITC-04). Removed: `EXT_INW` station, `ext_return_pool`, the `markRunSentOut→requestExtFinish→assignOutsourcedLine→receiveExtUnits→postExtInw` two-phase chain, the RULE-EXT-001 FBU/EXT dedup warning.

**Tech Stack:** Supabase Postgres (`store`/`public`), Cloudflare Worker `lotopsproxy`, Scanner PWA (`02_scanner/index.html`), Garage app.

**Spec:** `docs/superpowers/specs/2026-06-26-fbu-outsourced-unification-design.md` (§6).

**ITC-04 invariant preserved (RULE-EXT-001 amended):** one `EXT-NNN` object carries materials-out (delivery challan) ↔ built-cars-in (the `source='jobwork'`+`ext_run_no` GRN). Per-source accountability = query `grn_register` by `source`/`ext_run_no`.

---

## Task 1 — DECIDED (Afshaan S178): leave the 11 in-flight EXT runs AS-IS; build for future runs only

**Audit finding:** all 11 open `Issued` runs + EXT-001 have **real parts issued** (stock moved — 50 to 102,000 parts each, WOs `Complete`); the in-system "Send to vendor" flag was just never clicked. So they are NOT no-activity and are **NOT cancellable** (cancel would falsely credit ~260k parts or orphan the materials-out record). Afshaan: *"most of these have come back, built in other ways; not sure how they resolve in-system today. Leave them as-is, build for future runs, we'll reconcile later by matching received FBU units against these runs."*

**Therefore:** the new flow (Tasks 2-5) is built **additively for future outsourced runs**. The 11 existing runs are left exactly as they are (a separate later reconciliation: match FBU built-units received ↔ these runs' materials-out). **Old EXT handlers + the `EXT_INW` station + `ext_return_pool` are kept in place (dormant for new runs) so nothing on the old runs breaks** — their removal moves to Plan 4 *after* the old runs are reconciled. **Guard:** the new "Receive built cars" action must not be casually used on the 11 legacy runs (would double-count vs their FBU-path returns) — surface a caution / gate to new runs.

~~Original cancellation plan (SUPERSEDED — do not cancel):~~

### (reference only) In-flight EXT-run audit

**Files:** Supabase SQL; snapshot `production_runs` first.

- [ ] 1a. Snapshot: `CREATE TABLE store.safety_production_runs_ext_2026_06_26 AS SELECT * FROM store.production_runs WHERE run_type='outsourced';`
- [ ] 1b. Audit the open EXT runs (11 stuck `Issued` + EXT-001 legacy In Progress + any units already tagged):
```sql
SELECT pr.run_no, pr.product, pr.status, pr.ext_v2, pr.line_no, pr.sent_out_at IS NOT NULL sent, pr.finish_requested_at IS NOT NULL fin,
       (SELECT count(*) FROM public.units u WHERE u.production_run_id=pr.id) AS units_tagged,
       (SELECT count(*) FROM store.ext_return_pool ep WHERE ep.product=pr.product) AS pool_rows
FROM store.production_runs pr WHERE pr.run_type='outsourced' ORDER BY pr.run_date;
```
- [ ] 1c. **Decision per run (confirm with Afshaan):** the 11 `Issued` runs that never sent materials in-system (`sent=false`) → **Cancel** (no stock moved) and re-raise under the new flow if still needed. **EXT-001** (legacy v1, In Progress, sent) + any run with `units_tagged>0` → leave **as-is** (history; the new flow doesn't retro-migrate already-scanned units — those units stay valid). Document the disposition in the run's notes.
- [ ] 1d. Drain/snapshot `ext_return_pool` then leave it for Task 5 removal: `CREATE TABLE store.safety_ext_return_pool_2026_06_26 AS SELECT * FROM store.ext_return_pool;`

---

## Task 2: Worker — EXT run issues build materials only; "issue more to vendor"

**File:** `01_worker/worker.js` — `getProductionRun` (outsourced pick), `issueAgainstRun`, + a new supplementary-issue action.

- [ ] 2a. `getProductionRun` for an **outsourced** run: the pick = the product's **CKD-format Car/Remote/Fastener build components only** (what the vendor assembles) — NOT the `ANY` finish kit, NOT the `FBU` built-car. Reuse `store.outsource_bom_split` (phase='build') as the "send-to-vendor" category set (it stays as the build-subset config; the FINISH phase is retired — finishing is a separate run). Concretely, when `run.run_type==='outsourced'`, after the matcher, keep only rows whose `part_category` is a build category (`outsource_bom_split.phase='build'`) and drop `bom_format='ANY'` rows. Remove the `?phase=finish` branch + the `ext_v2 ? 'build'` auto-default (no finish phase anymore).
- [ ] 2b. Keep `ext_summary` but recompute **returned_qty from the built-car GRN tagged to the run** (not `units.production_run_id`): `returned = Σ grn_register.qty_received WHERE ext_run_no=run.run_no AND part_code ~ '-CAR-'`. `planned` = Σ WO qty. `pending = max(0, planned − returned)`.
- [ ] 2c. New POST `issueMoreToVendor` (gate `canScheduleRun`||`run_request`): a supplementary issue against an **In Progress** outsourced `EXT-NNN` — same build-materials pick, deducts `stock_ledger`, logs an `issue_register` row linked to the run, and (Task 4) rides a fresh delivery challan. This is the clear, linked short-supply path (replaces the buried manual route).
- [ ] 2d. `node --check`; commit; push; deploy; record version.
- [ ] 2e. Verify (curl/browser): an outsourced run's picklist lists only CKD car/remote build parts (no kit, no built-car); `issueMoreToVendor` adds a linked supplementary issue.

---

## Task 3: Worker — receive built cars back as a source-tagged GRN (replaces pool + EXT_INW)

**File:** `01_worker/worker.js` — new `receiveExtBuiltUnits`; remove `markRunSentOut`/`requestExtFinish`/`assignOutsourcedLine`/`receiveExtUnits`/`postExtInw`.

- [ ] 3a. New POST `receiveExtBuiltUnits` (gate `canScheduleRun`||`run_request`): input `{run_no, qty}` (optionally per variant/colour). For the run's product, resolve the built-car code (`builtPartCodeResolver`), then: insert a `grn_register` row (`part_code=<PROD>-CAR-01`, `qty_received=qty`, `source='jobwork'`, `ext_run_no=run_no`, `supplier`=vendor) + `bulk_update_stock_received([{part_code, qty}])`. Built remotes (Rift/Rumble-style) handled the same when the job returns remotes (`<PROD>-RM-01`). Count-based; **no per-unit UPC** (units are serialized later on the finishing FBU run's `INW`).
- [ ] 3b. Keep `markRunSentOut` semantics minimal — repurpose to stamp `sent_out_at` + status `Issued→In Progress` (the "handed to vendor on a challan" event) and KEEP it (it's the ITC-04 dispatch marker). **Remove** `requestExtFinish`, `assignOutsourcedLine`, `receiveExtUnits` (pool), `postExtInw` (scanner). When `receiveExtBuiltUnits` brings `returned ≥ planned`, set the run `Completed`.
- [ ] 3c. Remove the `SCANNER_ACTIONS` entry + handler for `EXT_INW` (`postExtInw`) and drop `EXT_INW` from `OPERATOR_GATE_STATIONS`.
- [ ] 3d. Remove the RULE-EXT-001 FBU/EXT dedup warning in the FBU-GRN path (no split remains — both land `<PROD>-CAR-01`, distinguished by `source`).
- [ ] 3e. `node --check`; commit; push; deploy.
- [ ] 3f. Verify (SQL + curl): `receiveExtBuiltUnits` on a test EXT run inserts a `jobwork` GRN + bumps `stock_ledger` `<PROD>-CAR-01`; `ext_summary.returned` reflects it; run auto-Completes at planned. Snapshot/revert any test data.

---

## Task 4: Scanner + Garage app — drop EXT_INW; rework the EXT panel

**Files:** `02_scanner/index.html`; `apps/garage/.../issue-queue/page.js` (+ RunDetailPanel).

- [ ] 4a. Scanner: remove the `outsourced` run category + the `EXT_INW` station definition. (Outsourced finishing uses the normal `fresh` category — `INW→QC→PKG`.) Deploy the scanner.
- [ ] 4b. Garage Issue Queue: the outsourced run panel becomes **Issue build materials → Send to vendor (challan) → Receive built cars (count) → [auto-Complete]**, plus an **"Issue more to vendor"** button (`issueMoreToVendor`). Remove the FINISH-badge / `requestExtFinish` / assign-line / pool-receive UI. "Receive built cars" calls `receiveExtBuiltUnits`.
- [ ] 4c. `npx turbo build --filter=garage` green; commit; push (auto-deploys).
- [ ] 4d. Verify (browser): create an outsourced run → issue build materials → send to vendor → receive built cars (count) → run completes; then a normal FBU finishing run consumes the now-stocked built car.

---

## Task 5: Retire `ext_return_pool` + knowledge

- [ ] 5a. After confirming no worker reader remains (grep `ext_return_pool`), rename `store.ext_return_pool` → `ext_return_pool_retired_2026_06_26` (data kept). Retire `outsource_bom_split`'s finish rows if any (keep build rows as the send-to-vendor config).
- [ ] 5b. `BUSINESS_RULES.md`: amend RULE-EXT-001 (units-in = source-tagged `<PROD>-CAR-01` GRN; finishing decoupled to a normal FBU run; no `EXT_INW`/pool). `systems/lotops.md` + `CORE.md`: outsourced flow + `EXT_INW`/`ext_return_pool` retired.
- [ ] 5c. `BACKLOG.md`: Plan 3 done; Plan 4 (fbu_stock freeze + dead-code) + the team PDF remain.

---

## Execution log (S178)

**Core outsourced collapse LIVE (future runs).** Worker `2b71bb09` (`receiveExtBuiltUnits`); Garage + Redline + Scanner deployed.
- **Task 1 ✅ (decided)** — 11 legacy EXT runs left as-is (real materials issued, 50–102k parts each; reconcile separately via FBU matching). New flow is future-only. Old handlers/`EXT_INW`/`ext_return_pool` kept dormant.
- **Task 3 ✅** — `receiveExtBuiltUnits`: built cars return as a count-based `source='jobwork'` GRN on the built-car part (`ext_run_no=EXT-NNN`) + `stock_ledger`; Issued→In Progress on first receive. (Build-materials issue already worked via the existing `ext_v2` build phase + Plan 2 matcher.)
- **Task 4 ✅** — Garage issue-queue: "Receive built cars" → `receiveExtBuiltUnits`; pool/finish/Ext-Inwarding copy replaced with the new flow. Redline `RunDetailPanel`: `requestExtFinish` button neutered (finishing = a normal run). Scanner: `outsourced`/`EXT_INW` category removed.
- **Deferred to Plan 4:** `issueMoreToVendor` (short-supply-to-vendor supplementary issue — Afshaan-flagged convenience, not core to the collapse); freeze `fbu_stock`/`ext_return_pool` + remove dormant old handlers (`requestExtFinish`/`assignOutsourcedLine`/`receiveExtUnits`/`postExtInw`) + the `EXT_INW` SCANNER_ACTION + `outsource_bom_split` finish rows; legacy-run receive gate.
- **Pending:** authenticated browser smoke (create an outsourced run → issue build materials → send to vendor → Receive built cars → built-car `stock_ledger` rises with a `jobwork` GRN → finish via a normal FBU run).

## Self-review (spec coverage)

- **Spec §6 (EXT issues raw build parts)** → Task 2a/2c.
- **Spec §6 (built cars in = source-tagged GRN; ITC-04 on one object)** → Task 3a/3b + `ext_summary` (2b).
- **Spec §6 (kill EXT_INW + pool + two-phase)** → Task 3b/3c, Task 4a, Task 5a.
- **Spec §6 (issue more to vendor)** → Task 2c.
- **Spec §6 (finishing = normal FBU run)** → relies on Plan 2 (already live); scanner uses `fresh` (4a).
- **In-flight EXT runs** → Task 1.
- **Deferred to Plan 4:** `fbu_stock` freeze + `postFbuGRN`/registers retirement + `fbu_includes_remote`/`fbu_products` dead-code + gate the FBU toggle to dual-format products; then the team-facing PDF.
