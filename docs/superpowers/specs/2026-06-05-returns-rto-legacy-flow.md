# Returns / RTO / Legacy-Unit Flow — Physical + System Map

> **Status:** WORKING DOC (design discussion in progress, 2026-06-05). Not a final spec.
> Captures (1) the intended **physical** flow on the floor, (2) the intended **system** model,
> (3) the **current** system as actually built, and (4) the **gap / root cause** + open questions.
> Continue the design discussion from "Open Design Questions" at the bottom.
>
> **Scope:** Garage + Redline + Scanner returns. Code lives in `01_worker/worker.js` (lotopsproxy),
> `02_scanner/index.html`, and `05_Throttle/apps/garage/src/app/(auth)/returns/*`.
> Line numbers are approximate, as of 2026-06-05.

---

## 0. TL;DR of the problem

A returned car must leave the store carrying a **LOT box label** (`pkg_scans` row), never a raw
**legacy EAN**. The system *does* have a "swap legacy → LOT unit + notional box label" capability —
but it is mounted **only on the dispatch-side `LEGACY_REG` station in `dispatch` mode**. The
**production/store return path (RTO_IN → `return` mode) mints the LOT unit but NOT a box label**, so a
legacy return processed by production has nothing valid to scan at PKG OUT → it gets re-packed → drifts
to `handed_over` → PKG OUT rejects it ("expected `pending_rtd`"). That is Mrudula's block.

**Principle to honour:** one centralized swap point (store return-intake), nothing leaves the store as a
legacy EAN, and a unit never loses its box on the happy path.

---

## 1. Physical flow on the floor (INTENDED)

### 1a. Returns arrive in any form
- **With a box** (modern: carries a LOT box label `LOT-xxxxxxxx-E/R`).
- **With a box** (legacy: carries only an **EAN** on the box exterior, no LOT label).
- **As a loose unit** (car and/or remote, possibly no box).
- **Incomplete / wrong**: only car, only remote, broken, or a **switcheroo** (customer returned
  something other than what they received).

Every return is linked to two things, captured by the scan/barcode on it:
1. the **channel** it came from, and
2. the **courier / logistics partner** that brought it.

### 1b. Store = intake + classify (ALWAYS the first door)
The store scans every return in and records:
- **courier partner** + **channel** (auto-linked from the scan where possible),
- **classification**:
  - **UDR — Undamaged Return**: box + shrink-wrap fully intact, unit never accessed.
  - **DR — Damaged Return** (any damage to box/shrink-wrap, or unit accessible). Source-typed:
    - **CXR** — customer return
    - **BRV** — bulk return from a vendor
- For anything that **can't be scanned / has no product / switcheroo / car-only / remote-only /
  broken** → entered **manually** as a structured record of what physically arrived.

Output of intake = sorted **piles**, exposed to production.

### 1c. Production acts on the piles
- **UDR pile** → light **scrutiny only**: **RTO IN scan → PKG OUT scan → dispatch.**
  **The box is NEVER opened.** (A UDR could in principle go straight to dispatch; production is an
  intentional check layer.) Legacy UDR boxes get a **notional LOT box label** applied to the
  *still-sealed* box so they can flow through this path without opening — see §2.
- **DR pile** → **repair run** (NOT PKG OUT): pooled so production sees the count, requests stock
  from the store, and processes in one or more `REP-NNN` runs.
- If production damages a UDR box mid-process → it **becomes a DR** → repair run.

### 1d. The hard rule
> **Nothing leaves the store carrying a legacy EAN.** If it has a box, it leaves with a **LOT box
> label**. The legacy EAN → LOT swap happens **once, centrally, at store intake**, with no leakage
> downstream.

---

## 2. Intended SYSTEM model / principles

- **PKG OUT is box-label only.** It scans a batch/box label and looks up the `pkg_scans` row. It does
  **NOT** (and should not) process a loose unit — **pairing is fixed at QC PASS, the label is born at
  PKG.** A *missing* modern label is a non-issue: **LOOKUP reprints it** (the `pkg_scans` row exists).
- **Legacy units are the real complexity.** A legacy unit has only an **EAN** — never packed in-system,
  so **no LOT label and no `pkg_scans` row**, and LOOKUP cannot reprint a label that never existed.
- **The swap:** a legacy EAN must be converted to a **LOT unit + a notional box label** (a `pkg_scans`
  row + printed sticker), generated **without opening the box** and **without needing the real car/remote
  UPCs** (freshly minted / notional values are fine). From that moment it is indistinguishable from
  modern stock and flows through RTO IN → PKG OUT identically.
- **Single door, no leakage:** intake is the only entry; every return leaves intake either as a
  LOT-labelled boxed unit (UDR pile) or flagged DR/loss (repair pile). A raw legacy EAN never proceeds.
- **A unit never loses its box** on the happy path (re-label is the damaged-box exception only).

---

## 3. Current system AS BUILT

### 3a. Unit status lifecycle (verified transitions)

| Station / action | Scanner activity | Sets `units.current_status` | Notes |
|---|---|---|---|
| INW | INW | `inwarded` | inward scan |
| QC Pass | QC_PASS | `qc_pass` | **car+remote pairing fixed here** |
| PKG (pack) | PKG | `pending_rtd` (`allocated` if repack) | **box label `-E/-R` born here**, `pkg_scans` row + print job (worker ~5407, `newCarStatus` 5420) |
| PKG OUT (fresh) | RTE / RTR | `rtd` | **requires `pending_rtd`** (worker 5653) → `rtd` (5676) |
| PKG OUT (return) | RTD_RETURN | `rtd` | **requires `rto_in`** (worker 5532); **DELETES the `pkg_scans` row** (5577) + deactivates box-unit (5582) + releases `return_units` (5590) |
| RTO IN | RTO_IN | `rto_in` | returned car comes back (worker 6847 for existing units) |
| DTK | DTK | `handed_over` | **dispatch-side** (worker 5774/5781) |
| ALLOC | ALLOC | `allocated` | accepts `handed_over`/`allocated` (worker 5833 → 5928) |
| PACK (bulk) | PACK | `packed_dispatch` | bulk/manifest model (worker ~6452/6461) |
| DOUT | DOUT | `shipped` | accepts `allocated`/`packed_dispatch` (worker ~6716 → 6736) |
| REPACK OUT | REPACK_OUT | `pending_rtd` | channel-swap re-pack (worker 8571) |

**Key fact:** **PKG OUT only ever produces `rtd`.** `handed_over` is produced ONLY by **DTK** and by
**LEGACY_REG dispatch-mode registration** — both **dispatch-side**.

### 3b. The two dispatch sub-models (forward flow)
- **Unit / Cred-direct model:** … QC → **PKG (`pending_rtd`)** → **PKG OUT / RTE-RTR (`rtd`)**.
- **Bulk / channel-manifest model:** … → **ALLOC (`allocated`)** → **PACK (`packed_dispatch`)** →
  **DOUT (`shipped`)**; **DTK** lands units at `handed_over` feeding allocation.
  *(Dispatch-internal ordering is the dispatch team's domain and not the focus of this doc.)*

### 3c. Returns intake — currently TWO+ doors (not unified)
- **`RET_IN` scanner station** (Returns V2, S70 — `postReturnIntake`): AWB → channel auto-resolve,
  disposition (UDR / Repair / Loss) + condition; sets unit → `rto_in`; writes `return_units` row.
- **Garage `/returns/process`** (browser — `postReturnUnit`, **added S102**): logs a `return_units` row
  (category + product + optional batch label → resolves car/remote UPC); status `pending_inspection`.
- **`RTO_IN` scanner station**: generic "car came back" → `rto_in`. For a **13+ digit EAN/legacy QR**
  it routes to `registerLegacyUnit` **`return` mode** (scanner 4616/4624).

### 3d. Legacy registration — `registerLegacyUnit` (worker ~6809), station `LEGACY_REG`

| Mode | Reached via | Sets status | **Box label minted?** |
|---|---|---|---|
| **dispatch** | LEGACY_REG station (dispatch-side); scan **EAN off box** | `handed_over` | ✅ **YES** — mints LOT UPC(s) + notional `-E/-R` label + `pkg_scans` + print job (worker 6952–6982) |
| **store** | LEGACY_REG station; scan legacy car QR | `inwarded` | ❌ no |
| **return** | **RTO_IN station** (production); scan EAN/legacy QR | `rto_in` | ❌ **NO** — mints the LOT unit only; the label block is gated `if (d.mode === 'dispatch')` |

Scanner exposes only **Dispatch** and **Store** mode buttons on the LEGACY_REG station
(`02_scanner` 1009/1013). **Return mode is invoked implicitly from RTO_IN, and never mints a label.**

### 3e. Pools + repair (matches the intended piles)
- Garage `/returns/udr-pool` + `/returns/repair-pool` — aggregated by product/model/colour
  (`getReturnPools`). UDR "Mark Issued to Production" (`markReturnUnitIssued`).
- Repair pool → "Schedule Repair Run" (`assignToRepairRun` → `REP-NNN` + `repair_run_lines`).
- Redline `/returns` = read-only floor view of the same pools.

### 3f. Tables
- `store.return_shipments` (`RS-NNN`; has `created_at`, `received_date`, `channel_id`, status).
- `store.return_units` (`RU-NNN`; **no `created_at` — uses `logged_at`**; `return_category`, `disposition`,
  `status` default `pending_inspection`, `car_upc`, `batch_label`, `intake_source`, `released_at`,
  `repair_run_id`, …). Most existing rows are `intake_source='legacy'`/`'scanner'`.

---

## 4. The GAP / root cause

1. **The notional-box-label swap exists only in `LEGACY_REG` `dispatch` mode** → produces
   `handed_over` units that feed the **dispatch** flow (ALLOC → DOUT). It is **not exposed to store or
   production**, and the production-facing **`return` mode mints NO label**.
2. So a **legacy return handled by production** = LOT unit at `rto_in` **with no `pkg_scans`/label** →
   **PKG OUT has nothing valid to scan** → floor is forced to **re-pack** (a re-label they shouldn't need).
3. **PKG OUT's return shortcut (RTD_RETURN) destroys the box** (`DELETE pkg_scans`, 5577) → even a clean
   in-box UDR loses its label on exit, so a **second** return is boxless → same trap.
4. A re-packed / dispatch-touched return drifts to **`handed_over`** (via DTK or legacy-dispatch mode);
   **PKG OUT fresh path rejects `handed_over`** (wants `pending_rtd`) → **STRANDED**.

### Mrudula's block, mapped
She processes a **mixed pile (legacy + modern) in one pass**. The legacy/boxless units have no usable
label; she re-packs; they land `handed_over`; PKG OUT rejects them with **"Unit status is 'handed_over',
expected pending_rtd."** Root = the legacy box-label swap isn't wired into the store/production return path.

---

## 5. Live evidence (2026-06-05)
- Of units RTO_IN'd in the last 3 days: **136 `rto_in`** (52 with a `pkg_scans` row), **65 stuck
  `handed_over`** (0 pkg rows), 163 `rtd`, 75 `shipped`.
- **5 units** confirmed in the exact failing state: re-packed after RTO_IN → `handed_over` → still have a
  `pkg_scans` row → PKG OUT rejects.
- Mrudula's error left **no `scan_violations` row** (couldn't pin her exact unit from logs).

---

## 6. Open design questions (CONTINUE HERE)

1. **Legacy UDR, sealed box:** do we **apply a fresh LOT box label to the still-sealed box** (trust the
   original factory pairing, no opening) — or does a legacy return by definition need opening (which by
   the floor rule makes it a DR → repair)? *This decides whether a clean "legacy UDR" path can exist.*
2. **Where to mount the centralized swap:** the **store return-intake station** (and/or `RET_IN` /
   Garage `/returns`). Should `return` mode ALSO mint the notional label, or should the swap be a
   distinct intake step?
3. **What status should a swapped legacy unit land in** so PKG OUT accepts it cleanly — `pending_rtd`
   (fresh path) vs `rto_in` (RTD_RETURN path, but that path destroys the box)?
4. **Stop destroying the box on RTD_RETURN** so a unit can cycle return→re-dispatch on its original
   label (honours "never lose the box"). Re-label stays the damaged-box exception only.
5. **Enforce the single door** — prevent a raw legacy EAN going RTO_IN → PKG OUT without the swap +
   without store classification.
6. **Cleanup** of the already-stranded units (5 re-packed + ~65 `handed_over`) once the flow is fixed.

---

## 7. Code reference index (approx, 2026-06-05)
- `registerLegacyUnit` — `01_worker/worker.js` ~6809 (station guard 6818; status 6887; dispatch label 6952–6982)
- PKG (pack) — worker ~5407 (`newCarStatus` 5420)
- PKG OUT — worker: RTD_RETURN branch 5532 (delete pkg_scans 5577); fresh path requires `pending_rtd` 5653 → `rtd` 5676
- DTK→`handed_over` 5774/5781 · ALLOC→`allocated` 5897/5928 · PACK→`packed_dispatch` 6452/6461 · DOUT→`shipped` ~6736
- Returns intake: `postReturnIntake` (RET_IN), `postReturnUnit` (Garage browser, S102), `postReturnInspection`
- Pools: `getReturnPools`, `assignToRepairRun`, `markReturnUnitIssued`
- Scanner: `02_scanner/index.html` — LEGACY_REG station 796, mode buttons 1009/1013, RTO_IN route to return mode 4616/4624
- Garage UI: `apps/garage/src/app/(auth)/returns/{shipments,process,udr-pool,repair-pool,losses,channels}/page.js`
