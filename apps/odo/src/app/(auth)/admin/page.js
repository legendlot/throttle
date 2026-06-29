'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { salesGet, salesPost } from '../../../lib/api.js';

const PERM_KEYS = [
  ['sales_view', 'View dashboard + export'],
  ['sales_refresh', 'Trigger refresh-now'],
  ['sales_upload', 'Upload QC reports'],
  ['sales_mapping_manage', 'Manage SKU mapping'],
  ['sales_connector_manage', 'Manage connectors / backfill'],
  ['salesops_admin', 'Admin'],
  ['salesops_super_admin', 'Super admin (governs access)'],
];

export default function AdminPage() {
  const { session, perms } = useAuth();
  const toast = useToast();
  const [boot, setBoot] = useState(null);
  const [tab, setTab] = useState('access');
  const [grant, setGrant] = useState({ email: '', role_key: '' });
  const [userOpts, setUserOpts] = useState([]);   // searchable LOT-people directory for the grant dropdown
  const [editRole, setEditRole] = useState(null);   // { role_key, label, permissions }
  const [drrDays, setDrrDays] = useState('');

  const load = () => { if (session) salesGet('getBootstrap', {}, session).then(setBoot); };
  useEffect(load, [session]);
  useEffect(() => { if (boot?.drr_window_days != null) setDrrDays(String(boot.drr_window_days)); }, [boot]);

  if (!perms?.salesops_admin && !perms?.salesops_super_admin) return <div style={{ fontFamily: 'var(--mono)', color: 'var(--t3)' }}>Admin access required.</div>;
  if (!boot) return <Spinner />;
  const isSuper = !!perms?.salesops_super_admin;
  const roles = boot.roles || [];
  const users = boot.accessUsers || [];

  const searchUsers = (q) => {
    if (!q || q.trim().length < 2) { setUserOpts([]); return; }
    salesGet('searchUsers', { q: q.trim() }, session)
      .then(r => setUserOpts((r?.rows || []).map(u => ({ value: u.email, label: u.full_name, hint: u.email }))))
      .catch(() => setUserOpts([]));
  };
  const doGrant = () => salesPost('grantAccess', grant, session).then(() => { toast?.showToast?.('Access granted', 'success'); setGrant({ email: '', role_key: '' }); setUserOpts([]); load(); }).catch(e => toast?.showToast?.(e.message, 'error'));
  const toggleUser = (u) => {
    if (u.active && !window.confirm(`Disable ${u.full_name}? They lose all Odo access until re-enabled.`)) return;
    salesPost('setUserActive', { user_id: u.user_id, active: !u.active }, session).then(load).catch(e => toast?.showToast?.(e.message, 'error'));
  };
  const saveRole = () => salesPost('saveRole', editRole, session).then(() => { toast?.showToast?.('Role saved', 'success'); setEditRole(null); load(); }).catch(e => toast?.showToast?.(e.message, 'error'));
  const delRole = (rk) => {
    if (!window.confirm(`Delete role “${rk}”? Users on this role lose its permissions. This can't be undone.`)) return;
    salesPost('deleteRole', { role_key: rk }, session).then(load).catch(e => toast?.showToast?.(e.message, 'error'));
  };
  const saveDrr = () => {
    const n = Number(drrDays);
    if (!(Number.isFinite(n) && n >= 1 && n <= 365)) return toast?.showToast?.('Days must be 1–365', 'error');
    salesPost('setDrrWindow', { days: Math.round(n) }, session).then(() => { toast?.showToast?.('DRR window saved', 'success'); load(); }).catch(e => toast?.showToast?.(e.message, 'error'));
  };

  return (
    <div style={{ maxWidth: 980, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {['access', 'roles', 'settings'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`so-chip${tab === t ? ' on' : ''}`} style={{ textTransform: 'capitalize' }}>{t}</button>
        ))}
      </div>

      {tab === 'access' && (
        <>
          {isSuper && (
            <div className="so-card" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 260 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--t3)' }}>Grant access — search person</span>
                <Combobox value={grant.email} options={userOpts} onQueryChange={searchUsers} onChange={(val) => setGrant(g => ({ ...g, email: val }))} placeholder="Type a name or email…" portal />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--t3)' }}>Role</span>
                <select className="so-select" value={grant.role_key} onChange={e => setGrant(g => ({ ...g, role_key: e.target.value }))}>
                  <option value="">— role —</option>
                  {roles.map(r => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
                </select>
              </label>
              <button className="so-btn" onClick={doGrant} disabled={!grant.email || !grant.role_key}>Grant</button>
            </div>
          )}
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="so-table">
              <thead><tr><th>User</th><th>Role</th><th>Status</th>{isSuper && <th></th>}</tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.user_id}>
                    <td style={{ color: 'var(--t1)' }}>{u.full_name}</td>
                    <td>{u.role_label}</td>
                    <td><span style={{ color: u.active ? 'var(--green)' : 'var(--red)' }}>{u.active ? 'active' : 'disabled'}</span></td>
                    {isSuper && <td><button className="so-btn ghost" onClick={() => toggleUser(u)}>{u.active ? 'Disable' : 'Enable'}</button></td>}
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No users provisioned.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'roles' && (
        <>
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="so-table">
              <thead><tr><th>Role</th><th>Key</th><th>Permissions</th><th></th></tr></thead>
              <tbody>
                {roles.map(r => (
                  <tr key={r.role_key}>
                    <td style={{ color: 'var(--t1)' }}>{r.label}{r.is_system && <span className="so-pill" style={{ marginLeft: 6, background: 'var(--surface2)', color: 'var(--t3)' }}>system</span>}</td>
                    <td>{r.role_key}</td>
                    <td style={{ color: 'var(--t3)' }}>{Object.keys(r.permissions || {}).filter(k => r.permissions[k]).length} keys</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {isSuper && !r.is_system && <button className="so-btn ghost" onClick={() => setEditRole({ role_key: r.role_key, label: r.label, description: r.description, permissions: { ...(r.permissions || {}) } })}>Edit</button>}
                      {isSuper && !r.is_system && <button className="so-btn ghost" onClick={() => delRole(r.role_key)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isSuper && (
            <button className="so-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setEditRole({ role_key: '', label: '', permissions: { sales_view: true } })}>+ New role</button>
          )}
          {editRole && (
            <div className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontFamily: 'var(--cond)', fontWeight: 600, color: 'var(--t1)' }}>{editRole.role_key ? `Edit · ${editRole.role_key}` : 'New role'}</div>
              {!editRole.role_key && <input className="so-input" placeholder="role_key (e.g. ops)" value={editRole.role_key} onChange={e => setEditRole(r => ({ ...r, role_key: e.target.value.toLowerCase().replace(/\s+/g, '_') }))} />}
              <input className="so-input" placeholder="Label" value={editRole.label || ''} onChange={e => setEditRole(r => ({ ...r, label: e.target.value }))} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 8 }}>
                {PERM_KEYS.map(([k, lbl]) => (
                  <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>
                    <input type="checkbox" checked={!!editRole.permissions?.[k]} onChange={e => setEditRole(r => ({ ...r, permissions: { ...r.permissions, [k]: e.target.checked } }))} />
                    {lbl}
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="so-btn" onClick={saveRole} disabled={!editRole.role_key || !editRole.label}>Save role</button>
                <button className="so-btn ghost" onClick={() => setEditRole(null)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'settings' && (
        <div className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 460 }}>
          <div style={{ fontFamily: 'var(--cond)', fontWeight: 600, color: 'var(--t1)' }}>DRR window</div>
          <div className="so-sub" style={{ fontSize: 12 }}>
            Daily Run Rate = average units sold per day over the last N full days (ending yesterday). This is global — it sets the DRR shown on Products and the metric other systems read.
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--t3)' }}>Days (1–365)</span>
              <input className="so-input" type="number" min={1} max={365} style={{ width: 120 }} value={drrDays} onChange={e => setDrrDays(e.target.value)} />
            </label>
            <button className="so-btn" onClick={saveDrr} disabled={String(drrDays) === String(boot.drr_window_days)}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
