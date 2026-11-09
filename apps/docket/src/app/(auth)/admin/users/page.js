'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { Lock, Search } from 'lucide-react';
import { EmptyState } from '../../../../components/ui/index.js';
import { AdminHead } from '../../../../components/AdminParts.js';
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

  if (perms && !perms.docket_admin) return <div className="adm"><EmptyState icon={Lock} title="Admins only" body="Requires docket_admin." /></div>;

  const filtered = q.trim()
    ? users.filter((u) => `${u.full_name} ${u.email} ${u.docket_role || ''}`.toLowerCase().includes(q.toLowerCase()))
    : users;

  return (
    <div className="adm wide">
      <AdminHead title="Users"
        lede="Assign a Docket role to each LOT user. Accounts are created in Garage; this only sets task-manager access. No role = baseline (own + collaborator + own-team tasks)." />

      <section className="adm-card">
        <div className="adm-card-h">
          <span>LOT users <span className="adm-count">{users.length || ''}</span></span>
          <span className="adm-search"><Search size={14} aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email…" aria-label="Search users" /></span>
        </div>
        {loading ? <div className="adm-card-b"><Spinner /></div> : (
          <div className="dtable-wrap">
            <table className="dtable">
              <thead><tr><th>Person</th><th className="dt-email">Email</th><th>Role</th><th className="ctr dt-status">Status</th><th className="dt-assign">Assign</th></tr></thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className={u.active === false ? 'inactive' : ''}>
                    <td><span className="dtable-name"><Avatar name={u.full_name} size={22} />{u.full_name || '—'}</span></td>
                    <td className="dt-email mono">{u.email || '—'}</td>
                    <td>{u.docket_role ? <span className="adm-key">{u.docket_role}</span> : <span className="adm-item-sub">baseline</span>}</td>
                    <td className="ctr dt-status"><span className="pill-on">Active</span></td>
                    <td className="dt-assign">
                      <select value={u.docket_role || ''} disabled={savingId === u.id} onChange={(e) => assign(u.id, e.target.value)} className="adm-select" aria-label={`Docket role for ${u.full_name || 'user'}`}>
                        <option value="">— none (baseline) —</option>
                        {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={5} className="dtable-none">{q.trim() ? 'No users match.' : 'No users.'}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
