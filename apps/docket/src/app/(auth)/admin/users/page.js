'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { AdminTabs } from '../../../../components/AdminTabs.js';
import { Avatar } from '../../../../components/primitives.js';

export default function UsersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [u, r] = await Promise.all([
        docketopsGet('getDocketUsers', {}, session).catch(() => []),
        docketopsGet('getDocketRoles', {}, session).catch(() => []),
      ]);
      setUsers(Array.isArray(u) ? u : []);
      setRoles(Array.isArray(r) ? r : []);
    } finally { setLoading(false); }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  async function assign(userId, roleKey) {
    setSavingId(userId);
    try {
      await docketopsPost('assignDocketRole', { data: { user_id: userId, role_key: roleKey || '' } }, session);
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, docket_role: roleKey || null } : u)));
      showToast('Role updated', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setSavingId(null); }
  }

  if (perms && !perms.docket_admin) return <div style={{ color: 'var(--text-3)' }}>Requires docket_admin.</div>;

  const filtered = q.trim()
    ? users.filter((u) => `${u.full_name} ${u.email} ${u.docket_role || ''}`.toLowerCase().includes(q.toLowerCase()))
    : users;

  return (
    <div className="screen">
      <AdminTabs />
      <div className="screen-head"><p>Assign a Docket role to each LOT user. Accounts are created in Garage; this only sets task-manager access. No role = baseline (own + collaborator + own-team tasks).</p></div>

      <div className="panel" style={{ padding: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'var(--f-display)', fontWeight: 600, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
            LOT Users {users.length > 0 && <span style={{ color: 'var(--text-4)' }}>· {users.length}</span>}
          </span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email…" className="date-input" style={{ width: 240 }} />
        </div>
        <div style={{ padding: '8px 18px 14px' }}>
          {loading ? <div style={{ padding: 24 }}><Spinner /></div> : (
            <table className="dtable">
              <thead><tr><th>Person</th><th>Email</th><th>Role</th><th className="ctr">Status</th><th style={{ width: 210 }}>Assign</th></tr></thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} style={{ opacity: u.active === false ? 0.5 : 1 }}>
                    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: 'var(--text-1)' }}><Avatar name={u.full_name} size={24} />{u.full_name || '—'}</span></td>
                    <td style={{ fontFamily: 'var(--f-mono)', fontSize: 12, color: 'var(--text-3)' }}>{u.email || '—'}</td>
                    <td>{u.docket_role ? <span style={badgeKey}>{u.docket_role}</span> : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>baseline</span>}</td>
                    <td className="ctr"><span className="pill-on">Active</span></td>
                    <td>
                      <select value={u.docket_role || ''} disabled={savingId === u.id} onChange={(e) => assign(u.id, e.target.value)} className="date-input" style={{ cursor: 'pointer' }}>
                        <option value="">— none (baseline) —</option>
                        {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const badgeKey = { fontFamily: 'var(--f-mono)', fontSize: 10, color: 'var(--st-progress)', background: 'var(--st-progress-bg)', borderRadius: 'var(--r-sm)', padding: '2px 7px' };
