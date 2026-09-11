# Changelog - Snorkel Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.20.0] - 2026-09-11
### Added
- Sales Orders: **Export + lines** (one row per line item) and a Partner PO Ref column on the order export.
- Sales Partners: a new partner needs a GSTIN or the **Not GST-registered** tick; never type a placeholder (URP/NA).
- Payments export: final **Open in Snorkel** column linking to each request's page and its invoices.

## [1.19.4] - 2026-09-11
### Changed
- Finance Queue / Mark-as-Paid: the GST % picker's pre-fill gains a step — linked PO rate, then the rate the payee's vendor's POs are always raised at, then 18% with a GSTIN, else 0%.

## [1.19.3] - 2026-09-11
### Changed
- Finance Queue / Mark-as-Paid: TDS is now computed on the invoice's taxable value (ex-GST), not the invoice total — corrected the "worked out from the invoice total automatically" wording and the instalment-warning callout; added the GST % picker (0/5/12/18/28, pre-filled from the linked PO or the payee's GSTIN) and the mixed-GST-rate guidance; noted a paid request shows the taxable value and GST % it was calculated on.
- Export paid payments: added the "GST % (TDS)" and "Taxable value (TDS base)" columns to the column list, both blank with no TDS or on pre-change payments.

## [1.19.2] - 2026-09-11
### Changed
- Procurement Overview: the "To Approve" card and pipeline stage now count Accepted POs (the step before final approval), and "Arriving · 14d" counts Accepted POs too; the chapter names both cards as they appear on screen and describes the pipeline strip.
- Purchase Orders list: the header Export's "Raised" column is now the last column of the file (after Status), so the columns before it keep their old positions; noted that Export + lines carries no Raised column.

### Fixed
- Collections: the September 2026 figure is 18 partners (23 invoices), not 13.

## [1.19.1] - 2026-09-11
### Added
- Finance Queue: the prior-TDS warning — when the same invoice already had TDS deducted on another payment request, an amber note under the TDS field lists it, and marking paid with a rate again shows a warning (never blocks).

## [1.19.0] - 2026-09-11
### Added
- Collections: a warning that Collections lists only invoices with money owed and is not a party balance, and a new Party Balances section — one row per partner with billed, credit notes, received and a signed balance (credit shown as Cr ₹…), All/Owing/In credit filter, search, sort and an Export for Tally reconciliation.

## [1.18.1] - 2026-09-11
### Changed
- Procurement overview + Purchase Orders list: "Open POs" / "Open value" now count every in-flight status, including Accepted (previously left out, though it holds over half of all POs). One definition is shared by every Open tile and list.

## [1.18.0] - 2026-09-11
### Added
- Purchase Orders list: documented the searchable vendor picker and the Raised-date filter (presets Today / 7D / 30D / MTD / Last mo / FY / All time plus custom from/to, defaulting to All time), the new "Raised" column (on screen and both exports, before Expected), that the status filter now covers every status including Accepted, and that the KPI tiles and both exports follow every filter (except the fixed To Inward tile); added a callout on cross-checking a month's POs against a vendor via Export + lines.
- Raising a Payment Request: documented the new optional "Note for Finance" field (free text, up to 2,000 characters, typically bank details/account name/UPI, visible to Finance and approvers).
- Finance Queue: documented the requester's Note for Finance shown under the bank block, and that the no-bank-account warning points to it when present.

## [1.17.4] - 2026-09-10
### Added
- Purchase Orders list: documented the new "Export + lines" button (one row per line item, carrying PO header context plus Line No, Part Code, Description, Product, Variant, Colour, Qty Ordered, Qty Received, Unit, Unit Price, Total Value, HSN, GST %), alongside the existing PO-per-row Export; noted the China/restricted-access rule and the PARTIAL-filename confirmation cover both buttons.
- Finance Queue: documented the new TDS rate (%) field at Mark as Paid, entered by whoever is authorised to pay; the live deduction/net calculation; Amount Paid defaulting to the net; that a blank rate means no TDS (not the same as 0); and that view-only users (including super admins) see any recorded TDS read-only.
- Payment requests (My Requests): documented the new "Export paid payments" panel (date range, Export CSV) for approvers/Finance/admins, paid requests only, columns including any TDS deducted, for Tally reconciliation; noted the range defaults to today.

## [1.16.0] - 2026-09-08
### Added
- PO Detail: documented changing an issued PO's delivery address (Ship to dropdown of active company addresses) via the new Change button next to the Delivery address block; this is the one amendment that does not bump the revision or raise a new PO number, instead written to the activity log with the old/new address and who changed it; a repeat pick of the same address is a no-op and writes nothing; deactivated addresses cannot be selected.
### Changed
- PO Detail: the layout paragraph and the "on the record" callout now note the delivery-address exception, since not every amendment bumps the revision.

## [1.15.0] - 2026-09-08
### Added
- Payment requests: documented the My Requests status tabs (All / Submitted / Approved / Paid / Cancelled) and that the Value figure counts active requests only, with cancelled and rejected ones excluded and visible under their own tab; rupee-only, other currencies counted separately.

## [1.14.0] - 2026-09-08
### Added
- PO Detail: documented the new Line Prices table inside Amend (# / Part code / Description / Ordered / Unit price), letting any line's unit price be corrected after issue with a required change note, revision bump and old/new price logged to Revision History; quantities stay off-limits there; hidden where China-PO prices are restricted; refused on Cancelled/Closed/Soft POs.
### Changed
- Raising a PO and PO Detail: documented that the part master now wins on HSN, a typed HSN that disagrees with the master is re-aligned on raise/amend; only Snorkel Admin, Finance or Procurement Manager can correct a part's HSN by typing a new code (which updates the master for future POs), anyone else's typed code is replaced and logged.

## [1.13.2] - 2026-09-08
### Changed
- Raising a PO: By Units (FBU/CKD) rows now have an editable Unit Price plus read-only HSN and GST% columns on INR POs; documented that the price is per product unit including the remote, and that a blank price on a row with quantity is refused (RULE-PO-001).

## [1.13.1] - 2026-09-04
### Fixed
- Finance Queue: a held request is rejected from its own page (Open, then Reject), not from the On hold section.

## [1.13.0] - 2026-09-04
### Changed
- Finance Queue: documented putting an approved request on hold (reason required, requester
  sees it), the On hold section (who/when/why, excluded from the To-pay total), Release, and
  that a held request can still be rejected or cancelled by the requester.
- Raising a Payment Request: documented the "On hold with Finance" status in the My Requests
  flow, that it is a pause not a rejection, and that the requester can still cancel it.
- Notifications: documented the "On hold" (with reason) and "Back with Finance" (on release)
  notification kinds.

## [1.12.0] - 2026-09-04
### Changed
- PO Requests: documented the new Items column (line count, or a dash for prose requests).
- Vendors: documented the new Process field (Moulding/Painting/Assembly/Other), required at
  creation, optional on edit, and the moulding-vendor painted-part-code PO block it enables.
- Raising a Payment Request: documented attaching an invoice after the fact from a request's
  Documents panel, available to the requester on their own request and to Finance, until the
  request is cancelled or rejected.
- Finance Queue: documented that only people authorised to pay see the UTR box and Mark-paid
  button; everyone else sees a view-only notice.
- Roles & What You Can See: added the money-authority model (raise vs. approve vs. pay; the
  ₹1,00,000 approval threshold; Finance role ≠ payment authority).

## [1.10.0] - 2026-09-03
### Added
- New Request: line items. "What do you need?" renamed "Why do you need it?" (context
  only); a new Items panel with a per-line part picker, qty, unit, est. price and a
  read-only auto-filled Tax column; live subtotal/est. tax/est. total; the request-level
  Estimated cost field disappears once a line is added.
- PO Requests: request detail now shows an Items table (mirrors the new-request lines)
  with a warning for lines with no tax rate resolved; older, line-less requests still
  read as prose.
- New Purchase Order: a request's item lines now prefill the PO's lines (part, description,
  qty, unit, requester's estimated price) when raising a PO from a request; still fully
  editable, still procurement's price to set.
- PO Detail: a "Cancel anyway" button on a Closed PO with zero receipts, opening the
  normal cancel dialog with a reason requirement and a notice explaining the exception.
### Changed
- New Request and PO Requests chapters call out that HSN/GST auto-fill depends on the
  part master, which as of this writing resolves a rate for only a small share of parts.

## [1.4.2] - 2026-08-17
### Changed
- Cover subtitle now says "sales orders" in the module list (missed in 1.4.1's rename).

## [1.4.1] - 2026-08-17
### Changed
- Module renamed: "Offline Sales" is now "Sales Orders" (nav group in the app and the
  matching manual part). Wording updated in the introduction and roles chapters. The
  underlying GT/MT channels and permissions are unchanged.

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
