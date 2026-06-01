'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, useEscapeClose } from '@throttle/ui';

const PERM_DEFS = [
  { group: 'Core Tabs', items: [
    { key: 'dashboard',    label: 'Dashboard',     type: 'bool'  },
    { key: 'stock',        label: 'Stock Ledger',  type: 'level' },
    { key: 'grn',          label: 'GRN Entry',     type: 'level' },
    { key: 'receiving',    label: 'Receiving',     type: 'level' },
    { key: 'work_order',   label: 'Work Orders',   type: 'level' },
    { key: 'stock_issue',  label: 'Stock Issue',   type: 'level' },
    { key: 'returns',      label: 'Returns',       type: 'level' },
  ] },
  { group: 'Production Floor', items: [
    { key: 'production_view', label: 'View Production & Floor Tools', type: 'bool' },
  ] },
  { group: 'Line Flush', items: [
    { key: 'line_flush_create', label: 'Create Flushes (Production)', type: 'bool' },
    { key: 'line_flush_verify', label: 'Verify Flushes (Store)',      type: 'bool' },
  ] },
  { group: 'Procurement', items: [
    { key: 'procurement_view',          label: 'View Procurement Tab', type: 'bool' },
    { key: 'procurement_raise',         label: 'Raise POs',            type: 'bool' },
    { key: 'procurement_approve',       label: 'Approve POs',          type: 'bool' },
    { key: 'procurement_china',         label: 'View / Raise China POs', type: 'bool' },
    { key: 'procurement_china_approve', label: 'Approve China POs',    type: 'bool' },
    { key: 'company_address_manage',    label: 'Manage Company Addresses', type: 'bool' },
  ] },
  { group: 'Damage / Cycle Counts', items: [
    { key: 'damage_manage',          label: 'Manage Damage Ledger', type: 'bool' },
    { key: 'cycle_count_record',     label: 'Record Cycle Counts',  type: 'bool' },
    { key: 'cycle_count_approve_l1', label: 'Approve Variance — L1', type: 'bool' },
    { key: 'cycle_count_approve_l2', label: 'Approve Variance — L2', type: 'bool' },
    { key: 'cycle_count_admin',      label: 'Cycle Count Admin / Thresholds', type: 'bool' },
  ] },
  { group: 'Process Deviations', items: [
    { key: 'deviation_propose',     label: 'Propose Deviations',     type: 'bool' },
    { key: 'deviation_approve_l1',  label: 'Approve Deviations — L1', type: 'bool' },
    { key: 'deviation_approve_l2',  label: 'Approve Deviations — L2', type: 'bool' },
    { key: 'deviation_approve_l3',  label: 'Approve Deviations — L3', type: 'bool' },
    { key: 'deviation_close',       label: 'Close Active Deviations', type: 'bool' },
  ] },
  { group: 'Direct Issuance', items: [
    { key: 'direct_issuance_request', label: 'Request Direct Issuance', type: 'bool' },
    { key: 'direct_issuance_approve', label: 'Approve & Issue / Close', type: 'bool' },
  ] },
  { group: 'Dispatch', items: [
    { key: 'dispatch_pack',    label: 'Pack Shipments (Add / Delete Boxes)', type: 'bool' },
    { key: 'dispatch_restock', label: 'Unit Restock (Scanner)',  type: 'bool' },
    { key: 'dispatch_challan', label: 'Issue Delivery Challans', type: 'bool' },
  ] },
  { group: 'Scan Corrections', items: [
    { key: 'scan_void_supervisor', label: 'Void Scans (Supervisor)', type: 'bool' },
    { key: 'scan_amend_manager',   label: 'Amend Scans (Manager)',   type: 'bool' },
  ] },
  { group: 'Reports', items: [
    { key: 'reports',            label: 'View & Download Reports',         type: 'bool' },
    { key: 'reports_finance',    label: 'Finance / Cost Reports',          type: 'bool' },
    { key: 'reports_compliance', label: 'Compliance Reports (sensitive)',  type: 'bool' },
  ] },
  { group: 'Users', items: [
    { key: 'users_view',   label: 'View Users Tab',       type: 'bool' },
    { key: 'users_manage', label: 'Manage Users & Roles', type: 'bool' },
  ] },
  { group: 'Pitstop (CS)', items: [
    { key: 'cs_ticket_view',     label: 'View Tickets',                      type: 'bool' },
    { key: 'cs_ticket_manage',   label: 'Manage Own Tickets (self-assign)',  type: 'bool' },
    { key: 'cs_ticket_reassign', label: 'Reassign Tickets to Others (TL+)',  type: 'bool' },
    { key: 'cs_ticket_approve',  label: 'Approve Refunds / Replacements',    type: 'bool' },
    { key: 'cs_ticket_admin',    label: 'CS Admin (force-close, depts, WA templates)', type: 'bool' },
    { key: 'cs_reports_view',    label: 'View CS Reports & Costs',           type: 'bool' },
  ] },
];

const LEVEL_OPTIONS = ['none', 'view', 'write'];
const LEVEL_COLORS  = { none: '#aaa', view: '#7b93ff', write: '#4ade80' };

const ROLE_LABELS = {
  super_admin: 'Super Admin', admin: 'Admin',
  production_manager: 'Production Manager', production_team: 'Production Team',
  store_head: 'Store Head', store_staff: 'Store Staff',
  cs_agent: 'CS Agent', cs_lead: 'CS Lead',
  store: 'Store', store_manager: 'Store Manager', ops: 'Ops',
  vinay: 'Vinay', brand: 'Brand', founders: "Founder's Office", production: 'Production',
};

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnDanger        = { background: '#ef4444', border: '1px solid #ef4444', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };

const tabBtnStyle = (active) => ({
  background: 'transparent',
  color: active ? 'var(--yellow)' : 'var(--t3)',
  border: 'none',
  borderBottom: active ? '2px solid var(--yellow)' : '2px solid transparent',
  padding: '8px 14px 10px',
  fontFamily: 'var(--cond)',
  fontSize: 13,
  fontWeight: active ? 700 : 500,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: 'pointer',
});

const toggleBtnStyle = (active) => ({
  background: active ? '#22c55e' : 'var(--surface2)',
  border: `1px solid ${active ? '#22c55e' : 'var(--border)'}`,
  color: active ? '#000' : 'var(--t3)',
  borderRadius: 3,
  padding: '4px 12px',
  fontSize: 10,
  fontFamily: 'var(--mono)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  fontWeight: active ? 700 : 500,
});

const levelBtnStyle = (active, level) => ({
  background: active ? LEVEL_COLORS[level] : 'var(--surface2)',
  border: `1px solid ${active ? LEVEL_COLORS[level] : 'var(--border)'}`,
  color: active ? '#000' : 'var(--t3)',
  borderRadius: 3,
  padding: '3px 10px',
  fontSize: 10,
  fontFamily: 'var(--mono)',
  textTransform: 'uppercase',
  cursor: 'pointer',
  fontWeight: active ? 700 : 500,
});

export default function UsersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState('users');

  // Data
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);

  // Users sub-tab
  const [usersView, setUsersView] = useState('list');
  const [editingUserId, setEditingUserId] = useState(null);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('');
  const [team, setTeam] = useState('');
  const [phone, setPhone] = useState('');
  const [userSubmitting, setUserSubmitting] = useState(false);
  const [resetPwdOpen, setResetPwdOpen] = useState(false);
  const [resetPwd, setResetPwd] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // Roles sub-tab
  const [rolesView, setRolesView] = useState('list');
  const [editingRoleId, setEditingRoleId] = useState(null);
  const [roleId, setRoleId] = useState('');
  const [roleName, setRoleName] = useState('');
  const [roleDesc, setRoleDesc] = useState('');
  const [permValues, setPermValues] = useState({});
  const [isSystemRole, setIsSystemRole] = useState(false);
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const loadAll = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [u, r] = await Promise.all([
        garageFetch('getUsers', {}, session).catch(() => []),
        garageFetch('getRoles', {}, session).catch(() => []),
      ]);
      setUsers(Array.isArray(u) ? u : []);
      setRoles(Array.isArray(r) ? r : []);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const userCountByRole = useMemo(() => {
    const m = {};
    users.forEach((u) => { m[u.role] = (m[u.role] || 0) + 1; });
    return m;
  }, [users]);

  // Users handlers ----------------------------------------------------------
  function clearUserForm() {
    setFullName('');
    setEmail('');
    setPassword('');
    setRole('');
    setTeam('');
    setPhone('');
  }

  function startCreateUser() {
    clearUserForm();
    setEditingUserId(null);
    setUsersView('form');
  }

  function startEditUser(u) {
    setEditingUserId(u.id);
    setFullName(u.full_name || '');
    setEmail(u.email || '');
    setPassword('');
    setRole(u.role || '');
    setTeam(u.team || '');
    setPhone(u.phone || '');
    setUsersView('form');
  }

  async function saveUser() {
    if (!fullName.trim()) { showToast('Full name required', 'error'); return; }
    if (!role) { showToast('Role required', 'error'); return; }
    setUserSubmitting(true);
    try {
      if (editingUserId) {
        await workerFetch('updateUser', {
          data: { id: editingUserId, full_name: fullName.trim(), role, team: team || null, phone: phone || null },
        }, session);
        showToast('User updated', 'success');
      } else {
        if (!email.trim()) { showToast('Email required', 'error'); return; }
        if (password.length < 8) { showToast('Password must be 8+ characters', 'error'); return; }
        await workerFetch('createUser', {
          data: {
            email: email.trim(),
            password,
            full_name: fullName.trim(),
            role,
            team: team || null,
            phone: phone || null,
          },
        }, session);
        showToast('User created', 'success');
      }
      setUsersView('list');
      setEditingUserId(null);
      clearUserForm();
      loadAll();
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    } finally {
      setUserSubmitting(false);
    }
  }

  async function submitResetPwd() {
    if (!editingUserId) return;
    if (resetPwd.length < 8) { showToast('Password must be 8+ characters', 'error'); return; }
    setResetSubmitting(true);
    try {
      await workerFetch('resetPassword', { data: { id: editingUserId, new_password: resetPwd } }, session);
      showToast('Password reset', 'success');
      setResetPwdOpen(false);
      setResetPwd('');
    } catch (e) {
      showToast(e.message || 'Reset failed', 'error');
    } finally {
      setResetSubmitting(false);
    }
  }

  // Roles handlers ----------------------------------------------------------
  function clearRoleForm() {
    setRoleId('');
    setRoleName('');
    setRoleDesc('');
    setPermValues({});
    setIsSystemRole(false);
  }

  function startCreateRole() {
    clearRoleForm();
    setEditingRoleId(null);
    setRolesView('form');
  }

  function startEditRole(r) {
    setEditingRoleId(r.role_id);
    setRoleId(r.role_id || '');
    setRoleName(r.role_name || '');
    setRoleDesc(r.description || '');
    setPermValues(r.permissions || {});
    setIsSystemRole(!!r.is_system);
    setRolesView('form');
  }

  function togglePermBool(key) {
    setPermValues((p) => ({ ...p, [key]: !p[key] }));
  }
  function setPermLevel(key, level) {
    setPermValues((p) => ({ ...p, [key]: level === 'none' ? null : level }));
  }

  async function saveRole() {
    if (!roleName.trim()) { showToast('Role name required', 'error'); return; }
    if (!editingRoleId && !roleId.trim()) { showToast('Role ID required', 'error'); return; }
    setRoleSubmitting(true);
    try {
      const payload = {
        role_id: editingRoleId || roleId.trim().toLowerCase().replace(/\s+/g, '_'),
        role_name: roleName.trim(),
        description: roleDesc || null,
        permissions: permValues,
      };
      const action = editingRoleId ? 'updateRole' : 'createRole';
      await workerFetch(action, { data: payload }, session);
      showToast(editingRoleId ? 'Role updated' : 'Role created', 'success');
      setRolesView('list');
      setEditingRoleId(null);
      clearRoleForm();
      loadAll();
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    } finally {
      setRoleSubmitting(false);
    }
  }

  async function confirmDeleteRole() {
    if (!editingRoleId) return;
    setDeleteSubmitting(true);
    try {
      await workerFetch('deleteRole', { data: { role_id: editingRoleId } }, session);
      showToast('Role deleted', 'success');
      setDeleteConfirmOpen(false);
      setRolesView('list');
      setEditingRoleId(null);
      clearRoleForm();
      loadAll();
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error');
    } finally {
      setDeleteSubmitting(false);
    }
  }

  if (perms && !perms.users_view && !perms.users_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const canManage = !!perms?.users_manage;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 8 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Users & Roles
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Manage user accounts and the role-based permission matrix.
        </p>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        <button type="button" style={tabBtnStyle(activeTab === 'users')} onClick={() => setActiveTab('users')}>Users</button>
        <button type="button" style={tabBtnStyle(activeTab === 'roles')} onClick={() => setActiveTab('roles')}>Roles & Permissions</button>
      </div>

      {activeTab === 'users' && (
        usersView === 'list' ? (
          <UsersList
            users={users}
            roles={roles}
            loading={loading}
            canManage={canManage}
            onCreate={startCreateUser}
            onEdit={startEditUser}
            onRefresh={loadAll}
          />
        ) : (
          <UsersForm
            editingUserId={editingUserId}
            fullName={fullName} setFullName={setFullName}
            email={email} setEmail={setEmail}
            password={password} setPassword={setPassword}
            role={role} setRole={setRole}
            team={team} setTeam={setTeam}
            phone={phone} setPhone={setPhone}
            roles={roles}
            users={users}
            submitting={userSubmitting}
            onSave={saveUser}
            onCancel={() => { setUsersView('list'); setEditingUserId(null); clearUserForm(); }}
            onResetPwd={() => { setResetPwd(''); setResetPwdOpen(true); }}
            canManage={canManage}
          />
        )
      )}

      {activeTab === 'roles' && (
        rolesView === 'list' ? (
          <RolesList
            roles={roles}
            userCountByRole={userCountByRole}
            loading={loading}
            canManage={canManage}
            onCreate={startCreateRole}
            onEdit={startEditRole}
            onRefresh={loadAll}
          />
        ) : (
          <RoleForm
            editingRoleId={editingRoleId}
            roleId={roleId} setRoleId={setRoleId}
            roleName={roleName} setRoleName={setRoleName}
            roleDesc={roleDesc} setRoleDesc={setRoleDesc}
            permValues={permValues}
            togglePermBool={togglePermBool}
            setPermLevel={setPermLevel}
            isSystemRole={isSystemRole}
            submitting={roleSubmitting}
            onSave={saveRole}
            onCancel={() => { setRolesView('list'); setEditingRoleId(null); clearRoleForm(); }}
            onDelete={() => setDeleteConfirmOpen(true)}
            canManage={canManage}
          />
        )
      )}

      {resetPwdOpen && (
        <ResetPasswordModal
          value={resetPwd}
          onChange={setResetPwd}
          submitting={resetSubmitting}
          onClose={() => !resetSubmitting && setResetPwdOpen(false)}
          onSubmit={submitResetPwd}
        />
      )}

      {deleteConfirmOpen && (
        <DeleteRoleConfirm
          roleName={roleName}
          submitting={deleteSubmitting}
          onClose={() => !deleteSubmitting && setDeleteConfirmOpen(false)}
          onConfirm={confirmDeleteRole}
        />
      )}
    </div>
  );
}

function UsersList({ users, roles, loading, canManage, onCreate, onEdit, onRefresh }) {
  const roleNameMap = useMemo(() => {
    const m = {};
    roles.forEach((r) => { m[r.role_id] = r.role_name; });
    return m;
  }, [roles]);

  function roleLabel(id) {
    return roleNameMap[id] || ROLE_LABELS[id] || id || '—';
  }

  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}>
        <span>All Users {users.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({users.length})</span>}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={btnSecondary} onClick={onRefresh} disabled={loading}>↻</button>
          {canManage && <button style={btnPrimary} onClick={onCreate}>+ New User</button>}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : users.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No users yet</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Name</th>
              <th style={tableThStyle}>Email</th>
              <th style={tableThStyle}>Role</th>
              <th style={tableThStyle}>Team</th>
              <th style={tableThStyle}>Phone</th>
              <th style={tableThStyle}>Status</th>
              <th style={tableThStyle}>Must Change Pwd</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
            </tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={tableTdStyle}>{u.full_name || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{u.email || '—'}</td>
                  <td style={tableTdStyle}>{roleLabel(u.role)}</td>
                  <td style={tableTdStyle}>{u.team || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{u.phone || '—'}</td>
                  <td style={tableTdStyle}><StatusBadge label={u.active === false ? 'Inactive' : 'Active'} tone={u.active === false ? 'red' : 'green'} /></td>
                  <td style={tableTdStyle}>
                    {u.must_change_password
                      ? <span style={{ color: '#f2cd1a', fontSize: 11 }}>⚠ Pending</span>
                      : <span style={{ color: 'var(--t3)' }}>—</span>}
                  </td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                    {canManage && <button style={btnSecondary} onClick={() => onEdit(u)}>Edit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function UsersForm({
  editingUserId, fullName, setFullName, email, setEmail, password, setPassword,
  role, setRole, team, setTeam, phone, setPhone, roles, users, submitting,
  onSave, onCancel, onResetPwd, canManage,
}) {
  const editing = !!editingUserId;
  const editingUser = editing ? users.find((u) => u.id === editingUserId) : null;
  const title = editing ? `Edit User — ${editingUser?.full_name || ''}` : 'New User';

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button style={btnSecondary} onClick={onCancel} disabled={submitting}>← Back to list</button>
      </div>
      <h2 style={{ fontFamily: 'var(--cond)', fontSize: 18, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>{title}</h2>

      <div style={{ ...panelStyle, maxWidth: 700 }}>
        <div style={panelHeaderStyle}><span>User Details</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Full Name *" value={fullName} onChange={setFullName} disabled={submitting} />
            <Field label="Email *" value={email} onChange={setEmail} disabled={submitting || editing} />
            {!editing && (
              <Field label="Temporary Password * (min 8)" type="password" value={password} onChange={setPassword} disabled={submitting} />
            )}
            <div>
              <span style={labelStyle}>Role *</span>
              <select value={role} onChange={(e) => setRole(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                <option value="">Select…</option>
                {roles.map((r) => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}
              </select>
            </div>
            <Field label="Team" value={team} onChange={setTeam} disabled={submitting} />
            <Field label="Phone" value={phone} onChange={setPhone} disabled={submitting} />
          </div>

          {!editing && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--t3)', fontStyle: 'italic' }}>
              User will be asked to set their own password on first login.
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, gap: 6, flexWrap: 'wrap' }}>
            <div>
              {editing && canManage && (
                <button style={btnSecondary} onClick={onResetPwd} disabled={submitting}>Reset Password</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={btnSecondary} onClick={onCancel} disabled={submitting}>Cancel</button>
              <button
                style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
                onClick={onSave}
                disabled={submitting}
              >
                {submitting ? 'Saving…' : 'Save User'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function RolesList({ roles, userCountByRole, loading, canManage, onCreate, onEdit, onRefresh }) {
  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}>
        <span>All Roles {roles.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({roles.length})</span>}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={btnSecondary} onClick={onRefresh} disabled={loading}>↻</button>
          {canManage && <button style={btnPrimary} onClick={onCreate}>+ New Role</button>}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : roles.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No roles yet</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Role ID</th>
              <th style={tableThStyle}>Name</th>
              <th style={tableThStyle}>Description</th>
              <th style={tableThStyle}>System</th>
              <th style={tableThStyle}>Users Assigned</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
            </tr></thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.role_id}>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.role_id}</td>
                  <td style={tableTdStyle}>{r.role_name}</td>
                  <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 320 }}>{r.description || '—'}</td>
                  <td style={tableTdStyle}><StatusBadge label={r.is_system ? 'System' : 'Custom'} tone={r.is_system ? 'gray' : 'blue'} /></td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{userCountByRole[r.role_id] || 0}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                    {canManage && <button style={btnSecondary} onClick={() => onEdit(r)}>Edit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RoleForm({
  editingRoleId, roleId, setRoleId, roleName, setRoleName, roleDesc, setRoleDesc,
  permValues, togglePermBool, setPermLevel, isSystemRole, submitting,
  onSave, onCancel, onDelete, canManage,
}) {
  const editing = !!editingRoleId;
  const title = editing ? `Edit Role — ${roleName}` : 'New Role';

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button style={btnSecondary} onClick={onCancel} disabled={submitting}>← Back to list</button>
      </div>
      <h2 style={{ fontFamily: 'var(--cond)', fontSize: 18, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>{title}</h2>

      <div style={{ ...panelStyle, maxWidth: 800 }}>
        <div style={panelHeaderStyle}><span>Role Details</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <span style={labelStyle}>Role ID *</span>
              <input
                type="text"
                value={roleId}
                onChange={(e) => setRoleId(e.target.value.toLowerCase().replace(/\s+/g, '_'))}
                placeholder="store_staff"
                style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }}
                disabled={submitting || editing}
              />
            </div>
            <Field label="Display Name *" value={roleName} onChange={setRoleName} disabled={submitting} />
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Description</span>
              <input type="text" value={roleDesc} onChange={(e) => setRoleDesc(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
            </div>
          </div>
        </div>
      </div>

      <div style={{ ...labelStyle, marginBottom: 6 }}>Permissions</div>
      <PermMatrix
        permValues={permValues}
        togglePermBool={togglePermBool}
        setPermLevel={setPermLevel}
        disabled={submitting}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
        <div>
          {editing && !isSystemRole && canManage && (
            <button style={btnDanger} onClick={onDelete} disabled={submitting}>Delete Role</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={btnSecondary} onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
            onClick={onSave}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Save Role'}
          </button>
        </div>
      </div>
    </>
  );
}

function PermMatrix({ permValues, togglePermBool, setPermLevel, disabled }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      {PERM_DEFS.map((g) => (
        <div key={g.group} style={{ ...panelStyle, marginBottom: 0 }}>
          <div style={panelHeaderStyle}><span>{g.group}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {g.items.map((it) => {
              const v = permValues[it.key];
              return (
                <div key={it.key} style={{
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  padding: '8px 10px', display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', gap: 12, fontSize: 12,
                }}>
                  <span>{it.label}</span>
                  {it.type === 'bool' ? (
                    <button
                      type="button"
                      style={toggleBtnStyle(!!v)}
                      onClick={() => !disabled && togglePermBool(it.key)}
                      disabled={disabled}
                    >
                      {v ? 'On' : 'Off'}
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: 4 }}>
                      {LEVEL_OPTIONS.map((lv) => {
                        const active = (v || 'none') === lv;
                        return (
                          <button
                            key={lv}
                            type="button"
                            style={levelBtnStyle(active, lv)}
                            onClick={() => !disabled && setPermLevel(it.key, lv)}
                            disabled={disabled}
                          >
                            {lv}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResetPasswordModal({ value, onChange, submitting, onClose, onSubmit }) {
  useEscapeClose(true, () => { if (!submitting) onClose(); });
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 380, maxWidth: 480 }}>
        <h3 style={{ margin: 0, marginBottom: 12, color: 'var(--yellow)', fontSize: 14, fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          Reset Password
        </h3>
        <span style={labelStyle}>New Temporary Password (min 8) *</span>
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }}
          disabled={submitting}
        />
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--t3)', fontStyle: 'italic' }}>
          User will be asked to change this on next login.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}
            onClick={onSubmit}
            disabled={submitting}
          >
            {submitting ? 'Resetting…' : 'Reset'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteRoleConfirm({ roleName, submitting, onClose, onConfirm }) {
  useEscapeClose(true, () => { if (!submitting) onClose(); });
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 380, maxWidth: 460 }}>
        <h3 style={{ margin: 0, marginBottom: 12, color: '#ff7070', fontSize: 14, fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          Delete Role
        </h3>
        <p style={{ margin: 0, marginBottom: 12, fontSize: 12, lineHeight: 1.6 }}>
          Delete the role <strong style={{ color: 'var(--yellow)', fontFamily: 'var(--mono)' }}>{roleName}</strong>?
          Users currently assigned this role will lose access until reassigned.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>Cancel</button>
          <button style={{ ...btnDanger, opacity: submitting ? 0.6 : 1 }} onClick={onConfirm} disabled={submitting}>
            {submitting ? 'Deleting…' : 'Delete Role'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', disabled }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={disabled} />
    </div>
  );
}
