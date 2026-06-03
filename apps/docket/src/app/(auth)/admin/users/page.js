'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';

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
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={h1}>Users</h1>
        <p style={sub}>Assign a Docket role to each LOT user. Accounts are created in Garage — this only sets task-manager access. No role = baseline (own + collaborator + own-team tasks).</p>
      </div>

      <div style={card}>
        <div style={cardHead}>
          <span>LOT Users {users.length > 0 && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>({users.length})</span>}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email…" style={search} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? <div style={{ padding: 24 }}><Spinner /></div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Name</th><th style={th}>Email</th><th style={th}>Docket Role</th><th style={th}>Assign</th>
              </tr></thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} style={{ opacity: u.active === false ? 0.5 : 1 }}>
                    <td style={td}>{u.full_name || '—'}</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{u.email || '—'}</td>
                    <td style={td}>
                      {u.docket_role ? <span style={badgeKey}>{u.docket_role}</span> : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>baseline (default)</span>}
                    </td>
                    <td style={td}>
                      <select value={u.docket_role || ''} disabled={savingId === u.id} onChange={(e) => assign(u.id, e.target.value)} style={select}>
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

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, maxWidth: 640, lineHeight: 1.5 };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' };
const cardHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700, color: 'var(--text-1)' };
const search = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 10px', fontSize: 12, color: 'var(--text-1)', outline: 'none', width: 240 };
const th = { textAlign: 'left', padding: '9px 14px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '9px 14px', fontSize: 13, color: 'var(--text-1)', borderBottom: '1px solid var(--border)' };
const select = { minWidth: 190, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: 12, outline: 'none' };
const badgeKey = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--state-info-fg)', background: 'var(--state-info-bg)', borderRadius: 'var(--radius-sm)', padding: '2px 7px' };
