# Part Coverage — "Are we covered?" supply-status engine

> Spec · 2026-06-20 · Status: DESIGN (pre-build, awaiting go-ahead)
> Backlog: [lotops]/[snorkel] [HIGH] "Part supply-status / are-we-covered view" (Afshaan 2026-06-20)
> System: Garage / Redline (lotopsproxy). v1 = planning-moment panel.

## 1. Problem

When the team plans a new production run, they scramble across Garage (stock/producibility),
Snorkel (POs), Manifest (China shipments), and receiving to answer two questions nobody can
answer in one place today:

1. **What's missing from the store that will block this run?**
2. **For each missing part — is it being acted on?** Ordered / in transit / landed-not-GRN'd /
   or just sitting ignored.

All the data exists. The missing piece is the **join across systems + a single status verdict
per part**, surfaced at the moment of planning.

## 2. Goal & scope

**v1 — planning-moment panel.** In the Redline new-run flow (and a standalone Garage check),
the planner picks **product + qty** and gets, before submitting, a per-part **coverage verdict**
that answers both questions. Lead with blockers; collapse what's fine.

**Out of scope for v1** (phased later): the standing floor-wide "Supply Blockers" board (v2);
direct `manifest.*` part-level read (blocked — see §8); landed-cost / money (never — qty + stage only).

## 3. The verdict taxonomy (the product)

For every part in the resolved BOM, exactly one verdict:

| Verdict | Condition | Planner action |
|---|---|---|
| ✅ **Covered** | net available ≥ required | none |
| 🟡 **Short — fully inbound** | short, correctly-coded inbound ≥ shortfall | wait; ETA shown |
| 🟠 **Short — partially inbound** | correctly-coded inbound > 0 but < shortfall | top up the order |
| 🔴 **Short — nothing ordered** | shortfall, no inbound on any live-attributable code | **raise a PO** |
| ⚠️ **Short — mis-coded / stranded** | shortfall, but inbound (or stock) sits on a **dead/superseded** code | **re-code / transfer**, don't re-order |

Q1 (am I out?) = the ✅ vs short split. Q2 (acted on?) = the inbound columns + stage/ETA.
The ⚠️ row is the money-saver — it catches orders that won't actually replenish the live part.

## 4. Data sources (all `store` for v1)

| Need | Source | Notes |
|---|---|---|
| Required per part | existing BOM resolver in `getProducibility`/`getProductionRun` | platform-aware (`platformOf`/`platformCommonRows`, RULE-PLATFORM-001), lump-sum (RULE-LUMP-001), channel packaging (RULE-012) |
| Live stock | `store.stock_ledger.closing_stock` (live code) | generated col (RULE-005) |
| Stranded stock | `stock_ledger.closing_stock` on superseded ancestor codes | walk `bom_register.superseded_by` |
| Code lineage | `store.bom_register` (`part_code`, `superseded_by`, `is_active`, `deprecated_at`) | soft-deprecation always sets `superseded_by` (RULE-004) |
| Open orders | `store.purchase_orders` (`status`, `source`, dates) + `store.po_lines` (`part_code`, `qty_ordered`, `qty_received`) | **India + projected-China both here at part level** |
| Landed not GRN'd | `store.receiving_lines` (`part_code`, `qty_counted`, `qty_grn`, `status`) | RULE-RCV-001 |

**No `manifest.*` read in v1** — its `order_lines.lot_product_code`/`part_code` are empty on all
lines today (vendor-code connector parked), so it yields no part-level mapping. Projected China POs
already carry LOT codes in `store.po_lines`, so China is covered there. See §8.

## 5. Resolver algorithm (per part)

```
1. lineage(part) = { live_code } ∪ { ancestors a : a.superseded_by ──*──> live_code }
2. live_stock     = closing_stock(live_code)
   stranded_stock = Σ closing_stock(a) for a in ancestors      # flagged separately
   net_available  = live_stock + stranded_stock
3. shortfall = max(0, required − net_available)
4. if shortfall == 0 → ✅ Covered
5. else gather inbound on ALL codes in lineage:
     open_po_lines  : PO.status ∉ {Cancelled} AND outstanding > 0
                      outstanding = qty_ordered − received_qty   # see §8 for received_qty
     landed_lines   : receiving_lines where qty_counted − qty_grn > 0
   classify each inbound row:
     - on LIVE code (or active code)      → "good" inbound  (counts toward shortfall)
     - on DEAD/superseded code            → "mis-coded" inbound (does NOT count)
6. good_inbound = Σ good rows ; mis_coded_inbound = Σ dead-code rows
   if good_inbound ≥ shortfall                       → 🟡 fully inbound
   elif good_inbound > 0                              → 🟠 partial
   elif mis_coded_inbound > 0 OR stranded_stock > 0   → ⚠️ mis-coded / stranded
   else                                               → 🔴 nothing ordered
7. stage + ETA: derive from the most-advanced good (or, for ⚠️, the mis-coded) inbound row (§6)
```

## 6. Unified stage + ETA

Collapse three lifecycles into one stage the floor reads at a glance. Stage of an inbound row:

| Stage | Derivation (live vocabulary confirmed 2026-06-20) |
|---|---|
| PO draft | `purchase_orders.status` ∈ {Draft, Sent} |
| On order (India) | status ∈ {Accepted, Approved, Confirmed & Payment Done}, `source='India'` → ETA `expected_delivery` |
| In production (China) | `source='China'`, `expected_ready_date` set, no `shipping_date` |
| In transit (China) | `source='China'`, `shipping_date` set / past, no `actual_arrival_date` → ETA `expected_arrival_date` |
| Arrived (China) | `source='China'`, `actual_arrival_date` set |
| Landed, awaiting GRN | `receiving_lines.qty_counted − qty_grn > 0` |
| In stock | counted in `closing_stock` |

(China per-leg detail — produced→picked-up→shipped→customs→cleared with milestone ETAs — lives in
`manifest.shipments`; surfaces only once the vendor-code connector populates `order_lines`, §8.)

## 7. Worker contract

New **read** action in `lotopsproxy` (`01_worker/worker.js`):

```
getPartCoverage({ product, qty })          # v1 input
  → { product, qty, summary: { blockers, unordered, mis_coded, partial },
      parts: [ {
        part_code, part_name, category, verdict,
        required, live_stock, stranded_stock, net_available, shortfall,
        inbound: [ { code, on_dead_code, superseded_by, source, qty, stage, eta } ],
        good_inbound, mis_coded_inbound,
        message            # human line e.g. "20,000 on order on dead code SH-ME-10 — won't replenish D1-ME-10"
      } ] }
```

- Reuse the existing platform-aware BOM resolution; do **not** re-implement.
- Pure read; **no cost data** → no `cost_view` needed. Gate on existing floor / `run_request` perm.
- Later inputs (same action, additive): `{ run_id }`, `{ part_codes: [] }`.

## 8. Edge cases & data-quality caveats

- **`po_lines.qty_received` is unreliable** (0/657 never written back — known backlog item). So
  `received_qty` is derived best-effort from `receiving_lines` (Σ `qty_grn` for the part on that
  shipment), not from `qty_received`. Where it can't be netted cleanly, show the PO as outstanding
  (gross) and label the qty "approx" rather than silently under/over-count. Inherits the
  "Pending POs never retire" limitation — acceptable for a planning hint; a manual "PO received
  elsewhere" close is the durable fix (separate item).
- **China via Manifest is invisible at part level until the vendor-code connector lands.** New
  (un-projected) China orders won't appear in coverage; only `store`-projected China POs do. State
  this in the panel footer ("China orders not yet projected to a PO are not shown"). When the
  connector + projection resume, manifest shipments become attributable and §6's China per-leg
  detail lights up — additive, no rework.
- **Stranded stock is counted but flagged**, never silently treated as available — it's physically
  under a different code and needs an `opening_stock` transfer (RULE-005) to land on the live code.
- **Lineage walk** must be cycle-safe (cap depth) and handle multi-hop chains (A→B→C).

## 9. Frontend (Garage/Redline panel)

- Trigger: Redline `/new-run`, after product + qty chosen, render a **Coverage** panel before submit.
  Also a standalone Garage page for ad-hoc "check any product × qty".
- Headline chip: **"3 blockers: 1 unordered · 1 mis-coded · 1 partial"**.
- List ordered 🔴 → ⚠️ → 🟠 → 🟡; ✅ collapsed behind "show all parts".
- Each blocker row: part, shortfall qty, and the `message` (action-state + stage + ETA).
- Footer caveats: the qty-approx note + the China-projection note.

## 10. Validation (live, 2026-06-20)

`D1-ME-10` (Drift 1 rear axle): live stock **−298**; ancestor `SH-ME-10` dead (`superseded_by=D1-ME-10`,
stock 0); PO **IN-CMP-0104** = 20,000 Accepted/India on **SH-ME-10**. Engine verdict: **⚠️ mis-coded** —
"short 298+; 20,000 on order but on dead code SH-ME-10 — won't replenish D1-ME-10." Correct, automatic.

## 11. Phasing

- **v1** — engine (`getPartCoverage`, store-only) + planning-moment panel in Garage/Redline. Closes the scramble.
- **v2** — standing "Supply Blockers" board aggregating across active demand (Garage panel or Odo lens); same engine.
- **v3** — manifest direct-read for China per-leg stage/ETA, once the vendor-code connector populates `order_lines`.
