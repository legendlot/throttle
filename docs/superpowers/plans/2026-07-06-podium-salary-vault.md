# Podium Salary Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Podium's absolute-salary vault safely usable — rebuild the salary gate into an explicit `podium.comp_access` allow-list (decoupled from admin/HR), add an own-only employee self-view, add an append-only audit log, then flip the vault on behind the tightened gate.

**Architecture:** Every salary path in podiumops funnels through one helper, `canComp()`. We change it from `isAdmin || podium_comp` to allow-list membership (`podium.comp_access`), add a parameter-less `getMyCompensation` self path, log cross-person reads to `podium.comp_access_log`, and gate allow-list management to `super_admin` (exactly Afshaan + Vinay). The CTC columns are already populated + already readable by today's comp-holders, so the vault flip is the LAST step, done only after a live assurance pass.

**Tech Stack:** Cloudflare Worker (`podiumops`, vanilla JS, no unit-test harness — verification is `node --check` + `wrangler deploy` + live curl/SQL/browser), Supabase Postgres (`podium` + `store` schemas, migrations via MCP `apply_migration`), Next.js static-export app (`apps/podium`, verified with `npx turbo build --filter=podium`).

**Project:** `jkxcnjabmrkteanzoofj` (Supabase `lot-production`). Worker source: `05_Throttle/podiumops-worker/src/index.js`. App: `05_Throttle/apps/podium`. Deploy worker: `cd 05_Throttle/podiumops-worker && npx wrangler deploy`. Spec: `docs/superpowers/specs/2026-07-06-podium-salary-vault-design.md`.

**Note on TDD:** This worker has no local test runner. "Failing test → implement → passing test" is replaced by: `node --check` (syntax), targeted SQL assertions, `turbo build`, and a live browser assurance pass (Task 12) that needs real Google logins. Keep commits frequent (one per task).

---

## Phase A — Database

### Task 1: `comp_access` allow-list table + seed the 4

**Files:**
- Migration (via MCP `apply_migration`, name `podium_comp_access_v1`)

- [ ] **Step 1: Apply the migration**

Use MCP `apply_migration` with project `jkxcnjabmrkteanzoofj`, name `podium_comp_access_v1`:

```sql
CREATE TABLE IF NOT EXISTS podium.comp_access (
  auth_user_id  uuid PRIMARY KEY,
  full_name     text,
  added_by      uuid,
  added_at      timestamptz NOT NULL DEFAULT now(),
  note          text
);
ALTER TABLE podium.comp_access ENABLE ROW LEVEL SECURITY;
GRANT ALL ON podium.comp_access TO service_role;
REVOKE ALL ON podium.comp_access FROM anon, authenticated;

-- Seed the current salary-visibility group (id-agnostic: match by work email).
INSERT INTO podium.comp_access (auth_user_id, full_name, note)
SELECT up.id, up.full_name, 'seed: initial comp group (2026-07-06)'
FROM store.users_profile up
JOIN auth.users au ON au.id = up.id
WHERE lower(au.email) IN (
  'afshaan@legendoftoys.com','vinay@legendoftoys.com',
  'mohit@legendoftoys.com','priya@legendoftoys.com'
)
ON CONFLICT (auth_user_id) DO NOTHING;
```

- [ ] **Step 2: Verify the seed = exactly 4, and RLS is on**

Use MCP `execute_sql`:

```sql
SELECT
  (SELECT count(*) FROM podium.comp_access) AS members,
  (SELECT count(*) FROM podium.comp_access ca
     JOIN auth.users au ON au.id = ca.auth_user_id
     WHERE lower(au.email) IN ('afshaan@legendoftoys.com','vinay@legendoftoys.com','mohit@legendoftoys.com','priya@legendoftoys.com')) AS matched,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'podium.comp_access'::regclass) AS rls_on;
```
Expected: `members=4, matched=4, rls_on=true`.

- [ ] **Step 3: Commit (migration is already persisted server-side; record it locally)**

No repo file changes for the migration itself. Proceed — the migration is committed in Supabase's migration history. (If the executor keeps a local migrations mirror, add it there and commit.)

---

### Task 2: `comp_access_log` append-only audit table

**Files:**
- Migration (via MCP `apply_migration`, name `podium_comp_access_log_v1`)

- [ ] **Step 1: Apply the migration**

```sql
CREATE TABLE IF NOT EXISTS podium.comp_access_log (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viewer_user_id      uuid NOT NULL,
  viewer_name         text,
  action              text NOT NULL,
  subject_employee_id uuid,
  subject_label       text,
  detail              jsonb,
  at                  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE podium.comp_access_log ENABLE ROW LEVEL SECURITY;
GRANT ALL ON podium.comp_access_log TO service_role;
REVOKE ALL ON podium.comp_access_log FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS comp_access_log_at_idx ON podium.comp_access_log (at DESC);
```

- [ ] **Step 2: Verify the table exists + a round-trip insert works**

```sql
INSERT INTO podium.comp_access_log (viewer_user_id, viewer_name, action, subject_label)
VALUES ('00000000-0000-0000-0000-000000000000', 'migration smoke', 'smoke_test', 'n/a');
SELECT count(*) AS rows FROM podium.comp_access_log WHERE action='smoke_test';
DELETE FROM podium.comp_access_log WHERE action='smoke_test';
```
Expected: insert succeeds, `rows=1`, delete succeeds.

---

### Task 3: Retire `podium_comp` from the role layer

**Files:**
- Migration (via MCP `apply_migration`, name `podium_retire_comp_key_v1`)

- [ ] **Step 1: Confirm the `comp` preset role has zero users (safety)**

```sql
SELECT (SELECT count(*) FROM store.podium_user_roles WHERE role_key='comp') AS comp_users,
       (SELECT count(*) FROM store.podium_roles WHERE permissions ? 'podium_comp') AS roles_with_key;
```
Expected: `comp_users=0`. If `comp_users>0`, STOP and surface — do not delete a role with users.

- [ ] **Step 2: Apply the migration**

```sql
-- Delete the now-meaningless 'comp' preset role (0 users; podium_comp is retired).
DELETE FROM store.podium_roles WHERE role_key='comp' AND is_system=false;
-- Strip the dead podium_comp key from every role's permissions (idempotent).
UPDATE store.podium_roles
SET permissions = permissions - 'podium_comp'
WHERE permissions ? 'podium_comp';
```

- [ ] **Step 3: Verify**

```sql
SELECT (SELECT count(*) FROM store.podium_roles WHERE role_key='comp') AS comp_role_left,
       (SELECT count(*) FROM store.podium_roles WHERE permissions ? 'podium_comp') AS roles_with_key;
```
Expected: `comp_role_left=0, roles_with_key=0`.

---

## Phase B — Worker gate rebuild (`05_Throttle/podiumops-worker/src/index.js`)

### Task 4: allow-list gate — `verifyJWT`, `canComp`, `requireSuperAdmin`, retire key

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`

- [ ] **Step 1: Resolve `compAccess` + `isSuperAdmin` in `verifyJWT`**

Find the block that resolves `permissions` (ends at the `return {` around line 138-140). Insert the allow-list lookup immediately BEFORE `return {`:

```js
  // Salary access is an explicit allow-list (podium.comp_access), decoupled from
  // admin/hr (RULE-PODIUM-002, amended 2026-07-06). Resolved once per request.
  const caRes = await sb(
    `/rest/v1/comp_access?auth_user_id=eq.${user.id}&select=auth_user_id&limit=1`,
    env,
  );
  const compAccess = !!(caRes.ok && caRes.data?.[0]);

  return {
```

Then add two fields inside the returned object (next to `permissions,`):

```js
    permissions,
    compAccess,
    isSuperAdmin: profile.role === 'super_admin',
    bearer: token,
```

- [ ] **Step 2: Make `canComp` allow-list-only + add `requireSuperAdmin`**

Replace:
```js
function canComp(auth) { return isAdmin(auth) || hasPerm(auth, 'podium_comp'); }
```
with:
```js
// Salary access = explicit allow-list membership only (auth.compAccess from verifyJWT).
// NOT implied by podium_admin/podium_hr. RULE-PODIUM-002 (amended 2026-07-06).
function canComp(auth) { return auth?.compAccess === true; }
```

Replace:
```js
function requireAdmin(auth) { return isAdmin(auth) ? null : err('Forbidden — requires podium_admin', 403); }
```
with:
```js
function requireAdmin(auth) { return isAdmin(auth) ? null : err('Forbidden — requires podium_admin', 403); }
function requireSuperAdmin(auth) { return auth?.isSuperAdmin ? null : err('Forbidden — requires super_admin', 403); }
```

- [ ] **Step 3: Retire `podium_comp` from the perm-key set**

Replace:
```js
const PODIUM_PERM_KEYS = ['podium_view', 'podium_hr', 'podium_comp', 'podium_admin'];
```
with:
```js
const PODIUM_PERM_KEYS = ['podium_view', 'podium_hr', 'podium_admin'];
```

Replace:
```js
  if (out.podium_hr || out.podium_comp || out.podium_admin) out.podium_view = true;
```
with:
```js
  if (out.podium_hr || out.podium_admin) out.podium_view = true;
```

- [ ] **Step 4: Add `super_admin` to the `getMe` tier**

Replace:
```js
    tier: { admin: isAdmin(auth), hr: isHr(auth), comp: canComp(auth) },
```
with:
```js
    tier: { admin: isAdmin(auth), hr: isHr(auth), comp: canComp(auth), super_admin: !!auth.isSuperAdmin },
```

- [ ] **Step 5: Syntax check**

Run: `node --check 05_Throttle/podiumops-worker/src/index.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js && git commit -m "podium: allow-list salary gate (canComp = comp_access membership); retire podium_comp key"
```

---

### Task 5: audit-log helper + wire into cross-person reads

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`

- [ ] **Step 1: Add `logCompAccess` helper**

Insert immediately ABOVE `async function getCompensation(` (the comment line `// Compensation — gated on podium_comp.`):

```js
// Append-only audit of CROSS-PERSON salary reads. Self-views of one's own pay are
// not a leak and are not logged. Best-effort: a failed insert must never block a read.
async function logCompAccess(auth, action, subjectEmployeeId, subjectLabel, env, detail) {
  try {
    await sb(`/rest/v1/comp_access_log`, env, {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify([{
        viewer_user_id: auth.userId,
        viewer_name: auth.fullName || null,
        action,
        subject_employee_id: subjectEmployeeId || null,
        subject_label: subjectLabel || null,
        detail: detail || null,
      }]),
    });
  } catch (_e) { /* best-effort audit; never block the read */ }
}
```

- [ ] **Step 2: Update the stale `getCompensation` comment + log the read**

Replace:
```js
// Compensation — gated on podium_comp. Returns the per-employee event log + the
// current CTC (latest non-bonus new_ctc; null while the vault is disabled).
async function getCompensation(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
```
with:
```js
// Compensation — CROSS-PERSON read, allow-list-gated (canComp = comp_access member).
// The ONLY path that returns another person's pay. Returns the per-employee event
// log + current CTC (latest non-bonus new_ctc). Every read is audited.
async function getCompensation(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  await logCompAccess(auth, 'getCompensation', employee_id, null, env);
```

- [ ] **Step 3: Log the factory-workforce read (carries per-operator CTC)**

Replace:
```js
async function getFactoryWorkforce(url, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const ops   = (await sbPublicGet(`/rest/v1/operators?select=id,employee_id,name,department,status&status=eq.active&order=department,name`, env)).data || [];
```
with:
```js
async function getFactoryWorkforce(url, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  await logCompAccess(auth, 'getFactoryWorkforce', null, 'all factory operators', env);
  const ops   = (await sbPublicGet(`/rest/v1/operators?select=id,employee_id,name,department,status&status=eq.active&order=department,name`, env)).data || [];
```

- [ ] **Step 4: Syntax check**

Run: `node --check 05_Throttle/podiumops-worker/src/index.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js && git commit -m "podium: audit-log helper; log cross-person salary reads (getCompensation, factory workforce)"
```

---

### Task 6: `getMyCompensation` — parameter-less self view

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`

- [ ] **Step 1: Add the handler**

Insert immediately BELOW the end of `getCompensation` (after its closing `}` and before the `// Documents —` comment):

```js
// SELF-ONLY comp view. Takes NO employee-id parameter — a caller can structurally
// only ever see their OWN compensation (resolved from the JWT via callerEmployee).
// Reachable by the self-only baseline (SELF_SERVE_GET). Self-views are not audited.
async function getMyCompensation(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, events: [], current_ctc: null });
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=eq.${me.id}&select=*&order=effective_date.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const events = r.data || [];
  const latestCtc = events.find(e => e.event_type !== 'one_time_bonus' && e.new_ctc != null);
  return ok({ employee_id: me.id, events, current_ctc: latestCtc ? Number(latestCtc.new_ctc) : null });
}
```

- [ ] **Step 2: Register in `GET_ACTIONS`**

Replace:
```js
  getCompensation,
  getDocuments, getDocumentDownloadUrl,
```
with:
```js
  getCompensation, getMyCompensation,
  getDocuments, getDocumentDownloadUrl,
```

- [ ] **Step 3: Register in `SELF_SERVE_GET`**

Replace:
```js
  'getEmployee', 'getMyPerformance', 'getAccomplishments', 'getObservations', 'getOneOnOnes',
```
with:
```js
  'getEmployee', 'getMyPerformance', 'getAccomplishments', 'getObservations', 'getOneOnOnes',
  // Own-salary view — parameter-less, self-scoped by callerEmployee.
  'getMyCompensation',
```

- [ ] **Step 4: Syntax check**

Run: `node --check 05_Throttle/podiumops-worker/src/index.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js && git commit -m "podium: getMyCompensation self-view (own pay only, no employee-id param)"
```

---

### Task 7: allow-list admin actions (super_admin only)

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`

- [ ] **Step 1: Add the four handlers**

Insert immediately ABOVE `const GET_ACTIONS = {`:

```js
// ── Salary-access allow-list (super_admin only: exactly Afshaan + Vinay) ──────
// Controls who is in podium.comp_access, i.e. who can see EVERYONE's salary.
// Edit-right derives from store.users_profile.role='super_admin', never from
// comp_access membership, so a super_admin can't lock themselves out.
async function getCompAccess(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const r = await sb(`/rest/v1/comp_access?select=*&order=added_at.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ members: r.data || [] });
}

async function addCompAccess(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.auth_user_id) return err('auth_user_id required', 400);
  const prof = await sbStore(`/rest/v1/users_profile?id=eq.${encodeURIComponent(d.auth_user_id)}&select=full_name&limit=1`, env);
  const fullName = (prof.ok && prof.data?.[0]?.full_name) || d.full_name || null;
  const r = await sb(`/rest/v1/comp_access?on_conflict=auth_user_id`, env, {
    method: 'POST', prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ auth_user_id: d.auth_user_id, full_name: fullName, added_by: auth.userId, note: d.note || null }),
  });
  if (!r.ok) return err('add_failed: ' + JSON.stringify(r.data), 400);
  await logCompAccess(auth, 'addCompAccess', null, fullName, env, { added: d.auth_user_id });
  return ok({ auth_user_id: d.auth_user_id, full_name: fullName });
}

async function removeCompAccess(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.auth_user_id) return err('auth_user_id required', 400);
  const r = await sb(`/rest/v1/comp_access?auth_user_id=eq.${encodeURIComponent(d.auth_user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('remove_failed', 400);
  await logCompAccess(auth, 'removeCompAccess', null, d.full_name || null, env, { removed: d.auth_user_id });
  return ok({ removed: d.auth_user_id });
}

async function getCompAccessLog(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
  const r = await sb(`/rest/v1/comp_access_log?select=*&order=at.desc&limit=${limit}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ log: r.data || [] });
}
```

- [ ] **Step 2: Register the GET actions**

Replace (in `GET_ACTIONS`):
```js
  // Permission layer (Podium-managed)
  getPodiumRoles, getPodiumUsers,
```
with:
```js
  // Permission layer (Podium-managed)
  getPodiumRoles, getPodiumUsers,
  // Salary-access allow-list (super_admin)
  getCompAccess, getCompAccessLog,
```

- [ ] **Step 3: Register the POST actions**

Replace (in `POST_ACTIONS`):
```js
  // Permission layer (Podium-managed)
  createPodiumRole, updatePodiumRole, deletePodiumRole, assignPodiumRole,
```
with:
```js
  // Permission layer (Podium-managed)
  createPodiumRole, updatePodiumRole, deletePodiumRole, assignPodiumRole,
  // Salary-access allow-list (super_admin)
  addCompAccess, removeCompAccess,
```

- [ ] **Step 4: Add to self-serve sets (internally super_admin-gated, so robust even if the caller lacks podium_view)**

Replace:
```js
const SELF_SERVE_GET = new Set([
  'getMe', 'getPodiumRoles',
```
with:
```js
const SELF_SERVE_GET = new Set([
  'getMe', 'getPodiumRoles',
  // Salary-access admin — internally super_admin-gated.
  'getCompAccess', 'getCompAccessLog',
```

Replace:
```js
const SELF_SERVE_POST = new Set([
  'createAccomplishment', 'updateAccomplishment', 'deleteAccomplishment',
```
with:
```js
const SELF_SERVE_POST = new Set([
  'createAccomplishment', 'updateAccomplishment', 'deleteAccomplishment',
  // Salary-access admin — internally super_admin-gated.
  'addCompAccess', 'removeCompAccess',
```

- [ ] **Step 5: Syntax check**

Run: `node --check 05_Throttle/podiumops-worker/src/index.js`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js && git commit -m "podium: super_admin-only salary-access allow-list admin (get/add/remove/log)"
```

---

### Task 8: deploy worker + unauthenticated smoke

**Files:** none (deploy only)

- [ ] **Step 1: Push then deploy**

```bash
cd 05_Throttle && git push
cd 05_Throttle/podiumops-worker && npx wrangler deploy
```
Expected: deploy succeeds, prints a version id.

- [ ] **Step 2: Unauthenticated smoke (all that's CLI-doable without a user JWT)**

```bash
curl -s "https://podiumops.afshaan.workers.dev/?action=ping"
curl -s -o /dev/null -w "%{http_code}\n" "https://podiumops.afshaan.workers.dev/?action=getCompensation&employee_id=00000000-0000-0000-0000-000000000000"
```
Expected: first returns `{"ok":true,"data":{"pong":true}}`; second returns `401` (no token → unauthorized, before any gate). Deeper auth checks are the live assurance pass (Task 12).

---

## Phase C — App (`05_Throttle/apps/podium`)

### Task 9: employee self-view — "My compensation" on `/me`

**Files:**
- Create: `05_Throttle/apps/podium/src/components/MyCompensation.js`
- Modify: `05_Throttle/apps/podium/src/app/(auth)/me/page.js`

- [ ] **Step 1: Create the self-contained component**

Create `05_Throttle/apps/podium/src/components/MyCompensation.js`:

```js
'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Lock } from 'lucide-react';
import { podiumopsGet } from '../lib/podiumopsFetch.js';

// Own-salary view. Calls getMyCompensation (parameter-less, self-scoped in the worker),
// so it can never show anyone else's pay. Renders nothing until loaded; hidden if the
// employee has no recorded compensation.
export default function MyCompensation() {
  const { session } = useAuth();
  const [d, setD] = useState(null);

  useEffect(() => {
    if (session) podiumopsGet('getMyCompensation', {}, session).then(setD).catch(() => setD(false));
  }, [session]);

  if (!d || d === false) return null;
  if (!d.events?.length && d.current_ctc == null) return null;

  const fmt = (n) => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN');
  return (
    <div style={card}>
      <div style={cardTitle}><Lock size={14} /> My Compensation</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--t3)' }}>Current CTC</span>
        <span className="num" style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>{fmt(d.current_ctc)}</span>
      </div>
      {d.events?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {d.events.map((e) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--t2)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <span>{e.event_type}{e.effective_date ? ' · ' + e.effective_date : ''}</span>
              <span className="num">{e.increment_pct != null ? '+' + e.increment_pct + '%' : ''} {e.new_ctc != null ? fmt(e.new_ctc) : (e.amount != null ? fmt(e.amount) : '')}</span>
            </div>
          ))}
        </div>
      )}
      <p style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10 }}>Only you and authorised Finance can see this. Nobody else can view your salary.</p>
    </div>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px', marginTop: 14 };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
```

- [ ] **Step 2: Mount it in the `/me` page**

Open `05_Throttle/apps/podium/src/app/(auth)/me/page.js`. Add the import near the other imports at the top:

```js
import MyCompensation from '../../../components/MyCompensation.js';
```
(Adjust the relative depth if the executor finds the file nests differently — the target is `src/components/MyCompensation.js`.)

Then render `<MyCompensation />` inside the page's main content container, after the existing performance/wins sections (place it as the last block in the top-level returned fragment/div).

- [ ] **Step 3: Build**

Run: `cd 05_Throttle && npx turbo build --filter=podium`
Expected: build completes with zero errors.

- [ ] **Step 4: Commit**

```bash
cd 05_Throttle && git add apps/podium/src/components/MyCompensation.js "apps/podium/src/app/(auth)/me/page.js" && git commit -m "podium: My Compensation self-view on /me (own pay only)"
```

---

### Task 10: "Salary access" admin card on `/admin/settings`

**Files:**
- Modify: `05_Throttle/apps/podium/src/app/(auth)/admin/settings/page.js`

- [ ] **Step 1: Import the new component + add super-admin card**

At the top of `settings/page.js`, add to the `lucide-react` import: `Users` and `ScrollText`. Add an import for the new card:

```js
import CompAccessCard from '../../../../components/CompAccessCard.js';
```

Inside the returned JSX, add `<CompAccessCard session={session} />` immediately after the `{/* Salary Vault (persisted) */}` card block (before Appraisals). The card self-hides for non-super-admins (it renders nothing if `getCompAccess` 403s), so no `perms` gating is needed here.

- [ ] **Step 2: Update the two stale copy blocks in this page**

Replace the Salary Vault `<p>` copy:
```js
        <p style={p}>
          When OFF (default for v1), Podium records increment % and one-time bonus amounts only — absolute
          base-salary / CTC figures are never stored. Turn this ON <strong>only after</strong> the Phase&nbsp;5
          security hardening (Cloudflare Access SSO in front of the site and worker) is live.
        </p>
```
with:
```js
        <p style={p}>
          When OFF, Podium records increment % and one-time bonus amounts only. When ON, absolute CTC is
          stored and shown <strong>only</strong> to the salary-access allow-list below (managed by super-admins).
          Every cross-person salary view is logged.
        </p>
```

Replace the Permissions `<p>` copy that lists `podium_comp`:
```js
          Podium runs its <strong>own</strong> permission layer (<code className="num">podium_view</code>, <code className="num">podium_hr</code>,
          <code className="num"> podium_comp</code>, <code className="num">podium_admin</code>) — managed here in Podium, not in Garage. Define
          custom roles on <strong>Permissions</strong>, then assign them to people on <strong>Users</strong>.
          Anyone with no assigned role gets self-only access.
```
with:
```js
          Podium runs its <strong>own</strong> permission layer (<code className="num">podium_view</code>, <code className="num">podium_hr</code>,
          <code className="num"> podium_admin</code>) — managed here in Podium, not in Garage. Define
          custom roles on <strong>Permissions</strong>, then assign them to people on <strong>Users</strong>.
          Anyone with no assigned role gets self-only access. <strong>Salary access is separate</strong> — an
          explicit allow-list controlled by super-admins (above), not a role key.
```

- [ ] **Step 2b: Create `CompAccessCard.js`**

Create `05_Throttle/apps/podium/src/components/CompAccessCard.js`:

```js
'use client';
import { useEffect, useState } from 'react';
import { KeyRound, X, Plus, ScrollText } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';

// Super-admin-only salary-access allow-list manager. Renders NOTHING for non-super-admins
// (the worker 403s getCompAccess → we hide the whole card). Lets Afshaan/Vinay see and edit
// who can view everyone's salary, and peek the access log.
export default function CompAccessCard({ session }) {
  const [members, setMembers] = useState(null); // null=loading, false=forbidden/hidden
  const [users, setUsers] = useState([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(null);

  async function load() {
    try {
      const r = await podiumopsGet('getCompAccess', {}, session);
      setMembers(r.members || []);
      const u = await podiumopsGet('getPodiumUsers', {}, session).catch(() => []);
      setUsers(Array.isArray(u) ? u : []);
    } catch { setMembers(false); }
  }
  useEffect(() => { if (session) load(); }, [session]);

  if (members === false || members === null) return null;

  const memberIds = new Set(members.map((m) => m.auth_user_id));
  const candidates = users.filter((u) => !memberIds.has(u.id) && u.active);

  async function add() {
    if (!pick) return;
    setBusy(true);
    try { await podiumopsPost('addCompAccess', { auth_user_id: pick }, session); setPick(''); await load(); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    setBusy(true);
    try { await podiumopsPost('removeCompAccess', { auth_user_id: id }, session); await load(); }
    finally { setBusy(false); }
  }
  async function toggleLog() {
    if (log) { setLog(null); return; }
    const r = await podiumopsGet('getCompAccessLog', { limit: 100 }, session).catch(() => ({ log: [] }));
    setLog(r.log || []);
  }

  return (
    <div style={card}>
      <div style={cardTitle}><KeyRound size={14} /> Salary Access (super-admins only)</div>
      <p style={p}>These people can see <strong>everyone's</strong> salary. Only super-admins can change this list.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {members.map((m) => (
          <div key={m.auth_user_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13.5, color: 'var(--t1)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span>{m.full_name || m.auth_user_id}</span>
            <button onClick={() => remove(m.auth_user_id)} disabled={busy} title="Remove" style={iconBtn}><X size={14} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}
          className="pd-input" style={{ flex: 1, background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 13 }}>
          <option value="">Add a person…</option>
          {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.email ? ' · ' + u.email : ''}</option>)}
        </select>
        <button onClick={add} disabled={busy || !pick} style={addBtn}><Plus size={14} /> Add</button>
      </div>
      <button onClick={toggleLog} style={{ ...link, marginTop: 12, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <ScrollText size={13} /> {log ? 'Hide' : 'View'} access log
      </button>
      {log && (
        <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', fontSize: 12, color: 'var(--t2)' }}>
          {log.length === 0 ? <span style={{ color: 'var(--t3)' }}>No access logged yet.</span> : log.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', padding: '5px 0' }}>
              <span>{r.viewer_name || r.viewer_user_id} · {r.action}{r.subject_label ? ' → ' + r.subject_label : ''}</span>
              <span className="num" style={{ color: 'var(--t3)' }}>{(r.at || '').replace('T', ' ').slice(0, 16)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px' };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
const p = { fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 };
const link = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--yellow)', fontSize: 13 };
const iconBtn = { background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--t3)', cursor: 'pointer', padding: 4, display: 'inline-flex' };
const addBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1a1a1a', border: 'none', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
```

- [ ] **Step 3: Build**

Run: `cd 05_Throttle && npx turbo build --filter=podium`
Expected: zero errors. (The `Users`/`ScrollText` import added in Step 1 must be present; if `Users` ends up unused, drop it to keep the build clean.)

- [ ] **Step 4: Commit + push (auto-deploys the app)**

```bash
cd 05_Throttle && git add apps/podium/src/components/CompAccessCard.js "apps/podium/src/app/(auth)/admin/settings/page.js" && git commit -m "podium: salary-access allow-list admin card (super-admin) + settings copy update" && git push
```

---

## Phase D — Live assurance, vault flip, knowledge

### Task 11: live assurance pass (§9 of the spec) — needs real Google logins

**Files:** none (manual/browser verification, done with Afshaan)

- [ ] **Step 1: Wait for the app deploy** (GitHub Actions ~3–4 min after the Task 10 push). Confirm `podium.legendoftoys.com` serves the new build.

- [ ] **Step 2: Walk the checklist in-browser with real accounts.** Record pass/fail for each:
  - A comp-group member (e.g. Afshaan/Vinay) opens any profile → sees CTC; `/admin/settings` shows the Salary Access card + can add/remove + view log.
  - Mohit / Priya (in the group) → can see salaries (they're Finance/leadership per Afshaan).
  - A NON-member with `podium_view` (e.g. the `jarvis_ro` user, or any admin removed from the list in a test) → opening a profile shows NO comp; `getCompensation` returns 403; `/admin/settings` shows NO Salary Access card.
  - A self-only user → `/me` shows "My Compensation" with THEIR figure only; they have no way to query another id.
  - After a couple of profile views by a member, the access log shows the rows.

- [ ] **Step 3: Confirm the audit log is populating**

Use MCP `execute_sql`:
```sql
SELECT action, count(*) FROM podium.comp_access_log GROUP BY action ORDER BY 2 DESC;
```
Expected: rows for `getCompensation` / `getFactoryWorkforce` accumulating from the browser walk.

If any check fails, STOP — do not proceed to the vault flip; fix and re-verify.

---

### Task 12: flip the vault on

**Files:** none (settings flip)

- [ ] **Step 1: Only after Task 11 fully passes**, enable the vault.

Use MCP `execute_sql`:
```sql
UPDATE podium.settings SET comp_vault_enabled = true WHERE id = 1;
SELECT comp_vault_enabled FROM podium.settings WHERE id = 1;
```
Expected: `comp_vault_enabled = true`.

- [ ] **Step 2: Confirm writes now persist CTC** — via the Podium UI (a comp-group member adds a test compensation event with a CTC), or defer to the real-data feed (Task 14, separate). Verify the UI Salary Vault toggle now reads "Enabled".

---

### Task 13: knowledge + rule updates

**Files:**
- Modify: `systems/podium.md`, `BUSINESS_RULES.md` reference is in the spoke (RULE-PODIUM-002 text lives in `systems/podium.md` §"Business rules")
- Modify: memory (`memory/` + `MEMORY.md`)

- [ ] **Step 1: Amend RULE-PODIUM-002 in `systems/podium.md`** — record that the vault is now ENABLED, gated by the `podium.comp_access` allow-list (decoupled from admin/hr), `podium_comp` key retired, super_admin-managed, cross-person reads audited, and that Cloudflare Access remains a recommended future defense-in-depth (not a blocker). Update the "Security posture" + "Permission tiers" sections and the Phase 5 roadmap row.

- [ ] **Step 2: Update the podiumops "Worker actions" list** in `systems/podium.md` — add `getMyCompensation`, `getCompAccess`, `getCompAccessLog`, `addCompAccess`, `removeCompAccess`; note `canComp` is allow-list-only.

- [ ] **Step 3: Write a memory** (`project_podium_salary_vault.md`) capturing: allow-list gate model, the 4-member group, super_admin-controls-membership, self-view guarantee, audit log, vault now on. Add the one-line pointer to `MEMORY.md`. Link `[[project_supabase_memory_bound_upgrade]]` only if relevant; link `[[feedback_verify_and_phase_sensitive]]`.

- [ ] **Step 4: Commit knowledge** (the brain-sync hook auto-commits `memory/` + spine; still commit the spoke explicitly if the hook is scoped):
```bash
cd /Users/afshaansiddiqui/Documents/Claude && git add systems/podium.md && git commit -m "podium: salary vault live — allow-list gate, self-view, audit log (RULE-PODIUM-002 amended)" && git push
```

---

## Out of scope (follow-on, when Afshaan provides the data)

**Real-salary data feed (spec §10)** is a separate work item executed after this gate ships and passes assurance. When Afshaan hands over the mixed-format data: parse → normalize `(EMP code, new_ctc, components, effective_from)` → review sheet for name-matching + magnitude sanity (the Chiragh extra-zero class) → snapshot the existing 29 `compensation_events` → reconcile (update stale / insert new) → load via a super_admin-gated bulk action or snapshotted SQL. No real salary values in chat; work in aggregates + the review artifact.

---

## Self-review notes (author)

- **Spec coverage:** §3 access model → Tasks 1,4,7 (+3 retires the key). §4 self-view → Task 6,9. §5 audit → Tasks 2,5,7. §6 factory pay → inherits Task 4 gate; read logged in Task 5. §7 ordering → Tasks enforce migrations→worker→app→assurance→flip. §8 deviation → Task 13. §9 checklist → Task 11. §10 data feed → Out of scope block. §11 components → Tasks map 1:1. §12 rollout order → Phase ordering.
- **Type consistency:** `canComp(auth)` reads `auth.compAccess` (boolean set in `verifyJWT`, Task 4); `requireSuperAdmin` reads `auth.isSuperAdmin` (Task 4); `logCompAccess(auth, action, subjectEmployeeId, subjectLabel, env, detail)` signature used identically in Tasks 5 & 7; app calls `podiumopsGet/Post` with the exact action names registered in Tasks 6 & 7.
- **No placeholders:** every code + SQL + command step is concrete.
