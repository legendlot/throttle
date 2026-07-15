'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, pageH1, pageSub,
} from '@/lib/snorkelui';
import { createMould } from '@/lib/moulds';

function Field({ label, children, span }) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : 'auto' }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export default function NewMouldPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [vendors, setVendors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    mould_no: '', description: '', vendor_code: '', hsn_code: '', gst_percent: '',
    default_shot_rate: '', notes: '',
  });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!session) return;
    garageFetch('getVendors', {}, session).then(d => setVendors(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.po_create) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  async function submit() {
    if (!f.mould_no.trim()) { showToast('Mould number is required', 'error'); return; }
    setSaving(true);
    try {
      const data = {
        mould_no: f.mould_no.trim(), description: f.description.trim() || null,
        vendor_code: f.vendor_code || null, hsn_code: f.hsn_code.trim() || null,
        gst_percent: f.gst_percent !== '' ? Number(f.gst_percent) : null,
        default_shot_rate: f.default_shot_rate !== '' ? Number(f.default_shot_rate) : null,
        notes: f.notes.trim() || null,
      };
      const res = await createMould(data, session);
      if (!res.ok) throw new Error(res.error || 'Create failed');
      showToast(`Mould ${res.data.mould_no} created — now map its parts`, 'success');
      router.push(`/moulds/detail?mould_no=${encodeURIComponent(res.data.mould_no)}`);
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
      setSaving(false);
    }
  }

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 };

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 760 }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>New Mould</h1>
        <p style={pageSub}>Register the mould, then map the part codes it produces (each with its per-shot count).</p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Details</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Mould No *"><input style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} value={f.mould_no} onChange={e => set('mould_no', e.target.value)} placeholder="e.g. 25306" /></Field>
            <Field label="Vendor (one per mould)">
              <select style={{ ...selectStyle, width: '100%' }} value={f.vendor_code} onChange={e => set('vendor_code', e.target.value)}>
                <option value="">— none —</option>
                {vendors.map(v => <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name}</option>)}
              </select>
            </Field>
            <Field label="Description" span><input style={{ ...inputStyle, width: '100%' }} value={f.description} onChange={e => set('description', e.target.value)} placeholder="e.g. Remote Control Parts" /></Field>
            <Field label="HSN code"><input style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} value={f.hsn_code} onChange={e => set('hsn_code', e.target.value)} placeholder="9503" /></Field>
            <Field label="GST %"><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.gst_percent} onChange={e => set('gst_percent', e.target.value)} placeholder="18" /></Field>
            <Field label="Default block rate / shot (₹)"><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.default_shot_rate} onChange={e => set('default_shot_rate', e.target.value)} placeholder="optional" /></Field>
            <Field label="Notes"><input style={{ ...inputStyle, width: '100%' }} value={f.notes} onChange={e => set('notes', e.target.value)} /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button style={btnPrimary} disabled={saving} onClick={submit}>{saving ? 'Saving…' : 'Create mould'}</button>
            <button style={btnSecondary} disabled={saving} onClick={() => router.push('/moulds')}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
