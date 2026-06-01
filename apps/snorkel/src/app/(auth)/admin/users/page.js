'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, tableThStyle, tableTdStyle, selectStyle, btnSecondary,
  pageH1, pageSub, StatusBadge,
} from '@/lib/snorkelui';

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
        garageFetch('getSnorkelUsers', {}, session).catch(() => []),
        garageFetch('getSnorkelRoles', {}, session).catch(() => []),
      ]);
      setUsers(Array.isArray(u) ? u : []);
      setRoles(Array.isArray(r) ? r : []);
    } finally { setLoading(false); }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  async function assign(userId, roleKey) {
    setSavingId(userId);
    try {
      await workerFetch('assignSnorkelRole', { data: { user_id: userId, role_key: roleKey || '' } }, session);
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, snorkel_role: roleKey || null } : u)));
      showToast('Role updated', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setSavingId(null); }
  }

  if (perms && !perms.snorkel_admin) return <div style={{ padding: 24, color: 'var(--t3)' }}>Admin only.</div>;

  const filtered = q.trim()
    ? users.filter((u) => `${u.full_name} ${u.email} ${u.snorkel_role || ''}`.toLowerCase().includes(q.toLowerCase()))
    : users;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>Users</h1>
        <p style={pageSub}>Assign a Snorkel role to each LOT user. Accounts are created in Garage — this only sets procurement access. No role = can file requests only.</p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>LOT Users {users.length > 0 && <span style={{ color: 'var(--t3)', fontSize: 11 }}>({users.length})</span>}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email…"
                 style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '5px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', width: 240 }} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Name</th>
                <th style={tableThStyle}>Email</th>
                <th style={tableThStyle}>Snorkel Role</th>
                <th style={tableThStyle}>Assign</th>
              </tr></thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} style={{ opacity: u.active === false ? 0.5 : 1 }}>
                    <td style={tableTdStyle}>{u.full_name || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{u.email || '—'}</td>
                    <td style={tableTdStyle}>
                      {u.snorkel_role
                        ? <StatusBadge label={u.snorkel_role} tone="blue" />
                        : <span style={{ fontSize: 11, color: 'var(--t3)' }}>requester (default)</span>}
                    </td>
                    <td style={tableTdStyle}>
                      <select
                        value={u.snorkel_role || ''}
                        disabled={savingId === u.id}
                        onChange={(e) => assign(u.id, e.target.value)}
                        style={{ ...selectStyle, minWidth: 180 }}
                      >
                        <option value="">— none (requester) —</option>
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
