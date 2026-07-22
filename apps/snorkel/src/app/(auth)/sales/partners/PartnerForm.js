'use client';
import { useState } from 'react';
import { panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle, btnPrimary, btnSecondary } from '@/lib/snorkelui';
import { INDIAN_STATES } from '@/lib/sales';

function Field({ label, children, span }) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : 'auto' }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

const EMPTY = {
  name: '', channel_key: '', partner_type: '', gstin: '', state: '', city: '', pincode: '',
  billing_address: '', shipping_address: '', contact_person: '', phone: '', email: '',
  default_credit_days: 45, is_active: true, notes: '',
};

// Shared create/edit form. `initial` may be a loaded partner row; `channels` from getSalesChannels.
export default function PartnerForm({ initial, channels, saving, onSubmit, onCancel }) {
  // Null-safe init: a loaded partner row stores blanks as NULL — spreading it raw
  // overrides EMPTY's '' with null, and submit()'s .trim() then throws on the first
  // blank field, silently killing Save (Vinayram, #bugs 2026-07-22). Only take
  // non-null values; nulls fall back to ''.
  const [f, setF] = useState(() => {
    const base = { ...EMPTY };
    if (initial) for (const k of Object.keys(EMPTY)) {
      if (initial[k] !== undefined && initial[k] !== null) base[k] = initial[k];
    }
    base.is_active = initial?.is_active !== false;
    return base;
  });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 };

  function submit() {
    onSubmit({
      name: f.name.trim(),
      channel_key: f.channel_key || null,
      partner_type: f.partner_type.trim() || null,
      gstin: f.gstin.trim() || null,
      state: f.state || null,
      city: f.city.trim() || null,
      pincode: f.pincode.trim() || null,
      billing_address: f.billing_address.trim() || null,
      shipping_address: f.shipping_address.trim() || null,
      contact_person: f.contact_person.trim() || null,
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      default_credit_days: Math.round(Number(f.default_credit_days) || 0),
      is_active: !!f.is_active,
      notes: f.notes.trim() || null,
    });
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Partner</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Name *" span><input style={{ ...inputStyle, width: '100%' }} value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Sharma Distributors" /></Field>
            <Field label="Channel">
              <select style={{ ...selectStyle, width: '100%' }} value={f.channel_key} onChange={e => set('channel_key', e.target.value)}>
                <option value="">— select —</option>
                {(channels || []).map(c => <option key={c.channel_key} value={c.channel_key}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Partner type"><input style={{ ...inputStyle, width: '100%' }} value={f.partner_type} onChange={e => set('partner_type', e.target.value)} placeholder="distributor / retailer / chain" /></Field>
            <Field label="GSTIN"><input style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} value={f.gstin} onChange={e => set('gstin', e.target.value.toUpperCase())} placeholder="29ABCDE1234F1Z5" /></Field>
            <Field label="State (place of supply)">
              <select style={{ ...selectStyle, width: '100%' }} value={f.state} onChange={e => set('state', e.target.value)}>
                <option value="">— select —</option>
                {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="City"><input style={{ ...inputStyle, width: '100%' }} value={f.city} onChange={e => set('city', e.target.value)} /></Field>
            <Field label="Pincode"><input style={{ ...inputStyle, width: '100%' }} value={f.pincode} onChange={e => set('pincode', e.target.value)} /></Field>
            <Field label="Default credit days"><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.default_credit_days} onChange={e => set('default_credit_days', e.target.value)} /></Field>
            <Field label="Billing address" span><textarea style={{ ...inputStyle, width: '100%', minHeight: 50, fontFamily: 'inherit' }} value={f.billing_address} onChange={e => set('billing_address', e.target.value)} /></Field>
            <Field label="Shipping address (blank = same as billing)" span><textarea style={{ ...inputStyle, width: '100%', minHeight: 50, fontFamily: 'inherit' }} value={f.shipping_address} onChange={e => set('shipping_address', e.target.value)} /></Field>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Contact</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Contact person"><input style={{ ...inputStyle, width: '100%' }} value={f.contact_person} onChange={e => set('contact_person', e.target.value)} /></Field>
            <Field label="Phone"><input style={{ ...inputStyle, width: '100%' }} value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
            <Field label="Email"><input style={{ ...inputStyle, width: '100%' }} value={f.email} onChange={e => set('email', e.target.value)} /></Field>
            <Field label="Active">
              <select style={{ ...selectStyle, width: '100%' }} value={f.is_active ? '1' : '0'} onChange={e => set('is_active', e.target.value === '1')}>
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </Field>
            <Field label="Notes" span><textarea style={{ ...inputStyle, width: '100%', minHeight: 50, fontFamily: 'inherit' }} value={f.notes} onChange={e => set('notes', e.target.value)} /></Field>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPrimary} onClick={submit} disabled={saving || !f.name.trim()}>{saving ? 'Saving…' : 'Save Partner'}</button>
        <button style={btnSecondary} onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}
