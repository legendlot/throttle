# Manifest Access Control + Permissions Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This codebase has NO unit-test harness for the worker/SPA — verification is build-green + SQL checks + authenticated smoke (the established LOT pattern), so steps verify that way, not via TDD test files.

**Goal:** Lock Manifest access by default with a visible Unauthorized wall, and give super admins (Afshaan + appointees) in-app Access Control + a Permissions Builder, governed by a new `manifest_super_admin` tier above operational `manifest_admin`.

**Architecture:** Additive migration (`active` flag on `manifest_user_roles` + `manifest_super_admin` on the `admin` role). Worker gains `canSuperAdmin`, re-gates governance handlers, honors `active` in `verifyJWT`, and adds `deleteRole`/`setUserActive`/`grantAccess` with server-side last-super-admin/self/system-role/SF-key guards. The SPA `Admin` screen becomes 3 tabs (Access Control · Roles · Operations); `ManifestApp` renders a full-screen wall on a 401.

**Tech Stack:** Cloudflare Worker (`manifestops`, vanilla JS + PostgREST via service role), Next.js static-export SPA (`apps/manifest/src/mf/`), Supabase Postgres (`manifest` + `store` schemas).

Spec: `docs/superpowers/specs/2026-06-18-manifest-access-control-design.md`.

---

### Task 1: Migration `manifest_access_control_v1`

**Files:** Supabase migration (via `apply_migration`).

- [ ] **Step 1: Apply migration**

```sql
-- manifest_access_control_v1
ALTER TABLE manifest.manifest_user_roles
  ADD COLUMN IF NOT EXISTS active      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_by uuid;

UPDATE manifest.manifest_roles
   SET permissions = permissions || '{"manifest_super_admin": true}'::jsonb
 WHERE role_key = 'admin';
```

- [ ] **Step 2: Verify** — `active` exists & true on all rows; `admin` role carries the key.

```sql
SELECT (SELECT count(*) FROM manifest.manifest_user_roles WHERE active) AS active_rows,
       (SELECT count(*) FROM manifest.manifest_user_roles) AS total_rows,
       (SELECT permissions->>'manifest_super_admin' FROM manifest.manifest_roles WHERE role_key='admin') AS admin_super;
```
Expected: `active_rows = total_rows`, `admin_super = 'true'`. Advisors clean.

---

### Task 2: Worker — `canSuperAdmin`, active-aware `verifyJWT`, re-gate governance

**Files:** Modify `manifestops-worker/src/index.js`.

- [ ] **Step 1: Add helper** after `const canAdmin = p => !!p.manifest_admin;` (~line 39):

```js
const canSuperAdmin      = p => !!p.manifest_super_admin;   // governs access + roles (Afshaan/Vinay)
```

- [ ] **Step 2: Make `verifyJWT` honor `active`** — in `getManifestRole`, add `&active=is.true` to the user-role lookup:

```js
const ur = await sb(`/rest/v1/manifest_user_roles?user_id=eq.${userId}&active=is.true&select=role_key&limit=1`);
```

- [ ] **Step 3: Re-gate governance GET handlers** — change `if (!canAdmin(P))` → `if (!canSuperAdmin(P))` in `getRoles` (~748) and `getUsers` (~754).

- [ ] **Step 4: Re-gate governance POST handlers** — change `if (!canAdmin(P))` → `if (!canSuperAdmin(P))` in `saveRole` (~1510), `setUserRole` (~1523), `onboardSfUser` (~1537). Leave Operations handlers (shipment defaults, `createForwarder`) on `canAdmin`.

- [ ] **Step 5: Verify build** — `cd manifestops-worker && npx wrangler deploy --dry-run` (or defer deploy to Task 4). Expected: bundles with no syntax error.

---

### Task 3: Worker — guards + new handlers (`deleteRole`, `setUserActive`, `grantAccess`) + `saveRole` hardening

**Files:** Modify `manifestops-worker/src/index.js`.

- [ ] **Step 1: Add a super-admin-count helper** near the other helpers (module scope):

```js
// Count users whose ACTIVE role carries manifest_super_admin. Used by last-super-admin guards.
async function activeSuperAdminUserIds() {
  const rolesR = await sb('/rest/v1/manifest_roles?select=role_key,permissions');
  const superKeys = new Set((rolesR.ok ? rolesR.data : [])
    .filter(r => r.permissions && r.permissions.manifest_super_admin)
    .map(r => r.role_key));
  if (!superKeys.size) return [];
  const urR = await sb('/rest/v1/manifest_user_roles?active=is.true&select=user_id,role_key');
  return (urR.ok ? urR.data : []).filter(u => superKeys.has(u.role_key)).map(u => u.user_id);
}
```

- [ ] **Step 2: Harden `saveRole`** — replace its body (keep the `canSuperAdmin` gate from Task 2) with:

```js
case 'saveRole': {
  if (!canSuperAdmin(P)) return err('No permission', 403);
  if (!d.role_key) return err('role_key required');
  // System roles are view-only.
  const existR = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system,party&limit=1`);
  const exist = existR.ok && existR.data[0] ? existR.data[0] : null;
  if (exist && exist.is_system) return err('System roles are locked', 403);
  // Party is immutable after create.
  const party = exist ? exist.party : (d.party === 'SF' ? 'SF' : 'LOT');
  let permissions = { ...(d.permissions || {}) };
  // SF roles may hold ONLY the SF key set + manifest_view — strip LOT-only keys.
  if (party === 'SF') {
    const SF_ALLOWED = new Set(['manifest_view','sf_order_update','sf_evidence_upload','sf_drawdown_raise','sf_vendor_payment_record','sf_running_account_view','sf_po_manage','sf_invoice_create']);
    permissions = Object.fromEntries(Object.entries(permissions).filter(([k,v]) => v && SF_ALLOWED.has(k)));
  }
  // Guard: don't strip the last super admin's governance via a role edit.
  if (exist && exist.is_system === false && !permissions.manifest_super_admin) {
    const supers = await activeSuperAdminUserIds();
    const holders = await sb(`/rest/v1/manifest_user_roles?role_key=eq.${encodeURIComponent(d.role_key)}&active=is.true&select=user_id`);
    const heldBy = new Set((holders.ok ? holders.data : []).map(u => u.user_id));
    if (supers.length && supers.every(id => heldBy.has(id))) return err('Would remove the last super admin', 409);
  }
  const row = { role_key: d.role_key, label: d.label || d.role_key, description: d.description || null, party, permissions };
  const r = await sb('/rest/v1/manifest_roles', { method: 'POST', body: JSON.stringify(row), prefer: 'return=representation,resolution=merge-duplicates' });
  if (!r.ok) return err('Role save failed: ' + JSON.stringify(r.data), 502);
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}
```

- [ ] **Step 3: Add `deleteRole`** (new case in the POST switch, after `saveRole`):

```js
case 'deleteRole': {
  if (!canSuperAdmin(P)) return err('No permission', 403);
  if (!d.role_key) return err('role_key required');
  const exR = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`);
  if (!exR.ok || !exR.data[0]) return err('Role not found', 404);
  if (exR.data[0].is_system) return err('System roles cannot be deleted', 403);
  const inUse = await sb(`/rest/v1/manifest_user_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=user_id`);
  if (inUse.ok && inUse.data.length) return err(`Role is assigned to ${inUse.data.length} user(s) — reassign them first`, 409);
  const r = await del('manifest_roles', `role_key=eq.${encodeURIComponent(d.role_key)}`);
  if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
  await logActivity(auth, 'role_deleted', { detail: d.role_key });
  return ok({ role_key: d.role_key, deleted: true });
}
```

- [ ] **Step 4: Add `setUserActive`** (new case):

```js
case 'setUserActive': {
  if (!canSuperAdmin(P)) return err('No permission', 403);
  if (!d.user_id) return err('user_id required');
  const active = d.active !== false;
  if (!active) {
    if (d.user_id === userId) return err('You cannot disable your own access', 409);
    const supers = await activeSuperAdminUserIds();
    if (supers.length === 1 && supers[0] === d.user_id) return err('Cannot disable the last super admin', 409);
  }
  const patch = active
    ? { active: true, disabled_at: null, disabled_by: null }
    : { active: false, disabled_at: nowISO(), disabled_by: userId };
  const r = await update('manifest_user_roles', patch, `user_id=eq.${encodeURIComponent(d.user_id)}`);
  if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
  await logActivity(auth, active ? 'access_enabled' : 'access_disabled', { detail: d.user_id });
  return ok({ user_id: d.user_id, active });
}
```

- [ ] **Step 5: Add `grantAccess`** (new case — generalizes `onboardSfUser`, does not clobber an existing profile):

```js
case 'grantAccess': {
  if (!canSuperAdmin(P)) return err('No permission', 403);
  if (!d.email || !d.role_key) return err('email and role_key required');
  const adminR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(d.email)}`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  let authUser = null;
  if (adminR.ok) { const j = await adminR.json(); authUser = (j.users || j)[0] || (Array.isArray(j) ? j[0] : null) || (j.id ? j : null); }
  if (!authUser?.id) return err('No auth user for that email yet — ask them to sign in once first, then retry', 422);
  // Party of the target role decides the default profile role on a NEW profile only.
  const roleR = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=party&limit=1`);
  const party = roleR.ok && roleR.data[0] ? roleR.data[0].party : 'LOT';
  const profR = await sbStore(`/rest/v1/users_profile?id=eq.${authUser.id}&select=id&limit=1`);
  if (!(profR.ok && profR.data[0])) {
    await sbStore('/rest/v1/users_profile', {
      method: 'POST',
      body: JSON.stringify({ id: authUser.id, full_name: d.full_name || d.email, role: party === 'SF' ? 'sf_partner' : 'staff', active: true }),
      prefer: 'return=minimal',
    });
  } else {
    await sbStore('/rest/v1/users_profile', {
      method: 'POST',
      body: JSON.stringify({ id: authUser.id, active: true }),
      prefer: 'return=minimal,resolution=merge-duplicates',
    });
  }
  await sb('/rest/v1/manifest_user_roles', {
    method: 'POST',
    body: JSON.stringify({ user_id: authUser.id, role_key: d.role_key, active: true, assigned_by: userId, assigned_at: nowISO() }),
    prefer: 'return=minimal,resolution=merge-duplicates',
  });
  await logActivity(auth, 'access_granted', { detail: `${d.email} → ${d.role_key}` });
  return ok({ user_id: authUser.id, email: d.email, role_key: d.role_key });
}
```

- [ ] **Step 6: Guard `setUserRole`** — at the top of `setUserRole`, after the gate, before the delete/upsert, block moving the last super admin off super and self-clearing:

```js
// inside setUserRole, after `if (!d.user_id) return err('user_id required');`
{
  const supers = await activeSuperAdminUserIds();
  const isLastSuper = supers.length === 1 && supers[0] === d.user_id;
  if (isLastSuper) {
    if (d.role_key === null || d.role_key === '') return err('Cannot remove the last super admin', 409);
    const tgt = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=permissions&limit=1`);
    const keepsSuper = tgt.ok && tgt.data[0] && tgt.data[0].permissions && tgt.data[0].permissions.manifest_super_admin;
    if (!keepsSuper) return err('Cannot demote the last super admin', 409);
  }
}
```
Also ensure the upsert preserves `active`: add `active: true` to the `setUserRole` insert body so a re-assign re-enables.

- [ ] **Step 7: Verify** — `cd manifestops-worker && npx wrangler deploy --dry-run`. Expected: bundles clean.

---

### Task 4: Worker — `getBootstrap` roles + accessUsers; remove orgGroups; deploy

**Files:** Modify `manifestops-worker/src/index.js` (`getBootstrap` ~395-531).

- [ ] **Step 1: Replace the `orgGroups` block** (the `if (canAdmin(P))` block ~506-525) with a super-admin payload:

```js
// ── governance payload (super admin only) ──
let roles = [], accessUsers = [];
if (canSuperAdmin(P)) {
  const [rolesR, urR, profR] = await Promise.all([
    query('manifest_roles', '?order=party.asc,role_key.asc&select=*'),
    query('manifest_user_roles', '?select=user_id,role_key,active,disabled_at'),
    queryStore('users_profile', '?select=id,full_name,active&order=full_name.asc'),
  ]);
  roles = rolesR.ok ? rolesR.data : [];
  const roleMeta = {}; roles.forEach(r => { roleMeta[r.role_key] = r; });
  const profById = {}; (profR.ok ? profR.data : []).forEach(u => { profById[u.id] = u; });
  accessUsers = (urR.ok ? urR.data : []).map(u => {
    const rm = roleMeta[u.role_key]; const pf = profById[u.user_id] || {};
    return { user_id: u.user_id, full_name: pf.full_name || '—', role_key: u.role_key,
             role_label: rm ? (rm.label || u.role_key) : u.role_key, party: rm ? rm.party : 'LOT',
             active: u.active !== false, disabled_at: u.disabled_at || null };
  }).sort((a,b) => (a.full_name||'').localeCompare(b.full_name||''));
}
```

- [ ] **Step 2: Update the return** — replace `subentities/orgGroups` tail of the `getBootstrap` return with:

```js
subentities: subR.ok ? subR.data : [], roles, accessUsers,
```
(Remove `orgGroups` from the returned object.)

- [ ] **Step 3: Deploy worker** (per CLAUDE.md sequence — commit happens with the app in Task 8; deploy after the edits build):

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/manifestops-worker && npx wrangler deploy
```
Expected: "Uploaded manifestops" + a new version id.

- [ ] **Step 4: Verify deployed** — call `getBootstrap` as Afshaan via SQL-equivalent is not possible without a JWT; instead confirm the worker responds and the action set is intact (no 500 on an anon GET → still returns `Unauthorised` 401):

```bash
curl -s "https://manifestops.afshaan.workers.dev/?action=getBootstrap" | head -c 200
```
Expected: `{"error":"Unauthorised"}` (401) — proves routing + no syntax crash.

---

### Task 5: App — Unauthorized wall in `ManifestApp.js`

**Files:** Modify `apps/manifest/src/mf/ManifestApp.js`.

- [ ] **Step 1: Track an `unauthorized` flag** — in `reload`, detect the 401 message:

```js
const reload = useCallback(async () => {
  if (!session) return;
  try { setError(''); setUnauth(false); const d = await garageFetch('getBootstrap', {}, session); setData(d); }
  catch (e) {
    const msg = e?.message || 'Could not load data';
    if (/unauthor/i.test(msg) || /Worker 401/.test(msg)) { setUnauth(true); setData(null); }
    else setError(msg);
  }
}, [session]);
```
Add `const [unauth, setUnauth] = useState(false);` with the other state, and `import { useAuth } from '@throttle/auth';` already present (use `signOut`).

- [ ] **Step 2: Render the wall** — before the main `return`, short-circuit:

```js
const { session, signOut } = useAuth();
// ...
if (hydrated && unauth) {
  return (
    <div style={{ height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg, #0b0d10)', color: 'var(--t1, #e7e9ec)', fontFamily: 'var(--font-mono, monospace)', padding: 24 }}>
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 10 }}>No access to Manifest</div>
        <p style={{ color: 'var(--t3, #8b9099)', fontSize: 13, lineHeight: 1.6 }}>
          Your account isn’t authorized for Manifest. Ask a super admin to grant you access.
        </p>
        <div style={{ fontSize: 12, color: 'var(--t2, #aab)', margin: '14px 0' }}>{session?.user?.email}</div>
        <button onClick={signOut} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border,#2a2f37)', background: 'transparent', color: 'var(--t1,#e7e9ec)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>Sign out</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build** — `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=manifest`. Expected: green.

---

### Task 6: App — gate the Admin nav item

**Files:** Modify `apps/manifest/src/mf/nav.js` + `Chrome.js` (Sidebar) or `ManifestApp.js`.

- [ ] **Step 1: Add a perm predicate to the Admin NAV entry** in `nav.js`:

```js
{ kind: 'item', id: 'admin', label: 'Admin', icon: ShieldCheck, needs: p => !!(p && (p.manifest_admin || p.manifest_super_admin)) },
```

- [ ] **Step 2: Filter NAV by perms where the Sidebar consumes it** — in `Chrome.js` Sidebar, filter items: `NAV.filter(n => n.kind !== 'item' || !n.needs || n.needs(me?.permissions))` (pass `me` already provided). Expected: non-admins don't see Admin.

- [ ] **Step 3: Verify build** — `npx turbo build --filter=manifest`. Green.

---

### Task 7: App — Admin screen: PERMISSION_KEYS catalog + 3 tabs (Access Control · Roles · Operations)

**Files:** Modify `apps/manifest/src/mf/screens.js` (`Admin`).

- [ ] **Step 1: Add the permission-key catalog** near the top of `screens.js`:

```js
const PERMISSION_KEYS = {
  LOT: [
    { group: 'Manifest',   keys: [['manifest_view','View Manifest']] },
    { group: 'Orders',     keys: [['order_manage','Manage orders'],['china_po_sync','Project to Snorkel']] },
    { group: 'Shipping',   keys: [['shipment_manage','Manage shipments']] },
    { group: 'Finance',    keys: [['charge_manage','Manage charges'],['payment_record','Record payments'],['drawdown_manage','Manage draw-downs'],['fx_manage','Manage FX'],['cost_view','View cost / margin']] },
    { group: 'Documents',  keys: [['doc_manage','Manage documents']] },
    { group: 'Governance', keys: [['manifest_admin','Operational admin'],['manifest_super_admin','Super admin (access + roles)']] },
  ],
  SF: [
    { group: 'Manifest',   keys: [['manifest_view','View Manifest']] },
    { group: 'Orders',     keys: [['sf_order_update','Update orders'],['sf_po_manage','Manage POs'],['sf_invoice_create','Create invoices']] },
    { group: 'Finance',    keys: [['sf_drawdown_raise','Raise draw-downs'],['sf_vendor_payment_record','Record vendor payments'],['sf_running_account_view','View running account']] },
    { group: 'Documents',  keys: [['sf_evidence_upload','Upload evidence']] },
  ],
};
```

- [ ] **Step 2: Rewrite the `Admin` component** as a tab host. Tabs visible by perm:

```js
function Admin({ data, session, reload }) {
  const P = data?.me?.permissions || {};
  const isSuper = !!P.manifest_super_admin;
  const isAdmin = !!P.manifest_admin;
  const TABS = [
    isSuper && ['access', 'Access Control'],
    isSuper && ['roles', 'Roles'],
    isAdmin && ['ops', 'Operations'],
  ].filter(Boolean);
  const [tab, setTab] = useState(TABS[0] ? TABS[0][0] : 'ops');
  if (!TABS.length) return <Card><Empty>Admin access required.</Empty></Card>;
  return (
    <Stack>
      <div style={{ display: 'flex', gap: 8 }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ padding: '7px 14px', borderRadius: 8, fontFamily: MONO, fontSize: 11, cursor: 'pointer',
            border: '1px solid var(--border)', background: tab === id ? 'var(--accent)' : 'transparent', color: tab === id ? '#000' : 'var(--t2)' }}>{label}</button>
        ))}
      </div>
      {tab === 'access' && <AccessControl data={data} session={session} reload={reload} />}
      {tab === 'roles'  && <RolesBuilder  data={data} session={session} reload={reload} />}
      {tab === 'ops'    && <Grid cols="1fr 1fr" style={{ alignItems: 'start' }}><ShipmentDefaults session={session} reload={reload} /><Forwarders session={session} /></Grid>}
    </Stack>
  );
}
```

- [ ] **Step 3: Add `AccessControl`** component — table from `data.accessUsers`, role dropdown (`setUserRole`), Active toggle (`setUserActive`), Remove (`setUserRole` null), and a "Grant access" inline form (`grantAccess`). Self / last-super rows: controls disabled. Code:

```js
function AccessControl({ data, session, reload }) {
  const users = data.accessUsers || [];
  const roles = data.roles || [];
  const meId = data.me?.id;
  const superHolders = users.filter(u => u.active && (roles.find(r => r.role_key === u.role_key)?.permissions?.manifest_super_admin));
  const lastSuper = superHolders.length === 1 ? superHolders[0].user_id : null;
  const [busy, setBusy] = useState('');
  const [grant, setGrant] = useState({ email: '', role_key: roles[0]?.role_key || '' });
  const act = async (action, body) => { setBusy(body.user_id || 'grant'); try { await workerFetch(action, body, session); await reload(); } catch (e) { alert(e?.message || 'Failed'); } setBusy(''); };
  return (
    <Stack>
      <Card title="Grant access">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input placeholder="email@…" value={grant.email} onChange={e => setGrant(g => ({ ...g, email: e.target.value }))}
            style={{ flex: 1, minWidth: 200, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--t1)', fontFamily: MONO, fontSize: 12 }} />
          <select value={grant.role_key} onChange={e => setGrant(g => ({ ...g, role_key: e.target.value }))}
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--t1)', fontFamily: MONO, fontSize: 12 }}>
            {roles.map(r => <option key={r.role_key} value={r.role_key}>{r.label} ({r.party})</option>)}
          </select>
          <Btn disabled={!grant.email || !grant.role_key || busy} onClick={() => act('grantAccess', grant).then(() => setGrant(g => ({ ...g, email: '' })))}>Grant</Btn>
        </div>
        <Mono size={10} color="var(--t3)" style={{ display: 'block', marginTop: 8 }}>The person must have signed in at least once (Google for LOT, email link for SF) before access can be granted.</Mono>
      </Card>
      <Card title="People with Manifest access">
        <Table rows={users} rowKey={(u) => u.user_id} cols={[
          { label: 'Name', render: (u) => <span style={{ color: 'var(--t1)' }}>{u.full_name}</span> },
          { label: 'Party', render: (u) => <Badge tone={u.party === 'SF' ? 'blue' : 'yellow'}>{u.party}</Badge> },
          { label: 'Role', render: (u) => (
            <select value={u.role_key} disabled={busy === u.user_id || u.user_id === lastSuper}
              onChange={(e) => act('setUserRole', { user_id: u.user_id, role_key: e.target.value })}
              style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--t1)', fontFamily: MONO, fontSize: 11 }}>
              {roles.map(r => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
            </select>) },
          { label: 'Status', render: (u) => <Badge tone={u.active ? 'green' : 'red'}>{u.active ? 'active' : 'disabled'}</Badge> },
          { label: '', align: 'right', render: (u) => {
            const guarded = u.user_id === meId || u.user_id === lastSuper;
            return (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <Btn disabled={guarded || busy === u.user_id} onClick={() => act('setUserActive', { user_id: u.user_id, active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</Btn>
                <Btn disabled={guarded || busy === u.user_id} onClick={() => { if (confirm(`Remove ${u.full_name}'s access?`)) act('setUserRole', { user_id: u.user_id, role_key: null }); }}>Remove</Btn>
              </span>);
          } },
        ]} />
      </Card>
    </Stack>
  );
}
```

- [ ] **Step 4: Add `RolesBuilder`** component — list roles, create-role form, key-checkbox editor, delete custom/unused:

```js
function RolesBuilder({ data, session, reload }) {
  const roles = data.roles || [];
  const users = data.accessUsers || [];
  const [sel, setSel] = useState(null); // role_key being edited, or '__new__'
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const assignedCount = (rk) => users.filter(u => u.role_key === rk).length;
  const openNew = () => { setSel('__new__'); setDraft({ role_key: '', label: '', description: '', party: 'LOT', permissions: {} }); };
  const openEdit = (r) => { setSel(r.role_key); setDraft({ ...r, permissions: { ...(r.permissions || {}) } }); };
  const save = async () => { setBusy(true); try { await workerFetch('saveRole', draft, session); await reload(); setSel(null); } catch (e) { alert(e?.message || 'Failed'); } setBusy(false); };
  const remove = async (rk) => { if (!confirm(`Delete role ${rk}?`)) return; setBusy(true); try { await workerFetch('deleteRole', { role_key: rk }, session); await reload(); setSel(null); } catch (e) { alert(e?.message || 'Failed'); } setBusy(false); };
  const toggleKey = (k) => setDraft(d => ({ ...d, permissions: { ...d.permissions, [k]: !d.permissions[k] } }));
  const cat = draft ? (PERMISSION_KEYS[draft.party] || PERMISSION_KEYS.LOT) : [];
  return (
    <Grid cols="320px 1fr" style={{ alignItems: 'start' }}>
      <Card title={<span style={{ display: 'inline-flex', justifyContent: 'space-between', width: '100%' }}>Roles <Btn onClick={openNew}><Plus size={13} style={{ verticalAlign: -2 }} /> New</Btn></span>}>
        <Table rows={roles} rowKey={(r) => r.role_key} cols={[
          { label: 'Role', render: (r) => <button onClick={() => openEdit(r)} style={{ background: 'none', border: 0, color: 'var(--t1)', cursor: 'pointer', fontFamily: MONO, fontSize: 11, textAlign: 'left' }}>{r.label}<Mono size={9} color="var(--t3)" style={{ display: 'block' }}>{r.role_key}</Mono></button> },
          { label: '', align: 'right', render: (r) => r.is_system ? <Badge tone="slate">System</Badge> : <Badge tone={r.party === 'SF' ? 'blue' : 'yellow'}>{r.party}</Badge> },
        ]} />
      </Card>
      {draft ? (
        <Card title={sel === '__new__' ? 'New role' : (draft.is_system ? `${draft.label} (system · locked)` : `Edit ${draft.label}`)}>
          {(() => { const locked = !!draft.is_system; return (
          <Stack>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input placeholder="role_key" value={draft.role_key} disabled={sel !== '__new__'} onChange={e => setDraft(d => ({ ...d, role_key: e.target.value.trim() }))} style={inpS} />
              <input placeholder="Label" value={draft.label} disabled={locked} onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} style={inpS} />
              <select value={draft.party} disabled={sel !== '__new__'} onChange={e => setDraft(d => ({ ...d, party: e.target.value }))} style={inpS}><option value="LOT">LOT</option><option value="SF">SF</option></select>
            </div>
            <input placeholder="Description" value={draft.description || ''} disabled={locked} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} style={{ ...inpS, width: '100%' }} />
            {cat.map(grp => (
              <div key={grp.group}>
                <Mono size={10} color="var(--t3)">{grp.group}</Mono>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                  {grp.keys.map(([k, label]) => (
                    <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--t2)', opacity: locked ? 0.6 : 1 }}>
                      <input type="checkbox" checked={!!draft.permissions[k]} disabled={locked} onChange={() => toggleKey(k)} />{label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {!locked && (
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn disabled={busy || !draft.role_key} onClick={save}>Save role</Btn>
                {sel !== '__new__' && <Btn disabled={busy || assignedCount(draft.role_key) > 0} onClick={() => remove(draft.role_key)}>Delete{assignedCount(draft.role_key) > 0 ? ` (${assignedCount(draft.role_key)} assigned)` : ''}</Btn>}
              </div>
            )}
          </Stack>); })()}
        </Card>
      ) : <Card><Empty>Select a role to view, or create a new one.</Empty></Card>}
    </Grid>
  );
}
const inpS = { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--t1)', fontFamily: MONO, fontSize: 12 };
```

- [ ] **Step 5: Ensure imports** — `workerFetch` is imported in `screens.js` (it is used elsewhere; if not, add `import { garageFetch, workerFetch } from '@throttle/db';`). Confirm `Plus`, `Badge`, `Btn`, `Table`, `Card`, `Stack`, `Empty`, `Mono`, `Grid`, `MONO`, `toneVar` are already in scope (they are used by the old Admin). Remove the now-dead `initials`/`orgGroups` usage from the old Admin.

- [ ] **Step 6: Verify build** — `npx turbo build --filter=manifest`. Expected: green, no unused-import errors.

---

### Task 8: Build all, commit, push, deploy, knowledge files

- [ ] **Step 1: Build every app** (shared-shell blast-radius check): `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build`. Expected: all apps green.
- [ ] **Step 2: Commit + push the monorepo** (worker + app together):

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add -A manifestops-worker apps/manifest docs/superpowers
git commit -m "manifest: access control + permissions builder + super-admin tier"
git push
```
(Note: do NOT `git add -A` the whole tree — a parallel session may share it. Scope the add.)

- [ ] **Step 3: Deploy worker** (if not already in Task 4): `cd manifestops-worker && npx wrangler deploy`.
- [ ] **Step 4: Verify** — anon `curl getBootstrap` → 401; app auto-deploys via `deploy-manifest.yml` (3–4 min).
- [ ] **Step 5: Update knowledge files** — `CORE.md` (manifest permission layer note + `manifest_super_admin`), `BUSINESS_RULES.md` (new RULE-MANIFEST-006 access control), `systems/manifest.md` (Access Control + Permissions Builder section), `BACKLOG.md` (close the access-control item). Commit the workspace root.

---

## Self-review notes
- **Spec coverage:** wall (T5), access control UI (T7 AccessControl), permissions builder (T7 RolesBuilder), super-admin tier (T1+T2), guards (T3+T6), grantAccess/onboard (T3), nav gate (T6), getBootstrap payload (T4) — all covered.
- **Type/name consistency:** worker actions `grantAccess`/`setUserActive`/`deleteRole`/`saveRole`/`setUserRole` match between worker cases and SPA `workerFetch` calls. `accessUsers`/`roles` keys match between T4 (producer) and T7 (consumer): `user_id, full_name, role_key, role_label, party, active`. `manifest_super_admin` key spelled consistently throughout.
- **No destructive SQL** — migration is ALTER ADD + UPDATE only.
