# Changelog - Pitstop Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.3.0] - 2026-06-25
### Changed
- The Inbox: WhatsApp is now two-way. Agents reply to WhatsApp from Pitstop;
  the customer's messages are pulled in live (both sides visible). Free-text
  works inside the 24-hour window; the composer is disabled once it closes
  (templates to reopen are a fast-follow). Replaced the old "read-only mirror"
  note. WhatsApp attachments not supported yet.
- The Inbox: new Transfer action (pick an agent, add an optional note, the chat
  moves to their queue with the note). Agents can transfer their own /
  unassigned chats; leads and admins can transfer any chat.
- The Inbox: replying to a customer now also assigns the linked ticket to the
  replier (whoever answers owns the case).
- Navigation: the sidebar is now collapsible (collapsed by default) via the
  bottom chevron or the PITSTOP header; added Inbox + Overview to the Work menu.

## [1.2.1] - 2026-06-23
### Changed
- The Inbox: documented multi-select + bulk assign (tick rows or Select-all,
  then Assign to… / Me / another agent / Release in one action).
- Calls: documented the new Prev / Next pagination (50 per page) for browsing
  older call records.

## [1.2.0] - 2026-06-23
### Added
- New chapter **The Inbox** (Work part): the cross-channel conversations console
  (Instagram, Messenger, WhatsApp). Covers the channel / Mine-Unassigned-All /
  Active-Closed layout, setting conversation **Priority** (Urgent / High / Normal /
  Low), **filtering and sorting** the list (by recent / oldest / priority, and by
  priority, tag or assigned agent), tagging and assigning, replying with the emoji /
  canned-response / attachment composer and private notes, the 24-hour reply window,
  WhatsApp being read-only for now, and **linking or creating a ticket** from a chat.

## [1.1.0] - 2026-06-15
### Changed
- Departments: now also where you set a teammate's CS role. Documented the new
  **Set Role** dropdown (Viewer / Agent / Team Lead), the rule that only CS roles are
  set here (wider company roles show as "Garage-managed"), and that you cannot change
  your own role. "Who" updated to Lead + Admin (Team Leads can open this screen).
- Departments: a person can now belong to **multiple departments** (tick boxes) and
  sees the tickets and calls of all of them; replaces the single-department dropdown.
- New Ticket: product, model and colour are now cascading **dropdowns** that auto-fill
  the SKU, as an alternative to the UPC lookup.

## [1.0.1] - 2026-06-06
### Changed
- Content freshness pass for changes since 1.0.0:
  - The Queue: ticket creation date and time (Indian time) now shown under the Age column.
  - Working a Ticket: header shows product colour and creation time; Shopify panel now
    carries full order details (line items, totals, shipping address, courier tracking).
  - Working a Ticket: verifying the issue requires an evidence attachment first — the
    Advance step now spells this out.
  - Calls: repeat calls from the same customer coalesce into the existing open ticket
    instead of spawning duplicates (every call still logged).

## [1.0.0] - 2026-05-29
### Added
- Complete self-serve manual for Pitstop: 4 parts, 12 chapters (Getting Started,
  Work, Analyze, Admin) covering the queue, the ticket workspace, new tickets,
  calls, reports and the three admin screens. Role-segmented (Agent / Lead /
  Admin). Built with the shared pipeline and the impeccable-polished theme; copy
  in house style (no em dashes).
