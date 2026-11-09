# Docket — ClickUp-style UI/UX redesign (plan, all surfaces)

> 2026-11-09 · Afshaan asked: adopt ClickUp's UI/UX on Docket, keep the dark theme, sort UI/UX before
> functionality. Source study: root `reference/clickup-ui-study.md` (live-measured ClickUp 4.0 dark tokens,
> sizes, screens). **UI-only:** no worker, RPC or DB change in any phase below. Functionality changes come later
> as their own spec.

## 0. Where Docket is today (seen live, 2026-11-09)

| Surface | Today | Gap against the ClickUp pattern |
|---|---|---|
| Shell | One 240px sidebar (Work · Programs · Common · My spaces · By others · Personal · System) + a topbar reading "Docket" on every page | No icon rail; the topbar doesn't say where you are; no global search or quick-create in the top bar |
| Task list | 52px card-like rows; DKT id under the title (wraps to 2 lines at narrow widths); team pill inline with the title; red left rule = overdue; "The Grid" tray above | Low density; no group headers or per-group add; one "Manage"-style toolbar (Group · Filter · Select · Archive done · view + density toggles); empty cells show "+ Owner / + Deadline" buttons |
| Board | 4 status columns, 200-ish-px cards with id + priority + title + team + avatars + overdue | No column tint, no per-column add, cards dense with text |
| Task drawer | Right side panel ~40% wide; status pill row; label/value list | Values truncate ("Set prog…", "Ge…", "Karan D"); description is a raw textarea; comments/history are below the fold |
| Task detail page | Separate full page with its own layout (`/tasks/detail`) | Duplicate of the drawer, drifted styling |
| Dashboard | 5 stat tiles + status bars + by-team table | Fine structurally; needs the card/elevation and type of the new system |
| Checklist · Scratchpad · Admin · Manual · Login | Each styled on its own | Needs the shared shell + primitives |

## 1. Decisions needed from Afshaan before Phase 0

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Fonts** — ClickUp uses the system font at 13–14px; Docket uses Tomorrow (display), Rubik (body), JetBrains Mono (ids) | Keep **Tomorrow** for the logo and page titles only, keep **JetBrains Mono** for DKT ids, move body + UI to the **system stack** (crisper at 13–14px, no web-font load). |
| D2 | **Navigation** — ClickUp: 64px icon rail + a 255px context sidebar | **Adopt.** Rail = Tasks · My tasks · Checklist · Scratchpad · Dashboard · Manual · Admin. Sidebar = the hierarchy only: Programs, Spaces (General · My spaces · By others). `⌘\` / `[` collapses the sidebar. |
| D3 | **Opening a task** — ClickUp default: a centred modal, with a toggle to side panel / full page | **Modal by default**, remembered per person; the side panel stays one click away for triage. `/tasks/detail` becomes the same component in full-page mode. |
| D4 | **Row height** | **36px default** (ClickUp), with density Compact 32 / Default 36 / Roomy 44 (the current toggle, re-based). |
| D5 | **Where yellow goes** — ClickUp keeps its accent rare (its "+ Task" button is light grey) | Yellow only on: primary create, the active nav item / view tab underline, the focus ring, selection. Every other button neutral. |
| D6 | **Background** | Keep **`#181818`** (ClickUp's `#111` is the most-complained-about thing in its dark mode); adopt its layer steps + 1px white-33% elevation ring. |

## 2. Phases — each one ships and deploys on its own

All frontend-only, `apps/docket` (+ additive opt-in props in `@throttle/ui` where shared). Order matters for
0 → 3 (each builds on the last); 4–7 can run in any order after 3. **Not parallel-safe**: 2, 3, 4 and 5 all edit
`tasks/page.js` (1,222 lines), so one writer at a time.

### Phase 0 — Foundation: tokens + primitives (no layout change)
- Rebase `globals.css` tokens on the study: layer steps (`#181818` base · `#1e1e1e` subtle · `#262626` strong ·
  `#2f2f2f` pressed), borders (`#2a2a2a` default, `#3a3a3a` strong, `#4a4a4a` hover), text (`#eeeeee` / `#b4b4b4` /
  `#7b7b7b` / placeholder `#6e6e6e`), elevation 1–5 with the white-33% ring, radii (6 control, 8 popover, 10 card),
  type scale 11 / 12 / 13 / 14 / 16 / 20 / 28, spacing 4-step, row heights from D4. Keep the legacy aliases.
- Primitives in `components/primitives.js` (+ `ui/`): `Button` (24 / 28 / 32; primary · neutral · ghost · danger),
  `IconButton`, `Pill` (status / priority / tag, 20px, radius 6), `Menu` + `Popover` (ring + elevation 4),
  `Tooltip` (with a shortcut-key chip), `AvatarStack`, `GhostCell` (the faint icon an empty cell shows),
  `Kbd`, `SegmentedTabs`, `EmptyState`.
- **Done when:** every existing screen renders on the new tokens with no layout change; side-by-side screenshots show
  only the colour and type shift.

### Phase 1 — App shell
- **Top bar 40px:** a breadcrumb/page title on the left (fixes "Docket" on every page) · a centred **search / ⌘K**
  trigger · **+ New** split button (Task / Space / Program) · "?" shortcuts · Live dot · AppLauncher · avatar menu.
- **Icon rail 64px** (D2): 32px tiles, radius 8, label under the icon, yellow active state, a notification dot slot.
- **Context sidebar 240px:** Programs (dot + name + count), Spaces tree (General · My spaces · By others), each
  section with a hover `+` and `⋯`; 28px rows, 14px text, indent per level; "Customize sidebar" footer (hide
  sections; stored in `localStorage`, same as today's `docket.nav.collapsed`).
- Mobile (<768): the rail becomes a bottom tab bar; the sidebar becomes a slide-over.
- **Done when:** every route renders inside the new shell; sidebar collapse, mobile slide-over and every nav link work.

### Phase 2 — Location header, views bar, toolbar
- **Location header:** `Space / Program ▾ ☆` breadcrumb; right side: Share-link copy · Space settings (owners).
- **Views bar:** `List · Board` tabs (yellow underline) + a disabled `+ View` (saved views = later, functionality spec).
- **Toolbar** replaces the Manage-style row: left **Group pill** (`Group: Status ▾`) · Subtasks (collapse / expand /
  separate) · Columns; right Filter (count badge) · **Me mode** · Archive-done toggle · search (`/`) · ⚙ Customize
  (density, show DKT ids, show team) · **+ Task** split (yellow).
- Quick-capture moves into the group foot ("+ Add task") and the top-bar **+ New**; `c` still focuses the nearest one.
- "The Grid" stays (Docket-specific), restyled as a collapsible group with a dashed-yellow header.
- **Done when:** every current filter / group / sort / toggle is reachable, and none lives in a popover-inside-a-popover.

### Phase 3 — List view
- **Group header** 36px: caret · status pill · count · `⋯` · "+ Add task"; groups collapse (state per person).
- **Rows 36px**, 1px `#2a2a2a` divider; hover `#1e1e1e`; selected `#262626` + a yellow-tinted left rule.
  Cells: status circle → title (14/500) → DKT id (mono, muted, **never wraps**) → team · program · owner avatar ·
  collaborators stack · priority flag · deadline. Empty cells show a `GhostCell` icon instead of "+ Owner" buttons.
- Hover row actions: select checkbox (left gutter), `+` sub-task, `⋯` menu (open, copy link, abandon…).
- Columns: show / hide, drag to reorder, resize; stored per person in `localStorage` (frontend-only).
- Overdue: a red deadline cell + a small icon, not a full-row red rule (keeps scanning calm); revised = `REV` chip.
- **Bulk bar** restyled as the ClickUp floating dark pill: "N selected ×" · Owner · Status · Priority · Deadline ·
  Program (same `bulkUpdateTasks` call).
- **Split `tasks/page.js`** into `TaskListView`, `GroupHeader`, `TaskRow`, `Toolbar`, `useTaskViewState` as part of
  this phase. It is the precondition for phases 4 and 5 staying small.
- **Done when:** a 300-task space scrolls smoothly, every inline edit still works with Tab, and the DKT id never wraps.

### Phase 4 — Board view
- Column 272px; header = status pill + count + `⋯`; the **column body tinted** with its status colour at ~5–10%;
  "+ Add task" at each column foot; cards 10px radius, `#1e1e1e`, elevation ring; title 14px first, then a quiet row of
  owner avatar · deadline · priority · sub-task count; DKT id on hover only. Card size S / M / L in Customize.
- **Done when:** drag-to-move still writes the same audited field, and the board reads cleanly at 1280px.

### Phase 5 — Task view (one component, three modes)
- `TaskView` replaces both `TaskDrawer` and the `/tasks/detail` layout. Modes: **modal** (default, D3) · side panel ·
  full page, with a switch-layout button; ‹ › steps through the current list; Esc closes.
- **Left pane:** breadcrumb (Space / Program) · DKT id · **28px title** · a 2-column property grid (icon + muted label →
  value or "Empty"; no truncation, wraps instead): Status, Owner, Collaborators, Deadline (+ revision count), Priority,
  Team, Program, Space, Created by/at → Description (auto-growing, markdown-light) → collapsible sections:
  Sub-tasks, Documents, (Checklist template link, if any).
- **Right pane ~38%:** tabs **Comments · History** with the composer docked at the bottom; an empty state with
  suggestions ("Mention a teammate", "Set an owner").
- Keyboard: `Shift+S` status · `Shift+A` owner · `Shift+D` deadline · `Shift+P` priority · `s` sub-task.
- **Done when:** every field editable in today's drawer + detail page is editable here, with the same audit
  (deadline reason, abandon reason).

### Phase 6 — ⌘K command bar
- Fuzzy-search over what the client already holds: spaces, programs, nav destinations, the loaded tasks (DKT id or
  title) + commands (New task, Go to My tasks, Toggle board, Switch density). Opened by `⌘K` / the top-bar search.
- Cross-space task search beyond the loaded rows needs a worker action → **out of scope here**, noted for the
  functionality spec.

### Phase 7 — Secondary surfaces on the new system
- **My tasks** → ClickUp-style home: "Today & overdue" · "Assigned to me" · "Collaborating", each a List-view group.
- **Checklist** → the List-view row + group header primitives (Today / This week / Manage); recurrence editor in a Popover.
- **Scratchpad** → notes list in the context sidebar; editor full-width; calculator docked right.
- **Dashboard** → card tiles on the elevation system; status distribution + by-team / by-person tables.
- **Admin** (roles, users, spaces, dashboard sharing) → a ClickUp "All settings" layout: a left settings nav + content
  cards with Save at the bottom right.
- **Login** → unchanged structure, new tokens. **Manual** → shell only.

### Phase 8 — Close-out
- System manual update (`manual-builder`, Docket chapter screenshots + wording).
- Browser smoke of every surface at 1440, 1280 and 390 wide; a hostile review per phase before its commit.

## 3. Out of scope (goes in the functionality spec)

Saved views / `+ View`, custom fields UI, notifications, @mentions, cross-space search, calendar/Gantt views,
time tracking, recurring one-time tasks, multi-level sub-tasks. Anything that needs a worker / RPC / DB change.

## 4. Size

Phases 0, 1, 4, 6 ≈ one session each; 2 + 3 ≈ two sessions (includes the `tasks/page.js` split); 5 ≈ two sessions;
7 ≈ two sessions; 8 ≈ half a session. Roughly 10–12 sessions end to end, with a live, usable Docket after every phase.
