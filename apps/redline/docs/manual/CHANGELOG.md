# Changelog — Redline Operations Manual

All notable changes to the manual are recorded here. The version here, in
`manual.json`, and on the cover/footer of the PDF must always match.

Format: [Keep a Changelog](https://keepachangelog.com/). Versioning is manual
(see `README.md` → Versioning).

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
