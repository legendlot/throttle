# Changelog - Docket Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [2.0.0] - 2026-11-13
The F9 plan layer, a new part and a restructure.
### Added
- **The Plan** (new part, 8 chapters): *Themes, Milestones & Results* (themes, milestones, results, tasks; states; actions; re-dating
  an agreed milestone needs a reason; Split; who sees what); *Proposals, Measures & Targets* (Propose, the
  Founders' decision, the No data source chip, readings, "Target reached"); *Plan Views* (Three weeks, Tree,
  Templates, Re-plan and who can open each); *Linking Tasks to the Plan* (the Plan field everywhere, Plan filter
  incl. Unplanned, sub-tasks inherit); *Weeks and Week Ending*; *The On-time Score*; *The Weekly Review*
  (/review, Hold, Copy for Slack, Founders' catch-up, score trend); *Hand-offs* (give, Incoming, accept).
- Roles **Founder** and **Founders' Associate** (badges `fnd`, `ass`) in the Roles chapter and the spine.
- `content/slack.html` written (command, shortcuts, buttons, reminders) but intentionally **not yet in the spine**.
### Changed
- **Roles & What You Can See**, **Roles & Permissions**, **Users**, **Spaces (Admin)**: the two Plan switches,
  Founder-only granting, the Founders' space.
- **Signing In & Getting Around**: the Plan rail icon and sidebar entries; no Programs, no New program.
- **The Tasks List**, **Inside a Task**: Plan column/filter/field, Group by Week ending and the Week filter, the
  read-only week board, hand-off chip and field, Incoming on My tasks.
- **Welcome**: how work is organised (Spaces and the Plan).
### Removed
- **Programs** chapter. Programs are retired (no sidebar entry, no capture); a note in *Spaces* explains it.

## [1.7.0] - 2026-11-11
### Added
- **Checklists**: the Today | Register switch on My day; The Register (7D/14D/30D window, paging,
  cell states, hover detail, adherence % and colour bands, ticking rules, one block per chart,
  read-only view for Managers/Reviewers); Shared charts (the template Chart setting, "Ticking for
  someone? Name them", any assignee can clear a tick).

## [1.6.0] - 2026-11-11
### Added
- **Inside a Task**: a Dependencies section covering Waiting on, Blocking and Related links, adding
  them (More actions menu, the strip, the command bar), removing them, cleared and abandoned
  blockers, the "mark done anyway" warning, the date clash hint, "N tasks you can't see", what is
  refused, and that the Blocked status stays a separate manual choice.
- **The Tasks List**: the dependency icon on rows and board cards (waiting with a count, blocking,
  cleared) and its popover; the **Waiting on others** and **Blocking others** filters.
- **Signing In & Getting Around**: the "Add dependency" command.

## [1.5.0] - 2026-11-09
### Added
- **Signing In & Getting Around**: the command bar (Cmd/Ctrl+K) now searches tasks in every
  space you can open, from any screen. 2+ characters or a DKT number, words in any order,
  typo fallback only when nothing matches, space and parent shown, Enter opens in place,
  Cmd/Ctrl+Enter full page, visibility rule. Removed the "Open Tasks to search tasks" note.
- **The Tasks List**: quick-add tokens in the capture line (@owner, !p0 to !p3, dates and
  times) with Owner / Deadline / Priority chips; tasks added under a status group are
  created in that status; **Triage The Grid** (Enter, A, S, Left, Esc); **Clean up**
  stale-work sweep from My tasks (Done, Revise / Set date, Abandon, bulk, Mine | Everyone).
### Changed
- **Inside a Task**: abandoned tasks are fully read-only (no edits, moves, comments,
  collaborator or document changes) until reactivated; the comment box says so.

## [1.4.0] - 2026-11-09
### Changed
- Whole manual brought in line with the ClickUp-style redesign (P0 to P7). Every
  passage describing the old layout was rewritten.
- **Signing In & Getting Around** rewritten: the icon rail, the Programs / Spaces
  sidebar (My spaces, By others, Customize sidebar, collapse), the top bar (breadcrumb,
  search box, yellow + New split button, app launcher), the new **command bar**
  (Cmd/Ctrl+K, "/" fuzzy search with recents), keyboard shortcuts, the phone bottom tab
  bar with More, and the Manual's Contents / PDF buttons on mobile.
- **The Tasks List** rewritten: views bar and toolbar, grouped rows with collapsible
  group headers and "+ Add task" per group, The Grid as a collapsible group with Owner /
  Deadline chips, column show/hide, resize and reorder (Program hidden by default),
  density 32 / 36 / 44, ids and sub-task toggles, Filter panel, Me and Archive done,
  expanded bulk bar (adds Collaborators, Move, Abandon), keyboard on the list, Board
  restyle (card size, collapsible columns, Shift+arrow move, per-column add), and the
  new My tasks groups (Today & overdue by IST end of day, Assigned to me,
  Collaborating, Raised by me).
- **Inside a Task** rewritten around the new task view: opens as a modal by default,
  switchable to side panel or full page, previous / next arrows, properties panel,
  Comments / History stream, deep link /tasks?task=<id>, abandoned tasks read-only.
- **Checklists**: My day / Manage / Oversight tabs, "Recurring this week" group,
  the schedule popover with an Ends date, templates, Stop.
- **Scratchpad**: notes column, editor, show / hide calculator, phone "< Notes" flow.
- **Dashboard**: summary cards, single status bar, By team / By person (Last seen, Load);
  removed the "Blocked" column the screen does not show.
- **Programs, Spaces, Lifecycle, Admin** (Roles & permissions, Users, Spaces): new
  creation paths (+ New, sidebar +), admin sidebar sub-nav and card layout, the
  Visibility column on admin Spaces.

## [1.3.0] - 2026-06-30
### Added
- The Tasks List chapter gained a **List view and Board view (Kanban)** section: the
  view switch on the control bar, that Board shows tasks as cards in columns (Status
  by default, switchable to Owner / Team / Program via Group by), drag a card between
  columns to change that field, only editable cards drag, top-level cards only with
  Abandoned left off, and that the Grid / Archive done / Select / density controls are
  list-view only. Notes that Board view also works inside a Program view.

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
