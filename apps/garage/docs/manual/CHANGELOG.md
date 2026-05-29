# Changelog - Garage Operations Manual

All notable changes to the manual are recorded here. The version here, in
`manual.json`, and on the cover/footer of the PDF must always match.

Format: [Keep a Changelog](https://keepachangelog.com/). Versioning is manual
(see `README.md`).

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
