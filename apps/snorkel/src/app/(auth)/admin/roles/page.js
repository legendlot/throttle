'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, labelStyle,
  btnPrimary, btnSecondary, btnDanger, pageH1, pageSub, StatusBadge,
} from '@/lib/snorkelui';

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
  { group: 'Admin', items: [
    { key: 'snorkel_admin', label: 'Manage Snorkel roles & assign users' },
  ] },
];

const toggleBtn = (on) => ({
  background: on ? 'var(--yellow)' : 'var(--surface2)', color: on ? '#000' : 'var(--t3)',
  border: `1px solid ${on ? 'var(--yellow)' : 'var(--border)'}`, borderRadius: 3,
  padding: '4px 12px', fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer',
  textTransform: 'uppercase', letterSpacing: '.05em',
});

export default function RolesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');     // list | form
  const [editKey, setEditKey] = useState(null);  // role_key when editing
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

  if (perms && !perms.snorkel_admin) return <div style={{ padding: 24, color: 'var(--t3)' }}>Admin only.</div>;

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 900 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={pageH1}>Roles & Permissions</h1>
          <p style={pageSub}>Snorkel-only permission roles. Assign people to roles on the Users page.</p>
        </div>
        {view === 'list'
          ? <button style={btnPrimary} onClick={startNew}>+ New Role</button>
          : <button style={btnSecondary} onClick={() => setView('list')}>← Back to roles</button>}
      </div>

      {view === 'list' ? (
        loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {roles.map((r) => (
              <div key={r.role_key} style={panelStyle}>
                <div style={panelHeaderStyle}>
                  <span>{r.label} {r.is_system && <StatusBadge label="system" tone="gray" />}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{r.role_key}</span>
                </div>
                <div style={panelBodyStyle}>
                  {r.description && <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 8 }}>{r.description}</div>}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
                    {Object.entries(r.permissions || {}).filter(([, v]) => v).map(([k]) => (
                      <StatusBadge key={k} label={k} tone="blue" />
                    ))}
                    {Object.values(r.permissions || {}).filter(Boolean).length === 0 && (
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>No elevated permissions (request-only)</span>
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
        )
      ) : (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>{editKey ? `Edit ${editKey}` : 'New Role'}</span></div>
          <div style={panelBodyStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: editKey ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 12 }}>
              {!editKey && (
                <div>
                  <span style={labelStyle}>Role Key *</span>
                  <input value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="e.g. buyer"
                         style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={saving} />
                </div>
              )}
              <div>
                <span style={labelStyle}>Label *</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={saving} />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <span style={labelStyle}>Description</span>
              <input value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={saving} />
            </div>

            {PERM_DEFS.map((g) => (
              <div key={g.group} style={{ marginBottom: 14 }}>
                <div style={{ ...labelStyle, marginBottom: 6 }}>{g.group}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.items.map((it) => (
                    <div key={it.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 10px' }}>
                      <span style={{ fontSize: 12 }}>{it.label} <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>· {it.key}</span></span>
                      <button type="button" style={toggleBtn(!!perm[it.key])} onClick={() => toggle(it.key)} disabled={saving}>
                        {perm[it.key] ? 'On' : 'Off'}
                      </button>
                    </div>
                  ))}
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
