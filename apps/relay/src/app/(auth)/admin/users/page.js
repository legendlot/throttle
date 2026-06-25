'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Check } from 'lucide-react';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';

export default function UsersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [assignments, setAssignments] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // assign form
  const [userId, setUserId] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [active, setActive] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [u, r] = await Promise.all([
        garageFetch('getUserRoles', {}, session).catch(() => []),
        garageFetch('getRoles', {}, session).catch(() => []),
      ]);
      setAssignments(Array.isArray(u) ? u : []);
      setRoles(Array.isArray(r) ? r : []);
    } finally { setLoading(false); }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  async function assign() {
    if (!userId.trim()) { showToast('User ID required', 'error'); return; }
    if (!roleKey) { showToast('Pick a role', 'error'); return; }
    setSaving(true);
    try {
      await workerFetch('assignUserRole', { user_id: userId.trim(), role_key: roleKey, active }, session);
      showToast('Role assigned', 'success');
      setUserId(''); setRoleKey(''); setActive(true);
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setSaving(false); }
  }

  async function toggleActive(a) {
    setSaving(true);
    try {
      await workerFetch('assignUserRole', { user_id: a.user_id, role_key: a.role_key, active: !a.active }, session);
      showToast('Updated', 'success');
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.relay_admin) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Admin only.</div>;

  return (
    <div className="pg">
      <PageHead title="Users" sub="Assign Relay roles to LOT users by their user ID." />

      <Panel title="Assign a role" pad>
        <div className="form-grid">
          <div className="ff">
            <div className="kv-k">User ID (UUID)</div>
            <input className="f-inp mono" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" disabled={saving} />
          </div>
          <div className="ff">
            <div className="kv-k">Role</div>
            <select className="f-inp" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} disabled={saving}>
              <option value="">— pick a role —</option>
              {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label} ({r.role_key})</option>)}
            </select>
          </div>
          <div className="ff">
            <div className="kv-k">Active</div>
            <button className={`tgl ${active ? 'on' : ''}`} onClick={() => setActive(a => !a)} disabled={saving} style={{ alignSelf: 'flex-start' }}>
              <span className="tgl-knob" /><span className="tgl-txt">{active ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        </div>
        <div className="form-foot">
          <Btn kind="primary" onClick={assign} disabled={saving}><Plus size={14} /> {saving ? 'Saving…' : 'Assign role'}</Btn>
        </div>
      </Panel>

      <Panel title="Role assignments" count={assignments.length}>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : assignments.length === 0
            ? <div style={{ padding: 24, color: 'var(--text-3)' }}>No assignments yet.</div>
            : (
              <table className="dt">
                <thead><tr><th>User ID</th><th>Role</th><th>Status</th><th>Assigned</th><th>Toggle</th></tr></thead>
                <tbody>
                  {assignments.map((a, i) => (
                    <tr key={`${a.user_id}-${a.role_key}-${i}`} style={{ opacity: a.active ? 1 : 0.5 }}>
                      <td className="mono dim">{a.user_id}</td>
                      <td><Badge label={a.role_key} tone="blue" /></td>
                      <td>{a.active ? <Badge label="active" tone="green" /> : <Badge label="inactive" tone="gray" />}</td>
                      <td className="mono dim">{fmtDate(a.assigned_at)}</td>
                      <td><Btn onClick={() => toggleActive(a)} disabled={saving}><Check size={14} /> {a.active ? 'Deactivate' : 'Activate'}</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </Panel>
    </div>
  );
}
