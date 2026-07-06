# Podium Salary Vault — Design

> Date: 2026-07-06 · System: Podium (People & Performance OS) · Author: Claude + Afshaan
> Status: Approved (design) → implementation plan next
> Supersedes the "vault gated OFF until Cloudflare Access" posture of RULE-PODIUM-002 (see §8).

## 1. Problem & goal

Podium ships an absolute-salary vault (`podium.compensation_events.old_ctc / new_ctc /
components`) that has never been safely usable. We now want it **live with real salaries**, with
one non-negotiable property: **no cross-person salary visibility.**

Two facts discovered while scoping (both drive the design):

1. **The salary data is already in the table and already readable.** The S99 load put real CTC +
   full component breakdowns for **24 employees** into `compensation_events`
   (29 events total, 29 with `components`, 24 with `new_ctc`). The `comp_vault_enabled` flag is
   **off**, but that flag only gates the worker *write* path and the UI — it does **not** gate
   reads. `getCompensation` returns the CTC columns to anyone who passes `canComp()`. So the vault
   flag is close to irrelevant to the real security question.
2. **`canComp()` silently couples salary access to being an admin.** Today
   `canComp = isAdmin(auth) || hasPerm(auth,'podium_comp')`. Four people hold the Podium `admin`
   role (Afshaan, Vinay, Mohit Jain, Priya Bahulkar) — so all four can already read those 24
   salaries, purely as a side effect of being admins.

**Goal:** rebuild the single salary chokepoint (`canComp`) into an **explicit allow-list**
decoupled from admin/HR, add a **self-only** path so each employee sees only their own pay, add an
**append-only audit log** of cross-person reads, then turn the vault on and feed real data — in
that order.

### Intended access (confirmed with Afshaan)

- **Salary-visibility group = the 4 today:** Afshaan + Vinay (super_admins), Mohit Jain (defacto
  head of sales / #3), Priya Bahulkar (Finance). They may see **everyone's** pay.
- **Everyone else sees only their own salary, nobody else's** — and this must hold airtight when
  Podium is later opened to all staff. (Today Podium is not open to all employees, so there is no
  live exposure to the general population yet; the design must guarantee it for the rollout.)
- **Only super_admin (exactly Afshaan + Vinay — verified as the only two active super_admins)**
  may change who is in the salary-visibility group.

### Non-goals

- Cloudflare Access / network-edge SSO (Phase 5) — explicitly deferred; see §8.
- Reworking the appraisal increment engine, job-role salary bands semantics, or the factory-cost
  math. Those inherit the new gate unchanged.
- Multi-currency / historical-FY comp modelling beyond what `compensation_events` already holds.

## 2. Architecture — one chokepoint

Every salary-bearing read in podiumops funnels through `canComp()` / `requireComp()`:
`getCompensation`, job-role salary bands (`projectJobRole`), appraisal increments (`getAppraisal`,
`getAppraisals`), and the factory-cost module (`getFactoryWorkforce` / `getFactoryPay` /
`upsertFactoryPay` / `bulkUploadFactoryPay` / cost-input handlers). Rebuilding that one function
closes/opens every path at once. No new per-path logic, no client-side filtering (which could
drift).

## 3. Access model

### 3.1 `podium.comp_access` allow-list (new)

```sql
CREATE TABLE podium.comp_access (
  auth_user_id  uuid PRIMARY KEY,          -- store.users_profile.id / auth.users.id
  full_name     text,                       -- denormalised for the admin surface + audit readability
  added_by      uuid,                       -- super_admin who granted
  added_at      timestamptz NOT NULL DEFAULT now(),
  note          text
);
-- RLS ON, service_role-only (RULE-RLS-001). No anon/authenticated grants.
```

Seed with the 4 current holders (Afshaan, Vinay, Mohit, Priya) by `auth_user_id`.

### 3.2 `canComp` becomes allow-list-only (worker)

```js
// Salary access is an explicit allow-list, decoupled from admin/hr.
// auth.compAccess is a boolean resolved once per request in verifyJWT (§3.4).
function canComp(auth) { return auth?.compAccess === true; }
```

- `podium_admin` and `podium_hr` **no longer imply** comp. An admin added for people-ops does not
  see salaries unless separately added to `comp_access`.
- The `podium_comp` **role key is retired from the comp decision** (Afshaan: allow-list only,
  retire the key). It is removed from `canComp`, from `normalizePodiumPerms`'s elevated-key set,
  and from `PODIUM_PERM_KEYS`. Existing role rows keep any leftover `podium_comp: true` harmlessly
  (worker ignores it); the two preset roles that reference it (`comp`, `hr`) have **0 users** and
  are cleaned up (the `comp` role deleted; `hr` keeps only `podium_hr`+`podium_view`).

### 3.3 Who edits the allow-list

- Read/manage `comp_access` is gated to **store `super_admin`** (Afshaan + Vinay — verified the
  only two). New worker actions:
  - GET `getCompAccess` — list current members (super_admin only).
  - POST `addCompAccess` / `removeCompAccess` — grant/revoke (super_admin only), writes
    `comp_access` + an audit row (§5). No self-removal guard is needed: a super_admin's *edit*
    right comes from `store.users_profile.role`, not from `comp_access` membership, so a
    super_admin can never lock themselves out of managing the list even if removed from it.
- Super_admin status is read from `store.users_profile.role = 'super_admin'` via the existing
  `sbStore` path (same source the worker already trusts for identity). No hardcoded UUIDs.

### 3.4 Resolving membership at auth time

Extend `verifyJWT` (already loads identity + podium role) with a single lookup:
```
compAccess = EXISTS(SELECT 1 FROM store... podium.comp_access WHERE auth_user_id = <jwt user id>)
```
Store `auth.compAccess = true|false` and `auth.isSuperAdmin = (profile.role === 'super_admin')`.
This is one extra indexed PK lookup per request — negligible, and keeps `canComp` a pure predicate.
(`comp_access` is in the `podium` schema, reachable via the worker's `sb` helper.)

## 4. Employee self-view — the rollout guarantee

- **New self-serve action `getMyCompensation`** (in `SELF_SERVE_GET`, reachable by the self-only
  baseline — no `podium_view` required):
  - Resolves the caller's own employee row via `auth_user_id = <jwt user id>` (`callerEmployee`).
  - Returns **only** that employee's `compensation_events` + derived `current_ctc`.
  - **Accepts no employee-id parameter.** There is structurally no input by which a caller can ask
    for another person's pay. If the caller has no employee row → empty result (not an error).
- **`getCompensation(employee_id)` stays strictly allow-list-gated** (`requireComp`). It is the
  **only** path that can read another person's salary. A non-allow-list caller gets 403 — it does
  **not** silently fall back to self (that avoids an ambiguity where self and cross-person paths
  blur).
- **`/me`** gains a "My compensation" block fed by `getMyCompensation`. Rendered only when the
  vault is on (or always, showing "not yet recorded" — decided at build; default: show own CTC +
  latest increment, nothing about anyone else).

Structural guarantee: self path has no cross-person input; cross-person path is allow-list-locked.
Opening Podium to all staff therefore cannot leak one employee's pay to another.

## 5. Audit log

```sql
CREATE TABLE podium.comp_access_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viewer_user_id  uuid NOT NULL,
  viewer_name     text,
  action          text NOT NULL,           -- 'getCompensation' | 'getFactoryPay' | 'addCompAccess' | 'removeCompAccess' | ...
  subject_employee_id uuid,                 -- podium.employees.id (null for allow-list admin actions)
  subject_label   text,                     -- EMP code / operator name for readability
  detail          jsonb,                    -- optional (e.g. {added: <uuid>})
  at              timestamptz NOT NULL DEFAULT now()
);
-- RLS ON, service_role-only. Append-only (no worker UPDATE/DELETE path).
```

- Written on every **cross-person** salary read: `getCompensation`, factory-pay reads
  (`getFactoryWorkforce`/`getFactoryPay`), and on `add/removeCompAccess`.
- **Self-views of one's own pay are NOT logged** — they are not a leak, and logging every
  employee checking their own salary would drown the signal. (Revisit if a compliance need arises.)
- Writing the log row must not break the read if it fails (best-effort insert; log-and-continue).
- Reviewable by super_admin via GET `getCompAccessLog` (paginated, super_admin only). A small
  admin surface can come later; SQL access suffices at launch.

## 6. Factory operator pay

Per Afshaan's answer ("keep current admins"), factory pay stays with the current group. Because
`comp_access` **is** that group, `requireComp` in the factory-cost handlers now resolves through the
same allow-list automatically — no separate config, and it tightens correctly (a future admin no
longer sees operator pay either). Redline's aggregate ₹/unit cost views (`factory_cost_view`, a
lotopsproxy perm, aggregate-only, no individual salaries) are **unaffected** and stay as-is.

## 7. Turning the vault on — ordering

The sensitive columns are already populated and already readable by the current comp-holders, so
order matters:

1. Ship gate rebuild (§3) + self-view (§4) + audit log (§5) + allow-list admin (§3.3). Deploy
   podiumops. Redeploy the app.
2. Run the leak-vector checklist (§9) live (real Google logins): a comp-group member sees all;
   a non-member sees only own via `/me`; `getCompensation(other_id)` 403s for a non-member.
3. **Only then** set `podium.settings.comp_vault_enabled = true` so `addCompensationEvent` /
   `applyIncrement` persist CTC and the UI exposes the vault. Reads are already correctly gated,
   so "vault on" changes only writes + UI affordance.

## 8. Security-posture deviation (RULE-PODIUM-002)

RULE-PODIUM-002 holds the vault OFF until Phase 5 (Cloudflare Access SSO in front of both
`podium.legendoftoys.com` and the podiumops worker). **Afshaan has chosen to enable the vault now**,
ahead of that milestone. Recorded honestly:

- **Boundary today = worker + Google-OAuth JWT (`@legendoftoys.com`, RULE-010) + RLS
  (service_role-only).** The public GH-Pages bundle holds no data (same as Pitstop PII).
- **Residual exposure paths:** a bug in the `canComp` gate, or a compromised comp-group Google
  account. There is no network-edge SSO wall in front of the worker.
- **Mitigations in this design:** single-chokepoint allow-list gate; own-only self path (no
  cross-person input); append-only audit log; RLS service-role-only; membership editable only by
  the two super_admins.
- **Recommendation (non-blocking):** add Cloudflare Access later as defense-in-depth.

RULE-PODIUM-002 will be amended to record this decision and the new allow-list gate.

## 9. Assurance checklist — the "absolutely sure" pass

Enumerate every salary-bearing path; each must be **allow-list-gated (cross-person)** or
**own-only (self)**. Verified in code review AND live after deploy:

| Path | Rule | Gate |
|---|---|---|
| `getCompensation(employee_id)` | cross-person | allow-list (`requireComp`) + audit |
| `getMyCompensation` | self | own employee row only, no id param |
| job-role salary bands (`projectJobRole`, `getJobRole(s)`, create/update) | cross-person (role-level) | allow-list |
| appraisal increment (`getAppraisal`, `getAppraisals`) | own (subject) OR all (allow-list) | `isSubject || canComp` |
| `applyIncrement` / `addCompensationEvent` (writes) | cross-person write | allow-list |
| factory pay reads (`getFactoryWorkforce`/`getFactoryPay`) | cross-person | allow-list + audit |
| factory pay writes (`upsertFactoryPay`/`bulkUploadFactoryPay`/cost inputs) | cross-person write | allow-list |
| `getEmployee` / directory | not salary | confirmed: `employees` has **no** salary column |
| `/me` (`getMyPerformance`) | self | carries no other-person comp |
| `comp_access` admin (`get/add/removeCompAccess`) | control-plane | super_admin only + audit |

Also confirm: no path returns raw `compensation_events` for a non-member; `getMyCompensation`
returns nothing when called for a foreign id (there is no such id param); the audit insert failing
never blocks a read.

## 10. Feeding real salaries (data)

Executed when Afshaan hands over the mixed-format data (separate work item, after the gate ships):

1. **Parse** the mixed format → normalized rows `(employee ↔ EMP code, new_ctc, components jsonb,
   effective_from, source_note)`. Name-match to `podium.employees` by EMP code where present, else
   fuzzy name → **review sheet** for Afshaan to confirm ambiguous/unmatched.
2. **Sanity-check magnitudes** (guard the Chiragh extra-zero class: ₹42,00,000 vs ₹4,20,000).
3. **Snapshot** the existing 29 `compensation_events` rows (`store.safety_podium_comp_<date>` or a
   `podium` snapshot table) before any write.
4. **Reconcile** with the S99 load: update stale/partial rows, insert new employees, avoid
   duplicate `initial` events per employee.
5. Load via a snapshotted migration/SQL or a super_admin-gated bulk action. No real salary values
   are pasted into chat; work happens in aggregates + the review artifact.

Component-breakdown fidelity (basic / HRA / allowances / employer PF / etc.) is confirmed against
the actual data shape at load time; `components` is jsonb, so the schema already accommodates it.

## 11. Components / interfaces summary

**DB (migrations):**
- `podium_comp_access_v1` — `podium.comp_access` (+ RLS, service_role grant) + seed the 4.
- `podium_comp_access_log_v1` — `podium.comp_access_log` (+ RLS, service_role grant).
- Role cleanup: delete the `comp` preset role; strip `podium_comp` from any role's `permissions`
  (idempotent UPDATE).

**Worker (`podiumops-worker/src/index.js`):**
- `verifyJWT` → add `compAccess` + `isSuperAdmin`.
- `canComp` → allow-list-only; drop `isAdmin ||` and the key. Remove `podium_comp` from
  `PODIUM_PERM_KEYS` / `normalizePodiumPerms`.
- New: `getMyCompensation` (SELF_SERVE_GET), `getCompAccess` / `addCompAccess` /
  `removeCompAccess` / `getCompAccessLog` (super_admin), `logCompAccess()` helper.
- `getCompensation` + factory-pay reads → call `logCompAccess()`.

**App (`apps/podium`):**
- `/me` → "My compensation" block (getMyCompensation).
- `/admin/settings` (or `/admin/roles`) → "Salary access" card (super_admin only): list/add/remove
  `comp_access` members; link to the audit log.
- Comp UI on `/people/detail` stays gated by the (now allow-list-driven) `can_see_comp` flag the
  worker already returns.

**Settings:** flip `podium.settings.comp_vault_enabled = true` as the final step (§7).

## 12. Rollout order

1. Migrations (`comp_access`, `comp_access_log`, role cleanup) + seed the 4.
2. Worker: gate rebuild + self-view + allow-list admin + audit. Commit → push → `wrangler deploy`.
3. App: `/me` comp block + salary-access admin card. Commit → push (auto-deploy).
4. Live assurance pass (§9).
5. Flip `comp_vault_enabled = true`.
6. (Separate) feed real salaries (§10).
7. Update knowledge: RULE-PODIUM-002 amendment, `systems/podium.md`, memory.

## 13. Open questions / decisions locked

- **Allow-list only, retire the key** — LOCKED (Afshaan).
- **Factory pay stays with the group** — LOCKED.
- **Audit cross-person reads, not self-views** — LOCKED.
- **Enable vault now, defer Cloudflare Access** — LOCKED, recorded in §8.
- Deferred to load time: component-breakdown fields; whether `/me` shows own CTC before the vault
  flip (default: show once recorded).
