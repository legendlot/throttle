'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast, Combobox } from '@throttle/ui';
import { ShieldCheck } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';

const ORANGE = '#FF6B00';

const cardStyle  = { padding: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 16 };
const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const inputStyle = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--text-1)', outline: 'none', fontFamily: 'inherit' };
const btnPrimary = { background: ORANGE, border: `1px solid ${ORANGE}`, borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--font-cond)', letterSpacing: '0.04em' };
const btnSmall   = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '4px 10px', fontSize: 11, color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'var(--font-cond)' };
const thStyle    = { ...labelStyle, textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' };
const tdStyle    = { padding: '8px', fontSize: 12, borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };

export default function AdminUsersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const canAdmin = !!perms?.ignition_admin;

  const [data, setData] = useState(null);
  const [grantable, setGrantable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pickUser, setPickUser] = useState('');
  const [pickRole, setPickRole] = useState('ignition_manager');

  const load = useCallback(async () => {
    if (!session || !canAdmin) { setLoading(false); return; }
    setLoading(true);
    try {
      const [access, users] = await Promise.all([
        ignitionopsGet('getIgnitionAccess', {}, session),
        ignitionopsGet('getGrantableUsers', {}, session),
      ]);
      setData(access);
      setGrantable(users?.users || []);
    } catch (e) {
      showToast(e.message || 'Failed to load access list', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, canAdmin, showToast]);

  useEffect(() => { load(); }, [load]);

  if (!canAdmin) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Admin only.</div>;
  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const roles = data?.roles || [];
  const users = data?.users || [];
  const roleLabel = (k) => roles.find((r) => r.role_key === k)?.label || k;

  async function grant() {
    if (!pickUser) { showToast('Pick a person', 'error'); return; }
    setBusy(true);
    try {
      await ignitionopsPost('grantIgnitionAccess', { data: { user_id: pickUser, role_key: pickRole } }, session);
      showToast('Access granted', 'success');
      setPickUser('');
      load();
    } catch (e) {
      showToast(e.message || 'Grant failed', 'error');
    } finally { setBusy(false); }
  }

  async function toggle(u) {
    setBusy(true);
    try {
      await ignitionopsPost('setIgnitionUserActive', { data: { user_id: u.user_id, active: !u.active } }, session);
      showToast(u.active ? 'Access revoked' : 'Access restored', 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    } finally { setBusy(false); }
  }

  // Everyone active is grantable — a person's other job (CS, social, production) no
  // longer competes with Ignition access, which is the point of the separate layer.
  const userOptions = grantable
    .filter((u) => !users.some((a) => a.user_id === u.id && a.active))
    .map((u) => ({ value: u.id, label: u.full_name, hint: u.role || '' }));

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>
        Ignition Access
      </h1>
      <p style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 16 }}>
        Ignition access is granted here and nowhere else. It is independent of a person’s
        role in other systems — granting or revoking Ignition never affects their Pitstop,
        Garage or Throttle access.
      </p>

      <div style={cardStyle}>
        <div style={{ ...labelStyle, marginBottom: 10 }}><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> Grant access</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ width: 280 }}>
            <span style={labelStyle}>Person</span>
            <Combobox
              value={pickUser}
              options={userOptions}
              onChange={(v) => setPickUser(v)}
              placeholder="Search anyone in the company…"
              portal
            />
          </div>
          <div>
            <span style={labelStyle}>Role</span>
            <select value={pickRole} onChange={(e) => setPickRole(e.target.value)} style={{ ...inputStyle, cursor: 'pointer', width: 200 }} disabled={busy}>
              {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
            </select>
          </div>
          <button style={btnPrimary} onClick={grant} disabled={busy}>{busy ? 'Saving…' : 'Grant'}</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 10 }}>
          {roles.map((r) => <div key={r.role_key}><strong style={{ color: 'var(--text-2)' }}>{r.label}</strong> — {r.description}</div>)}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ ...labelStyle, marginBottom: 10 }}>Who has access ({users.filter((u) => u.active).length} active)</div>
        {!users.length ? (
          <EmptyState title="Nobody has Ignition access yet" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Ignition role</th>
                <th style={thStyle}>Their other role</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.user_id} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td style={tdStyle}>{u.full_name || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', color: ORANGE }}>{roleLabel(u.role_key)}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{u.global_role || '—'}</td>
                  <td style={tdStyle}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: u.active ? '#4ade80' : 'var(--text-3)' }}>
                      {u.active ? 'Active' : 'Revoked'}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button style={btnSmall} onClick={() => toggle(u)} disabled={busy}>
                      {u.active ? 'Revoke' : 'Restore'}
                    </button>
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
