# Docket — Dashboard Sharing Control (design)

> 2026-06-06 (Session 103). Author: Claude Code (autonomous build, approved by Afshaan).
> Related: RULE-DOCKET-002 (permission layer), RULE-DOCKET-003 (spaces), RULE-RLS-001.

## Problem

The founder review dashboard (`/dashboard`) is locked behind the `docket_view_all`
permission. That key does double duty — it gates **both** the dashboard **and** org-wide
task visibility. So today there is no way to let someone see the dashboard without also
granting them visibility of every task in the org, and no way to open the dashboard to
the whole company at once.

Afshaan wants the dashboard to be a **shareable control**:
1. **Per-person grants** — tick specific people who may see the dashboard, *without*
   giving them all-tasks visibility.
2. **Make visible to all** — a single, **persistent** global toggle that opens the
   dashboard to every current *and* future employee in one go.
3. The control lives in **Roles & Permissions** (`/admin/roles`) and is **docket_admin-only**.

A granted viewer sees the **full org-wide dashboard** (tiles + status distribution +
by-team **and** by-person breakdowns) — identical to what founders see today.

## Approach

Decouple dashboard visibility from `docket_view_all` with **dedicated storage**, mirroring
the existing `spaces`/`space_members` pattern (per-person grants key on auth `user_id`,
exactly like `space_members`). A global persistent flag lives in a new key-value settings
table.

Rejected alternative: adding a `docket_dashboard` perm to the role system. The role layer
is role-based, not per-user, so per-person grants would mean minting per-user roles, and
"make all" doesn't map to a role at all. Dedicated tables are cleaner and keep the
permission matrix unpolluted.

## Data model — migration `docket_dashboard_sharing_v1` (`0003_dashboard_sharing.sql`)

```sql
-- key-value settings (extensible; first key = dashboard_public)
create table docket.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid
);
insert into docket.settings(key, value) values ('dashboard_public', 'false'::jsonb);

-- per-person dashboard grants (keys on auth user_id, like space_members)
create table docket.dashboard_viewers (
  user_id uuid primary key,
  granted_by_user_id uuid,
  granted_at timestamptz not null default now()
);
```

Both tables: RLS enabled, `grant all … to service_role`, **no anon/authenticated grants**
(RULE-RLS-001). The worker (service_role) is the only client.

## Access logic (worker `docketops`)

New helpers:
- `dashboardPublic(env)` → reads `docket.settings` key `dashboard_public` (bool).
- `isDashboardViewer(userId, env)` → row exists in `docket.dashboard_viewers`.
- `canViewDashboard(auth, env)` = `canViewAll(auth)` **OR** `dashboardPublic(env)` **OR**
  `isDashboardViewer(auth.userId, env)`.

Wiring:
- **`getDashboard`** — for the **General/default** space, swap the `canViewAll(auth)` gate
  for `await canViewDashboard(auth, env)`. Private-space dashboards keep their existing
  membership rule (`canAccessSpace`) untouched.
- **`getMe`** — add a computed `can_view_dashboard` boolean to the response (one extra
  cheap read OR'd in), so the sidebar can decide whether to show the Dashboard link
  without a second round-trip.

## New worker actions (all `docket_admin`-gated via `requireAdmin`)

- GET **`getDashboardSharing`** → `{ public: bool, viewers: [{ user_id, full_name }] }`.
  Viewer names hydrated from `store.users_profile`.
- POST **`setDashboardPublic`** `{ value: bool }` → upsert the settings row (stamps
  `updated_by_user_id`/`updated_at`).
- POST **`addDashboardViewer`** `{ user_id }` → insert (ignore-duplicates).
- POST **`removeDashboardViewer`** `{ user_id }` → delete.

Picker source = existing `getEmployees` (active podium employees with `auth_user_id`);
only employees with a login can be granted (grant stores the `auth_user_id`).

## Frontend (`apps/docket`)

- **`lib/nav.js`** — Dashboard nav item gate changes from `requires: 'docket_view_all'`
  to `requires: '_dashboard'` (a synthetic key fed from `getMe.can_view_dashboard`).
- **`(auth)/layout.js`** — the existing `getMe` call (already fetched for spaces) also
  captures `can_view_dashboard`; `buildNavGroups` is called with
  `{ ...(perms||{}), _dashboard: canViewDashboard }`.
- **`(auth)/dashboard/page.js`** — the client guard for the General dashboard relaxes to
  honour `can_view_dashboard` (fetched via `getMe`); the worker `getDashboard` 403 remains
  the real gate (page shows a friendly "no access" message on 403).
- **`(auth)/admin/roles/page.js`** — new **"Dashboard sharing"** card (rendered above the
  roles grid, admin-only — page is already `docket_admin`-gated):
  - **"Visible to everyone"** toggle (persistent global → `setDashboardPublic`).
  - **"Specific people"** list: a `Combobox` to add (options = active employees-with-login,
    minus already-granted) + removable rows (`removeDashboardViewer`). When the global
    toggle is ON, the per-person list is shown but de-emphasised with a note that everyone
    already has access; grants persist underneath for when it is flipped off.

## What a granted viewer gets

The full org-wide dashboard. Tile drill-throughs to `/tasks?overdue=1` etc. stay scoped to
the viewer's own task visibility (baseline = own/team/collaborator) — aggregate numbers on
the dashboard, their own subset on click-through. This degrades cleanly and is expected
given the explicit choice of "dashboard view without all-tasks".

## Out of scope (YAGNI)

- Audit/history of grant/toggle changes beyond the `granted_by`/`updated_by` stamps.
- Per-space dashboard sharing (this controls only the General/org dashboard; private-space
  dashboards already follow membership).
- Scoped/redacted dashboard variants (granted viewers get the full org view, per decision).
