# Changelog - Snorkel Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.1.0] - 2026-06-16
### Changed
- Rewrote "Signing In & Navigation" for the front-end redesign: the auto-collapsing
  sidebar (only the active section stays open) with an icon-rail collapse, the
  in-sidebar global search (with the `/` shortcut) that spans every record type, the
  slim top strip (area breadcrumb + segmented sub-tabs + LIVE dot), and the new
  page layout where the title sits in the page above its summary cards. Clarified the
  two kinds of search (system-wide vs in-panel filter) and added the HELP nav group.

## [1.0.0] - 2026-06-06
### Added
- Complete self-serve manual for Snorkel: 7 parts, 23 chapters (Getting Started;
  Requests & Purchase Orders; Vendors & Reorders; Payments; Offline Sales; Assets;
  Library & Admin) covering every nav screen, the PO approval chain
  (Draft -> Accepted -> Approved -> payment), the GST/HSN PO rules, China-PO
  gating, the offline-sales order -> dispatch handoff and GST invoicing, the asset
  register, and the Snorkel role/permission model. Role-segmented (Requester /
  Procurement / Approver / Finance / Admin). Built with the shared pipeline and
  the LOT theme; copy in house style (no em dashes). Added `req`/`proc`/`appr`/`fin`
  role colours to `assets/theme.css`.
