'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, ArrowLeft, ShieldCheck, LayoutDashboard, X, Globe, Lock } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { Button, IconButton, EmptyState } from '../../../../components/ui/index.js';
import { AdminHead, Switch } from '../../../../components/AdminParts.js';

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

  if (perms && !perms.docket_admin) return <div className="adm"><EmptyState icon={Lock} title="Admins only" body="Requires docket_admin." /></div>;

  return (
    <div className="adm">
      <AdminHead title="Roles & permissions"
        lede="Docket-only permission roles. Assign people on the Users page. No role = baseline (own + collaborator + own-team tasks)."
        action={view === 'list'
          ? <Button variant="primary" icon={Plus} onClick={startNew}>New role</Button>
          : <Button variant="ghost" icon={ArrowLeft} onClick={() => setView('list')}>Back to roles</Button>} />

      {view === 'list' ? (
        <>
          <DashboardSharingCard session={session} />
          <section className="adm-card">
            <div className="adm-card-h"><span>Roles</span><span className="adm-count">{roles.length}</span></div>
            {loading ? <div className="adm-card-b"><Spinner /></div> : (
              <ul className="adm-list">
                {roles.map((r) => {
                  const on = Object.entries(r.permissions || {}).filter(([, v]) => v).map(([k]) => k);
                  return (
                    <li key={r.role_key} className="adm-item">
                      <div className="adm-item-main">
                        <div className="adm-item-title">{r.label}{r.is_system && <span className="adm-badge">system</span>}<span className="adm-mono">{r.role_key}</span></div>
                        {r.description && <div className="adm-item-sub">{r.description}</div>}
                        <div className="adm-keys">
                          {on.map((k) => <span key={k} className="adm-key">{k}</span>)}
                          {on.length === 0 && <span className="adm-item-sub">Baseline (own + team tasks)</span>}
                        </div>
                      </div>
                      <div className="adm-item-acts">
                        <Button size="sm" onClick={() => startEdit(r)}>Edit</Button>
                        {!r.is_system && <Button size="sm" variant="danger" onClick={() => del(r)}>Delete</Button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      ) : (
        <section className="adm-card">
          <div className="adm-card-h"><span>{editKey ? `Edit ${editKey}` : 'New role'}</span></div>
          <div className="adm-card-b">
            <div className={'adm-grid' + (editKey ? ' one' : '')}>
              {!editKey && (
                <label className="adm-field"><span className="adm-lbl">Role key *</span>
                  <input className="adm-input mono" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="e.g. team_lead" disabled={saving} /></label>
              )}
              <label className="adm-field"><span className="adm-lbl">Label *</span><input className="adm-input" value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} /></label>
            </div>
            <label className="adm-field"><span className="adm-lbl">Description</span><input className="adm-input" value={desc} onChange={(e) => setDesc(e.target.value)} disabled={saving} /></label>

            {editIsSystem && <div className="adm-note"><ShieldCheck size={14} /> System role: permissions are fixed. Label &amp; description only.</div>}

            {PERM_DEFS.map((g) => (
              <div key={g.group} className="adm-field">
                <span className="adm-lbl">{g.group}</span>
                {g.items.map((it) => {
                  const forced = it.key === 'docket_view_all' && viewForced;
                  const on = !!perm[it.key];
                  const disabled = saving || editIsSystem || forced;
                  return (
                    <div key={it.key} className="adm-row">
                      <span className="adm-row-l">
                        {it.label} <span className="adm-mono">· {it.key}</span>
                        {forced && <span className="adm-row-hint"> (required by admin)</span>}
                      </span>
                      <Switch on={on} label={it.label} onClick={() => toggle(it.key)} disabled={disabled} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="adm-card-foot">
            <Button variant="ghost" onClick={() => setView('list')} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={saving}>{editKey ? 'Save role' : 'Create role'}</Button>
          </div>
        </section>
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
    <section className="adm-card">
      <div className="adm-card-h"><span className="adm-card-t"><LayoutDashboard size={15} aria-hidden /> Dashboard sharing</span></div>
      <div className="adm-card-b">
        <p className="adm-lede">
          Who can open the founder review <b>Dashboard</b>. Independent of all-tasks visibility — granted people
          see the org-wide dashboard but still only their own/team/collaborator tasks when they click through.
        </p>

        {loading ? <Spinner /> : (
          <>
            <div className="adm-row">
              <span className="adm-row-l">
                <Globe size={14} aria-hidden /> Visible to everyone
                <span className="adm-row-hint">· every current and future employee</span>
              </span>
              <Switch on={pub} label="Visible to everyone" onClick={togglePublic} disabled={busy} />
            </div>

            <div className={'adm-field' + (pub ? ' dim' : '')}>
              <span className="adm-lbl">Specific people</span>
              {pub && <div className="adm-row-hint">Everyone already has access; these grants are kept for when “Visible to everyone” is turned off.</div>}
              <div className="adm-pick">
                <Combobox value={pick} options={pickOpts} placeholder="Add a person…" allowClear portal
                  onChange={(v, opt) => { if (opt) addViewer(v); }} style={{ width: '100%' }} />
              </div>
              {viewers.length === 0
                ? <div className="adm-item-sub">No individual grants. {pub ? '' : 'Only roles with “See all org tasks + the review dashboard” can see it.'}</div>
                : <div className="adm-chips">
                    {viewers.map((v) => (
                      <span key={v.user_id} className="adm-chip">
                        {v.full_name || v.user_id}
                        <IconButton icon={X} size="sm" label={`Remove ${v.full_name || 'viewer'}`} tooltip={false} onClick={() => removeViewer(v.user_id)} disabled={busy} />
                      </span>
                    ))}
                  </div>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
