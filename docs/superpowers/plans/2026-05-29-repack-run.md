# Repack Run (Channel Swap) — Implementation Plan

> Created 2026-05-29 (Session 86). Lotops (Garage/Redline/Scanner) feature.
> Status: **design approved, not yet built.** Build blocked only on Supabase MCP
> reconnect (schema verification + DDL). Forward workflow only — no reconciliation
> of already-swapped units.

## Problem

The floor swaps a unit out of a **retail box** into an **ecom box** (or vice versa)
before dispatch — peeling the label, swapping the carton, hand-editing the DB.
Packaging differs per channel (RULE-012: `qty_ecomm` vs `qty_retail` Primary
Packaging rows), so a channel swap genuinely consumes a different box and needs a
fresh sticker. Today this is ad-hoc and error-prone. **The team is actively packing
now — this is priority.**

## Decisions (locked with the user, 2026-05-29)

1. **Whole old box is the unit of work.** REPACK_IN = scan the *old box label*; the
   worker pulls all active units in that box and processes them as a set. Per-unit
   scanning is a fallback, not the primary path.
2. **Stage-agnostic.** A run does not force a single lifecycle stage; the worker
   undoes each unit whatever state it is in.
3. **Old box → returned to store via Line Flush**, NOT scrapped at repack time.
   REPACK does not touch stock for the old box. Surviving boxes flush back to store
   stock; damaged ones simply aren't flushed. (`verifyFlush` dispositions already
   split Return-to-Stock vs Scrap — that *is* the "some survive, some don't"
   flexibility.)
4. **Forward workflow only.** No reconciliation pass for units already hand-swapped.

## Mechanics confirmed against live worker code (01_worker/worker.js)

- **PACK gate is `dispatch_box_units.is_active`** (PATTERN-091), not `pkg_scans`.
  `pkg_scans` is print history. Any path that frees a unit must set
  `is_active=false` or PACK throws "Unit already packed in a box".
  (postPack: `worker.js:5791–5928`.)
- **A re-pack path already exists.** `postPkg` accepts `allocated` units
  (PATTERN-036); `postPack` flows from `allocated`. `RTD_RETURN`
  (`worker.js:5013–5094`) and `postRestock` (`worker.js:7399–7490`) already do the
  exact "free a packed unit" undo: append scan + `is_active=false` on box_units +
  DELETE pkg_scans + flip status + mirror paired remote.
- **The only missing primitive** is freeing a *packed-but-not-returned* unit for a
  deliberate channel swap (REPACK_IN), then re-packing into the dest channel
  (REPACK_OUT).
- **Line flush needs no schema change.** `postFlush` (`worker.js:11932`) can be
  raised standalone (no run/WO anchor — both are conditional). `verifyFlush`
  (`worker.js:11985`) routes each returned line via dispositions (Return-to-Stock /
  Scrap → damage_ledger / Rework → WO).
- **Channel encoding:** `pkg_scans.channel` ∈ {`'ecom'`,`'retail'`} (note: `ecom`,
  not `ecomm`); batch_label suffix `-E`/`-R`; box↔channel match enforced at
  `postAlloc` via suffix.

## Open gates (must clear before/at build)

1. **Supabase MCP reconnect** — needed to verify schema + run DDL. (Daemon now
   connected; session restart required to load the tools.)
2. **DDL needs per-action approval** (standing rule) — show each migration first.
3. **`units.current_status` enum-vs-text** — docs contradict: `packed_dispatch` was
   added as an enum value (`unit_status_add_packed_dispatch`) but `direct_issued` is
   described as free text with "no CHECK constraint". Verify against live schema:
   `SELECT data_type, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='units' AND column_name='current_status';`
   If enum-typed → `ALTER TYPE unit_status ADD VALUE 'in_repack';` else no migration.
4. **Scoping confirms:** (a) from/to channel = `dispatch_channels` retail/ecom rows;
   (b) is a repack run global or scoped to a dispatch line (D1/D2)?

## Data model

- **`store.repack_runs`** — header. `RPK-NNN` from `store.sequences` (key `'repack'`;
  seed `INSERT INTO store.sequences (name,current_val) VALUES ('repack',0)`).
  Columns: id, run_no, product, variant_model, colour, from_channel, to_channel,
  target_qty, status, created_by, timestamps. Mirrors `production_runs`. GRANT ALL to
  service_role.
- **`public.channel_swap_history`** — append-only, one row per car swapped: car_upc,
  paired_remote_upc, repack_run_id, from_channel, to_channel, old_box_id, new_box_id,
  old_batch_label, new_batch_label, repack_in_scan_id, repack_out_scan_id,
  operator_id, line, swapped_at.
- **Enums:** `activity_type += 'REPACK_IN','REPACK_OUT'`; `unit_status += 'in_repack'`
  (only if enum-typed — gate #3).

## Worker (lotopsproxy)

New SCANNER_ACTIONS (device_code auth, dispatch stations):
- **`postRepackIn`** — scan OLD BOX label → fetch all active `dispatch_box_units` in
  box → validate each car in run scope (from_channel + product/variant) → per car +
  paired remote: append `REPACK_IN` scan, `is_active=false` (removed_at/removed_by),
  DELETE pkg_scans, `current_status='in_repack'`, release old shipment line slot
  (`release_dispatch_line_slot` if line-attributed). Stage-agnostic. Mirror remote.
- **`postRepackOut`** — scan car (status `in_repack`, belongs to run) → print new
  dest-channel sticker → new `pkg_scans` (channel=to_channel, batch_label new
  `-E`/`-R`) → new `dispatch_box_units` in a to_channel box (is_active=true) →
  `current_status='packed_dispatch'` → increment dest line → write
  `channel_swap_history`. Mirror remote.

New JWT CRUD: `createRepackRun`, `getRepackRuns`, `getRepackRun`,
`completeRepackRun`, `cancelRepackRun`. On create: compute dest-channel Primary
Packaging from BOM (RULE-012) → raise Issue Request (work_order) for the new boxes.
Permission: new `repack_run_manage` (or reuse a dispatch perm — confirm).

Old-box return: Repack Run detail "Flush old boxes" → standalone `postFlush` with
`flush_lines` for from_channel Primary Packaging, `return_type='Unused'`, qty = old
box count → store verifies → surviving boxes Return-to-Stock, damaged Scrap.

## Scanner (02_scanner/index.html)

Two stations `REPACK_IN` / `REPACK_OUT` in the dispatch group (D1/D2), gated like
PACK/DTK (`DISPATCH_STATION_CODES`). New device rows `REPACK_IN-D1/D2`,
`REPACK_OUT-D1/D2`. REPACK_IN UI: scan box, show units freed. REPACK_OUT: scan car,
print new sticker, scan into new box.

## UI (Redline dispatch)

Repack Run list + detail mirroring Production Run (in-scope / repacked / remaining),
create form (product/variant/from→to/target_qty), "Flush old boxes" action.

## Phasing (fast floor relief)

- **Phase 1 (stops hand-editing):** `postRepackIn` + `postRepackOut` + two scanner
  stations + minimal run-create. Floor swaps channels through the scanner with full
  audit.
- **Phase 2:** full run UI, auto box Issue Request, flush-old-boxes button, reports.

## Build order

1. Reconnect Supabase MCP (restart session).
2. Verify schema (gate #3 + dispatch_channels rows + Primary Packaging BOM).
3. DDL (approval each): seed `store.sequences` 'repack'; `store.repack_runs`;
   `public.channel_swap_history`; enum adds; service_role grants.
4. Worker: REPACK_IN / REPACK_OUT + CRUD → commit → push → `wrangler deploy`.
5. Scanner stations + device rows.
6. Redline UI.
7. Knowledge files: systems/lotops.md + BUSINESS_RULES.md (RULE-REPACK-*) + BACKLOG
   (close the Repack design item) + archive/SESSIONS.md.
