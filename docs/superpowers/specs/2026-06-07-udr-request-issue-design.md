# UDR Request → Issue design (Returns v2.1)

> Status: spec, awaiting build sign-off · Session 109 · Afshaan
> Scope: UDR ONLY. Repair (CXR/BRV) consolidation is a separate later exercise — do not touch it here.
> Governing rule: RULE-RET-002 (BUSINESS_RULES.md). Builds on RULE-RET-001 + the PKG_OUT UDR lock (lotopsproxy `2c5a9ba6`).

## Problem

Today the store **self-issues** UDRs (the Garage `/returns/udr-pool` page has a per-unit scan-out box
*and* a bulk "Issue all" button). That violates the store-is-pull-based principle, and the store has no
single, bounded view of what it owes. UDR is the only store issuance that isn't request-driven (besides
DSP, the sanctioned exception).

## Target model (locked decisions)

1. **Requester = Production, always.** Raised from Redline's returns view (mirrors "Request Repair Run").
   Never dispatch. (RULE-RET-002.)
2. **Request = a notional store work order** (`work_orders`, `wo_type='UDR'`): product/model/colour/qty,
   `status='Open'`. NOT a "dispatch order." Surfaces in the **Issue Queue** alongside production WOs.
3. **Store fulfils ONLY by scanning** at a new **Issue UDR** station (Store → Returns). No desk button.
4. **Scanner gate:** hard-reject a UDR scan with no open matching request (product/colour); soft-flag
   over-count (reconciles at PKG OUT).
5. Issuance stamps `return_units.issued_at` (drops from pool + locks). Unit stays `rto_in`; PKG OUT
   re-dispatches as today (locked branch).
6. **Line/daily total** counts fresh `PKG` + UDR `RTD_RETURN` (floor-level; PKG OUT is SHARED). No
   line-binding anywhere. (Separate, lighter sub-task — can follow the core.)

## Data model

- **`store.work_orders`** new `wo_type='UDR'`. Columns reused: `product`, `variant`, `colour`, `qty`
  (= requested qty), `status` (Open → Complete), `created_by`, `wo_no` (existing `WO-NNN` sequence).
  Fulfilled qty = COUNT of `return_units` linked to this WO (no new counter column needed) OR a
  `qty_fulfilled` column — decide at build (lean: derive by COUNT to avoid drift).
- **`store.return_units`** new nullable `udr_wo_no text` — links an issued UDR unit to the request it
  fulfilled (audit + fulfilled-count). Additive migration.
- No other schema changes.

## Worker (`01_worker/worker.js`)

- **`createUdrRequest`** (JWT, `canManageFloor` — Production/Redline): body `{ lines:[{product,model,color,qty}], notes }`.
  Creates one `work_orders` row per line, `wo_type='UDR'`, `status='Open'`. Mirrors `createRepairRun`'s shape.
  (Guard: production-role; reject if a line's qty exceeds the available UDR pool for that product/colour? →
  soft-allow, notional — see open Q3.)
- **`getWorkOrders`** — already returns non-planned open WOs; confirm `wo_type='UDR'` passes its filter
  (it filters `wo_type=neq.planned`), so UDR WOs surface with no change. Issue-Queue page adds `'UDR'` to
  its client-side allow-list + a green "UDR" badge.
- **`postUdrIssueScan`** (NEW `SCANNER_ACTION`, device-auth, in the SCANNER_ACTIONS if-chain — RULE-007):
  body `{ scan, device_code, operator_id }`.
  1. Resolve scan → `car_upc` (strip `-E/-R`).
  2. Find the open UDR `return_units` row (`disposition∈(UDR,udr)`, `issued_at IS NULL`, `released_at IS NULL`).
     None → hard-reject + `scan_violations` ("not a UDR / already issued / not a return").
  3. Find an **open `wo_type='UDR'` work order** matching the unit's product (+colour/model). None → **hard-reject**
     ("no open UDR request for <product> — Production must request it first") + `scan_violations`.
  4. Stamp `return_units.issued_at = now`, `issued_to_production_at = now`, `udr_wo_no = <wo_no>`, operator from session.
  5. Recompute the WO's fulfilled count; if `>= qty` set the WO `status='Complete'`; if over, soft-flag
     (`scan_violations` station `UDR_ISSUE`, like the pick over-scan) but still accept.
  6. Return product/colour + remaining qty for the operator feed.
- **No change to `postPkgOut`** — the UDR re-dispatch branch + the lock already handle the rest.

## Scanner (`02_scanner/index.html`)

- New `STATION_DEFS.UDR_ISSUE` = `{ label:'Issue UDR', activity:'UDR_ISSUE', hint:'SCAN UDR BOX LABEL OR UPC' }`.
- Add to `DEPARTMENTS.store` → `Returns` category: `stations:['RET_IN','UDR_ISSUE']`. SHARED (no line);
  add `UDR_ISSUE:'none'` to `STATION_LINE_TYPE`. Operator-gated (Store already is).
- Scan handler: `cfg.stationCode==='UDR_ISSUE'` → `workerPost('postUdrIssueScan', {...})`; success beep +
  feed row "✓ Issued <product> (N left on request)"; hard-reject → red screen + buzz + the worker message.

## Garage (`apps/garage`)

- **Issue Queue** (`issue-queue/page.js`): add `'UDR'` to the WO allow-list (line ~191); badge `'UDR'`
  tone green; clicking a UDR row is informational (fulfilment is on the floor scanner, not here).
- **`/returns/udr-pool`** → **read-only pool view**: drop the scan-out box AND the "Issue all" button;
  show the pool (product/colour/count of un-issued UDRs) + a column of open UDR requests + fulfilled/qty.
  (Issuance is scanner-only now.)

## Redline (`apps/redline`)

- **`/returns`** (returns piles view): add **"Request UDR Issue →"** next to "Request Repair Run →".
  Opens a picker of the UDR buckets (`getReturnPilesV2` UDR pile) + qty per line → `createUdrRequest`.
  Production/Supervisor only.

## Build sequence

1. Migration: `work_orders` accepts `wo_type='UDR'` (no DDL if `wo_type` is free text — verify CHECK);
   `return_units.udr_wo_no text` (additive). Advisors clean.
2. Worker: `createUdrRequest` + `postUdrIssueScan` + Issue-Queue/`getWorkOrders` confirm. Commit → push → deploy.
3. Scanner: `UDR_ISSUE` station + handler. Push (GH-Pages).
4. Garage: Issue Queue badge + read-only UDR pool. Build all apps.
5. Redline: Request UDR Issue. Build.
6. Line/daily UDR count (optional, can be a follow-up): add `RTD_RETURN`(udr) floor tally.
7. Manuals: fold the new station + request flow (Garage/Redline) — same PR.

## Open questions (resolve at build)

- Q1: Fulfilled count derived (COUNT of linked `return_units`) vs a `qty_fulfilled` column. Lean: derive.
- Q2: Match granularity — product only, or product+colour+model? Lean: product+colour (matches pool buckets).
- Q3: Should `createUdrRequest` cap qty at the available UDR pool, or allow notional over-request? Lean:
  allow (notional), warn if over pool.
- Q4: Line/daily UDR count — ship with the core or as a fast-follow? Lean: fast-follow.
