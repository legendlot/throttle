'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState } from '@throttle/ui';
import { PageHead, Panel, Badge as RBadge, Btn } from '@/components/ui.js';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

const EMPTY_FORM = {
  label: '', legal_name: '', line1: '', line2: '',
  city: '', state: '', pincode: '', country: 'India',
  gstin: '', phone: '', email: '',
};

function Badge({ label, tone }) {
  const tones = {
    blue:  { bg: 'rgba(33,60,226,.12)',  fg: '#7b93ff', bd: 'rgba(33,60,226,.35)' },
    green: { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', bd: 'rgba(34,197,94,.35)' },
    gray:  { bg: 'rgba(120,120,120,.12)', fg: 'var(--t3)', bd: 'var(--border)' },
  };
  const t = tones[tone] || tones.gray;
  return (
    <span style={{ display: 'inline-block', background: t.bg, color: t.fg, border: `1px solid ${t.bd}`, borderRadius: 3, padding: '2px 6px', fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.05em', textTransform: 'uppercase', marginRight: 4, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

export default function AddressesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const canManage = hasPermission(perms, 'company_address_manage');

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId]   = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId]     = useState(null);     // null = add, else editing id
  const [form, setForm]         = useState(EMPTY_FORM);
  const [saving, setSaving]     = useState(false);

  async function loadAll() {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('listCompanyAddresses', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (canManage) loadAll(); else setLoading(false); /* eslint-disable-next-line */ }, [session, canManage]);

  const stats = useMemo(() => ({
    total:  rows.length,
    active: rows.filter(r => r.active).length,
  }), [rows]);

  function openAdd() {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setFormOpen(true);
  }
  function openEdit(r) {
    setEditId(r.id);
    setForm({
      label: r.label || '', legal_name: r.legal_name || '',
      line1: r.line1 || '', line2: r.line2 || '',
      city: r.city || '', state: r.state || '', pincode: r.pincode || '',
      country: r.country || 'India',
      gstin: r.gstin || '', phone: r.phone || '', email: r.email || '',
    });
    setFormOpen(true);
  }

  async function saveForm() {
    for (const [f, lbl] of [['label','Label'],['legal_name','Legal name'],['line1','Address line 1'],['city','City'],['state','State'],['pincode','Pincode']]) {
      if (!form[f] || !form[f].trim()) { showToast(`${lbl} is required`, 'error'); return; }
    }
    if (!/^\d{6}$/.test(form.pincode.trim())) { showToast('Pincode must be 6 digits', 'error'); return; }
    setSaving(true);
    try {
      const action = editId ? 'updateCompanyAddress' : 'createCompanyAddress';
      const payload = editId ? { ...form, id: editId } : { ...form };
      const r = await workerFetch(action, { data: payload }, session);
      if (!r.ok) { showToast(r.data?.error || 'Save failed', 'error'); return; }
      showToast(editId ? 'Saved' : 'Address added', 'success');
      setFormOpen(false);
      loadAll();
    } finally {
      setSaving(false);
    }
  }

  async function rowAction(action, id, okMsg) {
    setBusyId(id);
    try {
      const r = await workerFetch(action, { data: { id } }, session);
      if (!r.ok) { showToast(r.data?.error || 'Action failed', 'error'); return; }
      showToast(okMsg, 'success');
      loadAll();
    } finally {
      setBusyId(null);
    }
  }
  function setRegistered(r)  { rowAction('setRegisteredOffice', r.id, 'Registered office updated'); }
  function setDefault(r)     { rowAction('setDefaultDeliveryAddress', r.id, 'Default delivery updated'); }
  async function toggleActive(r) {
    setBusyId(r.id);
    try {
      const r2 = await workerFetch('updateCompanyAddress', { data: { id: r.id, active: !r.active } }, session);
      if (!r2.ok) { showToast(r2.data?.error || 'Action failed', 'error'); return; }
      showToast(r.active ? 'Deactivated' : 'Activated', 'success');
      loadAll();
    } finally {
      setBusyId(null);
    }
  }

  if (!canManage) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState title="Admin access required" message="You need the Manage Company Addresses permission to view this page." />
      </div>
    );
  }
  if (loading) return <Spinner label="Loading addresses…" />;

  const fld = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="pg">
      <PageHead title="Company Addresses" sub="LOT's own addresses. The Registered Office is the bill-to on every PO; Default Delivery is the pre-filled ship-to."
        actions={<Btn kind="primary" onClick={openAdd}>+ Add address</Btn>} />

      <div className="info-bar">
        <span>These are LOT&apos;s own addresses. The <strong>Registered Office</strong> is the buyer/bill-to on every PO; the <strong>Default Delivery</strong> is pre-selected as the ship-to on new POs. Deactivate to retire an address without losing it from past POs.</span>
      </div>

      <Panel title="Addresses" count={`${stats.active} active · ${stats.total} total`}>
        <table className="dt">
          <thead><tr>
            <th>Label</th><th>Legal name</th><th>Address</th><th>GSTIN</th><th>Roles</th><th>Status</th><th className="num">Actions</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center' }} className="dim">No addresses yet — add one.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
                <td style={{ fontWeight: 600 }}>{r.label || '—'}</td>
                <td className="dim">{r.legal_name || '—'}</td>
                <td className="dim addr-cell">
                  {r.line1}{r.line2 ? `, ${r.line2}` : ''}<br />
                  {[r.city, r.state, r.pincode].filter(Boolean).join(', ')}{r.country && r.country !== 'India' ? `, ${r.country}` : ''}
                </td>
                <td className="mono dim" style={{ fontSize: 10 }}>{r.gstin || '—'}</td>
                <td>
                  <span className="role-tags">
                    {r.is_registered_office && <RBadge label="Registered Office" tone="blue" />}
                    {r.is_default_delivery && <RBadge label="Default Delivery" tone="green" />}
                    {!r.is_registered_office && !r.is_default_delivery && <span className="dim">—</span>}
                  </span>
                </td>
                <td><RBadge label={r.active ? 'Active' : 'Inactive'} tone={r.active ? 'green' : 'gray'} dot /></td>
                <td className="num">
                  <span className="act-grp">
                    <Btn onClick={() => openEdit(r)} disabled={busyId === r.id}>Edit</Btn>
                    {r.active && !r.is_registered_office && <Btn onClick={() => setRegistered(r)} disabled={busyId === r.id}>Set reg.</Btn>}
                    {r.active && !r.is_default_delivery && <Btn onClick={() => setDefault(r)} disabled={busyId === r.id}>Set default</Btn>}
                    <Btn onClick={() => toggleActive(r)} disabled={busyId === r.id || (r.active && (r.is_registered_office || r.is_default_delivery))}>{r.active ? 'Deactivate' : 'Activate'}</Btn>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {formOpen && (
        <Modal open onClose={() => setFormOpen(false)} size="md" title={editId ? 'Edit address' : 'Add address'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>Label / Head <span style={{ color: '#ff7070' }}>*</span></label>
              <input type="text" value={form.label} onChange={fld('label')} placeholder="e.g. Corporate Office, Factory 1, Factory 2" style={{ ...inputStyle, width: '100%' }} autoFocus />
            </div>
            <div>
              <label style={labelStyle}>Legal Name <span style={{ color: '#ff7070' }}>*</span></label>
              <input type="text" value={form.legal_name} onChange={fld('legal_name')} placeholder="e.g. M/s. Silverton Ventures" style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div>
              <label style={labelStyle}>Address Line 1 <span style={{ color: '#ff7070' }}>*</span></label>
              <input type="text" value={form.line1} onChange={fld('line1')} style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div>
              <label style={labelStyle}>Address Line 2</label>
              <input type="text" value={form.line2} onChange={fld('line2')} style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 2 }}>
                <label style={labelStyle}>City <span style={{ color: '#ff7070' }}>*</span></label>
                <input type="text" value={form.city} onChange={fld('city')} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div style={{ flex: 2 }}>
                <label style={labelStyle}>State <span style={{ color: '#ff7070' }}>*</span></label>
                <input type="text" value={form.state} onChange={fld('state')} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Pincode <span style={{ color: '#ff7070' }}>*</span></label>
                <input type="text" inputMode="numeric" value={form.pincode} onChange={fld('pincode')} placeholder="6 digits" style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Country</label>
                <input type="text" value={form.country} onChange={fld('country')} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div style={{ flex: 2 }}>
                <label style={labelStyle}>GSTIN</label>
                <input type="text" value={form.gstin} onChange={fld('gstin')} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Phone</label>
                <input type="text" value={form.phone} onChange={fld('phone')} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Email</label>
                <input type="text" value={form.email} onChange={fld('email')} style={{ ...inputStyle, width: '100%' }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button onClick={() => setFormOpen(false)} style={btnSecondary} disabled={saving}>CANCEL</button>
              <button onClick={saveForm} style={btnPrimary} disabled={saving}>{saving ? 'SAVING…' : (editId ? 'SAVE' : 'ADD')}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
