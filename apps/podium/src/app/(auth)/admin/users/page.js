'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Search } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { Avatar, GridHead, GridRow, gridTh } from '../../../../components/ui.js';

const COLS = '2.2fr 1fr 1.3fr 110px';

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
        podiumopsGet('getPodiumUsers', {}, session).catch(() => []),
        podiumopsGet('getPodiumRoles', {}, session).catch(() => []),
      ]);
      setUsers(Array.isArray(u) ? u : []);
      setRoles(Array.isArray(r) ? r : []);
    } finally { setLoading(false); }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  async function assign(userId, roleKey) {
    setSavingId(userId);
    try {
      await podiumopsPost('assignPodiumRole', { data: { user_id: userId, role_key: roleKey || '' } }, session);
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, podium_role: roleKey || null } : u)));
      showToast('Role updated', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setSavingId(null); }
  }

  if (perms && !perms.podium_admin) return <div style={{ color: 'var(--t3)' }}>Requires podium_admin.</div>;

  const filtered = q.trim()
    ? users.filter((u) => `${u.full_name} ${u.email} ${u.podium_role || ''}`.toLowerCase().includes(q.toLowerCase()))
    : users;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--t3)', margin: 0, maxWidth: 560, lineHeight: 1.5 }}>
          Assign a Podium role to each LOT user — this only sets People &amp; Performance access. No role = self-only.
        </p>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: 240, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', color: 'var(--t4)' }}>
          <Search size={14} strokeWidth={1.9} />
          <input data-search-primary value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 12.5 }} />
        </label>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
          <GridHead cols={COLS}>
            <div style={gridTh}>User {users.length > 0 && <span style={{ color: 'var(--t4)' }}>({users.length})</span>}</div>
            <div style={gridTh}>Role</div>
            <div style={gridTh}>Assign</div>
            <div style={gridTh}>Status</div>
          </GridHead>
          {filtered.map((u) => {
            const inactive = u.active === false;
            return (
              <GridRow key={u.id} cols={COLS}>
                <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 11, opacity: inactive ? 0.55 : 1 }}>
                  <Avatar name={u.full_name || u.email} tintKey={u.id} size={32} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{u.full_name || '—'}</div>
                    <div className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{u.email || '—'}</div>
                  </div>
                </div>
                <div style={{ padding: '10px 16px' }}>
                  {u.podium_role
                    ? <span className="num" style={{ fontSize: 10, color: 'var(--info-fg)', background: 'var(--info-bg)', borderRadius: 'var(--r-sm)', padding: '2px 7px' }}>{u.podium_role}</span>
                    : <span style={{ fontSize: 11, color: 'var(--t4)' }}>self-only</span>}
                </div>
                <div style={{ padding: '10px 16px' }}>
                  <select value={u.podium_role || ''} disabled={savingId === u.id} onChange={(e) => assign(u.id, e.target.value)}
                    style={{ width: '100%', minWidth: 150, background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 8px', fontSize: 12, outline: 'none' }}>
                    <option value="">— none (self-only) —</option>
                    {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
                  </select>
                </div>
                <div style={{ padding: '10px 16px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 5, color: inactive ? 'var(--neutral-fg)' : 'var(--ok-fg)', background: inactive ? 'var(--neutral-bg)' : 'var(--ok-bg)', border: `1px solid ${inactive ? 'var(--neutral-bd)' : 'var(--ok-bd)'}` }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: inactive ? 'var(--neutral-fg)' : 'var(--ok-fg)' }} />{inactive ? 'Inactive' : 'Active'}
                  </span>
                </div>
              </GridRow>
            );
          })}
        </div>
      )}
    </div>
  );
}
