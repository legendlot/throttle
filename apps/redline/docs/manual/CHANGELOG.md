# Changelog — Redline Operations Manual

All notable changes to the manual are recorded here. The version here, in
`manual.json`, and on the cover/footer of the PDF must always match.

Format: [Keep a Changelog](https://keepachangelog.com/). Versioning is manual
(see `README.md` → Versioning).

## [1.3.0] - 2026-06-08

### Added
- New **Line Flush** chapter: production raises a flush to return leftover material; the store verifies it in Garage.
- **New Run / Request** chapter gained a **Recent Runs** section (Requested / Issued / Upcoming groups, plus ad-hoc tracking) covering Cancel, Confirm Receipt, Mark Complete and Request Finish.

### Changed
- **Process Deviations** rewritten from the floor view to the full management console (all status tabs, the full approve/reject/escalate/acknowledge/close/retro detail, full propose) now that the complete queue lives in Redline. Approval permissions are still set in Garage Users.

## [1.2.1] - 2026-06-07

### Changed
- Added Ad Hoc Parts to the New Run / Request chapter (production-only one-off parts request; moved from Garage).

## [1.2.0] - 2026-06-07

### Changed
- New "New Run / Request" chapter: the unified Fresh/Outsourced/Repair/Repack request surface, with the step-by-step inventory flow for each run type.
- Scanner: new Repack Release station (Dispatch) documented; Repack In now requires a release for dispatch-held units; Repack Out channel set from the request.
- Scanner: outsourced runs documented as two-phase (Ext Inwarding is the finish step); Repair Start now marks repair lineage and stickers loose pile units.
- Repack Runs page: requests now start in New Run / Request (structured product/channel/qty) and raise the packaging + dispatch-release pulls.

## [1.1.0] - 2026-06-07
### Added
- New **Scanner** part documenting the production and dispatch floor-scanner
  stations after the department-gated redesign: The Floor Scanner (department
  PINs, the on-screen keypad, operator QR sign-in now required on Production too,
  the guided line/station flow, the auto-derived shift windows, logout-to-landing,
  and the red-screen reject behaviour), Production Stations (Assembly, QC Pass/Fail,
  Workshop, Packaging, PKG Out with the tightened acceptance rules), Repair,
  Outsourced & Repack, Dispatch Stations (Dispatch In, Allocate, Pack, Dispatch
  Out, Restock), and Attendance & Lookup.

## [1.0.2] - 2026-05-29
### Changed
- Copy convention: removed em dashes throughout (house style), replacing each with
  a comma, colon, semicolon, period or parentheses as the sentence required. The
  only dashes kept are the two that refer to the dash character shown on screen
  (the "a dash means zero" note and the EWB empty-value indicator). En dashes in
  numeric ranges are unaffected.

## [1.0.1] — 2026-05-29
### Changed
- Formatting/visual polish pass (impeccable), aligned to Redline's DESIGN.md:
  - Callouts redesigned — removed the side-stripe `border-left` accent (banned);
    now full tinted border + background + colored icon-label (color + icon + label).
  - Typography: body 11pt / line-height 1.62, side margins widened to 26mm so the
    text measure stays ~72ch; `h3` size lifted to restore hierarchy; lead 12pt.
  - Colour: warm-tinted OKLCH neutral ramp toward the brand hue, AA-safe tertiary
    ink (brand `#1f1f1f` / `#F2CD1A` kept verbatim).
  - Tables/glance/anatomy spacing on-scale; lighter header rule; warm zebra.
  - Print: orphans/widows control, `text-wrap: pretty/balance`, footer re-aligned
    to the new margins.

## [1.0.0] — 2026-05-29
### Added
- **Complete manual** — every one of the 30 Redline screens is now written out in
  full (purpose, how to read each section, what to do, callouts and gotchas),
  replacing the 25 placeholder stubs from 0.1.0.
- Production: Dashboard, Planner, Line Design, Line Setup, Lines, Manpower, Hourly,
  QC Audit, Process Deviations.
- Activity: Alerts, Returns, Scans, Corrections.
- Dispatch: Overview, Lines, Shipments, Delivery Challans, Channel Master, Repack Runs.
- Repair: Customer Repairs, Repair Queue. Reporting hub. Admin: UPC Generator,
  Operators, Print Center.

## [0.1.0] — 2026-05-29
### Added
- Initial scaffold: build pipeline (`build.py`), brand-matched print theme
  (`assets/theme.css`), and the full manual structure (`manual.json`) — 7 parts,
  30 chapters covering every Redline screen.
- Full chapters: **Welcome to Redline**, **Signing In & Getting Around**,
  **Roles & What You Can See**, **QC**, **Dispatch Pipeline**.
- All remaining 25 chapters present as styled stubs (route + roles + one-line
  summary) pending full write-up.
- Auto-generated cover, table of contents with page numbers, PDF bookmarks, and
  page-numbered footers.
