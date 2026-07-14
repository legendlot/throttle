'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
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

  // grant form
  const [person, setPerson] = useState(null);   // { user_id, full_name, email }
  const [personVal, setPersonVal] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [userOpts, setUserOpts] = useState([]);  // searchable LOT-people directory

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

  const searchUsers = (q) => {
    if (!q || q.trim().length < 2) { setUserOpts([]); return; }
    garageFetch('searchUsers', { q: q.trim() }, session)
      .then((r) => setUserOpts((r?.rows || []).map((u) => ({
        value: u.id, label: u.full_name, hint: u.email, full_name: u.full_name, email: u.email,
      }))))
      .catch(() => setUserOpts([]));
  };

  function pickPerson(val, opt) {
    setPersonVal(val);
    const o = opt || userOpts.find((x) => x.value === val);
    setPerson(o ? { user_id: o.value, full_name: o.full_name, email: o.email } : null);
  }

  async function grant() {
    if (!person?.user_id) { showToast('Search and pick a person', 'error'); return; }
    if (!roleKey) { showToast('Pick a role', 'error'); return; }
    setSaving(true);
    try {
      await workerFetch('assignUserRole', {
        user_id: person.user_id, role_key: roleKey, active: true, full_name: person.full_name,
      }, session);
      showToast('Access granted', 'success');
      setPerson(null); setPersonVal(''); setRoleKey(''); setUserOpts([]);
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setSaving(false); }
  }

  async function toggleActive(a) {
    setSaving(true);
    try {
      await workerFetch('assignUserRole', {
        user_id: a.user_id, role_key: a.role_key, active: !a.active, full_name: a.full_name,
      }, session);
      showToast('Updated', 'success');
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.relay_admin) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Admin only.</div>;

  return (
    <div className="pg">
      <PageHead title="Users" sub="Grant Relay access to LOT people. A legendoftoys.com login alone gives no access — a role must be assigned here." />

      <Panel title="Grant access" pad>
        <div className="form-grid">
          <div className="ff">
            <div className="kv-k">Person</div>
            <Combobox
              value={personVal}
              options={userOpts}
              onQueryChange={searchUsers}
              onChange={pickPerson}
              placeholder="Type a name or email…"
              portal
            />
            {person?.email && <div className="mono dim" style={{ marginTop: 4, fontSize: 12 }}>{person.email}</div>}
          </div>
          <div className="ff">
            <div className="kv-k">Role</div>
            <select className="f-inp" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} disabled={saving}>
              <option value="">— pick a role —</option>
              {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label} ({r.role_key})</option>)}
            </select>
          </div>
        </div>
        <div className="form-foot">
          <Btn kind="primary" onClick={grant} disabled={saving || !person?.user_id || !roleKey}><Plus size={14} /> {saving ? 'Saving…' : 'Grant access'}</Btn>
        </div>
      </Panel>

      <Panel title="Access list" count={assignments.length}>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : assignments.length === 0
            ? <div style={{ padding: 24, color: 'var(--text-3)' }}>No one has been granted access yet.</div>
            : (
              <table className="dt">
                <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Assigned</th><th>Toggle</th></tr></thead>
                <tbody>
                  {assignments.map((a, i) => (
                    <tr key={`${a.user_id}-${a.role_key}-${i}`} style={{ opacity: a.active ? 1 : 0.5 }}>
                      <td>{a.full_name || <span className="mono dim">{a.user_id}</span>}</td>
                      <td className="mono dim">{a.email || '—'}</td>
                      <td><Badge label={a.role_label || a.role_key} tone="blue" /></td>
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
