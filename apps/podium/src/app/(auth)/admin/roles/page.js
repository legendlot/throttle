'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, ShieldCheck } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';

// Prototype "Permissions" summary cards — one per permission key, with the count
// of people whose assigned role grants it (RULE-PODIUM-001: elevated keys imply view).
const PERM_SUMMARY = [
  { key: 'podium_view',  label: 'Viewer', desc: 'Read-only access to the directory, org chart and departments.', fg: 'var(--blue-soft)' },
  { key: 'podium_hr',    label: 'HR',     desc: 'Manage people, departments, roles and appraisal cycles.',        fg: 'var(--green-bright)' },
  { key: 'podium_admin', label: 'Admin',  desc: 'Full access including users, permissions and settings.',          fg: 'var(--yellow)' },
];

function PermSummary({ roles, users }) {
  const roleMap = {};
  for (const r of roles) roleMap[r.role_key] = r.permissions || {};
  const count = (key) => users.filter(u => u.podium_role && roleMap[u.podium_role]?.[key]).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
      {PERM_SUMMARY.map(p => (
        <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '16px 18px' }}>
          <div style={{ width: 48, height: 48, borderRadius: 11, background: 'var(--bg)', border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <ShieldCheck size={22} color={p.fg} strokeWidth={1.75} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{p.label}</span>
              <span className="num" style={{ fontSize: 11, color: 'var(--t3)', background: 'var(--bg)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: 5 }}>{p.key}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 4 }}>{p.desc}</div>
          </div>
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div className="num" style={{ fontSize: 22, fontWeight: 600, color: 'var(--t1)' }}>{count(p.key)}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t4)' }}>People</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Podium permission matrix — the 4 boolean keys, grouped. Define unlimited custom
// roles from these toggles. Any elevated key implies podium_view (enforced both
// here and server-side — RULE-PODIUM-001 corollary).
const PERM_DEFS = [
  { group: 'Workspace', items: [
    { key: 'podium_view', label: 'View directory, org chart & dashboards' },
  ] },
  { group: 'People', items: [
    { key: 'podium_hr', label: 'Manage people, departments, roles, documents & org snapshots' },
  ] },
  { group: 'Compensation', items: [
    { key: 'podium_comp', label: 'View & edit compensation and salary bands' },
  ] },
  { group: 'Admin', items: [
    { key: 'podium_admin', label: 'Manage Podium roles, assign users & change settings' },
  ] },
];
const ELEVATED = ['podium_hr', 'podium_comp', 'podium_admin'];

export default function RolesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [roles, setRoles] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');      // list | form
  const [editKey, setEditKey] = useState(null);
  const [editIsSystem, setEditIsSystem] = useState(false);
  const [roleKey, setRoleKey] = useState('');
  const [label, setLabel] = useState('');
  const [desc, setDesc] = useState('');
  const [perm, setPerm] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [r, u] = await Promise.all([
        podiumopsGet('getPodiumRoles', {}, session),
        podiumopsGet('getPodiumUsers', {}, session).catch(() => []),
      ]);
      setRoles(Array.isArray(r) ? r : []);
      setUsers(Array.isArray(u) ? u : []);
    } catch (e) { showToast(e.message || 'Failed to load roles', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function startNew() {
    setEditKey(null); setEditIsSystem(false);
    setRoleKey(''); setLabel(''); setDesc(''); setPerm({}); setView('form');
  }
  function startEdit(r) {
    setEditKey(r.role_key); setEditIsSystem(!!r.is_system);
    setRoleKey(r.role_key); setLabel(r.label || ''); setDesc(r.description || '');
    setPerm(r.permissions || {}); setView('form');
  }
  function toggle(k) {
    setPerm((p) => {
      const next = { ...p, [k]: !p[k] };
      // Footgun guard: any elevated key forces podium_view on (mirrors the worker).
      if (ELEVATED.includes(k) && next[k]) next.podium_view = true;
      return next;
    });
  }
  const viewForced = ELEVATED.some((k) => perm[k]); // podium_view locked on

  async function save() {
    if (!label.trim()) { showToast('Label required', 'error'); return; }
    if (!editKey && !roleKey.trim()) { showToast('Role key required', 'error'); return; }
    setSaving(true);
    try {
      const action = editKey ? 'updatePodiumRole' : 'createPodiumRole';
      const data = editKey
        ? { role_key: editKey, label: label.trim(), description: desc || null, permissions: perm }
        : { role_key: roleKey.trim(), label: label.trim(), description: desc || null, permissions: perm };
      await podiumopsPost(action, { data }, session);
      showToast(editKey ? 'Role updated' : 'Role created', 'success');
      setView('list'); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  async function del(r) {
    if (!confirm(`Delete role "${r.label}"?`)) return;
    try {
      await podiumopsPost('deletePodiumRole', { data: { role_key: r.role_key } }, session);
      showToast('Role deleted', 'success'); load();
    } catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  if (perms && !perms.podium_admin) return <div style={{ color: 'var(--text-3)' }}>Requires podium_admin.</div>;

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={h1}>Roles &amp; Permissions</h1>
          <p style={sub}>Podium-only permission roles. Assign people to roles on the Users page. No role = self-only (own profile + own wins).</p>
        </div>
        {view === 'list'
          ? <button style={btnPrimary} onClick={startNew}><Plus size={14} /> New Role</button>
          : <button style={btnSecondary} onClick={() => setView('list')}><ArrowLeft size={14} /> Back to roles</button>}
      </div>

      {view === 'list' ? (
        loading ? <Spinner /> : (
          <>
          <PermSummary roles={roles} users={users} />
          <div style={{ ...lbl, marginBottom: 10 }}>Custom roles</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {roles.map((r) => (
              <div key={r.role_key} style={card}>
                <div style={cardHead}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {r.label}
                    {r.is_system && <span style={badgeGray}>system</span>}
                  </span>
                  <span style={mono}>{r.role_key}</span>
                </div>
                <div style={{ padding: '12px 14px' }}>
                  {r.description && <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>{r.description}</div>}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                    {Object.entries(r.permissions || {}).filter(([, v]) => v).map(([k]) => (
                      <span key={k} style={badgeKey}>{k}</span>
                    ))}
                    {Object.values(r.permissions || {}).filter(Boolean).length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>No elevated permissions (self-only)</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={btnSecondary} onClick={() => startEdit(r)}>Edit</button>
                    {!r.is_system && <button style={btnDanger} onClick={() => del(r)}>Delete</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          </>
        )
      ) : (
        <div style={card}>
          <div style={cardHead}><span>{editKey ? `Edit ${editKey}` : 'New Role'}</span></div>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: editKey ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 12 }}>
              {!editKey && (
                <div>
                  <span style={lbl}>Role Key *</span>
                  <input value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="e.g. hr_lead"
                         style={{ ...input, fontFamily: 'var(--font-mono)' }} disabled={saving} />
                </div>
              )}
              <div>
                <span style={lbl}>Label *</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} style={input} disabled={saving} />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <span style={lbl}>Description</span>
              <input value={desc} onChange={(e) => setDesc(e.target.value)} style={input} disabled={saving} />
            </div>

            {editIsSystem && (
              <div style={noteBox}>
                <ShieldCheck size={14} /> System role — permissions are fixed. You can edit the label and description only.
              </div>
            )}

            {PERM_DEFS.map((g) => (
              <div key={g.group} style={{ marginBottom: 14 }}>
                <div style={{ ...lbl, marginBottom: 6 }}>{g.group}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.items.map((it) => {
                    const forced = it.key === 'podium_view' && viewForced;
                    const on = !!perm[it.key];
                    const disabled = saving || editIsSystem || forced;
                    return (
                      <div key={it.key} style={permRow}>
                        <span style={{ fontSize: 13 }}>
                          {it.label} <span style={mono}>· {it.key}</span>
                          {forced && <span style={{ fontSize: 11, color: 'var(--text-3)' }}> — required by elevated access</span>}
                        </span>
                        <button type="button" style={toggleBtn(on)} onClick={() => toggle(it.key)} disabled={disabled}>
                          {on ? 'On' : 'Off'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button style={btnSecondary} onClick={() => setView('list')} disabled={saving}>Cancel</button>
              <button style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>
                {saving ? 'Saving…' : (editKey ? 'Save Role' : 'Create Role')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── styles ──
const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, maxWidth: 620, lineHeight: 1.5 };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' };
const cardHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700, color: 'var(--text-1)' };
const mono = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' };
const lbl = { display: 'block', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 700 };
const input = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, outline: 'none' };
const permRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' };
const noteBox = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--accent-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, color: 'var(--text-2)', marginBottom: 14 };
const badgeGray = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px', textTransform: 'uppercase' };
const badgeKey = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--state-info-fg)', background: 'var(--state-info-bg)', borderRadius: 'var(--radius-sm)', padding: '2px 7px' };

function toggleBtn(on) {
  return {
    background: on ? 'var(--podium-accent)' : 'var(--surface-3)', color: on ? '#1f1f1f' : 'var(--text-3)',
    border: `1px solid ${on ? 'var(--podium-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)',
    padding: '4px 14px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  };
}
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const btnPrimary = { ...btnBase, background: 'var(--podium-accent)', color: '#1f1f1f', border: '1px solid var(--podium-accent)' };
const btnSecondary = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
const btnDanger = { ...btnBase, background: 'transparent', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)' };
