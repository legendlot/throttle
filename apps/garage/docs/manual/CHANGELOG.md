# Changelog - Garage Operations Manual

All notable changes to the manual are recorded here. The version here, in
`manual.json`, and on the cover/footer of the PDF must always match.

Format: [Keep a Changelog](https://keepachangelog.com/). Versioning is manual
(see `README.md`).

## 1.16.0 - 2026-08-31

- **Receiving** gains "Bags that never got a label": the per-line **N unlabelled** badge,
  the **Print N missing labels** button, why a never-bagged line is not counted as short,
  and the warning that these labels must only go on bags carrying no label at all.
- **Bag Sizes** now states what a blank size means: a part with no size set is treated as
  **50** per bag. Flagged as a fallback, not a house standard, since real sizes vary by
  product and several recent products use 25.

## [1.19.0] - 2026-09-01

### Added
- **Job Work** chapter (`/jobwork`): what LOT material is currently sitting at a vendor, how to
  read Sent / Returned / Damaged / Remainder, and why an empty table does not mean nothing is out.

### Changed
- **Direct Issuance**: a vendor is now required on every issuance. The old free-text destination
  box is replaced by Vendor (required), Deliver to (person or place) and Contact phone. Documents
  the new **Job Work (to vendor)** purpose, the automatic JWC delivery challan and gate pass, and
  the inline "+ Add vendor" option.
- **Direct Issuance**: corrected a long-standing inaccuracy. Stock moves when the DI sticker is
  scanned at the DSP Issue station, not when someone clicks approve. Approving authorises and
  prints the sticker; force-issue without a scan is the logged exception.
- **Receiving**: on a job work return, the damaged quantity moves stock. Those pieces are still
  ours, so they go back on the unpainted code to be sent out again. On an ordinary purchase,
  damaged is recorded and nothing moves, exactly as before.

## [1.15.0] - 2026-08-31

### Added
- **Users & Roles: Attendance device.** New section for the super-admin card that ties clock-in and clock-out to one phone at the gate. Explains in plain terms why a PIN or a device code cannot prove *which* phone is asking, and why the phone's own non-exportable key can. Covers enrol, lock and the reset path for a lost or replaced handset.
- States plainly that the lock is **set up but not yet enforced**, and that switching it on before the gate phone is enrolled would stop the whole floor clocking in.
- States what the lock does not solve (someone at the desk scanning a colleague's badge) and the queue to expect (about 110 clock-ins between 8:30 and 9:30).

### Changed
- **Fix:** the Scanner Department PINs section said the scanner has **three** PIN-gated departments. It has had **four** since Attendance was gated in S199, and the card on screen has shown four rows for weeks.

## [1.10.0] - 2026-07-29

### Added
- **Cycle Count** scanner chapter (Scanner part). The new Store station for the shelf audit: scan the QR on each part bag and one scan counts the whole bag, so nobody types a quantity. Covers what each on-screen message means, that a re-scan is safe and reports "Already counted" rather than an error, and that the station never moves stock on its own.

### Changed
- **Cycle Counts** chapter rewritten around the bag-scan flow, which is now the everyday way to run a count. Documents the two entry points (**Bag-Scan Count** for walking a rack, **Pick Parts** for working the due list), the live Bags Scanned tile and Bags column, that a bag-scan count has no fixed scope so only what you scanned is on the count, and that typing a figure by hand replaces the scanned total on that line (so enter the full quantity, not just the loose remainder). Blind counting and "completing only proposes" are unchanged and still called out.

## [1.9.0] - 2026-06-27

### Changed
- **Issue Queue** chapter: replaced the old "Issue as CKD parts or FBU units" toggle with the new model. The run's **format** (declared by production at run-create) decides the pick list; the store issues exactly that (1:1) or **rejects** the run if stock cannot match. There is no store-side format toggle anymore. Built cars are now ordinary stock, so an FBU run's car appears as a normal pick line.
- **Receiving** chapter: declaring **FBU Units** now reveals an optional **Link outsourced run** box. Vendor-built cars come back here in normal Receiving, book into normal stock, and the linked outsourced run **auto-completes** once the full count is received (no counting pool, no Ext Inwarding scan, no separate "Receive built cars" button).

## [1.8.0] - 2026-06-14

### Added
- **Manpower** is now three tabs: **Store Activities** (the existing daily activity log), **Attendance** (the store team's clock-in/out with late/OT notes, Streak, Absent-this-month, **Day status** and Close Shift) and **Shifts** (the store's shift timing — effective-dated versions with History; no early checkout).

### Changed
- Rewrote the **Manpower** chapter accordingly (was just the Store Activities log; attendance/shifts for the store now live here rather than only in Redline).
- **Scanner Lookup** now also resolves **part bags** (`BAG-…`) — showing the part, quantity, product and pick history (which run it was picked into, when, on which device).

## [1.7.0] - 2026-06-13

### Changed
- Rewrote **Signing In & Getting Around** for the redesigned shell: the accordion sidebar (only the active group expands), the user-managed **Pinned** shortcuts list, the collapsible icon rail, the **Setup & More** drawer, and the **command bar** (Cmd/Ctrl+K). Clicking the GARAGE bar collapses the sidebar.
- Re-grouped the manual to the new four-destination IA: **Overview, Inventory, Fulfilment, Returns**, plus a **Setup & More** part (Reports, Activity Log, Producibility, Manpower, Library, Users).
- Rewrote the **Dashboard** chapter as **Overview**, the triage home: a clickable KPI rail and a prioritised "Needs Attention Now" feed that now contains what used to be the Alerts screen.
- **Receiving**: documented Upcoming Shipments listing above Active Shipments, and the status now reading GRN'd / Received (green) once a shipment is fully booked.

### Added
- **Pick Scans** chapter under Fulfilment: the searchable run picker (each option shows product and status) and the per-run scan audit with a single Scan time.

### Removed
- Dropped the standalone **Alerts** chapter (folded into Overview).
- Removed **Unit Restock**, **Dispatch Roster** and **Dispatch Counts**: these dispatch-team screens moved to Redline. Old Garage links redirect there.

## [1.5.0] - 2026-06-08

### Removed
- Removed the entire **Production** part (Production Runs, Ad Hoc Requests, Line Flush, Process Deviations). Those production-owned screens moved to Redline (run-request consolidation); the store now services runs through the Issue Queue. Garage is store / fulfilment only.

### Changed
- **Flush Verify** chapter: noted production raises flushes in Redline, and documented the new **Quarantine Register** tab (read-only list of quarantined parts).

## [1.4.2] - 2026-06-07

### Changed
- Ad Hoc Requests reframed to track + cancel; create moved to Redline (production-only New Run / Request).

## [1.4.1] - 2026-06-07

### Changed
- Production Runs: create path retired (runs are now requested in Redline / New Run); chapter reframed as view + manage (receipts, outsourced send/receive/finish).

## [1.4.0] - 2026-06-07

### Changed
- Production Runs: two-phase outsourced runs documented (build pick only, Receive built units into the pool, Issue Finish Parts) with the inventory flow; note that run requests now start in Redline.
- Ad Hoc Requests: can now be linked to a repair run (and product), building the repair parts-consumption record.
- Issue Queue: added the REPACK PKG and UDR request types and which are scan-only vs desk-issued.

## [1.3.0] - 2026-06-07
### Added
- New **Scanner** part documenting the Store department's floor-scanner stations
  after the department-gated redesign: The Floor Scanner (department PINs, the
  on-screen keypad, operator QR sign-in, the guided category/station flow, the
  auto-derived shift, logout-to-landing, and the red-screen reject behaviour),
  Store Issue, Returns Intake (bind an open RS-NNN, capture-only), Direct Issue
  (scan-to-issue), and Legacy Reg & Lookup.
### Changed
- Users & Roles: added the super-admin **Scanner Department PINs** card (write-only,
  hashed, set/rotate the three department PINs).
- Open Return Shipments: the PWA now binds by scanning the **QR code** on the
  Process screen.

## [1.2.0] - 2026-06-06
### Added
- Gate Pass and Unit Restock chapters (Store part). Gate Pass covers the
  factory gate entry/exit log: inbound vs outbound, direction-locked purposes,
  returnable tracking, hand-signed printing and void-not-delete. Unit Restock
  covers returning shipped units to sellable stock via the bulk paste flow,
  skip reasons and the restock report.

## [1.0.0] - 2026-05-29
### Added
- Complete self-serve manual for Garage: 8 parts, 42 chapters covering every
  screen (Overview, Inventory, Production, Store, Returns, Library, Procurement,
  Users), each written out in full (purpose, how to read every part, what to do,
  callouts and gotchas), role-segmented across Store / Production / Procurement /
  Admin.
- Built with the shared pipeline (self-bootstrapping `build.py`, Chrome render,
  measured table of contents, PDF bookmarks, page-numbered footers) and the
  impeccable-polished print theme, copy in house style (no em dashes).
- Note: `/products` (a standalone product catalog) does not exist in Garage; new
  products are registered under Procurement, documented in that part.
