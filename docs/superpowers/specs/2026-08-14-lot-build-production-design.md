# L.O.T Build — Production & Tracking System

**Status:** DESIGN — not built. One physical test gates the whole thing (§3).
**Date:** 2026-08-14 · **Author:** Claude session S278 · **Origin:** Anusha's "LOT BUILD IDEA - V1"
**Closes:** the TBD in RULE-LOTBUILD-001 — *"Production model is per-SHEET… This is still TBD (needs its own production/stock/scan design)."*

---

## 1. What this is

L.O.T Build is laser-cut wooden puzzles and desk standees — a separate category from the RC car
line. One sellable product is **N laser-cut sheets**, where N is 1 for most standees and up to 8+
for Colosseum. Today there is no production system at all: parts are catalogue-only with stock set
by hand.

This spec defines production, identity, QC and packing for Build, running **parallel to LOT Cars on
the same stack** — same worker, same scanner, same Redline, same dispatch chain downstream.

**Live catalogue this must serve** (measured 2026-08-14): 28 active SKUs across 8 families —
11 HP desk standees, 6 HP drops, 6 Wooden Garage, plus Colosseum, Taj Mahal, Eiffel Tower,
Leaning Tower of Pisa, DIY Drone.

⚠️ **The catalogue is dominated by simple products.** Most SKUs are 1–2 sheets. The design must not
make the common case pay for the rare one — see §5, single-sheet products fall out for free.

### Goals, in priority order (Afshaan, 2026-08-14)

1. **Traceability** — *"which particular sheet got scrapped and where, and from which batch, which run"*
2. **QC analytics** — defect rates by product, position, machine, board
3. **Complete-box assurance** — never ship a box missing a sheet or carrying a duplicate

No customer has yet reported a wrong or incomplete box; the line is new and low-volume. This is
being built ahead of the problem, deliberately.

---

## 2. The hardware and software reality

| | |
|---|---|
| Machine | Creative Laser **CL1610**, 150W CO₂ (Ahmedabad) |
| Controller | **Ruida RD6445S** |
| Current software | **RDWorks** (Ruida's own) — free, no licence |
| Proposed software | **LightBurn Pro** — $199 one-time, perpetual, 3 seats, $40/yr optional updates |

**Why the software question decides the design:** the laser replicates a design file N times across
the bed. Whether it can vary *data* per copy determines whether sheets can be identified by the
laser itself or need physical stickers.

- **RDWorks CAN vary a serial per copy** (`Enable SN array`) — but has **no barcode or QR
  generation at all**, and no CSV import. Its serial is human-readable text from a machine-local
  counter. Unusable: not scannable, and it reintroduces per-machine counters that Redline can't own.
- **LightBurn CAN drive a QR code from CSV variable text**, with `Variable Offset` giving each copy
  in an array a different row. It supports the RD6445S. This is the enabling capability.

---

## 3. ⚠️ THE GATING TEST — do this before anything is built

**Etch one QR code onto your actual wood and scan it with the actual floor scanner.**

Everything below assumes this passes. It is cheap, it takes an afternoon, and it is the only
question that can invalidate the whole approach.

Test on the **smallest** sheet in the catalogue, not Colosseum:

1. QR encoding a real 12-character payload (`LOT-00300123`)
2. At the size that actually fits the waste frame
3. On each wood type in use (pine, MDF, baseboard)
4. Scanned by the floor scanner, at floor lighting, by an operator not looking for it to work

Also measure **added etch time per copy** — seconds × 8–10 copies × every bed is real machine
capacity, and it is a cost nobody has counted yet.

**If it fails**, fall back to the sticker design (§10). Everything else in this spec is unchanged —
only the identity-creation station differs.

---

## 4. Architecture decisions

Each of these was contested. Recording the reasoning so they are not silently reversed.

### D1 — The unit's identity is an **anchor sheet**, not a new number ✅

One position per product is marked `is_anchor`. **That sheet's UPC is the unit.** At packing it
becomes `pkg_scans.car_upc` and the box label is `LOT-00300123-E` / `-R`.

**Why this matters more than it looks:** 13 tables carry a `car_upc` column — `pkg_scans`,
`unit_pairs`, `dispatch_allocations`, `dispatch_box_units`, `dispatch_audit_lines`,
`dispatch_audit_scans`, `return_units`, `unit_restocks`, `repack_releases`, `channel_swap_history`,
`unit_pairing_history`, `units` — plus **273 references in the worker**. Dispatch, PKG OUT, returns
intake, repack, restock, audits and channel swap all assume one primary UPC per shippable unit.

Minting a separate box number (as the original doc proposed) means Build units never populate
`car_upc`, and **every one of those tables needs a parallel Build path**. That is a second dispatch
chain, not a widened pair-scan.

It also matches Cars exactly: `batchLabel = ${car_upc}-${channelCode}`. Cars has never minted a
third number for the box.

**Consumption: N LOT numbers per unit, not N+1.**

### D2 — Sheets are **not** `product_master` rows ✅

Sheet definitions live in their own tables. `product_master` stays "things you can sell".

Reasons: 28 SKUs × N sheets would flood Odo, Dispatch, `sku_map` and every report with rows that
are not products; `product_master.component_type` has a CHECK of `car|remote|accessory|drone|puzzle`
so a `sheet` value would fail on insert anyway; and sheet counts **change with design revisions**,
which is not something `product_master` should track.

`units.component_type` has no CHECK and takes `'sheet'` freely.

### D3 — Sheet sets are **versioned** ✅

A product's sheet set is a revision. A unit records the revision it was packed against.

Without this, changing Colosseum from 8 sheets to 9 retroactively makes every previously packed
unit "incomplete". Same reasoning as pinned journey versions in Relay and `bom_register.bom_version`.

### D4 — Identity is created **when the sheet comes off the bed**, not before ✅

Afshaan: *"identity can only be created after something is taken off the laser bed… in the direction
of keeping things simple rather than complicating them for no reason."*

Nothing before the bed is tracked. Offcuts and part-boards are written off. Yield is derived, not
counted (§9).

### D5 — Cut-out and QC are **one station, one gesture** ✅

QC happens immediately after removal from the bed. Two stations would be theatre.

⚠️ **Deviation from Cars, recorded deliberately:** Cars creates the `units` row at INW with status
`inwarded`, then QC moves it to `qc_pass`. Build creates the `units` row **directly at
`qc_pass`/`qc_fail`** in one scan. Someone will later ask why Build has no INW — this is why.

### D6 — The **cut session** is a first-class object ⭐ NEW, not in the original doc

The original design tracked sheets to a *sticker print batch*. That is the wrong grouping.

A sticker batch is 100 stickers off a printer. The **physical** batch is one bed run — one board,
one machine, one settings profile, 8–10 copies, one moment. Warped board, drifting focus, bad
material lot: those defects cluster by **bed run**, and a sticker batch cuts across many of them.

Goal 1 asks *"from which patch"*. Without cut sessions that question has no answer.

**With etched QR this becomes elegant: one CSV = one bed run = one batch.** The unit of numbering
and the unit of physical causation become the same object.

---

## 5. Identity model

Three layers, each answering a different question:

| Question | Answered by | Why there |
|---|---|---|
| **Which position is this sheet?** | Etched into the cut file — static, identical on every copy | The risky question. Answered by physics, not by a human comparing similar wooden sheets |
| **Which individual sheet is this?** | Etched QR from CSV — unique per copy | Only variable data can do this. Redline owns the number |
| **Which unit did it go into?** | `unit_sheets`, written at pack | Set membership is only knowable at pack time |

**The original doc's #1 downfall disappears rather than being mitigated.** It proposed applying
position stickers and having QC "confirm the sheet matches its label" — asking a human to
distinguish eight similar sheets by eye, on every sheet, forever. With position cut into the wood by
the same file that cuts the shape, misapplication is not mitigated, it is **impossible**.

**Single-sheet products fall out for free.** For an HP standee, its one sheet is the anchor: sheet
UPC = unit UPC, pack scans one sheet, box label is that UPC + channel. Structurally identical to a
car with no remote. No extra machinery for the common case.

---

## 6. Schema

All additive. No changes to existing columns or constraints.

### `store.build_sheet_sets` — the set header
```
id            uuid pk
product_code  text not null        -- public.product_master.product_code
revision      int  not null        -- 1, 2, 3…
status        text not null        -- draft | current | superseded
effective_from date
note          text
created_at/by
UNIQUE (product_code, revision)
partial UNIQUE (product_code) WHERE status = 'current'
```

### `store.build_sheet_defs` — the positions in a set
```
id         uuid pk
set_id     uuid not null → build_sheet_sets(id) ON DELETE CASCADE
position   text not null        -- 'S01'
label      text                 -- 'Base plate', for the operator
is_anchor  boolean not null default false
sort_order int
UNIQUE (set_id, position)
partial UNIQUE (set_id) WHERE is_anchor   -- exactly one anchor per set
```

### `store.build_cut_sessions` — one bed run ⭐
```
id             uuid pk
session_no     text unique          -- CS-NNNN via store.sequences
run_id         uuid                 -- the Build production run
set_id         uuid → build_sheet_sets
position       text not null        -- the ONE position on this bed
machine_code   text                 -- 'CL1610-01'
material_ref   text                 -- board / GRN / supplier lot, if known (OPEN Q2)
csv_batch_id   text                 -- the upc_batches batch this bed consumed
status         text                 -- open | closed
opened_at/by · closed_at
```

### `public.units` — additive columns
```
+ sheet_position   text     -- 'S01', null for Cars
+ cut_session_id   uuid     -- null for Cars
+ sheet_set_id     uuid     -- the revision this sheet was cut against
```
`component_type = 'sheet'` for non-anchor sheets, `'puzzle'` for the anchor.

### `public.unit_sheets` — set membership
```
id         uuid pk
unit_upc   text not null    -- the ANCHOR sheet's upc = the unit
sheet_upc  text not null
position   text not null
set_id     uuid not null    -- revision pinned at pack (D3)
packed_at  timestamptz
UNIQUE (sheet_upc)          -- a sheet can belong to exactly one unit, ever
INDEX (unit_upc)
```
⚠️ **Do not widen `unit_pairs`.** RULE-RET-001 §3 depends on its exact car⇄remote semantics for
returns disposition and pairing history.

### `store.build_pack_sessions` + `build_pack_scans` — the pack claim
```
build_pack_sessions
  id uuid pk · device_code · operator_id · set_id · channel (ecom|retail)
  status (open|committed|abandoned) · opened_at · committed_at

build_pack_scans
  session_id uuid → build_pack_sessions(id) ON DELETE CASCADE
  sheet_upc text not null · position text · scanned_at
  UNIQUE (sheet_upc) WHERE session status = 'open'   -- enforced by partial index
```
⚠️ **Why server-side and not scanner-local:** with N=8 an operator can be interrupted mid-set, and
worse, **two packers can scan the same sheet into two different boxes**. Each scan must *claim* the
sheet server-side. The original doc treats pack as one atomic action, which only works at N=2.

### `public.upc_pool` — additive
```
+ sheet_position  text    -- the position this number was minted for
```
A number is born knowing its position. That is what lets the QC station reject a code from the
wrong position batch **in software**, before any human comparison.

---

## 7. Stations

Two new scanner stations, both device-authed, both operator-gated.

⚠️ **Both must be added to `OPERATOR_GATE_STATIONS` in the worker.** A station whose handler requires
`operator_id` but is missing from that set is dead on arrival — no operator can sign in. This is the
PATTERN-218 shape and it has bitten twice.

### Station A — `BUILD_QC` ("Cut Out")

Under **Production**. Sits at the laser.

**Session open:** operator selects run → product → position → machine. Creates a `build_cut_session`.

**Per sheet:** scan QR → **Pass** or **Fail** (+ defect code).

**Validation on every scan:**

| Check | Failure message |
|---|---|
| Code exists in `upc_pool` | `Unknown code — not a generated sheet number` |
| Code's `sheet_position` matches the open session's position | `This is an S05 code — the bed is running S03` |
| Code not already scanned | `Already recorded — S03, passed, 14:22` |
| Code's batch matches the session's `csv_batch_id` | `This code belongs to another bed run` |

The second check is the one that matters: **a wrong-batch code is caught by software on the first
scan**, not by eyesight.

**On pass:** insert `units` row directly at `qc_pass`, with `sheet_position`, `cut_session_id`,
`sheet_set_id`, `production_run_id`. Insert `scans` row `activity='QC_PASS'`.
**On fail:** same, at `qc_fail`, `activity='QC_FAIL'` + defect code. The sheet can never be packed.

**Session close:** stamps `closed_at`. Yield for that bed = sheets recorded ÷ copies on the bed.

### Station B — `BUILD_PACK`

Under **Production**, notionally separate from cut-out (Afshaan: *"ideally a different station"* —
may be the same person).

**Start:** operator selects channel (ecom / retail). Opens a `build_pack_session`.

**Per sheet:** scan → claim → running progress display (`S01 ✓ · S03 ✓ · S05 ✓ — 3/8`).

**Commit** (automatic when the set is complete, or explicit):

Validation, all of which must pass:
1. Every sheet belongs to the **same product**
2. Every sheet was cut against the **same set revision**
3. **Exactly one** of each position in that revision — nothing missing, nothing duplicated
4. Every sheet is `qc_pass`
5. No sheet already appears in `unit_sheets`

On success: anchor sheet → `pkg_scans.car_upc`; `batch_label = <anchor>-E|-R`; `unit_sheets` rows
written; anchor `units.current_status = 'packed'`; non-anchor sheets → `'packed'`; box label printed
via `print_jobs`.

On failure the scanner names the exact reason — `Missing S05`, `S03 scanned twice`,
`S07 failed QC on 12 Aug`, `S02 is Colosseum, S04 is Taj Mahal`, `S06 is revision 2, this set is revision 3`.

---

## 8. Material, runs and yield

**Build runs become real.** Production plans a Build run in Redline the same way as a Cars run;
wood is issued against it.

⚠️ **Wood cannot be a per-unit BOM quantity.** One board yields 8–10 copies of *one* position, so
"boards per unit" is a fraction that varies by position. `bom_register.qty_per_unit` is an integer
and cannot express it.

**Use RULE-LUMP-001** — it exists for exactly this: lump-sum materials issue a flat quantity per
picklist rather than `qty_per_unit × units`. Wood is issued to the run as a lump. The per-unit BOM
stays **Box + Manual** (RULE-LOTBUILD-001, unchanged — no comic, no licence).

**Yield needs no offcut tracking:**
```
yield = sheets that received identity ÷ boards issued to the run
```
Sliceable by machine, product, position and operator, because the cut session carries all four.

---

## 9. Redline surfaces

| Surface | Purpose |
|---|---|
| **Sheet Sets** (admin) | Define positions per product, mark the anchor, create revisions |
| **Generate batch → CSV** | Allocate N LOT numbers for one position, export the CSV LightBurn merges |
| **Cut sessions** | Live and historical bed runs — yield, defects, machine, operator |
| **Build runs** | Plan runs, issue wood, track completion |
| **Quality** | Defect rate by product · position · machine · board. Goal 2 |

---

## 10. Fallback: stickers

If the §3 scan test fails, revert Station A's identity source to **20mm printed QR stickers**
applied after removal from the bed. Everything else in this spec is unchanged.

The sticker design then needs, at minimum:
- **Position etched into the cut file anyway** (static, free) so the physical sheet still declares
  what it is
- One position per bed (already true) so only one sticker roll is at the station at a time
- The `upc_pool.sheet_position` check in Station A, which catches a leftover roll on the first scan
- A reprint path for smudged or peeled labels — reissue the **same** code, never a new serial

Cost of the fallback: sticker rolls, printing, and roughly **8 sticker applications per Colosseum
unit, permanently**.

---

## 11. Rules to amend

**RULE-LOTBUILD-001** — the TBD closes. Replace *"Production model is per-SHEET… still TBD"* with a
pointer to this spec. The "catalog-only, set stock manually" line becomes false once runs exist.

**RULE-009** — ⚠️ **material.** Dispatch counts today filter to the primary unit (car OR drone) and
`component_type='puzzle'` is **deliberately excluded** from primary-unit metrics. That was correct
when Build wasn't produced. Once Build units flow through dispatch, **the anchor must be counted or
dispatch numbers silently under-report by the entire Build line**.

**RULE-002 / RULE-LUMP-001** — record that Build wood is lump-sum by design, so nobody "fixes" the
missing per-unit quantity.

---

## 12. Build order

| Phase | Contents | Gate |
|---|---|---|
| **0** | The scan test (§3) | Everything |
| **1** | Schema + sheet-set admin in Redline | — |
| **2** | Batch → CSV generation; LightBurn workflow proven on one bed | Phase 0 |
| **3** | `BUILD_QC` station — worker + scanner | Phase 2 |
| **4** | `BUILD_PACK` station — worker + scanner + box label | Phase 3 |
| **5** | Build runs + lump-sum wood issue | Phase 3 |
| **6** | Quality + yield reporting | Phase 5 |

**Phases 3 and 4 are where Build starts producing sellable, traceable units.** 5 and 6 are the
management layer and can lag.

---

## 13. Open decisions

| # | Question | Blocks |
|---|---|---|
| 1 | Is the etched **position** code feasible on the smallest standees, where waste frame space is already tight? | §5 layer 1 |
| 2 | Do boards carry any identity on arrival — GRN or supplier lot? If yes, `cut_sessions.material_ref` links traceability back to the supplier | §6, Goal 1 |
| 3 | Does a QC-failed sheet's wood need to reconcile against boards issued, or is it written off like offcuts? | §8 |
| 4 | Who owns the laser workstation — can LightBurn be installed without a third party? | Phase 2 |

---

## 14. Corrections to the original document

Recorded so the reasoning isn't relitigated. All four were verified against live code or the
vendor's own manual.

| Claim in "LOT BUILD IDEA - V1" | Reality |
|---|---|
| *"Sheet UPC = product code + running serial… the same shape Redline already prints (FAXXR00289821)"* | The QR encodes `upc_id` = the **global** `LOT-########`. `FAXXR00289821` is human-readable text: product code + that same global number. There is no independent per-product serial in the scannable payload. The doc contradicts itself — Part A says "independent", Part E says "one global sequence". **Part E is right.** |
| *"Redline generates the full-unit LOT, prints the outer-box barcode"* | Cars derives the box label from the car's own UPC: `batchLabel = ${car_upc}-${channelCode}`. No third number is minted. Adopting the doc's version costs a 9th number per Colosseum **and** cuts Build out of 13 `car_upc` tables. See D1. |
| *"Generating the batch auto-registers every UPC… no separate inward scan needed"* | In Cars, generation only fills `upc_pool`; the `units` row is created at the **INW scan**, gated by `lineProductGuard`. Skipping it is a real deviation — resolved deliberately in D5, not by accident. |
| *"The laser takes a design file and replicates it N times"* (stated as a hard constraint) | **RDWorks already supports per-copy serials** via `Enable SN array`. The real limits are no QR/barcode generation and no CSV import — which is what makes LightBurn the answer, not the replication behaviour. |

**And one gap the doc did not see:** sheets were to be traced to a *sticker print batch*, which
cannot answer *"which patch"*. The cut session (D6) is the addition that makes Goal 1 achievable.

---

## Sources

Creative Laser CL1610 · Ruida RD6445S controller · RDWorks V8 manual §Variable Text ·
LightBurn Variable Text documentation · LightBurn forum: QR codes and arrays from CSV ·
LightBurn Ruida Ethernet guide · MIT EHS and Stanford EHS laser safety guidance
