# Changelog - Snorkel Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.4.0] - 2026-07-15
### Added
- New "Moulds & Mould Orders" chapter in Vendors & Reorders: what a mould is (parts we
  injection-mould at a vendor from a mould we own, block-priced per shot), the Moulds
  register and its part map with per-shot counts, how to raise a one-line mould PO with
  the "+ Add Mould Line" kind and the "Will receive" preview, and how the store still
  receives the real constituent part codes (order shots times per-shot count) while the
  vendor doc shows only the mould.

## [1.3.0] - 2026-06-25
### Added
- New "Credit Notes" chapter in Offline Sales: when to raise one (under-supply, sales
  return, price drop after supply, transit loss/damage), how to raise it from an invoiced
  order, the draft to issue to cancel lifecycle and the LOT/CN number, the effect on the
  order's net due and reported GST, printing to PDF, and that a credit note is money and
  tax only (it does not move stock).

## [1.2.0] - 2026-06-23
### Added
- New "Fulfilment & tracking" chapter in Offline Sales: what happens after you confirm
  an order, now that confirming raises a fulfilment request the Depot team accepts
  (full or split) or rejects, the six fulfilment labels, and the courier/tracking and
  delivery dates that flow back read-only.
### Changed
- "Sales Orders": confirming now raises a fulfilment request (not a single shipment),
  dispatch happens in Depot (not Redline), and the fulfilment labels were updated to the
  new vocabulary; cross-links to the new chapter; steps de-em-dashed to house style.
- "Channels": documented the per-channel Type, Collection (Auto with period vs Manual)
  and Sell-out (feeds Odo, GT/MT only) settings, plus a sell-out vs sell-in note.
- "Collections": due date now uses the channel's Auto collection period when set, else
  the partner's credit days.

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
