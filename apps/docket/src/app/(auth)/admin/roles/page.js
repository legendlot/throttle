'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, ArrowLeft, ShieldCheck, LayoutDashboard, X, Globe } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';

// Docket permission matrix — 2 boolean keys. Define unlimited custom roles from
// these toggles. docket_admin implies docket_view_all (enforced here + server-side).
const PERM_DEFS = [
  { group: 'Visibility', items: [
    { key: 'docket_view_all', label: 'See all org tasks + the review dashboard' },
  ] },
  { group: 'Admin', items: [
    { key: 'docket_admin', label: 'Manage roles, assign users & edit/abandon any task' },
  ] },
];
const ELEVATED = ['docket_admin'];

export default function RolesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
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
      const r = await docketopsGet('getDocketRoles', {}, session);
      setRoles(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load roles', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function startNew() { setEditKey(null); setEditIsSystem(false); setRoleKey(''); setLabel(''); setDesc(''); setPerm({}); setView('form'); }
  function startEdit(r) { setEditKey(r.role_key); setEditIsSystem(!!r.is_system); setRoleKey(r.role_key); setLabel(r.label || ''); setDesc(r.description || ''); setPerm(r.permissions || {}); setView('form'); }
  function toggle(k) {
    setPerm((p) => {
      const next = { ...p, [k]: !p[k] };
      if (ELEVATED.includes(k) && next[k]) next.docket_view_all = true; // footgun guard
      return next;
    });
  }
  const viewForced = ELEVATED.some((k) => perm[k]);

  async function save() {
    if (!label.trim()) { showToast('Label required', 'error'); return; }
    if (!editKey && !roleKey.trim()) { showToast('Role key required', 'error'); return; }
    setSaving(true);
    try {
      const action = editKey ? 'updateDocketRole' : 'createDocketRole';
      const data = editKey
        ? { role_key: editKey, label: label.trim(), description: desc || null, permissions: perm }
        : { role_key: roleKey.trim(), label: label.trim(), description: desc || null, permissions: perm };
      await docketopsPost(action, { data }, session);
      showToast(editKey ? 'Role updated' : 'Role created', 'success');
      setView('list'); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }
  async function del(r) {
    if (!confirm(`Delete role "${r.label}"?`)) return;
    try { await docketopsPost('deleteDocketRole', { data: { role_key: r.role_key } }, session); showToast('Role deleted', 'success'); load(); }
    catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  if (perms && !perms.docket_admin) return <div style={{ color: 'var(--text-3)' }}>Requires docket_admin.</div>;

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={h1}>Roles &amp; Permissions</h1>
          <p style={sub}>Docket-only permission roles. Assign people on the Users page. No role = baseline (own + collaborator + own-team tasks).</p>
        </div>
        {view === 'list'
          ? <button style={btnPrimary} onClick={startNew}><Plus size={14} /> New Role</button>
          : <button style={btnSecondary} onClick={() => setView('list')}><ArrowLeft size={14} /> Back to roles</button>}
      </div>

      {view === 'list' ? (
        <>
          <DashboardSharingCard session={session} />
          <div style={{ ...lbl, marginBottom: 8 }}>Roles</div>
          {loading ? <Spinner /> : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {roles.map((r) => (
              <div key={r.role_key} style={card}>
                <div style={cardHead}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{r.label}{r.is_system && <span style={badgeGray}>system</span>}</span>
                  <span style={mono}>{r.role_key}</span>
                </div>
                <div style={{ padding: '12px 14px' }}>
                  {r.description && <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>{r.description}</div>}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                    {Object.entries(r.permissions || {}).filter(([, v]) => v).map(([k]) => <span key={k} style={badgeKey}>{k}</span>)}
                    {Object.values(r.permissions || {}).filter(Boolean).length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Baseline (own + team tasks)</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={btnSecondary} onClick={() => startEdit(r)}>Edit</button>
                    {!r.is_system && <button style={btnDanger} onClick={() => del(r)}>Delete</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          )}
        </>
      ) : (
        <div style={card}>
          <div style={cardHead}><span>{editKey ? `Edit ${editKey}` : 'New Role'}</span></div>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: editKey ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 12 }}>
              {!editKey && (
                <div>
                  <span style={lbl}>Role Key *</span>
                  <input value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="e.g. team_lead" style={{ ...input, fontFamily: 'var(--font-mono)' }} disabled={saving} />
                </div>
              )}
              <div><span style={lbl}>Label *</span><input value={label} onChange={(e) => setLabel(e.target.value)} style={input} disabled={saving} /></div>
            </div>
            <div style={{ marginBottom: 16 }}><span style={lbl}>Description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} style={input} disabled={saving} /></div>

            {editIsSystem && <div style={noteBox}><ShieldCheck size={14} /> System role: permissions are fixed. Label &amp; description only.</div>}

            {PERM_DEFS.map((g) => (
              <div key={g.group} style={{ marginBottom: 14 }}>
                <div style={{ ...lbl, marginBottom: 6 }}>{g.group}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.items.map((it) => {
                    const forced = it.key === 'docket_view_all' && viewForced;
                    const on = !!perm[it.key];
                    const disabled = saving || editIsSystem || forced;
                    return (
                      <div key={it.key} style={permRow}>
                        <span style={{ fontSize: 13 }}>
                          {it.label} <span style={mono}>· {it.key}</span>
                          {forced && <span style={{ fontSize: 11, color: 'var(--text-3)' }}> (required by admin)</span>}
                        </span>
                        <button type="button" style={toggleBtn(on)} onClick={() => toggle(it.key)} disabled={disabled}>{on ? 'On' : 'Off'}</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button style={btnSecondary} onClick={() => setView('list')} disabled={saving}>Cancel</button>
              <button style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>{saving ? 'Saving…' : (editKey ? 'Save Role' : 'Create Role')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dashboard sharing (RULE-DOCKET-006) ─────────────────────────────────────
// Decouples who can see the founder dashboard from docket_view_all: a persistent
// "visible to everyone" toggle + per-person grants. Admin-only (page already gated).
function DashboardSharingCard({ session }) {
  const { showToast } = useToast();
  const [pub, setPub] = useState(false);
  const [viewers, setViewers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [s, emps] = await Promise.all([
        docketopsGet('getDashboardSharing', {}, session),
        docketopsGet('getEmployees', {}, session),
      ]);
      setPub(!!s?.public);
      setViewers(Array.isArray(s?.viewers) ? s.viewers : []);
      // Only employees with a login can be granted (grant keys on auth user_id).
      setEmployees((Array.isArray(emps) ? emps : []).filter((e) => e.auth_user_id));
    } catch (e) { showToast(e.message || 'Failed to load dashboard sharing', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  async function togglePublic() {
    setBusy(true);
    try { await docketopsPost('setDashboardPublic', { data: { value: !pub } }, session); setPub((p) => !p); }
    catch (e) { showToast(e.message || 'Failed to update', 'error'); }
    finally { setBusy(false); }
  }
  async function addViewer(userId) {
    if (!userId) return;
    setBusy(true);
    try { await docketopsPost('addDashboardViewer', { data: { user_id: userId } }, session); setPick(''); await load(); }
    catch (e) { showToast(e.message || 'Failed to add', 'error'); }
    finally { setBusy(false); }
  }
  async function removeViewer(userId) {
    setBusy(true);
    try { await docketopsPost('removeDashboardViewer', { data: { user_id: userId } }, session); setViewers((v) => v.filter((x) => x.user_id !== userId)); }
    catch (e) { showToast(e.message || 'Failed to remove', 'error'); }
    finally { setBusy(false); }
  }

  const grantedIds = new Set(viewers.map((v) => v.user_id));
  const pickOpts = employees.filter((e) => !grantedIds.has(e.auth_user_id)).map((e) => ({ value: e.auth_user_id, label: e.full_name }));

  return (
    <div style={{ ...card, marginBottom: 22 }}>
      <div style={cardHead}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><LayoutDashboard size={15} /> Dashboard sharing</span>
      </div>
      <div style={{ padding: '14px 16px' }}>
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5, maxWidth: 620 }}>
          Who can open the founder review <b>Dashboard</b>. Independent of all-tasks visibility — granted people
          see the org-wide dashboard but still only their own/team/collaborator tasks when they click through.
        </p>

        {loading ? <Spinner /> : (
          <>
            <div style={permRow}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <Globe size={14} /> Visible to everyone
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· every current and future employee</span>
              </span>
              <button type="button" style={toggleBtn(pub)} onClick={togglePublic} disabled={busy}>{pub ? 'On' : 'Off'}</button>
            </div>

            <div style={{ marginTop: 16, opacity: pub ? 0.5 : 1 }}>
              <div style={{ ...lbl, marginBottom: 6 }}>Specific people</div>
              {pub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>Everyone already has access; these grants are kept for when “Visible to everyone” is turned off.</div>}
              <div style={{ maxWidth: 320, marginBottom: 10 }}>
                <Combobox value={pick} options={pickOpts} placeholder="Add a person…" allowClear
                  onChange={(v, opt) => { if (opt) addViewer(v); }} style={input} />
              </div>
              {viewers.length === 0
                ? <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No individual grants. {pub ? '' : 'Only roles with “See all org tasks + the review dashboard” can see it.'}</div>
                : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {viewers.map((v) => (
                      <span key={v.user_id} style={viewerChip}>
                        {v.full_name || v.user_id}
                        <button type="button" onClick={() => removeViewer(v.user_id)} disabled={busy} style={chipX} title="Remove"><X size={12} /></button>
                      </span>
                    ))}
                  </div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
const viewerChip = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 6px 4px 10px', fontSize: 12, color: 'var(--text-1)' };
const chipX = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 0 };

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
function toggleBtn(on) { return { background: on ? 'var(--docket-accent)' : 'var(--surface-3)', color: on ? 'var(--accent-fg)' : 'var(--text-3)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '4px 14px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' }; }
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const btnPrimary = { ...btnBase, background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: '1px solid var(--docket-accent)' };
const btnSecondary = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
const btnDanger = { ...btnBase, background: 'transparent', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)' };
