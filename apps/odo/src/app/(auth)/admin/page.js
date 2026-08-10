'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { salesGet, salesPost } from '../../../lib/api.js';
import { PageHead, PanelHead, Pill, Swatch } from '../../../components/prism.js';
import { HUE_CYCLE, STATUS, rgb } from '../../../lib/hues.js';

const PERM_KEYS = [
  ['sales_view', 'View dashboard + export'],
  ['sales_refresh', 'Trigger refresh-now'],
  ['sales_upload', 'Upload QC reports'],
  ['sales_mapping_manage', 'Manage SKU mapping'],
  ['sales_connector_manage', 'Manage connectors / backfill'],
  ['salesops_admin', 'Admin'],
  ['salesops_super_admin', 'Super admin (governs access)'],
];

// Stable per-role hue so a person's avatar and their role chip always read as the same colour —
// identity you can scan without reading. Derived from the role list order, not a new token.
const hueAt = (i) => HUE_CYCLE[i % HUE_CYCLE.length];

export default function AdminPage() {
  const { session, perms } = useAuth();
  const toast = useToast();
  const [boot, setBoot] = useState(null);
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
  const roleHue = Object.fromEntries(roles.map((r, i) => [r.role_key, hueAt(i)]));

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

  const drrDirty = String(drrDays) !== String(boot.drr_window_days);

  return (
    <div className="so-page" style={{ maxWidth: 1180 }}>
      <PageHead title="Admin" sub="Who can see Odo, what they can do, and the settings every page reads from" />

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* ── Users ── */}
        <div className="so-card flush">
          <PanelHead title="Users" qual={`(${users.length})`} style={{ marginBottom: isSuper ? 10 : 0 }} />
          {isSuper && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', padding: '0 18px 14px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 220 }}>
                <span className="so-eyebrow">Grant access — search person</span>
                <Combobox value={grant.email} options={userOpts} onQueryChange={searchUsers} onChange={(val) => setGrant(g => ({ ...g, email: val }))} placeholder="Type a name or email…" portal />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="so-eyebrow">Role</span>
                <select className="so-select" value={grant.role_key} onChange={e => setGrant(g => ({ ...g, role_key: e.target.value }))}>
                  <option value="">— role —</option>
                  {roles.map(r => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
                </select>
              </label>
              <button className="so-btn" onClick={doGrant} disabled={!grant.email || !grant.role_key}>Grant</button>
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table className="so-table">
              <thead><tr><th>User</th><th>Role</th><th>Status</th>{isSuper && <th className="so-num"></th>}</tr></thead>
              <tbody>
                {users.map(u => {
                  const h = roleHue[u.role_key] || HUE_CYCLE[7];
                  const initial = (u.full_name || '—').trim().charAt(0).toUpperCase();
                  return (
                    <tr key={u.user_id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 27, height: 27, flex: 'none', borderRadius: 8, background: `rgba(${rgb(h)},.16)`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 11.5, color: h }}>{initial}</div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t1)' }}>{u.full_name}</div>
                            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t5)' }}>{u.role_key}</div>
                          </div>
                        </div>
                      </td>
                      <td><Pill color={h}>{u.role_label}</Pill></td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11, color: u.active ? STATUS.good : STATUS.bad }}>
                          <span className="so-dot" style={{ width: 6, height: 6, background: u.active ? STATUS.good : STATUS.bad }} />
                          {u.active ? 'active' : 'disabled'}
                        </span>
                      </td>
                      {isSuper && <td className="so-num"><button className="so-btn ghost" style={{ padding: '5px 10px' }} onClick={() => toggleUser(u)}>{u.active ? 'Disable' : 'Enable'}</button></td>}
                    </tr>
                  );
                })}
                {users.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No users provisioned.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Settings ── the knobs other pages read from ── */}
        <div className="so-card">
          <PanelHead title="Settings" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 0', borderBottom: '1px solid var(--border-table)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t1)', fontWeight: 500 }}>DRR window · default</div>
              <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--t3)', marginTop: 2, lineHeight: 1.45 }}>
                Daily Run Rate = average units sold per day over the last N full days (ending yesterday). <b>Products no longer uses this</b> — since 2026-08-10 that page divides by whatever range you pick, so DRR sits on the same period as the Units and Gross beside it. This stays the fallback for any caller that asks for DRR without naming a window.
              </div>
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', fontFamily: 'var(--mono)', fontSize: 12.5,
              fontWeight: 600, color: 'var(--accent)', background: 'rgba(242,205,26,.11)', border: '1px solid rgba(242,205,26,.3)',
              borderRadius: 8, padding: '5px 10px' }}>
              <input type="number" min={1} max={365} value={drrDays} onChange={e => setDrrDays(e.target.value)}
                aria-label="DRR window days (1–365)" title="1–365"
                style={{ width: 38, background: 'transparent', border: 'none', outline: 'none', textAlign: 'right',
                  fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }} />
              days
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="so-btn" onClick={saveDrr} disabled={!drrDirty}>Save</button>
          </div>
        </div>
      </div>

      {/* ── Roles & permissions ── */}
      <div className="so-card flush">
        <PanelHead title="Roles & permissions" qual={`(${roles.length})`} style={{ marginBottom: 0 }}
          right={isSuper ? <button className="so-btn" onClick={() => setEditRole({ role_key: '', label: '', permissions: { sales_view: true } })}>+ New role</button> : null} />
        <div style={{ overflowX: 'auto' }}>
          <table className="so-table">
            <thead><tr><th>Role</th><th>Key</th><th>Permissions</th><th className="so-num"></th></tr></thead>
            <tbody>
              {roles.map((r, i) => {
                const h = hueAt(i);
                const granted = Object.keys(r.permissions || {}).filter(k => r.permissions[k]);
                return (
                  <tr key={r.role_key}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Swatch color={h} />
                        <span style={{ fontFamily: 'var(--ui)', fontWeight: 600, color: 'var(--t1)' }}>{r.label}</span>
                        {r.is_system && <Pill>system</Pill>}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{r.role_key}</td>
                    <td>
                      {granted.length === 0
                        ? <span className="so-null">—</span>
                        : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {granted.map(k => <Pill key={k} color="var(--t2-cell)" style={{ borderRadius: 'var(--r-pill)' }}>{k}</Pill>)}
                          </div>}
                    </td>
                    <td className="so-num">
                      <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                        {isSuper && !r.is_system && <button className="so-btn ghost" style={{ padding: '5px 10px' }} onClick={() => setEditRole({ role_key: r.role_key, label: r.label, description: r.description, permissions: { ...(r.permissions || {}) } })}>Edit</button>}
                        {isSuper && !r.is_system && <button className="so-btn ghost" style={{ padding: '5px 10px' }} onClick={() => delRole(r.role_key)}>Delete</button>}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {roles.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No roles defined.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editRole && (
        <div className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PanelHead title={editRole.role_key ? `Edit role` : 'New role'} qual={editRole.role_key ? `· ${editRole.role_key}` : undefined} style={{ marginBottom: 0 }} />
          {!editRole.role_key && <input className="so-input" placeholder="role_key (e.g. ops)" value={editRole.role_key} onChange={e => setEditRole(r => ({ ...r, role_key: e.target.value.toLowerCase().replace(/\s+/g, '_') }))} />}
          <input className="so-input" placeholder="Label" value={editRole.label || ''} onChange={e => setEditRole(r => ({ ...r, label: e.target.value }))} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 8 }}>
            {PERM_KEYS.map(([k, lbl]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t2)' }}>
                <input type="checkbox" checked={!!editRole.permissions?.[k]} onChange={e => setEditRole(r => ({ ...r, permissions: { ...r.permissions, [k]: e.target.checked } }))} />
                {lbl}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t5)' }}>{k}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="so-btn" onClick={saveRole} disabled={!editRole.role_key || !editRole.label}>Save role</button>
            <button className="so-btn ghost" onClick={() => setEditRole(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
