# Returns Process — Final Spec & Phased Implementation Plan

> Supersedes the design-discussion doc `2026-06-05-returns-rto-legacy-flow.md` (which captured the
> problem + open questions). This is the agreed design + the build plan.
> Decisions locked with Afshaan, 2026-06-06. Scope: `01_worker/worker.js` (lotopsproxy),
> `02_scanner/index.html`, `apps/garage`, `apps/redline`, Supabase (`public` + `store`).

---

## A. Locked design decisions

1. **Store is the single intake door.** All returns enter via Store (Garage + PWA Return Intake).
2. **Four dispositions, Store's free choice (no enforced rule):** `UDR`, `CXR`, `BRV`, `Loss`.
   - UDR → re-dispatch, no repair. CXR/BRV → repair run. Loss → write-off (record what arrived).
3. **Cars & remotes are independent in returns.** `paired_with` is **broken at intake** but kept as
   **history** (new `store.unit_pairing_history`, never hard-deleted). Re-pairing happens at the
   **repair QC-PASS** station, identical to fresh production. UDRs (sealed) keep their pairing.
4. **Legacy at intake = real fresh LOT label, sealed-box (option b).** Store prints a notional box
   label (`pkg_scans` row + sticker) without opening the box (the `registerLegacyUnit` dispatch-mode
   capability, exposed to Store). The minted UPC is **marked consumed in `upc_pool`** so
   `generateUpcBatch` can never reissue it. Opened/relabeled legacy → fresh car/remote labels,
   independent, paired at QC PASS.
5. **Issuing = physical scan-out per unit** (like the parts pick list). Two issue types:
   - **Issue as Repair** → feeds `REP-NNN` (CXR/BRV; multi-product allowed).
   - **Issue as UDR** → run-less; scan-out each → eligible for PKG OUT.
6. **PKG OUT accepts two inputs, box-label-driven:** (a) `pending_rtd` fresh from PKG IN *(existing)*;
   (b) `rto_in` whose `return_units` row is **disposition=UDR + issued**, scanning its **intact
   original/legacy box label** — **non-destructive (must NOT delete the `pkg_scans` row)**. Guards:
   reject if no box label / not UDR / not issued.
7. **No 3-strike auto-scrap in v1** (backlog). Repair QC loop is unlimited, like normal production.
8. **Scanner = PWA (`02_scanner`)**, not keyboard-wedge. Garage and the PWA share the **open shipment
   row** (`RS-NNN`); Garage reflects scans by **short-polling the worker** (~3–5s), no realtime push
   (anon key can't subscribe to `return_units`).
9. **Device→shipment binding = select the open shipment on the scanner** (same shipment-selection
   UX dispatch already uses to pick a shipment today). No barcode printing. The PWA lists open
   `RS-NNN` returns shipments; operator taps the one they're processing; scans then append to it.
10. **Disposition is set in Garage** (PWA = pure scan capture: scan → append `return_units` row).

---

## B. Build sequence (phased; checkpoint after each)

> Order matters: DB → worker → scanner → Garage → Redline → cleanup. Worker rule: edit → commit →
> push → `wrangler deploy`. Apps: build per-app, commit, push (auto-deploy). **Run the schema
> verification query before every DB write.**

### Phase 1 — Database (Supabase migrations)
- **`store.return_shipments`**: confirm/add `status` (`open`/`processing`/`processed`), `courier`,
  `received_date`, `processed_at`, and a **scannable shipment code** (reuse `RS-NNN` as the barcode
  payload).
- **`store.return_units`**: disposition enum/text → add **`loss`**; add **`is_switcheroo`** +
  **`received_item_note`**; **`issue_type`** (`repair`/`udr`) + **`issued_at`**; ensure FK to
  `return_shipments`; keep `logged_at` (no `created_at` — known trap). Default `status`
  `pending_disposition`.
- **`store.unit_pairing_history`** (NEW): `(id, car_upc, remote_upc, linked_at, unlinked_at,
  unlink_reason, unlink_context)` — append-only. Populated when a return breaks a pairing.
- **`upc_pool`**: ensure legacy-minted UPCs are inserted/updated to a **consumed** status
  (`applied`/`printed`) so `generateUpcBatch` skips them (RULE-008 enum is closed — reuse, don't add).
- **Repair runs**: verify existing `public.repair_runs` / `repair_run_lines` / `repair_run_units`
  cover Inspect→Repair→QC→WKS→PKG; add a **scrap** marker + station progression fields if missing.
- Grants (`GRANT ALL … TO service_role`) + **RLS enabled** on every new table (RULE-RLS-001).

### Phase 2 — Worker (`lotopsproxy`)
- **Intake (scanner-side, SCANNER_ACTIONS):** `postReturnIntakeScan` — bound to `RS-NNN` via the
  scanned barcode; resolve scan by format (box label → `pkg_scans`; `LOT-` → unit; EAN → product +
  legacy path); append `return_units` row `pending_disposition`. **Break `paired_with` here** + write
  `unit_pairing_history`.
- **Disposition (Garage-side, JWT):** set `UDR/CXR/BRV/Loss`, switcheroo + received note, manual
  product entry; **legacy relabel + notional box-label print** (mint LOT + `pkg_scans` + print job +
  **block UPC in `upc_pool`**); resolves the white-screen-class array bugs by hardening payloads.
- **Issue scan-out:** `issueReturnUnit` (scan a unit out) with `issue_type` → repair (`assignToRepairRun`
  → `REP-NNN`) or UDR (run-less, mark issued, **keep box label**). **Whole-unit pick list** generator
  (mirror parts pick list; group by product/variant; show label/UPC).
- **PKG OUT:** accept `pending_rtd` (fresh) **or** `rto_in`+UDR-issued (non-destructive — stop the
  RTD_RETURN `DELETE pkg_scans` for the UDR path); guard: must have box label, must be UDR + issued.
- **Repair stations:** `REP_START` (Inspect → Repair/Scrap), QC PASS (**re-pair car+remote**, like
  fresh QC), QC FAIL → WKS loop, finished → handover. Scrap → scrap pile, terminal.

### Phase 3 — Scanner PWA (`02_scanner`)
- **Return Intake station** + **shipment-selection binding** (PWA lists open `RS-NNN`; operator taps
  one; hold `RS-NNN` in device state; every scan posts `postReturnIntakeScan`). Reuse the existing
  dispatch shipment-picker UX.
- **Repair stations** wired to the new flow: `REP_START` (Repair/Scrap choice), QC, WKS IN/OUT,
  PKG IN, **PKG OUT (two-input)**. (Legacy box-label *printing* stays in Garage, not the PWA.)

### Phase 4 — Garage (`apps/garage`)
- **Returns intake console** (`/returns/process` rebuilt): open shipment, **live polling row list**,
  per-unit disposition, manual entry, legacy relabel + print, switcheroo/Loss, close shipment,
  resumable open shipment. **Defensive array handling throughout** (the page has crashed before).
- **Issue** (`/returns/...`): repair pick list + UDR pick list, **scan-out** each unit.
- **Pools**: UDR / CXR / BRV / Loss + scrap, by product/variant.

### Phase 5 — Redline (`apps/redline`)
- **Read-only pile view** (UDR/CXR/BRV/Loss/scrap by product/variant).
- **Request repair run** → Store issues against it.
- **Repair line view / stations** surfaced (reuse `get_line_view` repair support from S100).

### Phase 6 — Migrate & verify
- Smoke each path end-to-end (modern UDR, legacy UDR, CXR repair w/ QC fail loop, car/remote
  mismatch, switcheroo→Loss). Confirm no raw EAN leaves, no box-label loss on UDR cycle.
- Fold the process into the **Garage** and **Redline** page-manuals (the `docs/manual/` content).

---

## C. Risks / guardrails
- **PKG OUT is high-blast-radius** (all dispatch). Change the UDR-accept path additively; never
  regress the fresh `pending_rtd` path. Verify against live before deploy.
- **`/returns/process` is fragility-prone** (S102 white-screen: a non-array payload reached `.map`).
  Harden every worker payload to `Array.isArray(...) ? ... : []` and every page derivation likewise.
- **`store.return_units` has `logged_at`, not `created_at`** — never order by `created_at` (the exact
  S102 bug). 
- Cars/remotes independent: ensure the **break-link writes history** and **QC PASS re-pair** mirrors
  fresh production precisely (don't fork the pairing logic).
