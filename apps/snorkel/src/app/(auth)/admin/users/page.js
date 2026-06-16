'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Kpi, Panel, Badge } from '@/components/ui.js';

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

  if (perms && !perms.snorkel_admin) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Admin only.</div>;

  const filtered = q.trim()
    ? users.filter((u) => `${u.full_name} ${u.email} ${u.snorkel_role || ''}`.toLowerCase().includes(q.toLowerCase()))
    : users;
  const assigned = users.filter((u) => u.snorkel_role).length;

  return (
    <div className="pg">
      <PageHead title="Users" sub="Assign a Snorkel role to each LOT user. No role means they can file requests only." />

      <div className="kpi-row kpi-3">
        <Kpi label="LOT users" value={users.length} sub="with access" tone="blue" />
        <Kpi label="Assigned" value={assigned} sub="have a role" tone="green" />
        <Kpi label="Requesters" value={users.length - assigned} sub="default access" tone="gray" />
      </div>

      <Panel title="LOT Users" count={users.length}
        action={<input className="sel" data-search-primary value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email · /" style={{ minWidth: 220 }} />}>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : (
            <table className="dt">
              <thead><tr><th>Name</th><th>Email</th><th>Snorkel role</th><th>Assign</th></tr></thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} style={{ opacity: u.active === false ? 0.5 : 1 }}>
                    <td>{u.full_name || '—'}{u.active === false && <span className="rev">inactive</span>}</td>
                    <td className="mono dim">{u.email || '—'}</td>
                    <td>{u.snorkel_role ? <Badge label={u.snorkel_role} tone="blue" /> : <span className="dim">requester (default)</span>}</td>
                    <td>
                      <select className="sel" value={u.snorkel_role || ''} disabled={savingId === u.id} onChange={(e) => assign(u.id, e.target.value)} style={{ minWidth: 180 }}>
                        <option value="">— none (requester) —</option>
                        {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
