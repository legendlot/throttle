# Manifest — Access Control + Permissions Builder (design)

> Date: 2026-06-18 · System: Manifest (China-import LOT↔SF OS) · Worker: `manifestops` · App: `apps/manifest`
> Backlog: closes/supersedes the S149 "[manifest] [MED] Access control — per-person enable/disable + Unauthorized screen" item and adds an in-app permissions builder + a super-admin governance tier.

## 1. Problem & goals

Manifest carries sensitive cross-company financial data (the LOT↔Solve Factory pooled running
account, vendor payments, invoices). Access must be **locked by default** and **governed by a
super admin** (Afshaan, plus anyone he appoints — most likely Vinay).

Today:
- Server-side access is **already locked**: `verifyJWT` denies anyone without an active
  `store.users_profile` row **and** a `manifest.manifest_user_roles` row (no role → 401).
- But there is **no visible wall** (an unauthorized user just sees "Failed to load Manifest data:
  Unauthorised"), **no in-app UI** to grant/revoke access or build roles (the worker has
  `saveRole`/`setUserRole`/`getRoles`/`getUsers` but the SPA Admin screen never exposes them — roles
  are managed by raw SQL today), and **no super-admin tier** distinct from the operational
  `manifest_admin`.

Goals:
1. A **visible Unauthorized wall** for users with no/disabled access.
2. An in-app **Access Control** UI: grant access, change role, soft-disable/re-enable, hard-remove.
3. An in-app **Permissions Builder**: super admins compose roles from the fixed capability set,
   create/edit/delete custom roles; system roles are view-only.
4. A **super-admin tier above `manifest_admin`**: only super admins govern access + roles + appoint
   other super admins. Regular `manifest_admin` keeps operational admin (shipment defaults,
   forwarders) but cannot change who has access or what roles can do.

Non-goals: changing the OTP login flow, SF cost-stripping, one-role-per-user, or any operational
handler. No new permission *keys* beyond the one governance key (the key vocabulary is fixed in the
worker — each key gates specific handlers; the builder composes roles from it, it does not invent
capabilities).

## 2. Decisions (from brainstorming)

- **Super-admin = a new capability `manifest_super_admin`**, carried by a role (not a per-user
  boolean column). The existing **`admin` system role becomes the super-admin tier** (gets the new
  key). "Regular operational admin" = any buildable role with `manifest_admin: true` but *not*
  `manifest_super_admin`.
- **Permissions builder: full role CRUD, system roles locked.** Super admins create new roles, edit
  any *custom* role (label/description/permission-key checkboxes), and delete *unused custom* roles.
  `is_system` roles (`admin`, `sf_owner`, `lot_finance`, `lot_founder`) are **view-only** (visible to
  see/clone, never editable/deletable).
- **Access lifecycle: soft disable + hard remove, both available.** Per person: change role, toggle
  Active on/off (soft — keeps row + history, instantly blocks login, reversible), or Remove. A
  "Grant access" action adds a new person by email + role. Disabled users hit the wall.
- The active flag is **Manifest-scoped** (`manifest_user_roles.active`), never the shared
  `store.users_profile.active` (which would lock the person out of every LOT system).

## 3. Data model — migration `manifest_access_control_v1` (additive only)

```sql
-- (a) Manifest-scoped access kill switch
ALTER TABLE manifest.manifest_user_roles
  ADD COLUMN IF NOT EXISTS active      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_by uuid;

-- (b) Make the existing top-tier role the super admin (Afshaan currently holds `admin`)
UPDATE manifest.manifest_roles
   SET permissions = permissions || '{"manifest_super_admin": true}'::jsonb
 WHERE role_key = 'admin';
```

- No new tables. No destructive SQL (the `sql-gate` hook will not prompt).
- `manifest_user_roles` is already one-row-per-user; `active` defaults true so every existing
  assignment (only Afshaan today) stays enabled.
- `disabled_at`/`disabled_by` are audit only.

## 4. Worker — `manifestops` (`05_Throttle/manifestops-worker/src/index.js`)

### 4.1 Permission helper + gate move
```js
const canSuperAdmin = p => !!p.manifest_super_admin;
```
Re-gate **governance** handlers from `canAdmin` → `canSuperAdmin`:
`getRoles`, `saveRole`, `setUserRole`, `onboardSfUser`, and the new `deleteRole`, `setUserActive`,
`grantAccess`. **Leave operational handlers on `canAdmin`** (shipment defaults, forwarders create,
and any non-governance admin action). `getUsers` → `canSuperAdmin` (it feeds the access screen).

### 4.2 `verifyJWT` — honor the active flag (one line)
The role lookup adds `&active=is.true`:
```js
const ur = await sb(`/rest/v1/manifest_user_roles?user_id=eq.${userId}&active=is.true&select=role_key&limit=1`);
```
A disabled user resolves to `roleKey: null` → `verifyJWT` returns null → 401 → the wall.

### 4.3 New handlers (all `canSuperAdmin`-gated)
- **`deleteRole(role_key)`** — reject if the role `is_system` (403) or is currently assigned to any
  user (409, list count). Else delete the `manifest_roles` row.
- **`setUserActive(user_id, active)`** — set `active` + (`disabled_at`,`disabled_by`) when disabling,
  clear them when re-enabling. Guards below.
- **`grantAccess(email, role_key)`** — generalizes `onboardSfUser`: resolve the auth user by email via
  the Supabase admin API (`/auth/v1/admin/users?email=`), 422 if none ("ask them to sign in once
  first"). Then ensure a `store.users_profile` row exists **without clobbering an existing one**: look
  it up first; if missing, INSERT (`active=true`, `role='sf_partner'` for an SF-party role else
  `'staff'`); if present, only ensure `active=true` (never overwrite an existing LOT user's
  `role`/`full_name`). Finally upsert `manifest_user_roles` (role_key, active=true, assigned_by).
  `onboardSfUser` stays as a thin alias for back-compat.

### 4.4 `saveRole` hardening
- Reject saving a role whose `role_key` matches an existing `is_system` role (403).
- For a **SF-party** role, strip/deny LOT-only keys (`manifest_admin`, `manifest_super_admin`,
  `cost_view`, `payment_record`, `charge_manage`, `fx_manage`, `china_po_sync`, `order_manage`,
  `shipment_manage`, `drawdown_manage`, `doc_manage`) — SF roles may only hold the SF key set +
  `manifest_view`.
- `party` is immutable after create (a role's party is fixed; to change it, make a new role).

### 4.5 Last-super-admin + self guards (server-enforced)
A small helper counts active super admins (users whose active role carries `manifest_super_admin`).
Reject with 409 when an action would:
- disable / remove **yourself** (`d.user_id === userId`), or
- disable / remove / re-role-away-from-super the **last active super admin**, or
- (`saveRole`) remove `manifest_super_admin` from a role if that would zero out active super admins,
- (`setUserRole`) move the last super admin onto a non-super role.

### 4.6 `getBootstrap`
`me.permissions` already carries the full map → the SPA sees `manifest_super_admin` with no payload
change. Extend the admin payload so the Access Control + Roles tabs have data in one round-trip:
when `canSuperAdmin(P)`, return `roles` (all `manifest_roles` rows incl. `is_system`/permissions) and
`accessUsers` (each `users_profile` that has a `manifest_user_roles` row, joined: name, email, party,
role_key, role label, active, disabled_at). **`orgGroups` is retired** — `accessUsers` supersedes it;
remove the `orgGroups` block from `getBootstrap` and the read-only member-list rendering in the old
Admin screen.

## 5. UI — `apps/manifest/src/mf/`

### 5.1 Unauthorized wall (`ManifestApp.js`)
Distinguish an **auth/permission failure** from a transient load error. When `getBootstrap` fails
with 401 (or returns no `me`), render a **full-screen Unauthorized view** (no Sidebar/Topbar/data):
- Headline: "No access to Manifest."
- Body: "Your account isn't authorized for Manifest. Ask a super admin to grant you access."
- Shows the signed-in email (`session.user.email`) + a **Sign out** button (`useAuth().signOut`).
Other (network/500) errors keep the existing inline "Failed to load" message.

### 5.2 Admin screen restructured (`screens.js` `Admin`)
Three tabs (sub-nav inside the Admin screen):
- **Access Control** *(super-admin only)* — table from `accessUsers`: avatar/name, email, party badge,
  Role (dropdown to change → `setUserRole`), Active toggle (→ `setUserActive`), Remove (→ `setUserRole`
  null). Disabled rows greyed with a "disabled" badge. A **"Grant access"** button → email + role
  picker → `grantAccess`. Self-row and last-super-admin row: guarded controls disabled with a tooltip
  reason (server still enforces).
- **Roles** *(super-admin only)* — the **Permissions Builder**: role list (system roles badged
  "System · locked", view-only). "New role" form: `role_key`, `label`, `description`, `party` (LOT/SF).
  Editor: permission-key checkboxes **grouped + labelled**, filtered to the role's party (LOT key set
  for LOT, SF key set for SF). Save → `saveRole`; Delete (custom + unused only) → `deleteRole`.
  A static `PERMISSION_KEYS` catalog (key → label, group, party) lives in the app for nice rendering.
- **Operations** *(`manifest_admin`)* — existing Shipment Defaults + Forwarders, unchanged.

Tab visibility: Access Control + Roles render only when `data.me.permissions.manifest_super_admin`;
Operations renders when `manifest_admin`. If a user has neither (shouldn't reach Admin), show an
inline "Admin access required" card.

### 5.3 Nav (`nav.js`)
The **Admin** nav item shows when `manifest_admin || manifest_super_admin`. (Currently the SPA nav is
static; add a light per-item perm predicate, or filter the `NAV` array in `ManifestApp`/`Sidebar`
against `me.permissions`. Minimal: only the Admin item needs gating today.)

### 5.4 Permission-key catalog (display)
```
LOT group "Manifest":   manifest_view
LOT group "Orders":     order_manage, china_po_sync
LOT group "Shipping":   shipment_manage
LOT group "Finance":    charge_manage, payment_record, drawdown_manage, fx_manage, cost_view
LOT group "Documents":  doc_manage
LOT group "Governance": manifest_admin, manifest_super_admin
SF  group "Manifest":   manifest_view
SF  group "Orders":     sf_order_update, sf_po_manage, sf_invoice_create
SF  group "Finance":    sf_drawdown_raise, sf_vendor_payment_record, sf_running_account_view
SF  group "Documents":  sf_evidence_upload
```

## 6. Verification

- **Migration**: advisor-clean; `manifest_user_roles` has `active` (default true) on all rows; `admin`
  role carries `manifest_super_admin`.
- **Worker (build + deploy `manifestops`)**: governance handlers 403 for a non-super `manifest_admin`;
  `setUserActive(false)` then a fresh `getBootstrap` for that user → 401; last-super-admin guard 409s;
  SF role can't be saved with a LOT key; `deleteRole` 409s on an assigned role and 403s on a system
  role; `grantAccess` 422s for an unknown email.
- **App (build all apps green; deploy via push)**: signed-out/unauthorized → wall; super admin sees 3
  tabs and can grant/disable/role-change + build a role; `manifest_admin` (non-super) sees only
  Operations; SF user sees no Admin item.
- Live authenticated browser smoke is the standing Manifest go-live caveat (no in-session JWT);
  exercise it on `manifest.legendoftoys.com` once deployed.

## 7. Rollout / sequence

edit → build → commit → push → `cd 05_Throttle/manifestops-worker && npx wrangler deploy` (worker),
then app auto-deploys on push (`deploy-manifest.yml`). Migration applied first (additive, safe).

## 8. Out of scope / later

- Multiple roles per user (stays one-role-per-user).
- New permission *keys* / finer-grained capabilities (requires worker handler changes).
- Audit log surface for access changes (the `disabled_at/by` + existing `manifest.activity` cover the
  data; a dedicated viewer is later).
- Self-service "request access" (the wall is informational only).
