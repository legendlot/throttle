# Changelog — Depot Operations Manual

## 1.5.0 — 2026-08-25 (Session 308)
**Scanner / Dispatch Scan Stations:** packing now takes two scans. Added a
**Scanning the courier label at Pack** section covering the courier (AWB) scan alongside the box
label, that either order works, that a courier-label scan alone never packs anything, and that
missing it blocks nothing. Documents the one refusal the floor can hit: a second, different
courier label on a box that already carries one. The Pack row in the flow table was updated to
match. Explains why it exists: a single-unit dispatch previously recorded the channel but not
which order it filled, so "which customer got this car?" had no answer.

## 1.1.0 — 2026-06-23 (Session 164)
Added the **Fulfilment Requests** chapter (Outbound, first), covering the new Snorkel-to-Depot
sales-order fulfilment flow: how a confirmed order arrives as a pending request (and surfaces on
the Overview tile), Accept Full vs Accept Split (with per-shipment dispatch dates), Reject (which
cancels the Snorkel order), and how fulfilment status + dates flow back to the sales order.

## 1.0.0 — 2026-06-17 (Session 149)
First complete Depot manual. 20 chapters across 7 parts mirroring the app's IA:
- **Getting Started** — Welcome, Signing In and Navigation, Roles and What You Can See.
- **Overview** — the live warehouse cockpit (`/dashboard`).
- **Outbound** — Pipeline, Shipments, Challans, Dispatch Counts (the ad-hoc scratchpad).
- **Returns** — Unit Restock, Repack, Repack Reports.
- **Floor** — Live Floor, Lines, Scan Feed, **Stock Audit** (the governed, self-correcting
  count, RULE-AUDIT-001), Dispatch Roster, Manpower.
- **Setup** — Channels.
- **Scanner** — The Floor Scanner basics + the Dispatch scan stations (including the new
  Stock Audit station).

Dispatch screens shared with Redline were adapted from Redline's Dispatch chapters; the
Overview cockpit, Scan Feed and Stock Audit chapters are net-new to Depot.
