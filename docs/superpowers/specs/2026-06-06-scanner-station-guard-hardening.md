# Scanner Station Guard Hardening — Design Spec (WIP)

> Status: **DESIGN — NOT YET IMPLEMENTED.** Hold until the floor finishes current activity
> (Afshaan, 2026-06-06: the team still needs the legacy RTO_IN station live right now; Store
> not yet ready for clean Returns-v2 processing — implement ~couple of hours later / end of shift).
> Worker: `lotopsproxy` (`01_worker/worker.js`). High-stakes deploy (Garage+Redline+Scanner).

## Why

The 2026-06-06 PKG-OUT station mix-up (367 cars wrongly scanned RTO_IN→RTD_RETURN→DTK; fresh
production + dispatched stock all swept into "returns", box labels hard-deleted) exposed that
the **returns/re-dispatch boundary is unguarded**, even though the production line itself is
well-guarded. This spec audits the guard on **every scanner station** and defines the correct
state-machine guard for each, so a unit can only ever be at a station its real lifecycle allows.

Two root holes found:
1. **RTO_IN station accepts a unit in ANY status** (no input-state guard) → any fresh/dispatched
   unit can be flipped to `rto_in`.
2. **PKG_OUT's `rto_in` branch (RTD_RETURN)** re-dispatches any `rto_in` unit and, when there is
   no proper UDR `return_units` record, **falls through to a v1 path that DELETES the box label**.

## Lifecycle / status vocabulary (cars)

`available`(pool) → **INW** → `inwarded` → **QC_PASS** → `qc_pass` → **PKG** → `pending_rtd`
→ **PKG_OUT (RTE/RTR)** → `rtd` → **DTK** → `handed_over` → **ALLOC** → `allocated`
→ **PACK** → `packed_dispatch` → **DOUT** → `shipped`.
QC fail loop: `qc_fail` → **WKS_IN** → `in_repair` → **WKS_OUT** → `repaired` → QC again.
Returns (v2): `shipped` → **RET_IN** (intake, binds RS-NNN, creates `return_units`) → `rto_in`
→ Garage disposition (UDR/CXR/BRV/Loss) → **Issue UDR** (`issueReturnUnit`, stamps
`return_units.issue_type='udr'`+`issued_at`) → **PKG_OUT (RTD_RETURN, non-destructive)** → `rtd` …
CXR/BRV → repair run → QC re-pair → PKG (`pending_rtd`) → normal dispatch.

---

## A. PRODUCTION stations — audit (2026-06-06)

**Verdict: the production line is well-guarded.** Every forward transition already enforces the
correct prior state. The only production-side weakness is PKG_OUT's return branch.

| Station | Action | Requires (input) | Other guards | Output | Status |
|---|---|---|---|---|---|
| INW | postScan | UPC `available` in `upc_pool`; not already inwarded | device=INW; car product == line's active run (`lineProductGuard`) | `inwarded` | ✅ keep |
| QC_PASS | postQcPass | `inwarded` \| `repaired` | device=QC_PASS; rejects remote-scanned-as-car | `qc_pass` | ✅ keep |
| QC_FAIL | postQcFail | `inwarded` \| `repaired` | device=QC_FAIL; line-product guard | `qc_fail` | ✅ keep |
| WKS_IN | postScan/postWksScan | `qc_fail` | device=WKS | `in_repair` | ✅ keep |
| WKS_OUT | postScan/postWksOut | `in_repair` | device=WKS | `repaired` (loop++) | ✅ keep |
| PKG | postPkg | `qc_pass` (fresh) \| `allocated` (re-pack) | device=PKG; **pair-verify** car+remote paired at QC; not-already-packed (no active pkg_scans/dispatch_box_units) | `pending_rtd` / `allocated` | ✅ keep |
| PKG_OUT | postPkgOut | **fresh:** `pending_rtd` → RTE/RTR | device=PKG_OUT | `rtd` | ⚠️ fresh OK; **return branch = hole** |

### A.1 PKG_OUT — the fix (two-state guard)

PKG_OUT must accept **only**:
1. **Fresh / re-packed:** `current_status = 'pending_rtd'` (last scan PKG) → RTE/RTR fresh dispatch.
   (Also covers repaired CXR/BRV returns — they are re-PKG'd back to `pending_rtd`.)
2. **Processed UDR return:** `current_status = 'rto_in'` **AND** a `store.return_units` row for the
   car with **all of**: `disposition='UDR'`, `issue_type='udr'`, `issued_at` IS NOT NULL,
   `released_at` IS NULL → RTD_RETURN **non-destructive** re-dispatch (keeps the box label).

**Reject everything else — critically a bare `rto_in` with no valid UDR-issued record.**
Implementation: in `postPkgOut`'s `rto_in` block, the existing UDR-guarded non-destructive branch
stays; **replace the "fall through to v1 destructive RTD_RETURN" with a hard error** (HTTP 422 +
`scan_violations` row) when no valid UDR record exists. This kills the box-label-deletion path and
makes a wrongly-`rto_in` unit un-re-dispatchable until Store dispositions it properly.

This guard is an **independent second line of defense**: even if RTO_IN wrongly flips a unit to
`rto_in`, it cannot be re-dispatched / lose its box label at PKG_OUT without a real UDR record.

---

## B. RETURNS / RE-DISPATCH boundary — audit + fix (the root holes)

### B.1 RTO_IN (legacy `postScan` station) — UNGUARDED INPUT
- Current: device-station lock exists (device must be set to RTO_IN) + duplicate-same-activity
  check ONLY. **No `current_status` guard** → flips ANY unit (fresh `pending_rtd`, `qc_pass`,
  `shipped`, `handed_over`…) straight to `rto_in`. This is what swept production units into returns.
- **Decision (Afshaan):** Returns-v2 `RET_IN` (`postReturnIntakeScan`) is the proper single intake
  door (binds RS-NNN, creates `return_units`, disposition workflow — RULE-RET-001). The legacy
  RTO_IN station is **redundant**.
  - **Preferred fix: RETIRE legacy RTO_IN** — remove from the scanner station list + drop `RTO_IN`
    from `postScan`'s `ALLOWED` array. Route ALL returns through `RET_IN`.
    - Operational implication: `RET_IN` requires an open `RS-NNN` shipment selected on the device
      first (the single-door process). Retiring RTO_IN **forces** that. Flag to floor (Piyush/Mrudula).
  - **Fallback if a no-shipment quick path must stay:** guard RTO_IN to accept **only
    `current_status='shipped'`** (last scan DOUT — a genuine customer return) and reject all else.

### B.2 PKG_OUT `rto_in` branch (RTD_RETURN) — see A.1 (two-state guard kills destructive fallback).

### B.3 RTD_RETURN — what it is (keep it)
Not a station; a branch of PKG_OUT. When a box is scanned at PKG_OUT and the car is `rto_in`, it
re-dispatches the return (reuses the original box label, `rto_in`→`rtd`). Legitimately needed for
the UDR re-dispatch flow in v2 — **keep it**, but only reachable via the A.1 guard (valid UDR record).

### B.4 REPAIR-run stations (`postRepScan`, station `REPAIR`) — UNGUARDED INPUT (same hole class)
**These ARE the current/v2 repair stations** — verified against the live scanner station picker
(only `REPAIR` → REP_START/REP_PASS/REP_SCRAP, plus the separate `WKS` workshop). Returns-v2 (S104)
**reused the repair line unchanged** (RULE-RET-001: "Repair line (REP_START/QC re-pair/WKS/PKG)
reused unchanged"). No `REP_QC`/forked repair-QC station exists — the v2 re-pair happens at the
**normal QC_PASS station** (`postQcPass`, which accepts `repaired`). Full v2 chain:
`issueReturnUnit`(repair) → **REP_START** (`→in_repair_run`) → repair → **REP_PASS** ("REPAIRED →
SEND TO QC", `→repaired`) → **QC_PASS** (re-pair car+remote, `→qc_pass`) → **PKG** (`→pending_rtd`)
→ **PKG_OUT**. QC_PASS + PKG are already guarded; the gap is REP_START/REP_PASS/REP_SCRAP input state.

`scan_type` ∈ REP_START / REP_PASS / REP_SCRAP. **No positive input-state guard.**
- **REP_START** — current guards: device valid; 10s dedup; blocks already-`in_repair_run`; blocks a
  duplicate `repair_run_units` row in the same run. **Gap:** any non-`in_repair_run`, non-terminal
  unit (incl. fresh `pending_rtd`/`qc_pass`/`inwarded`) can be pulled into a repair run.
- **REP_PASS** — current: 10s dedup; blocks terminal (`repaired`/`scrapped_repair`/`shipped`/
  `handed_over`). **Gap:** does NOT require `in_repair_run` first — code explicitly allows REP_PASS
  without a prior REP_START (S77 operator-training concession). Almost any non-terminal unit → `repaired`.
- **REP_SCRAP** — same gap as REP_PASS → `scrapped_repair`.
- Note: the **production QC-fail loop uses WKS** (WKS_IN requires `qc_fail`, WKS_OUT requires
  `in_repair`) and IS guarded. The gap is the **REP-run** stations, which serve **returns** repair.

**Proposed guard:**
- **REP_START** → require the unit to be a **CXR/BRV return issued to THIS run**: `store.return_units`
  row with `disposition ∈ ('CXR','BRV')`, `issue_type='repair'`, `repair_run_id` = scanned run.
  Reject fresh/dispatched units.
- **REP_PASS / REP_SCRAP** → require `current_status='in_repair_run'` (enforce REP_START sequencing;
  drop the S77 "REP_PASS without REP_START" leniency).
- **CONFIRM (Afshaan):** is a repair run returns-only (CXR/BRV), or also used for production QC-fail /
  Pitstop repair tickets? That sets REP_START's exact eligible-input set.

---

## C. DISPATCH stations — audit (TODO)
DTK (`rtd`→`handed_over`), ALLOC, PACK, DOUT. To be audited next.

## D. OTHER scanner stations — audit (TODO)
RET_IN, EXT_INW, REPACK_IN/REPACK_OUT (note: REPACK_IN is intentionally un-status-gated per S87 —
revisit), LEGACY_REG, STORE_ISSUE, DSP_ISSUE, LOOKUP. To be audited next.

---

## Rollout
1. Implement after floor settles (Afshaan to trigger).
2. Edit → commit → push → `cd 01_worker && npx wrangler deploy` (sequence per CLAUDE.md).
3. Scanner UI: drop RTO_IN from the station picker (`02_scanner/index.html`) if retiring B.1.
4. Floor heads-up: returns now go through RET_IN (open an RS-NNN shipment first).
