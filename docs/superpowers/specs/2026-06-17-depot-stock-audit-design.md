# Depot — Dispatch Stock Audit (design)

> Status: approved (Afshaan, S148). Architecture choice: **B — self-contained module** (v1 kept lean).
> System: Depot (dispatch back-office). Worker: `lotopsproxy` (shared, no new worker). Schemas: `store` + `public`.
> Spec date: 2026-06-17.

## Problem

Dispatch has no governed way to verify that the finished cars the *system* thinks it holds
actually exist on the floor. Counts drift (order cancellations, mis-scans, lost/found units,
units marked shipped that never left). Today the only counting tool is the **`/dispatch-counts`
scratchpad** (`unit_counts` — random-scan a pile to rebuild a strayed count); it is ad-hoc, has
no check-and-balance, and is explicitly **left alone**.

We need a **proper, governed stock audit**: the dispatch team scans their physical stock, the
system shows a per-product variance against the held count, surfaces the exact box labels not
found, and — after a second person reviews — self-corrects the system. Every audit is recorded
in a register so all counts are tracked.

## Core principles (from brainstorming)

1. **Full physical scan, not aggregate tally.** The floor scans the actual `LOT-…-E/R` box
   labels; the discrepancy is exact specific units, not just a number.
2. **The floor never hunts.** They scan whatever is in front of them and submit. The system
   derives missing (expected, not scanned) and extra (scanned, not expected). The *targeted*
   re-look (going to find specific missing batch labels) is optional and driven by the variance
   report — never a mid-count checklist chase.
3. **Idempotent / multi-pass.** Scanning is dedup-by-UPC, so re-scanning, redoing, or adding
   more units just merges. They keep scanning until the variance closes.
4. **Open scope, report only what was scanned.** Variance is shown only for products that got
   ≥1 scan. Un-scanned products are "not audited this run," never flagged as missing.
5. **Check and balance.** Counter ≠ reviewer. One review, then corrections post. Light enough
   for daily use, but a genuine second pair of eyes on every write-off.

## What "held" means

Cars only (remote is implied by the car's box-label pairing — RULE-009 holds, no separate
remote audit). A car is **physically held by dispatch** when:

```
component_type = 'car' AND current_status IN ('handed_over', 'allocated')
```

- `handed_over` = handed to dispatch (post-DTK), not yet allocated.
- `allocated` = allocated to a channel; **includes "packed"** (packed is a *box* state —
  `dispatch_boxes.status='packed'` — the unit stays `current_status='allocated'`).
- Excluded: `pending_rtd` (still with production, pre-handover), `shipped` (left the building),
  `lost`/`scrapped_*`, and all production statuses.

Every held car carries a **`batch_label`** (`LOT-<upc>-E` / `LOT-<upc>-R`) created at PKG and
stored in `public.pkg_scans.batch_label`; mirrored to `dispatch_allocations.batch_label` at
ALLOC. This is the physical barcode on the box the team scans, and what the "missing labels"
list shows. Source of truth for the label = `pkg_scans` (covers both held statuses), fallback
`dispatch_allocations`.

## Lifecycle

```
OPEN ──▶ (scanning, re-scannable) ──▶ submit ──▶ IN_REVIEW ──▶ approve ──▶ COMPLETED
  └────────────────────────── cancel ──────────────────────────────▶ CANCELLED
```

- **OPEN** — a supervisor opens an audit. The dispatch team scans held cars (floor scanner or
  desk paste). Live variance is viewable any time.
- **submit** — the counter freezes the variance into audit lines and moves the audit to
  IN_REVIEW. No more scanning.
- **IN_REVIEW** — a **different** supervisor reviews the variance, optionally skips individual
  lines, and approves.
- **COMPLETED** — on approval, corrections post (per-unit re-validated) and counts are stamped.
- **CANCELLED** — abandon without correcting (reason optional).

**One audit OPEN at a time** in v1 (keeps the scanner unambiguous). Concurrent D1/D2 audits =
later enhancement.

## Data model (new `store` tables — RLS on, `GRANT ALL … TO service_role`)

### `store.dispatch_audits` (header)
| column | type | notes |
|---|---|---|
| `id` | bigint PK | identity |
| `audit_no` | text UNIQUE | `AUD-NNNN` via `store.sequences` key `dispatch_audit` |
| `status` | text | `open`/`in_review`/`completed`/`cancelled` (CHECK) |
| `area` | text NULL | free-text note ("D1 racks", etc.) |
| `notes` | text NULL | |
| `opened_by` | uuid | auth user |
| `opened_at` | timestamptz | default now() |
| `submitted_by` | uuid NULL | |
| `submitted_at` | timestamptz NULL | |
| `reviewed_by` | uuid NULL | the approver (≠ counter) |
| `reviewed_at` | timestamptz NULL | |
| `present_count` | int NULL | stamped at submit/complete |
| `missing_count` | int NULL | |
| `extra_count` | int NULL | |
| `corrected_count` | int NULL | stamped at complete |

### `store.dispatch_audit_scans` (raw scan log, deduped)
| column | type | notes |
|---|---|---|
| `id` | bigint PK | |
| `audit_id` | bigint FK → dispatch_audits ON DELETE CASCADE | |
| `car_upc` | text | |
| `batch_label` | text NULL | captured value scanned |
| `product`/`model`/`color` | text NULL | snapshot at scan for display |
| `scanned_by` | uuid NULL | operator id |
| `device_code` | text NULL | `DESK-AUDIT` for desk paste |
| `scanned_at` | timestamptz | default now() |

**`UNIQUE(audit_id, car_upc)`** — insert is `ON CONFLICT DO NOTHING` → idempotent multi-pass.

### `store.dispatch_audit_lines` (frozen variance + correction record)
Written at **submit**, one row per discrepancy + (optionally) per present unit.
| column | type | notes |
|---|---|---|
| `id` | bigint PK | |
| `audit_id` | bigint FK ON DELETE CASCADE | |
| `car_upc` | text | |
| `batch_label` | text NULL | |
| `product`/`model`/`color` | text NULL | |
| `result` | text | `present`/`missing`/`extra` (CHECK) |
| `expected_status` | text NULL | held status at submit (null for extra) |
| `found_status` | text NULL | actual status of a scanned extra |
| `correction` | text | `none`/`write_off`/`restore`/`skip` (CHECK); default by result |
| `corrected_to_status` | text NULL | stamped at complete |
| `reviewed` | boolean | default false |

> To keep line volume sane, `present` units need not each get a line — present count is derived.
> v1 writes lines for **missing + extra only** (the actionable discrepancies); `present_count`
> is computed. (Decision: lines = discrepancies only.)

## Worker actions (lotopsproxy)

All on `lotopsproxy`. Reads via existing `garageFetch` GET routing; writes via POST switch
(JWT) except the scanner action.

- **`getDispatchAudits`** (GET, `canCountRecord`) — register list (filter by status, recent N).
- **`createDispatchAudit`** (POST, `canCountRecord`) — guard: no other `open` audit exists
  (one-at-a-time). Mints `AUD-NNNN`. Returns the audit.
- **`getDispatchAudit`** (GET, `canCountRecord`) — header + **live variance** while open
  (computed: scanned set vs held cars, grouped by product, scoped to scanned products) OR the
  frozen lines once submitted. Includes the missing-batch-label drilldown + extra list.
- **`postStockAudit`** (SCANNER_ACTION, device + operator gated) — one scan: resolve the
  scanned `LOT-…` label → `car_upc`; dedup-upsert into `dispatch_audit_scans`; attach to the
  single OPEN audit (or the `audit_id` passed from the station). Returns running scanned count
  + the unit's product/variant + a soft flag if the unit isn't currently held (still recorded —
  it becomes an "extra" at variance time). Never hard-blocks a foreign/duplicate scan.
- **`addAuditScansBulk`** (POST, `canCountRecord`) — desk fallback: paste UPCs/labels →
  same dedup-upsert; `device_code='DESK-AUDIT'`.
- **`submitDispatchAudit`** (POST, `canCountRecord`) — freeze: compute variance for scanned
  products, write `dispatch_audit_lines` (missing + extra), set default `correction`
  (missing→`write_off`, extra→`restore`), stamp counts, status → `in_review`.
- **`reviewDispatchAudit`** (POST, `canCountApproveL1`) — **guard `reviewed_by ≠ opened_by`
  and `≠ submitted_by`**. Optional payload to `skip` specific line ids (sets correction=`skip`).
  Applies corrections (re-validate each unit's current status at this instant; skip if it no
  longer matches the expected/found state recorded):
  - `missing` + `write_off` → `units.current_status = 'lost'`.
  - `extra` + `restore` → `units.current_status = 'handed_over'`.
  - `skip` → no change (left for a future audit).
  The correction record is the `dispatch_audit_lines` row itself (`correction` +
  `corrected_to_status`) plus the audit header — **no `stock_adjustments` row** (approach B).
  Stamps `reviewed_by/at`, `corrected_count`, status → `completed`.
- **`cancelDispatchAudit`** (POST, `canCountRecord` or `canCountApproveL1`) — status →
  `cancelled`; no corrections.

**Permissions:** reuse existing keys — counting/opening/scanning = `cycle_count_record`
(`canCountRecord`); review/approve = `cycle_count_approve_l1` (`canCountApproveL1`). No new
permission layer; Depot stays on `store.roles`. Scanner station is operator-gated (operator
login required), no extra perm.

## Scanner station (`02_scanner/index.html` + worker)

New **Dispatch → Stock Audit** station, code `STOCK_AUDIT`:
1. worker: add `'postStockAudit'` to `SCANNER_ACTIONS`; add `'STOCK_AUDIT'` to
   `OPERATOR_GATE_STATIONS`; implement handler.
2. scanner: add a `stock_audit` category to the `dispatch` department; line type `D` (D1/D2
   picker, though stationless for audit — line is cosmetic); station config (label/hint/
   activity `STOCK_AUDIT`); scan handler posts `postStockAudit` with `batch_label`, `device_id`,
   `operator_id` (+ resolved open `audit_id`).

UX: operator unlocks Dispatch (PIN) → operator login → station resolves the single OPEN audit
(shows "no open audit — open one in Depot" if none) → scans box labels → screen shows running
count + last unit + soft "not currently held" flag. Re-scans dedup silently.

## Depot UI

New page under the **Floor** nav group: **Stock Audit** (`/dispatch-audits`).
- **List/register** — every audit: no., status badge, opened/submitted/reviewed who+when,
  present/missing/extra, corrected. Search by `audit_no`. "Open new audit" button.
- **Detail** —
  - *Open*: live variance table (product · held · scanned · missing · extra), missing
    drilldown (batch labels to look for), extra list, a "Scan via floor scanner" hint + a
    desk "Add scans (paste)" box, and a **Submit for review** button.
  - *In review*: frozen variance, per-line skip toggles, **Approve & correct** button
    (hidden/disabled for the counter — enforced server-side too).
  - *Completed*: read-only variance + what was corrected.

Reuses the Depot kit (Panel/FilterChip/ToneBadge/Icon). `canCountApproveL1`-gated controls
degrade gracefully for non-approvers.

## Correction semantics (summary)

| result | meaning | default correction | effect on approve |
|---|---|---|---|
| present | scanned ∧ held | none | — |
| missing | held ∧ not scanned | write_off | `current_status → 'lost'` (reversible) |
| extra | scanned ∧ not held | restore | `current_status → 'handed_over'` |
| (any) | reviewer chose skip | skip | no change, left for next audit |

`lost` is reversible: a later audit that scans a written-off unit lands it as **extra →
restore → handed_over**. Foreign/unknown UPCs scanned by mistake appear as extras whose
`found_status` is null/unknown; reviewer skips them (no auto-restore of a non-unit).

## Out of scope (v1) / later

- Scheduling, daily reminders, assignment of audits to people (register shows cadence for now).
- Concurrent open audits (D1/D2 at once).
- Per-present-unit line rows (present is a derived count in v1).
- Writing corrections into the shared `stock_adjustments` ledger (approach C) — only if a
  unified cross-system corrections report is wanted later.
- Remote-level audit (not needed — pairing carries it).
- Any physical location/bin model (separately dropped S148).

## Invariants / rules touched

- RULE-009 (dispatch = cars only) — upheld.
- New cross-cutting rule to add on build: **RULE-AUDIT-001** (dispatch stock audit: full-scan,
  open-scope, dedup, counter≠reviewer single-review, missing→lost / extra→handed_over,
  self-contained in `store.dispatch_audit*`).
- Every new `store` table: RLS on at creation + `GRANT ALL … TO service_role` (CORE invariant).
- New scanner station must be in `OPERATOR_GATE_STATIONS` (RULE-SCAN-001 / PATTERN-137).
- `store.sequences` new key `dispatch_audit` for `AUD-NNNN`.
