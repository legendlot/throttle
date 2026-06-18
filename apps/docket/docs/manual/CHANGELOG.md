# Changelog - Docket Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.2.0] - 2026-06-18
### Added
- The Tasks List chapter now covers two S153 features. **Updating many tasks at
  once** (bulk update): the Select toggle, per-row tick boxes that appear only on
  tasks you can edit, Select all, and the yellow bulk bar that sets owner / status /
  priority / deadline / program across the whole selection, plus notes that only
  your own tasks change and that bulk deadlines keep the same audit reason. **My
  tasks**: clarified that the sidebar My tasks view is cross-space (not one space),
  splitting work into an "Assigned to me" (owner) section and a collapsible
  "Collaborating" section, with a Space column, and that capturing there assigns to
  you.

## [1.0.1] - 2026-06-06
### Fixed
- Scratchpad chapter: verified against the live app and tightened to match it
  exactly. The Scratchpad is a plain free-text note area with a docked Calculator
  widget (not per-line checkboxes or inline arithmetic, which were a design
  intent in RULE-DOCKET-005 but never shipped). Clarified that the calculator
  result updates live as you type or tap the keypad, that Enter/= collapses the
  sum to its result, and that C clears.

## [1.0.0] - 2026-06-06
### Added
- Complete self-serve manual for Docket: 6 parts, 13 chapters (Getting Started,
  Working with Tasks, Organising Work, Scratchpad, Dashboard & Reporting,
  Administration) covering the Tasks list, the task detail panel/page, the task
  lifecycle, Programs, Spaces, the Scratchpad, the review Dashboard, and the three
  admin screens (Roles & Permissions incl. dashboard sharing, Users, Spaces).
  Role-segmented (Member / Reviewer / Admin). Built with the shared pipeline and
  the LOT-brand theme; copy in house style (no em dashes). Added `.role.mem` and
  `.role.view` badge styles to `assets/theme.css`.
