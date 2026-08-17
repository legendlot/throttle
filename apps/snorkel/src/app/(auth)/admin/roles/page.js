'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil } from 'lucide-react';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';

// Snorkel permission matrix — all keys are boolean toggles.
const PERM_DEFS = [
  { group: 'Workspace', items: [
    { key: 'procurement_view', label: 'View procurement workspace (POs, vendors, forwarders)' },
  ] },
  { group: 'Purchase Orders', items: [
    { key: 'po_create',         label: 'Create / amend / cancel POs (+ make PO from request)' },
    { key: 'po_request_accept', label: 'Accept POs — Draft → Accepted (approves the request)' },
    { key: 'po_approve',        label: 'Final approve POs — Accepted → Approved' },
    { key: 'payment_route',     label: 'Route payment + mark paid' },
    { key: 'po_china',          label: 'China POs + new-product registration' },
  ] },
  { group: 'Masters', items: [
    { key: 'vendor_manage',          label: 'Manage vendors / forwarders / supplied items' },
    { key: 'company_address_manage', label: 'Manage company addresses' },
  ] },
  { group: 'Sales Orders', items: [
    { key: 'sales_view',          label: 'View sales orders / partners / collections' },
    { key: 'sales_order_manage',  label: 'Create / edit / cancel orders + generate invoice' },
    { key: 'sales_order_confirm', label: 'Confirm orders → hand off to dispatch' },
    { key: 'sales_payment_manage', label: 'Record / delete collection receipts' },
    { key: 'sales_partner_manage', label: 'Manage partners + sales channels' },
    { key: 'sales_credit_note',   label: 'Raise / issue / cancel credit notes' },
  ] },
  { group: 'Admin', items: [
    { key: 'snorkel_admin', label: 'Manage Snorkel roles & assign users' },
  ] },
];

export default function RolesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [editKey, setEditKey] = useState(null);
  const [roleKey, setRoleKey] = useState('');
  const [label, setLabel] = useState('');
  const [desc, setDesc] = useState('');
  const [perm, setPerm] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getSnorkelRoles', {}, session);
      setRoles(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load roles', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function startNew() { setEditKey(null); setRoleKey(''); setLabel(''); setDesc(''); setPerm({}); setView('form'); }
  function startEdit(r) { setEditKey(r.role_key); setRoleKey(r.role_key); setLabel(r.label || ''); setDesc(r.description || ''); setPerm(r.permissions || {}); setView('form'); }
  function toggle(k) { setPerm((p) => ({ ...p, [k]: !p[k] })); }

  async function save() {
    if (!label.trim()) { showToast('Label required', 'error'); return; }
    if (!editKey && !roleKey.trim()) { showToast('Role key required', 'error'); return; }
    setSaving(true);
    try {
      const action = editKey ? 'updateSnorkelRole' : 'createSnorkelRole';
      const data = editKey
        ? { role_key: editKey, label: label.trim(), description: desc || null, permissions: perm }
        : { role_key: roleKey.trim(), label: label.trim(), description: desc || null, permissions: perm };
      await workerFetch(action, { data }, session);
      showToast(editKey ? 'Role updated' : 'Role created', 'success');
      setView('list'); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  async function del(r) {
    if (!confirm(`Delete role "${r.label}"?`)) return;
    try {
      await workerFetch('deleteSnorkelRole', { data: { role_key: r.role_key } }, session);
      showToast('Role deleted', 'success'); load();
    } catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  if (perms && !perms.snorkel_admin) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Admin only.</div>;

  if (view === 'form') {
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to roles</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{editKey ? label || editKey : 'New Role'}</span>
          </div>
          <div className="po-head-r"><Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save role'}</Btn></div>
        </div>

        <Panel title="Role details" pad>
          <div className="kv-grid">
            {!editKey && <div><div className="kv-k">Role key</div><input className="f-inp mono" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="e.g. buyer" disabled={saving} /></div>}
            <div><div className="kv-k">Label</div><input className="f-inp" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Buyer" disabled={saving} /></div>
          </div>
          <div style={{ marginTop: 12 }}><div className="kv-k">Description</div><input className="f-inp" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What this role can do" disabled={saving} /></div>
        </Panel>

        {PERM_DEFS.map(g => (
          <Panel title={g.group} key={g.group} pad>
            <div className="perm-list">
              {g.items.map(it => (
                <div className="perm-row" key={it.key}>
                  <div className="perm-l"><span className="perm-lbl">{it.label}</span><span className="perm-key mono">{it.key}</span></div>
                  <button className={`tgl ${perm[it.key] ? 'on' : ''}`} onClick={() => toggle(it.key)} disabled={saving}>
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
      <PageHead title="Roles & Permissions" sub="Snorkel-only permission roles. Assign people to roles on the Users page."
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
                      ? <span className="dim">Request-only access</span>
                      : <><span className="role-pcount mono">{on.length}</span><span className="role-plabel">permission{on.length === 1 ? '' : 's'} granted</span></>}
                  </div>
                  <div className="role-foot">
                    <Btn onClick={() => startEdit(r)}><Pencil size={14} /> Edit</Btn>
                    {!r.is_system && <Btn onClick={() => del(r)}>Delete</Btn>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
