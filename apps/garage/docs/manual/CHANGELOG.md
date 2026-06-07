# Changelog - Garage Operations Manual

All notable changes to the manual are recorded here. The version here, in
`manual.json`, and on the cover/footer of the PDF must always match.

Format: [Keep a Changelog](https://keepachangelog.com/). Versioning is manual
(see `README.md`).

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
