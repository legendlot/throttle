'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil, Copy } from 'lucide-react';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';

// Relay permission matrix — all 10 keys are boolean toggles.
const PERM_DEFS = [
  { group: 'Workspace', items: [
    { key: 'relay_view', label: 'View Relay workspace (campaigns, journeys, segments, templates)' },
  ] },
  { group: 'Build', items: [
    { key: 'segment_manage',  label: 'Create / edit audience segments' },
    { key: 'template_manage', label: 'Create / edit message templates' },
    { key: 'campaign_build',  label: 'Build campaigns & journeys (draft)' },
  ] },
  { group: 'Send', items: [
    { key: 'send_activate', label: 'Activate / send campaigns & journeys' },
    { key: 'approve',       label: 'Approve sends that require approval' },
  ] },
  { group: 'Data', items: [
    { key: 'data_consent_admin', label: 'Manage contact data & consent records' },
  ] },
  { group: 'Connectors', items: [
    { key: 'connector_channel_manage', label: 'Manage sender identities & channel connectors' },
  ] },
  { group: 'Admin', items: [
    { key: 'relay_admin',       label: 'Assign Relay roles to users' },
    { key: 'relay_super_admin', label: 'Manage Relay roles, settings & caps' },
  ] },
];

export default function RolesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [editKey, setEditKey] = useState(null);   // role_key being edited (null = new)
  const [roleKey, setRoleKey] = useState('');
  const [label, setLabel] = useState('');
  const [desc, setDesc] = useState('');
  const [perm, setPerm] = useState({});
  const [readOnly, setReadOnly] = useState(false); // viewing a system role
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getRoles', {}, session);
      setRoles(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load roles', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function startNew() {
    setEditKey(null); setRoleKey(''); setLabel(''); setDesc(''); setPerm({}); setReadOnly(false); setView('form');
  }
  function startEdit(r) {
    setEditKey(r.role_key); setRoleKey(r.role_key); setLabel(r.label || ''); setDesc(r.description || '');
    setPerm(r.permissions || {}); setReadOnly(!!r.is_system); setView('form');
  }
  function startClone(r) {
    setEditKey(null); setRoleKey(''); setLabel(`${r.label} (copy)`); setDesc(r.description || '');
    setPerm({ ...(r.permissions || {}) }); setReadOnly(false); setView('form');
  }
  function toggle(k) { if (readOnly) return; setPerm((p) => ({ ...p, [k]: !p[k] })); }

  async function save() {
    if (!label.trim()) { showToast('Label required', 'error'); return; }
    if (!editKey && !roleKey.trim()) { showToast('Role key required', 'error'); return; }
    setSaving(true);
    try {
      await workerFetch('saveRole', {
        role_key: editKey || roleKey.trim(),
        label: label.trim(),
        description: desc || null,
        permissions: perm,
      }, session);
      showToast(editKey ? 'Role updated' : 'Role created', 'success');
      setView('list'); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.relay_super_admin) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Super-admin only.</div>;

  if (view === 'form') {
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to roles</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{editKey ? (label || editKey) : 'New Role'}</span>
            {readOnly && <Badge label="system · read-only" tone="gray" />}
          </div>
          <div className="po-head-r">
            {!readOnly && <Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save role'}</Btn>}
          </div>
        </div>

        <Panel title="Role details" pad>
          <div className="kv-grid">
            {!editKey && <div><div className="kv-k">Role key</div><input className="f-inp mono" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="e.g. campaign_manager" disabled={saving} /></div>}
            <div><div className="kv-k">Label</div><input className="f-inp" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Campaign Manager" disabled={saving || readOnly} /></div>
          </div>
          <div style={{ marginTop: 12 }}><div className="kv-k">Description</div><input className="f-inp" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What this role can do" disabled={saving || readOnly} /></div>
        </Panel>

        {PERM_DEFS.map(g => (
          <Panel title={g.group} key={g.group} pad>
            <div className="perm-list">
              {g.items.map(it => (
                <div className="perm-row" key={it.key}>
                  <div className="perm-l"><span className="perm-lbl">{it.label}</span><span className="perm-key mono">{it.key}</span></div>
                  <button className={`tgl ${perm[it.key] ? 'on' : ''}`} onClick={() => toggle(it.key)} disabled={saving || readOnly}>
                    <span className="tgl-knob" /><span className="tgl-txt">{perm[it.key] ? 'ON' : 'OFF'}</span>
                  </button>
                </div>
              ))}
            </div>
          </Panel>
        ))}
      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Roles" sub="Relay permission roles. System roles are read-only but can be cloned into editable custom roles."
        actions={<Btn kind="primary" onClick={startNew}><Plus size={14} /> New role</Btn>} />
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : (
          <div className="role-grid">
            {roles.map((r) => {
              const on = Object.entries(r.permissions || {}).filter(([, v]) => v).map(([k]) => k);
              return (
                <div className="role-card" key={r.role_key}>
                  <div className="role-head">
                    <span className="role-name">{r.label}{r.is_system && <Badge label="system" tone="gray" />}</span>
                    <span className="role-key mono">{r.role_key}</span>
                  </div>
                  {r.description && <div className="role-desc">{r.description}</div>}
                  <div className="role-perms">
                    {on.length === 0
                      ? <span className="dim">No permissions</span>
                      : <><span className="role-pcount mono">{on.length}</span><span className="role-plabel">permission{on.length === 1 ? '' : 's'} granted</span></>}
                  </div>
                  <div className="role-foot">
                    <Btn onClick={() => startEdit(r)}><Pencil size={14} /> {r.is_system ? 'View' : 'Edit'}</Btn>
                    <Btn onClick={() => startClone(r)}><Copy size={14} /> Clone</Btn>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
