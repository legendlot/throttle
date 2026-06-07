# Garage PRODUCTION Group Removal — Design Spec

> **Status:** Design LOCKED (2026-06-08, Afshaan) — all decisions confirmed (§8). NOT yet built.
> Two build-time verifies noted: receipt Contested→Locked store sub-flow (§8.3) and repair-run home (§8.6).
> **Scope:** Remove the Garage **PRODUCTION** nav group entirely. Production owns *requests
> and decisions* (Redline); the store owns *fulfilment* (Garage, mostly already the Issue Queue).
> Each production tab is split along the production↔store seam, not blindly relocated.
> **Predecessor:** S110 run-request consolidation (`2026-06-07-run-request-consolidation-design.md`,
> RULE-RUN-001). This finishes the front-end half: S110 moved *creation* to Redline; this removes
> the leftover Garage front-end and routes the remaining management actions to the correct end.
> **Related rules:** RULE-RUN-001, RULE-EXT-001 (+S110 amend), RULE-RET-002, RULE-SHORT-001, RULE-001.

---

## 1. Locked framing (from the live discussion, 2026-06-07/08)

1. **Production REQUESTS and DECIDES; the store FULFILS.** Production only requests — it never
   issues or sends. *All* issuance and sending is Store/Garage (Afshaan). The two apps are the two
   ends of one process; do not merge or duplicate them.
2. **The Garage PRODUCTION nav group is removed from the front end entirely** (Production Runs,
   Ad Hoc Requests, Line Flush, Process Deviations). Backends stay — they now take requests from
   Redline and serve the store via the Issue Queue.
3. **Do not touch the S110 request surface** (`apps/redline/(auth)/new-run`) or duplicate/regress it.
4. **The store side mostly already lives in the Issue Queue** — fold the few remaining store actions
   in there so it feels simple and natural, not bolted on.

## 2. Per-tab decisions

### 2.1 Line Flush — split by end
- **Production-facing (raise):** production finishes a build and returns leftover material to the
  store by raising a line flush. → **Redline.** New page `apps/redline/(auth)/line-flush`: the raise
  form + the flush list + read-only detail. Gate `line_flush_create`.
- **Store-facing (receive / dispose / accept):** the store receives the flush, sets a disposition,
  and accepts material back into inventory. → **stays in Garage.** Keep `apps/garage/(auth)/flush-verify`
  (under STORE) and **fold the Quarantine Register into it as a second tab** (it's store
  bin-management; it currently rides on the Garage line-flush page that's being deleted).
- **Delete** `apps/garage/(auth)/line-flush`.
- Worker: unchanged. Redline reuses `getProductionRuns`, `getMaterials`, `getFlushes`/`getFlush`,
  `postFlush` (all already callable from Redline). The Garage raise loaded runs to attach a flush to
  a run — preserve that in Redline.

### 2.2 Process Deviations — purely production → Redline
- It documents a temporary/permanent process change with supervisor review; the store has no
  process deviations. **Move the whole thing to Redline** and **delete** Garage's page.
- Redline today has a *floor view* (active-by-line cards + read-only pending + quick-ack) that
  banners "use the Garage page for the full queue." Replace it with the **full management console**
  ported from Garage (all status tabs; full detail modal: approve / reject / escalate / acknowledge /
  close / retro sign-off; full propose modal), **keeping the by-line active cards as the "Active"
  tab** presentation. Remove the banner.
- **User management is unaffected.** The deviation tier permissions (`deviation_propose`,
  `deviation_approve_l1/l2/l3`, `deviation_close`) are role permissions assigned in Garage `/users`
  (the central role matrix). They **stay in Garage** — the feature just *reads* them and the worker
  enforces them. Nothing in user management moves; the deviation perm keys stay in the Garage
  `/users` PERM_DEFS.
- Worker: unchanged (`getProcessDeviations`, `getProcessDeviation`, `getActiveDeviations`,
  `proposeDeviation`, `approve/reject/escalate/acknowledge/cancel/close/confirmRetroactive`).

### 2.3 Production Runs — split along the production↔store seam
The Garage `production-runs` page (RunsTable + 715-line RunDetailPanel + ReceiptPanel + RejectRunModal
+ RepairRunDetailPanel) mixes production decisions and store execution. Split it:

**Run lifecycle → owner → app**

| Action | Worker handler | Owner | Lands in |
|---|---|---|---|
| Create run (fresh/outsourced/repair/repack) + ad-hoc | `createProductionRun`/`createRepairRun`/`createRepackRun`/`postWorkOrder` | Production | **Redline** `new-run` ✅ S110 |
| Issue build/normal materials against a run | `issueAgainstRun` | Store | **Garage** Issue Queue ✅ exists |
| **Reject run** (e.g. parts unavailable) | `RejectRunModal` | Store | **Garage** Issue Queue ✅ **already there** (line 974) |
| **Confirm Receipt** (accept issued qty → Short Issue WO on short) | `postIssueReceipt` | Production | **Redline** 🔨 move |
| **Re-Appeal** a contested receipt | `reappealIssueReceipt` | Production | **Redline** 🔨 move *(proposed — review)* |
| **Complete run** | `completeProductionRun` | Production | **Redline** 🔨 move |
| **Cancel run** (pre-issue Draft/Submitted) | `cancelProductionRun` | Production | **Redline** 🔨 move *(proposed — review)* |
| **Force Resolve** a locked receipt (`procurement_approve`) | `forceResolveReceipt` | Procurement/admin | **stays Garage** *(proposed — review)* |
| Outsourced — **Send to Vendor** | `markRunSentOut` | Store | **Garage** Issue Queue 🔨 fold in |
| Outsourced — **Receive units into pool** | `receiveExtUnits` (+ legacy `assignOutsourcedLine`) | Store | **Garage** Issue Queue 🔨 fold in |
| Outsourced — **Request Finish** | NEW (sets a finish-requested marker) | Production | **Redline** 🔨 new |
| Outsourced — **Issue Finish parts** | `issueAgainstRun` (phase=finish) | Store | **Garage** Issue Queue 🔨 surfaces as a pull |
| Ext-inward stickering | `postExtInw` | Floor | Scanner ✅ unchanged |

**A. "Recent Runs" on the Redline `new-run` tab — NOT a separate page.** Production management folds
into the existing request surface (`apps/redline/(auth)/new-run`), below the request tabs, as a
**Recent Runs** table grouped by state for clarity (Afshaan):

| Group | Run state | Production actions |
|---|---|---|
| **Requested** | created, pre-issue (Draft/Submitted, store hasn't issued) | **Cancel** (pre-issue) |
| **Issued** | store has issued the pick | **Confirm Receipt** (+ ReceiptPanel) · **Re-Appeal** (if contested) · **Complete** |
| **Upcoming** | outsourced, issued + sent to vendor, awaiting return (In Progress, `ext_v2`) | **Request Finish** — **greyed out until the store has inwarded units** (pool has received qty); enables once available · **Complete** |

- Read-only pick list + vendor/run info + WOs + receipt banner in the row's detail; the actions above
  are the production-owned ones only.
- Does **not** include Reject / Send-to-Vendor / Receive-units / Issue-Finish (store, in the Issue
  Queue). Once production clicks **Request Finish**, the FINISH pull appears in the store's Issue Queue
  (§3); after the store issues it, production stickers at Ext Inwarding.
- Ad-hoc requests already live on this tab (S110) — Recent Runs sits alongside them (§2.4).
- Repair runs have their own Redline home (`/repair-queue`, `/returns`); confirm repair-run detail is
  reachable there, and move `RepairRunDetailPanel` content over if not (§8.6).

**B. Issue Queue fold-in** (`apps/garage/(auth)/issue-queue`, store side):
- **Reject:** already present — no change.
- **Outsourced run detail** gains two contextual store actions when opened: **Send to Vendor**
  (`markRunSentOut`, when build is issued / status Issued) and **Receive units into pool**
  (`receiveExtUnits`, when In Progress). These move verbatim from RunDetailPanel into the Issue
  Queue's run detail — same handlers, same look as the rest of the queue.
- **Finish pull:** when production clicks **Request Finish** in Redline, the In-Progress `ext_v2`
  run surfaces in the Issue Queue as a **FINISH** row (phase=finish pick), issued by the store via
  the existing `CONFIRM ISSUE` → `issueAgainstRun {phase:'finish'}` path. This is the *only* new
  worker/queue wiring (see §3).
- **Delete** the Garage `production-runs` page + its components (`RunsTable`, `RunDetailPanel`,
  `ReceiptPanel`, `RejectRunModal` stays — still used by the Issue Queue —, `RepairRunDetailPanel`
  moves to Redline).
- **Issue Queue "RUN" deep-link** (Recent Issues, line 1100, `/production-runs?run=`): drop it —
  render the run number as plain text (no cross-app jump).

### 2.4 Ad Hoc Requests — already on the Redline tab; tracking joins Recent Runs
- The ad-hoc **request** is already the "Ad Hoc Parts" tab on Redline `new-run` (S110). The pending
  piece is **tracking/cancelling** open ad-hoc requests — that joins the **Recent Runs** table (§2.3 A)
  on the same tab, so production requests and tracks runs *and* parts in one place (Afshaan).
- **Delete** Garage `work-orders` page (track/cancel) + `WorkOrdersTable`.

### 2.5 Remove the Garage PRODUCTION nav group
- After 2.1–2.4, delete the entire `production` group from `apps/garage/src/lib/nav.js` (all four
  items) + drop orphaned icon imports (`Cog`, `ClipboardList`, `Workflow`; keep `AlertTriangle` —
  used by Damage Ledger).
- `apps/redline/src/lib/nav.js`: add **`line-flush`** to the PRODUCTION group. **No** separate
  production-runs item — run management lives in the Recent Runs table on `new-run` (New Run / Request
  + Deviations already there). Consider relabelling `new-run` to "Runs / Requests" since it now hosts
  both requesting and managing.

## 3. The one real worker change — Request Finish → Issue-Queue pull

Today "Issue Finish Parts" is a Garage button that *both* triggers and issues the finish phase
(store self-initiation). To honour pull-based fulfilment (RULE-RET-002) and §3.2 ⑦ of the S110 spec:

- The **Request Finish** control lives in the **Upcoming** group of Recent Runs (§2.3 A). It is
  **greyed out until the store has inwarded units** — i.e. until `receiveExtUnits` has put returned
  units in the `ext_return_pool` (`run.ext_summary.returned_qty > 0` / pool stock available). Then it
  enables.
- **Production "Request Finish"** (Redline) sets a finish-requested marker on the run
  (additive column, e.g. `production_runs.finish_requested_at timestamptz` — verify live schema;
  no enum change).
- **Issue Queue** additionally loads In-Progress `ext_v2` runs where `finish_requested_at IS NOT NULL`
  and finish isn't yet issued; renders a **FINISH** badge row (reusing the run-row machinery), opened
  → `getProductionRun {phase:'finish'}` pick → `CONFIRM ISSUE` → `issueAgainstRun {phase:'finish'}`
  (already supported on In-Progress ext_v2 runs, S110).
- Build-phase (the initial outsourced run) is unchanged — it already auto-surfaces in the queue and
  the store issues build-only (S110).

Everything else reuses existing handlers; this is the only behavioural addition (worker = lotopsproxy,
**high blast radius — Garage + Redline + Scanner** — sequence carefully).

## 4. Permissions (verified live `store.roles`, 2026-06-08)
- Redline app access is **open to any authenticated LOT user** (`RequireAuth` checks only a session);
  pages gate by perm. No grants needed.
- `line_flush_create`: admin, super_admin, production_manager, production_team, store_head → gates the
  Redline raise. `line_flush_verify` (store roles) → stays the Garage Flush Verify gate.
- `deviation_propose` / `deviation_approve_l1/l2/l3` / `deviation_close` → gate the Redline console
  (unchanged keys; still assigned in Garage `/users`).
- `run_request` (admin, super_admin, production_manager, production_team, store_head) → gates the new
  Redline production runs view.
- The current Garage `production-runs` page had **no UI perm gate** and its components never checked
  perms (worker enforces). Keep worker enforcement; add `run_request` only as the Redline nav gate.

## 5. Affected files
- **`01_worker/worker.js`:** `getProductionRun` finish marker awareness (none needed for the pick —
  phase=finish already works); the Issue-Queue feed must include finish-requested In-Progress ext_v2
  runs (extend `getProductionRuns` usage in the queue *or* a small `getFinishQueue`); `markRunSentOut`
  / `receiveExtUnits` unchanged; a `requestExtFinish` (or reuse a field set) action to stamp
  `finish_requested_at`.
- **`apps/redline`:** extend `(auth)/new-run/page.js` with a **Recent Runs** section (Requested /
  Issued / Upcoming groups + per-state production actions) + ad-hoc tracking; port `ReceiptPanel`
  (Confirm Receipt / Re-Appeal); new `(auth)/line-flush/page.js`; full Process Deviations console
  (replace floor view, keep by-line cards); `lib/nav.js` (+ line-flush only).
- **`apps/garage`:** Issue Queue — Send-to-Vendor + Receive-units on the outsourced run detail, FINISH
  pull rows, drop the `/production-runs?run=` deep-link; Flush Verify — add Quarantine Register tab;
  delete `production-runs/` (+ RunDetailPanel/ReceiptPanel/RepairRunDetailPanel), `work-orders/`,
  `line-flush/`, `process-deviations/`; `lib/nav.js` (remove PRODUCTION group).
- **Manuals (final step, in-system upkeep):** Garage manual — drop Production Runs / Ad Hoc / Line
  Flush / Process Deviations chapters; add Quarantine to the Flush Verify chapter; the Issue Queue
  chapter gains the outsourced store steps + FINISH pull. Redline manual — add Line Flush, Production
  Runs (production view), full Process Deviations; New Run / Request notes Request-Finish. Rebuild both
  PDFs + `manual.json`.

## 6. Risk / blast radius
- Worker change is small but in `lotopsproxy` (Garage + Redline + Scanner) — edit → commit → push →
  deploy, smoke before relying on it. No DB migration except one additive column (`finish_requested_at`).
- Monorepo build affects Garage + Redline; shared packages aren't touched. Build all apps.
- Legacy outsourced runs (`ext_v2=false`, EXT-001/002/003) keep the old one-step receive — the
  finish-pull path only engages for `ext_v2=true` runs (mirror the S110 guard).

## 7. Build sequence (proposed)
1. **Process Deviations → Redline** (full console + cards; delete Garage page). Self-contained, no
   worker/DB change. Lowest risk — do first.
2. **Line Flush split** — Redline raise page; Garage Flush Verify gains Quarantine tab; delete Garage
   line-flush. No worker/DB change.
3. **Production Runs split** — Recent Runs on Redline `new-run` (Requested→Cancel / Issued→Confirm
   Receipt·Re-Appeal·Complete / Upcoming→Request-Finish greyed-until-inwarded) + ad-hoc tracking;
   Issue-Queue fold-in (Send-to-Vendor, Receive-units, FINISH pull) + the worker finish-marker change
   + drop the deep-link; delete Garage production-runs + work-orders.
4. **Remove the Garage PRODUCTION nav group** + icon cleanup; Redline nav additions.
5. **Manuals** rebuild (both apps).
6. **Live floor smoke** — fresh issue + receipt-confirm (Redline) + short → Short WO; reject from Issue
   Queue; outsourced build → Send-to-Vendor → Receive → Request-Finish → store issues FINISH → Ext
   Inwarding; line-flush raise (Redline) → verify + quarantine (Garage); deviation propose/approve (Redline).

## 8. Resolved decisions (Afshaan, 2026-06-08)
1. **Cancel run** (pre-issue) → **Redline**, in the Recent Runs **Requested** group. ✅
2. **Re-Appeal** (contested receipt) → **Redline**, Recent Runs **Issued** group. ✅
3. **Force Resolve** (locked receipt, `procurement_approve`) → **stays Garage**. ✅ Place it where the
   store/procurement sees the receipt in Garage (Issue Queue run detail or a small receipts spot),
   gated by `procurement_approve`. Verify the receipt Contested→Locked sub-flow's store side during build.
4. **Ad-hoc tracking** → joins the **Recent Runs** table on the Redline `new-run` tab (request already
   there). ✅
5. **Finish pull** → render the In-Progress `ext_v2` finish-requested run as a **FINISH-badge row** in
   the Issue Queue (reuse run-row rendering), issued via `issueAgainstRun {phase:'finish'}`. ✅
6. **Repair-run detail home** (verify, not yet decided): the Garage page also showed repair runs
   (`getRepairRunsDash` + `RepairRunDetailPanel`). Confirm repair-run viewing/management is fully
   covered by Redline `/repair-queue` + `/returns`; if a gap, move `RepairRunDetailPanel` there. Recent
   Runs on `new-run` covers fresh + outsourced; repair stays in the repair surfaces.
