# Run-Request Consolidation — Design Spec

> **Status:** Design LOCKED (2026-06-07, Afshaan). NOT yet built. Build follows this spec.
> **Scope:** consolidate how production *requests* runs into ONE surface in Redline, with a
> consistent pull-based model across run types. Backends may stay separate; the hard requirement
> is one request surface + one store-facing Issue Queue, to kill floor confusion.
> **Predecessor discussion:** `claude_chat_handover/2026-06-07_run-request-consolidation-handoff.md`.
> Related rules: RULE-EXT-001, RULE-RET-001/002, RULE-DSP-001, RULE-SCAN-001, RULE-GP-001,
> RULE-REPACK-004, RULE-FBU-001, RULE-001/SHORT-001.

---

## 1. Locked framing (do not relitigate)

1. **Single request surface → Redline.** Production is the requester; move the request UI out of
   Garage (store). Garage = store/fulfilment; Redline = production floor.
2. **Scope = ONE request surface + ONE consolidated Issue Queue, not a unified backend.** Each run
   type keeps its own machinery; we unify *how it is requested* and *how the store sees what it owes*.
3. **Anything requested FROM THE STORE is a "run."** Repack folds in (it pulls store packaging).
4. **UDR stays OUT** — quick flip / issue-request, already shipped S109 (RULE-RET-002). Do not touch.
5. **Runs in scope:** Fresh in-house · Outsourced/EXT · Repair · Repack.

## 2. The unifying principle (already true across the system — now made universal)

**Store issuance is pull-based (RULE-RET-002).** The store never self-issues; every issue is pulled
by a request landing in the **Issue Queue** (the only store-initiated exception is DSP, RULE-DSP-001).
Consolidation makes this universal: **every run type fans out one or more pulls** that surface as
`work_orders` rows in the one Issue Queue, each tagged to its source run. Symmetrically, the
**scanner is the ground truth** — a desk click authorizes, a scan executes (RULE-DSP-001); every
station hard-rejects work that has no open authorizing request.

**The consolidated Issue Queue** is the store's single bounded "what do I owe right now" list:

| Source | `work_orders` row(s) | wo_type |
|---|---|---|
| Fresh run | the run's BOM pick | `planned` (existing) |
| Outsourced — Build | build-BOM pick (car/remote/fastener) | `planned` (on the EXT run) |
| Outsourced — Finish | finish-BOM pick (everything else) | `planned` (2nd pull on the EXT run) |
| Repair — ad-hoc | specific parts, run-linked | ad-hoc (existing) + run link |
| Repack | to-channel primary packaging (box + tray) | **NEW `repack_pkg`** |
| UDR (out of scope) | notional UDR request | `UDR` (S109, shipped) |

## 3. Per-run-type designs

### 3.1 Fresh in-house — UNCHANGED
`production_runs` (`run_type='in-house'`, RUN-NNN), `work_orders` (`wo_type='planned'`). No change
beyond surfacing its request on the unified Redline surface (§4).

---

### 3.2 Outsourced / EXT — two-phase run (Build outside, Finish in-house)

**Concept:** a normal production run the vendor splits into a **Build** half and a **Finish** half.
Two pulls, two issues, one vendor round-trip. Production requests it like a fresh run; the line is a
vendor line.

```
BUILD  (outside)
  ① Production: "Request Outsourced Run" in Redline      → Issue Queue   [reuse: Issue Queue]
  ② Store issues the BUILD-BOM (Car + Remote + Fastener) → existing pick [reuse: getProductionRun picklist]
  ③ Production sends materials out                        → Gate Pass    [reuse: RULE-GP-001 job-work-out,
                                                                           returnable, expected_return_date]
  ④ Run → In Progress (sent_out_at)

VENDOR builds. Finished units come back (possibly in INSTALMENTS).

RECEIVE  (store)
  ⑤ Store sees "expecting N built <product>" line        → auto-created  [reuse: shipment + receiving + GRN]
     in their normal shipments-to-receive list             job-work return shipment (auto-linked to ④)
  ⑥ Store count-GRNs into a dedicated UNTAGGED ext_return → partial OK   [NEW pool; partial receipts,
     pool (no stickering at store); gate pass auto-marks                  remainder stays pending on shipment]
     returned when fully received

FINISH  (in-house, when a line is free)
  ⑦ Production: "Finish EXT-NNN"                          → Issue Queue   [reuse: Issue Queue — 2nd pull]
  ⑧ Store issues the FINISH-BOM (everything not build) +
     releases units from the pool
  ⑨ Production stickers each unit at EXT_INW (mint UPC,   → EXT_INW       [reuse: postExtInw — moved to
     tag production_run_id = EXT-NNN) → QC → PKG → dispatch                FINISH-time, not receive-time]
```

**Decisions locked:**
- **Send-out is production-owned** via a Gate Pass (job-work-out, returnable, expected_return_date) —
  the store never sends out (RULE-RET-002; DSP/samples remain the only exception). The gate pass is
  also the ITC-04 challan-out artifact.
- **Build vs Finish split is DB-config, not hardcoded** (see §5 `outsource_bom_split`):
  - **Build-BOM:** part categories **Car, Remote, Fastener**.
  - **Finish-BOM:** everything else (RC + AA Battery, **Sticker**, Accessories, Charger Cable, Para,
    Packaging, Primary Packaging). *Definitions are editable in the DB; can change later.*
- **Receive = count-GRN into a dedicated, UNTAGGED `ext_return` pool** (NOT `fbu_stock`). No
  per-unit stickering at the store; **production stickers at FINISH-time EXT_INW**.
- **Installment receipts:** the auto-created return shipment receives across multiple GRN events;
  remainder stays pending (`ext_summary {planned, received, pending}`).
- **Gate-pass out + return-shipment in are auto-linked**; the store's single inward action closes
  the gate-pass returnable.

**Consequence (amends RULE-EXT-001 #2):** because the pool is untagged, materials-out ↔ units-in
reconciliation (ITC-04) shifts from **per-unit at receive** to **document/count level** (gate-pass
out-qty + return-shipment received-qty), with per-unit run identity re-established at finish-time
stickering. Consciously accepted.

---

### 3.3 Repair — open-ended, instrumented recovery run

**Concept:** a repair run is **not** a planned run — it's a discovery-driven recovery run.
Input is discovered, output is discovered, parts are discovered. We do not structure it; we
**instrument** it so the data to structure it later accrues.

**Why repair runs exist:** use line downtime · recover low-stock products from the pile · shrink the
broken/return pile. **The pile** (production damage, stray samples, unprocessed channel returns) is
physically indistinguishable, unidentified, unowned.

```
REQUEST  (production)
  ① Production: "Request Repair Run" (NO target)          → one request surface  [reuse: createRepairRun, REP-NNN]
     run opens target-less; input/output accrue as it runs

REPAIR START  (its own station — deliberately NOT inward; the repair-lineage marker)
  ② Operator eyeballs each pile unit — physically, no scanner prompt:
       • Not repairable → straight to scrap pile. No sticker, no scan. (System-free.)
       • Repairable     → apply UPC sticker (fresh if none/invalid) → SCAN at Repair Start
                          → tag production_run_id = REP-NNN
                          → leaves a permanent "was repaired" marker (the Repair-Start scan,
                            checkable downstream via UPC or box label)
     (Disciplined stream: classified CXR/BRV returns store-issued to this REP-NNN also enter here —
      already identified; gated by the S108 REP_START store-issued guard. Pile units = fresh-UPC,
      non-return, ungated per RULE-SCAN-001.)
  ③ Same operator repairs the unit (no extra scan).
     On a shortfall → raise an AD-HOC PART REQUEST off-line (desk), LINKED to REP-NNN (+ product).
  → send to QC

QC ──pass──► PKG ──► dispatch              ← standard line, UNCHANGED
QC ──fail──► WKS in ─► WKS out ─► QC       ← standard fresh-run workshop loop, UNCHANGED
```

**Decisions locked:**
- **No pile intake door today** (priority: deplete the pile fast; plug the leak once stable).
- **Target-less.** Safeguard is *visibility* (instrumentation), not a forced target.
- **One consolidated Repair Start station** (inspect + identify + scrap-decision + repair); no
  separate inspect station — fewer devices.
- **Repair Start is its own station, NOT INW** — its scan is the permanent "was repaired" marker.
- **Scrap is system-free** (no scan; physical pile) — scrap-recovery is a separate future workflow.
- **Ad-hoc part requests are MANUAL (desk, not scanner)** — the scanner stays single-input — and
  **linked to the run (+product)**. Primary path: raise from the run's Redline detail (auto-linked);
  fallback standalone form defaults to the operator's active open repair run. **Generalize the link
  to ANY run** (also tidies fresh-run ad-hoc top-ups, RULE-SHORT-001).
- **From QC onward = a normal line** (QC-pass → PKG → dispatch; QC-fail → standard Workshop loop).

**Instrumentation per REP-NNN:** inspected · repairable · scrapped (tally) · in-repair · recovered
(QC-pass output) · ad-hoc parts per part/product. This is the feedback dataset → (a) buy-extra,
(b) eventually a structured repair BOM.

**Parked (separate future designs, NOT this change):** the pile intake/identity door · the
**external-repair** process (damaged pieces sent out for repair — own guards/rules) · the
**scrap-recovery** workflow · using the QC-fail/Workshop count to feed the repair pool.

---

### 3.4 Repack — channel swap, structured request, dispatch handover

**Concept:** inventory is packed in channel A but needed in channel B with no A-order coming; repack
rather than build new. The **only** backward material movement in the factory — dangerous by design,
so it gets the tightest controls. Keep the existing floor mechanics (they already nail the label
flip); add the request structure, the two pulls, and the dispatch handover.

```
REQUEST  (production)
  ① "Request Repack Run": product/model/colour + FROM → TO channel + qty
     → fans out TWO pulls:
        (a) → Store: issue TO-channel PRIMARY PACKAGING (box + tray)  → Issue Queue (wo_type repack_pkg)
        (b) → Dispatch: a RELEASE-TO-REPACK list (product/qty)        → dispatch "to release" list

RELEASE TO REPACK  (dispatch side — per-unit scan = custody-transfer sign-off)
  ② Dispatch operator scans EACH box being handed over to RPK-NNN
     → records who/when/which-run; LOCKS the unit out of dispatch's normal flow
     (so it can't also be allocated/packed/shipped)

REPACK IN  (production line)
  ③ Scan the OLD box label LOT-…-E/R. HARD-REJECT unless:
        • unit is rtd (production-held, no handover) / handed_over / allocated, AND
        • (if handed_over/allocated) it was RELEASED to this run at ②.
     Blocked: packed-in-bulk-box, shipped. Everything unauthorized → red screen + scan_violations.
  ④ Existing full rollback: delete pkg_scans + dispatch_allocations + box-units, release manifest
     slot, roll car+remote → qc_pass, open channel_swap_history row.

REPACK OUT
  ⑤ Two-scan car+remote pair re-verify → print FLIPPED -E/-R label (channel DEFAULTED from the
     request, not the operator) → pending_rtd → close swap row → auto-complete run at target.

  → PKG_OUT → rtd → DTK → ALLOC → PACK → DOUT   (standard dispatch tail)

OLD PACKAGING
  ⑥ Auto-fed RUN-LINKED line flush: qty = repacked count; verify splits reusable vs damaged
     (relabel-over reconciles reusable; damage written off).
```

**Decisions locked:**
- **Structured request** (product/model/colour + from→to channel) — amends RULE-REPACK-004
  (counter → structured request). Repack Out E/R **defaults from the request**.
- **Two pulls on creation:** store packaging (box + tray, to-channel) + dispatch release.
- **Dispatch handover = per-unit Release-to-Repack scan** (option A, tightest). The floor operator
  cannot pull an unauthorized unit; REPACK_IN hard-rejects anything not released.
- **Entry stages:** `rtd` (production-held, no handover) / `handed_over` / `allocated` (dispatch-held,
  require release). Packed/shipped stay hard-blocked.
- **Auto-feed run-linked line flush** for the old packaging (qty from run; reusable vs damaged split).

---

## 4. Cross-cutting: the unified request surface + permissions

- **Move the run-request UI to Redline.** A single **"New Run / Request"** entry → pick type
  (Fresh · Outsourced · Repair · Repack) → type-specific form. (Today Production Runs live in Garage:
  `apps/garage/.../production-runs/*`; repair/repack requests already partly in Redline
  `apps/redline/.../returns`, `repack-runs/*`.)
- **Permissions:** reconcile `canScheduleRun` (fresh/outsourced) · `canManageFloor` (repair) ·
  `repack_run_manage` (repack) into one coherent requester model under the unified surface.
  **[OPEN — see §8.]**
- **Garage retains the store/fulfilment side** (Issue Queue, GRN, receiving, line flush) — those do
  not move; only the *request* origination moves to Redline.

## 5. DB changes (all additive; verify live `information_schema` before writing)

- **`store.outsource_bom_split`** (NEW) — config: `part_category` → `phase ('build'|'finish')`,
  default `finish`; seed Car/Remote/Fastener = `build`. Read at run time by `getProductionRun`.
  *Editable later without deploy.*
- **`ext_return` pool** (NEW, `store` or `public`) — count-only, keyed `product|variant|colour`,
  untagged. Fed by the outsourced return-shipment GRN; drained at FINISH issue.
- **Job-work return shipment** — reuse the existing shipment/receiving/GRN tables with a job-work
  flag linking to the EXT run + gate pass (NOT a purchase PO — no payment/GST-purchase semantics).
- **`work_orders.wo_type`** gains **`repack_pkg`** (to-channel primary packaging request).
- **Repack release-to-repack** — a release record (run + car_upc + dispatch operator + ts) that
  REPACK_IN validates and that locks the unit out of dispatch flow. (Could extend
  `channel_swap_history` or a small new `repack_releases` table.)
- **Repack request fields** — promote product/model/colour + from/to channel from optional metadata
  to first-class request inputs (`repack_runs` columns already exist, nullable — make them carried).
- **Repack → line flush link** — `line_flushes` already supports a run link; wire a repack-run flush
  (qty auto-fed). Confirm `line_flushes` can anchor to a repack run (today it anchors production runs/WOs).

## 6. Rule changes

- **AMEND RULE-EXT-001 #2** — outsourced returns: per-unit-at-receive → **count-GRN into untagged
  `ext_return` pool**; per-unit run identity created at **finish-time EXT_INW**; reconciliation is
  document/count level.
- **AMEND RULE-REPACK-004** — repack run: pure counter → **structured request** (product + from→to +
  qty), to-channel defaults Repack Out; adds dispatch handover + two pulls + auto line-flush.
- **NEW (repair)** — repair run is target-less + instrumented; Repair Start is its own lineage
  station; scrap is system-free; ad-hoc parts are manual + run-linked. (Draft RULE-REPAIR-001.)
- **NEW (repack handover)** — dispatch → production custody transfer is a per-unit release scan;
  REPACK_IN hard-rejects unreleased dispatch-held units. (Folds into RULE-REPACK-004 + RULE-SCAN-001.)
- **Reaffirm RULE-RET-002** — every consolidated pull is request-driven; store self-issue stays
  DSP-only.

## 7. Affected files / handlers (verify line numbers at build)

- **`01_worker/worker.js`:** `createProductionRun`/`resolveIssueMode`, `getProductionRun` (build/finish
  split via `outsource_bom_split`; `ext_summary`), `markRunSentOut`, `assignOutsourcedLine`,
  `postExtInw` (→ finish-time), new ext_return-pool GRN + finish-issue; `createRepairRun`,
  ad-hoc-issue handler (+ run/product link), `REP_START`; `createRepackRun` (structured + 2 pulls),
  `postRepackIn` (release validation + widened stages), `postRepackOut` (default channel), new
  Release-to-Repack scanner action, repack line-flush wiring; Issue-Queue/`getWorkOrders` filters.
- **`02_scanner/index.html`:** EXT_INW (finish-time), Repair Start, Release-to-Repack (dispatch),
  REPACK_IN/REPACK_OUT guard messages.
- **`apps/redline`:** unified New-Run/Request surface (Fresh/Outsourced/Repair/Repack), repair-run
  detail "Request parts" (ad-hoc, auto-linked), structured repack request, dispatch "to release" list.
- **`apps/garage`:** Issue Queue (new rows: repack_pkg, outsourced build/finish, ad-hoc run-linked);
  receiving (job-work return shipment); line flush (repack-linked).

## 8. Umbrella decisions — RESOLVED (Afshaan, 2026-06-07)

1. **Permissions — MERGE the requester side.** ONE production key **`run_request`** gates the unified
   Redline surface for all four run types (production owns every request). The dispatch
   **Release-to-Repack** stays a SEPARATE dispatch-side permission (`dispatch_restock` or new
   `repack_release`) — a different party's authority; intentional separation, not redundancy. Verify
   `run_request` against live `store.roles` before enforcing.
2. **Job-work return = DEDICATED object** (own table, reusing receiving_lines + GRN mechanics, linked
   to the EXT run + gate pass) — NOT a flag on purchase shipments/POs. Chosen for long-term stability:
   a flag forces every purchase/payment/GST/GRN consumer to branch on it forever and risks job-work
   leaking into purchase reporting (the EXT-003↔GRN-203 class). Dedicated keeps the domains cleanly
   separated, consistent with the dedicated `ext_return` pool.
3. **`ext_return` pool → `store` schema** (store owns it), keyed `product|variant|colour`.
4. **Fold in EVERYTHING** — all four run types fully consolidated this round, including repair AND
   repack requests into the one request surface + Issue Queue. No deferral.
5. **Build it all, one effort, step by step** — sequence chosen below (§10).

## 9. (was §8.5) — n/a

## 10. Build sequence (locked — additive-foundation-first, smallest-delta-up)

Each step: edit → build → commit → push → (worker) deploy. Confirmation gates at DDL + every deploy.
A bad `lotopsproxy` deploy takes down Garage+Redline+Scanner — sequence is dependency-ordered so the
worker/scanner/app land coherently per step.

- **Step 0 — DB foundation (additive migrations). ✅ DONE 2026-06-07** (migration
  `run_consolidation_step0_foundation`). Created `store.outsource_bom_split` (14 rows; build =
  Car/Remote/Fastener/Drone/Train, rest finish), `store.ext_return_pool` (count-only, untagged,
  keyed product|variant|colour), `public.repack_releases` (per-unit release sign-off, one-open-per-car
  partial unique index), + additive columns `store.work_orders.repack_run_id`, `store.work_orders.phase`,
  `store.line_flushes.repack_run_id`. `wo_type` is free text (no enum migration). `repack_runs` already
  has product/variant_model/colour/from_channel/to_channel. RLS-on + no policy = service_role-only
  (advisor INFO lint only, intended). Dedicated job-work-return object deferred to Step 4.
- **Step 1 — Permissions.** Add `run_request` (verify vs `store.roles`); dispatch `repack_release`.
- **Step 2 — Unified request surface (Redline).** New-Run/Request entry → type-specific forms
  (Fresh/Outsourced/Repair/Repack); migrate the request origination out of Garage.
- **Step 3 — Repack** (smallest backend delta atop existing REPACK_IN/OUT): structured request + 2
  pulls (store packaging WO + dispatch release list) + Release-to-Repack scanner station + REPACK_IN
  release-validation + widened stages (+`rtd`) + Repack Out channel default + auto run-linked flush.
- **Step 4 — Outsourced:** build/finish split (read `outsource_bom_split` in `getProductionRun`) +
  gate-pass send-out + auto dedicated job-work-return shipment + `ext_return` GRN + finish pull +
  `postExtInw` moved to finish-time.
- **Step 5 — Repair:** Repair Start station (inspect folded in, scrap system-free, lineage marker) +
  manual run-linked (+product) ad-hoc request + instrumentation; standard QC/WKS tail unchanged.
- **Step 6 — Consolidated Issue Queue (Garage):** surface all new rows (repack_pkg, outsourced
  build/finish, ad-hoc run-linked) as one bounded list.
- **Step 7 — Manuals fold** (Garage/Redline/scanner) per S105 in-system upkeep + the inventory-flow
  diagram format for each flow.
- **Step 8 — Live floor smoke** across all four flows.

## 9. Out of scope / parked

UDR (shipped) · pile intake door · external-repair process · scrap-recovery workflow · QC-fail-count →
repair-pool feedback · unified *backend* (explicitly not a goal).
