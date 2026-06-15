'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  inputStyle, selectStyle, labelStyle, btnPrimary, StatusBadge,
} from '../../../../lib/manifestui.js';

export default function UsersPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sf, setSf] = useState({ email: '', full_name: '', role_key: 'sf_owner' });

  async function load() {
    const [u, r] = await Promise.all([garageFetch('getUsers', {}, session), garageFetch('getRoles', {}, session)]);
    setUsers(u || []); setRoles(r || []); setLoading(false);
  }
  useEffect(() => { if (session) load(); }, [session]);

  async function setRole(user_id, role_key) {
    const r = await workerFetch('setUserRole', { data: { user_id, role_key: role_key || null } }, session);
    if (r.ok) load(); else toast.error(r.error);
  }
  async function onboard() {
    if (!sf.email) { toast.error('Email required'); return; }
    const r = await workerFetch('onboardSfUser', { data: sf }, session);
    if (r.ok) { toast.success(`Onboarded ${sf.email}`); setSf({ email: '', full_name: '', role_key: 'sf_owner' }); load(); } else toast.error(r.error);
  }

  const sfRoles = roles.filter(r => r.party === 'SF');

  return (
    <div>
      <div style={{ marginBottom: 16 }}><h1 style={pageH1}>Users</h1><div style={pageSub}>Assign Manifest roles · onboard external Solve Factory owners</div></div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Onboard a Solve Factory owner (external)</span></div>
        <div style={{ ...panelBodyStyle }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>
            First have them request a login link on the sign-in screen (email tab). Then onboard their email here to create their profile + assign an SF role.
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <div><label style={labelStyle}>Email</label><input style={{ ...inputStyle, minWidth: 220 }} value={sf.email} onChange={e => setSf(s => ({ ...s, email: e.target.value }))} placeholder="owner@solvefactory.com" /></div>
            <div><label style={labelStyle}>Name</label><input style={inputStyle} value={sf.full_name} onChange={e => setSf(s => ({ ...s, full_name: e.target.value }))} /></div>
            <div><label style={labelStyle}>Role</label><select style={selectStyle} value={sf.role_key} onChange={e => setSf(s => ({ ...s, role_key: e.target.value }))}>{(sfRoles.length ? sfRoles : [{ role_key: 'sf_owner', label: 'Solve Factory Owner' }]).map(r => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}</select></div>
            <button style={btnPrimary} onClick={onboard}>Onboard</button>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Users ({users.length})</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={tableThStyle}>Name</th><th style={tableThStyle}>LOT role</th><th style={tableThStyle}>Active</th><th style={tableThStyle}>Manifest role</th></tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={4}>Loading…</td></tr>}
              {!loading && users.map(u => (
                <tr key={u.id}>
                  <td style={tableTdStyle}>{u.full_name || u.id}</td>
                  <td style={tableTdStyle}>{u.role || '—'}</td>
                  <td style={tableTdStyle}>{u.active ? <StatusBadge label="active" tone="green" /> : <StatusBadge label="inactive" tone="gray" />}</td>
                  <td style={tableTdStyle}>
                    <select style={{ ...selectStyle, padding: '3px 6px' }} value={u.manifest_role || ''} onChange={e => setRole(u.id, e.target.value)}>
                      <option value="">— none —</option>
                      {roles.map(r => <option key={r.role_key} value={r.role_key}>{r.label} ({r.party})</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
