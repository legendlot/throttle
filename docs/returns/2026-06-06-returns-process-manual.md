# Returns Process — Team Manual (Business + System)

> Combined handover guide. Covers what each team **does** (business process) and **how the
> systems support it** (Garage, Redline, PWA scanner). Standalone for now; to be folded into the
> Garage and Redline page-manuals once the process is implemented.
> Owner: Store (intake) + Production (repair). Last updated: 2026-06-06.

---

## 1. The big picture (read this first)

- **The Store is the single door for ALL returns.** Every returned unit — modern, legacy, damaged,
  switcheroo, loose car or remote — enters through Store intake first. Nothing skips it.
- **Returns arrive in shipments.** One shipment can carry any mix of products, channels, and
  conditions.
- **The Store sorts every unit into one of four piles** (Store's own judgement — there is no
  enforced rule):
  - **UDR** — Undamaged Return → re-dispatch as-is, **no repair**.
  - **CXR** — Customer Return → **repair**.
  - **BRV** — Bulk/Vendor Return → **repair**.
  - **Loss** — switcheroo / wrong item / nothing received → **written off** (record what arrived).
- **Cars and remotes are independent units in returns.** During returns, a car and a remote are
  treated separately. Any old car↔remote link is **broken at Store intake** (kept as history, never
  erased) and a **fresh pairing is made at the repair QC-PASS station**, exactly like a brand-new
  production run.
- **Five golden rules** (never break these):
  1. Single door — Store intake is the only entry.
  2. Nothing leaves the Store without a **box label**.
  3. A raw **legacy EAN never travels downstream** — it gets a real LOT box label at intake.
  4. A **UDR box is never opened** — preserve it, re-dispatch on its existing label.
  5. Car↔remote pairing is re-made **only at QC PASS**; the old link is preserved as history.

---

## 2. Who uses what

| Team | System | Does |
|---|---|---|
| **Store** | **Garage** (returns console) + **PWA scanner** (Return Intake station) | Receive shipments, scan + classify every unit into UDR/CXR/BRV/Loss, relabel legacy units, issue units out |
| **Production** | **Redline** (see piles, request repair runs) + **PWA scanner** (repair stations) | Request stock from Store, run the repair line, push finished units to dispatch |
| **Dispatch** | (unchanged) | Receives UDRs and finished repaired units via the normal handover |

---

## 3. STORE — receiving & sorting (Garage + PWA scanner)

1. **Open a return shipment** in Garage → it gets an `RS-NNN` number. Enter **courier** and **date
   received**. Garage shows a **shipment barcode** on screen.
2. **Bind the scanner**: on the PWA, pick **Return Intake**, and **scan the shipment barcode** once.
   The device is now feeding *this* shipment. (Two shipments can be processed at two stations at once
   — each scans its own barcode.)
3. **Scan each unit in**, in this priority:
   - Box intact + LOT box label readable → **scan the box label**.
   - Box damaged / box label unreadable → **scan the car (or remote) UPC**.
   - No readable LOT at all → **scan the product EAN/barcode**.
   - Nothing scannable → **enter the product manually** in Garage.
   Each scanned unit pops up as a row in the Garage shipment (a few seconds after the beep — the
   screen refreshes itself; you don't reload).
4. **Set the disposition** on each row in Garage: **UDR / CXR / BRV / Loss**.
   - **Legacy unit** (no LOT label): mark it **Legacy** and **print a fresh box label** from Garage.
     For a sealed undamaged box the label is applied to the *closed* box (no opening). The printed
     UPC is automatically **blocked from future batch printing** so no one reprints it later. If the
     box is opened, attach fresh labels to the **car and/or remote** as received (they stay separate
     — see §6).
   - **Switcheroo / wrong item / nothing received** → **Loss**, and **record what physically
     arrived** in the note.
5. Each unit also captures: **channel, product, variant, colour, date processed**.
6. **Close the shipment** when the pile is done. Units now sit in their piles, visible to Production
   in Redline.

> The shipment **stays open** the whole time you're scanning and dispositioning — it's a live draft.
> You can close the laptop and resume later; reopening `RS-NNN` shows everything scanned so far.

---

## 4. STORE — issuing units to Production (scan-out)

Production requests stock; the Store issues it. Issuing **scans each unit out** (just like a normal
store pick-list issue). The pick list is **whole units** — some carry box labels, some original
car+remote UPCs, some newly-attached legacy UPCs.

- **Issue as Repair** → feeds a repair run (`REP-NNN`). For **CXR + BRV** units.
- **Issue as UDR** → no repair run; each UDR is scanned out and goes straight to PKG OUT.

---

## 5. PRODUCTION — the two paths

### 5a. UDR path (no repair)
- **One scan at PKG OUT** (the box label) → **handover to dispatch**. The box is **never opened**.
  It rides its existing (or Store-printed legacy) box label out. That's the whole path.

### 5b. CXR / BRV path (repair run, `REP-NNN`)
Cars and remotes move through as **independent units** (no pairing yet):

1. **Inspection / Rep Start** — scan the unit, choose **Repair** or **Scrap**.
   - *Scrap* → goes to the **scrap pile**, stops here.
   - *Repair* → continues.
2. **Repair** — fix the unit, then send to QC (no extra scan).
3. **QC** — same as a normal production run:
   - **Pass** → **PKG IN → PKG OUT** → handover to dispatch. *(Car↔remote pairing is made here at
     QC PASS, exactly like a fresh production run.)*
   - **Fail** → **WKS IN → WKS OUT → back to QC**, and repeat until it passes.
4. **Mismatched car/remote counts are normal.** If the Store sends 100 cars but only 70 remotes,
   Production builds/requests the other 30 remotes from the Store ad-hoc and pairs them at QC PASS.

> *Planned later (not in v1):* a unit that fails QC 3 times will auto-scrap. For now the QC loop is
> unlimited, same as normal production.

---

## 6. Why cars and remotes are separate in returns

A returned unit may arrive car-only, remote-only, or as a pair whose halves are in different
condition. So returns treat the **car and the remote as independent items**. Any existing car↔remote
link is **broken when the Store takes the unit in** (the history of the old pairing is kept, never
deleted). A **new pairing is created at the repair QC-PASS station** — the same moment a fresh
production run pairs a car with its remote. UDRs (sealed, never opened) keep their original pairing.

---

## 7. REDLINE — Production's view

- **Read-only view of the piles** (UDR / CXR / BRV counts by product / variant / colour) + scrap.
- **Request a repair run** → the Store issues the units against it.

---

## 8. Quick reference — disposition → destination

| Pile | Condition | Destination |
|---|---|---|
| **UDR** | Undamaged, box sealed | Issue as UDR → 1 scan at PKG OUT → dispatch |
| **CXR** | Customer return, needs work | Repair run → Inspect → Repair → QC → PKG → dispatch |
| **BRV** | Bulk/vendor return, needs work | Repair run (same as CXR) |
| **Loss** | Switcheroo / wrong / not received | Written off; record what arrived |
| **Scrap** | Unrepairable (decided at Inspection or QC) | Scrap pile |
