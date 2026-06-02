'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, pageH1, pageSub,
} from '@/lib/snorkelui';
import { ASSET_STATUSES, ACQ_TYPES, RENTAL_PERIODS } from '@/lib/assets';

const CURRENCIES = ['INR', 'USD', 'RMB', 'EUR', 'GBP'];
const OTHER = '__other__';

function Field({ label, children, span }) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : 'auto' }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export default function NewAssetPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [cats, setCats] = useState([]);
  const [locs, setLocs] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [users, setUsers] = useState([]);
  const [saving, setSaving] = useState(false);

  const [f, setF] = useState({
    name: '', description: '', category_id: '', status: 'in_use', acquisition_type: 'purchased',
    location_id: '', serial_no: '', model_no: '', secondary_ref: '',
    vendor_pick: '', vendor_name_other: '',
    custodian_pick: '', custodian_name_other: '',
    source_po_number: '', purchase_cost: '', currency: 'INR', acquired_date: '',
    rental_cost: '', rental_period: '', rental_start_date: '', rental_end_date: '',
    warranty_expiry: '', amc_renewal: '',
  });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!session) return;
    garageFetch('getAssetCategories', {}, session).then(d => setCats(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getAssetLocations', {}, session).then(d => setLocs(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getVendors', {}, session).then(d => setVendors(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getAssetUsers', {}, session).then(d => setUsers(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.asset_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const isRental = f.acquisition_type === 'rented';

  async function submit() {
    if (!f.name.trim()) { showToast('Name is required', 'error'); return; }
    setSaving(true);
    try {
      // Resolve vendor + custodian (picker vs free-text).
      let vendor_code = null, vendor_name = null;
      if (f.vendor_pick && f.vendor_pick !== OTHER) {
        const v = vendors.find(x => x.vendor_code === f.vendor_pick);
        vendor_code = v?.vendor_code || null; vendor_name = v?.vendor_name || null;
      } else if (f.vendor_pick === OTHER) {
        vendor_name = f.vendor_name_other.trim() || null;
      }
      let custodian_user_id = null, custodian_name = null;
      if (f.custodian_pick && f.custodian_pick !== OTHER) {
        const u = users.find(x => x.id === f.custodian_pick);
        custodian_user_id = u?.id || null; custodian_name = u?.full_name || null;
      } else if (f.custodian_pick === OTHER) {
        custodian_name = f.custodian_name_other.trim() || null;
      }

      const data = {
        name: f.name.trim(), description: f.description.trim() || null,
        category_id: f.category_id || null, status: f.status, acquisition_type: f.acquisition_type,
        location_id: f.location_id || null, custodian_user_id, custodian_name,
        serial_no: f.serial_no.trim() || null, model_no: f.model_no.trim() || null,
        secondary_ref: f.secondary_ref.trim() || null,
        vendor_code, vendor_name, currency: f.currency,
        warranty_expiry: f.warranty_expiry || null, amc_renewal: f.amc_renewal || null,
      };
      if (isRental) {
        Object.assign(data, {
          rental_cost: f.rental_cost || null, rental_period: f.rental_period || null,
          rental_start_date: f.rental_start_date || null, rental_end_date: f.rental_end_date || null,
        });
      } else {
        Object.assign(data, {
          source_po_number: f.source_po_number.trim() || null,
          purchase_cost: f.purchase_cost || null, acquired_date: f.acquired_date || null,
        });
      }
      const res = await workerFetch('createAsset', { data }, session);
      if (!res.ok) throw new Error(res.error || 'Create failed');
      showToast(`Asset ${res.data.asset_code} created`, 'success');
      router.push(`/assets/detail?id=${encodeURIComponent(res.data.id)}`);
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
      setSaving(false);
    }
  }

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 };

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 860 }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>New Asset</h1>
        <p style={pageSub}>A printable AST-code is assigned automatically.</p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Details</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Name *" span><input style={{ ...inputStyle, width: '100%' }} value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Injection Moulding Machine #2" /></Field>
            <Field label="Category">
              <select style={{ ...selectStyle, width: '100%' }} value={f.category_id} onChange={e => set('category_id', e.target.value)}>
                <option value="">— none —</option>
                {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select style={{ ...selectStyle, width: '100%' }} value={f.status} onChange={e => set('status', e.target.value)}>
                {ASSET_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Acquisition type">
              <select style={{ ...selectStyle, width: '100%' }} value={f.acquisition_type} onChange={e => set('acquisition_type', e.target.value)}>
                {ACQ_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </Field>
            <Field label="Location">
              <select style={{ ...selectStyle, width: '100%' }} value={f.location_id} onChange={e => set('location_id', e.target.value)}>
                <option value="">— none —</option>
                {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Custodian">
              <select style={{ ...selectStyle, width: '100%' }} value={f.custodian_pick} onChange={e => set('custodian_pick', e.target.value)}>
                <option value="">— unassigned —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                <option value={OTHER}>Other (no login)…</option>
              </select>
            </Field>
            {f.custodian_pick === OTHER && (
              <Field label="Custodian name (free text)"><input style={{ ...inputStyle, width: '100%' }} value={f.custodian_name_other} onChange={e => set('custodian_name_other', e.target.value)} placeholder="e.g. floor staff name" /></Field>
            )}
            <Field label="Serial no."><input style={{ ...inputStyle, width: '100%' }} value={f.serial_no} onChange={e => set('serial_no', e.target.value)} /></Field>
            <Field label="Model / vendor no."><input style={{ ...inputStyle, width: '100%' }} value={f.model_no} onChange={e => set('model_no', e.target.value)} /></Field>
            <Field label="Secondary ref (old tag)"><input style={{ ...inputStyle, width: '100%' }} value={f.secondary_ref} onChange={e => set('secondary_ref', e.target.value)} /></Field>
            <Field label="Description" span><textarea style={{ ...inputStyle, width: '100%', minHeight: 56, fontFamily: 'inherit' }} value={f.description} onChange={e => set('description', e.target.value)} /></Field>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>{isRental ? 'Rental' : 'Purchase'} &amp; vendor</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Vendor">
              <select style={{ ...selectStyle, width: '100%' }} value={f.vendor_pick} onChange={e => set('vendor_pick', e.target.value)}>
                <option value="">— none —</option>
                {vendors.map(v => <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name}</option>)}
                <option value={OTHER}>Other (not listed)…</option>
              </select>
            </Field>
            {f.vendor_pick === OTHER && (
              <Field label="Vendor name (free text)"><input style={{ ...inputStyle, width: '100%' }} value={f.vendor_name_other} onChange={e => set('vendor_name_other', e.target.value)} /></Field>
            )}
            <Field label="Currency">
              <select style={{ ...selectStyle, width: '100%' }} value={f.currency} onChange={e => set('currency', e.target.value)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            {!isRental && <>
              <Field label="Purchase cost"><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.purchase_cost} onChange={e => set('purchase_cost', e.target.value)} /></Field>
              <Field label="Acquired date"><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.acquired_date} onChange={e => set('acquired_date', e.target.value)} /></Field>
              <Field label="Source PO number"><input style={{ ...inputStyle, width: '100%' }} value={f.source_po_number} onChange={e => set('source_po_number', e.target.value)} placeholder="e.g. IN-PRO-0123" /></Field>
            </>}

            {isRental && <>
              <Field label="Rental cost"><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.rental_cost} onChange={e => set('rental_cost', e.target.value)} /></Field>
              <Field label="Rental period">
                <select style={{ ...selectStyle, width: '100%' }} value={f.rental_period} onChange={e => set('rental_period', e.target.value)}>
                  <option value="">— select —</option>
                  {RENTAL_PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Rental start"><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.rental_start_date} onChange={e => set('rental_start_date', e.target.value)} /></Field>
              <Field label="Rental end"><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.rental_end_date} onChange={e => set('rental_end_date', e.target.value)} /></Field>
            </>}
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Warranty / AMC</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Warranty expiry"><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.warranty_expiry} onChange={e => set('warranty_expiry', e.target.value)} /></Field>
            <Field label="AMC renewal"><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.amc_renewal} onChange={e => set('amc_renewal', e.target.value)} /></Field>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPrimary} onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Create Asset'}</button>
        <button style={btnSecondary} onClick={() => router.push('/assets')} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}
