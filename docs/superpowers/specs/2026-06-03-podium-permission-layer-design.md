# Podium self-managed permission layer — design

> Date: 2026-06-03 (Session 97)
> System: Podium (People & Performance OS) — `podiumops` worker + `apps/podium`
> Reference: the Snorkel permission layer (`store.snorkel_roles` / `snorkel_user_roles`,
> `apps/snorkel/.../admin/{roles,users}`, RULE-SNORKEL-002).

## Goal

Move Podium's permission layer **out of the shared `store.roles`** (managed in Garage
`/users`) and **into Podium itself**, exactly as Snorkel does. Add an in-Podium admin
surface where an admin can **define new roles with custom permissions** (a permission-key
matrix) and assign one role per LOT user — all without touching Garage.

Today Podium gates on `store.roles` via `users_profile.role` and the four keys
`podium_view` / `podium_admin` / `podium_hr` / `podium_comp` (only `admin` + `super_admin`
carry them). Manager powers are derived from the `employees.manager_id` chain (a graph, not
a perm) — that stays untouched.

## Decisions (locked with Afshaan)

1. **Default access = self-only baseline.** A logged-in `@legendoftoys.com` user with **no**
   assigned Podium role can see only their own profile + log/view their own wins (`/me`),
   nothing about anyone else. (Not zero-access.)
2. **Keep the 4 existing permission keys as-is** (no granularization). Every existing worker
   gate maps 1:1. Unlimited custom *roles* are composed from these 4 toggles.

## Data model (in `store`, mirrors Snorkel 1:1)

- **`store.podium_roles`** — `id bigserial`, `role_key text UNIQUE NOT NULL`, `label text NOT NULL`,
  `description text`, `permissions jsonb NOT NULL DEFAULT '{}'`, `is_system bool NOT NULL DEFAULT false`,
  `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`.
- **`store.podium_user_roles`** — `user_id uuid PRIMARY KEY`, `role_key text NOT NULL`,
  `assigned_by uuid`, `assigned_at timestamptz NOT NULL DEFAULT now()`. One Podium role per user
  (upsert on `user_id`).

Both: RLS **enabled**, `GRANT ALL … TO service_role`, **no** anon/authenticated grants
(RULE-RLS-001). Placed in `store` (not the `podium` schema) to match Snorkel exactly and reuse
the worker's existing `sbStore` helper.

## Worker (`podiumops`)

### verifyJWT cutover
Replace the `store.roles`-via-`users_profile.role` permission lookup with a Podium-layer
resolve: `podium_user_roles(user_id) → role_key → podium_roles.permissions`. No assigned role
→ `permissions = {}`, `podiumRole = null`. Identity (`full_name`, `active`) still from
`users_profile`. Return shape adds `podiumRole`; `permissions` now sourced from the new layer.

### Gate → "full baseline OR self-scoped"
Today `handleGet`/`handlePost` hard-403 without `podium_view`. New logic:
- **`getMe` is always reachable** post-auth (so a no-role user can load the app and the nav).
- `SELF_SERVE_GET = { getEmployee, getMyPerformance, getAccomplishments, getObservations, getOneOnOnes }`
- `SELF_SERVE_POST = { createAccomplishment, updateAccomplishment, deleteAccomplishment }`
  (wins are self-recorded per the Podium spec).
- If caller has `podium_view` → full baseline as today.
- If **not**, only the self-serve actions pass the gate, **and** each self-serve handler
  hard-restricts the target to the caller's own `employees` row (any other `id`/`employee_id`
  → 403). A caller with no linked employee row gets nothing but `getMe`.
- Existing per-row visibility filters stay as the second line of defense (observations return
  only `shared_with_employee` to a subject; 1:1 `private_notes` stripped from the report; comp
  gated). Self-scoping is an additional outer guard, not a replacement.

### Role-admin actions
- `getPodiumRoles` — list roles (reachable by any baseline user, for the assign dropdown +
  showing role labels; roles carry no secrets).
- `getPodiumUsers` — `podium_admin`. All LOT users (`users_profile` + auth emails) annotated
  with their current `podium_role`.
- `createPodiumRole` / `updatePodiumRole` — `podium_admin`. **Footgun guard:** if any key other
  than `podium_view` is enabled, force `podium_view:true` in the stored permissions (so an admin
  cannot mint an elevated role that 403s itself at the gate — RULE-PODIUM-001 corollary).
- `deletePodiumRole` — `podium_admin`. Refuse if `is_system` or if any user is assigned.
- `assignPodiumRole` — `podium_admin`. `{ user_id, role_key }`; empty `role_key` → unassign
  (delete the `podium_user_roles` row → user falls back to self-only).

## Frontend (`apps/podium`)

- **`/admin/roles`** — port of Snorkel's roles page. Role cards + create/edit/delete form with a
  grouped permission-key matrix (toggle switches):
  - **Workspace** → `podium_view` (directory, org chart, dashboards)
  - **People** → `podium_hr` (manage people / departments / job roles / docs / org snapshots)
  - **Compensation** → `podium_comp` (compensation + salary bands)
  - **Admin** → `podium_admin` (manage Podium roles + assign users + settings)
- **`/admin/users`** — port of Snorkel's users page. Every LOT user + a role `<select>`
  (`— none (self-only) —` + each role). Calls `assignPodiumRole`.
- **Nav (`lib/nav.js`):** ADMIN group gains "Roles & Permissions" (`/admin/roles`) and "Users"
  (`/admin/users`), both `requires: 'podium_admin'`. Additionally, gate the baseline browse items
  behind `podium_view` so a self-only user's sidebar shows **only** My Performance: add
  `requires: 'podium_view'` to Dashboard, Directory, Org Chart, Team, Roles & KPIs, Departments.
  `/me` stays open.
- **Landing for self-only users:** ensure a user without `podium_view` lands on `/me` rather than
  a `podium_view`-gated page (adjust the podium default-route / `(auth)` redirect as needed).
- Both admin pages already have a client-side `perms.podium_admin` guard (copied from Snorkel).
  `perms` flows automatically: the shared `AuthProvider` populates it from `getMe().permissions`,
  which now returns the new-layer perms.

## Seed + bootstrap (in the migration — prevents lockout)

Seed roles:
- **`admin`** (system, undeletable) — all four keys true. The founder role.
- **`employee`** (system, undeletable) — `{}` (empty = the self-only default; labeled so it shows
  in the assign dropdown).
- **`hr`** (preset, editable) — `podium_view` + `podium_hr`.
- **`comp`** (preset, editable) — `podium_view` + `podium_comp`.
- **`people_manager`** (preset, editable) — `podium_view` (browse directory/org; full-profile of
  reports comes from the manager chain).

**Bootstrap:** insert every user who currently holds `podium_admin` in `store.roles` (i.e. all
holders of `admin` / `super_admin`) into `store.podium_user_roles` as `admin`, in the same
migration. So the instant the new worker is deployed, current admins keep full access.

## Cutover / rollback

- Apply the migration **before** deploying the new worker (old worker keeps reading `store.roles`
  until then — no access gap; admins are bootstrapped into the new layer at migration time).
- The stale `podium_*` keys in `store.roles` are left in place (harmless dead, like Snorkel) — the
  worker just stops reading them. Stripping them is deferred (it touches the shared roles JSONB
  Garage `/users` renders) and is out of scope.
- Rollback = redeploy the prior `podiumops` worker (reads `store.roles` again). The new tables are
  additive and harmless if unused.

## Scope guard

Podium-only this session: `podiumops` worker + `apps/podium` + the two new `store` tables. No
other system touched. Build sequence: migration → worker edit/commit/push/deploy → app build →
commit/push (auto-deploy).

## New business rule

**RULE-PODIUM-006** (to add): Podium runs its OWN permission layer
(`store.podium_roles` / `podium_user_roles`), isolated from the shared `store.roles` — same
pattern as Snorkel (RULE-SNORKEL-002). No Podium role = self-only baseline (own profile + own
wins via `/me`), not zero access. Every elevated role must carry `podium_view` (enforced
server-side in create/update — RULE-PODIUM-001 corollary).
