'use client';
import { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { panelStyle, panelHeaderStyle, panelBodyStyle, btnPrimary, btnSecondary, pageH1, pageSub, labelStyle, StatusBadge } from '@/lib/snorkelui';
import PartnerForm from '../PartnerForm';

function Row({ label, value }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--t1)' }}>{value || <span style={{ color: 'var(--t3)' }}>—</span>}</div>
    </div>
  );
}

function PartnerDetailInner() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get('id');
  const [partner, setPartner] = useState(null);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const canManage = !!perms?.sales_partner_manage;

  // A tab switch or token refresh hands us a NEW session OBJECT with the same user.
  // Keying `load` on it re-ran the fetch, which flipped `loading` and unmounted an
  // open edit form mid-typing (Vinayram, 2026-07-29). Hold the live session in a ref
  // so every fetch still uses a current token, and key the loads on the stable user id.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const userId = session?.user?.id ?? null;

  const load = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !id) return;
    setLoading(true);
    try {
      const p = await garageFetch('getSalesPartner', { id }, s);
      setPartner(p || null);
    } catch (e) {
      showToast(e.message || 'Failed to load partner', 'error');
    } finally { setLoading(false); }
  }, [userId, id, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const s = sessionRef.current;
    if (!s) return;
    garageFetch('getSalesChannels', {}, s).then(d => setChannels(Array.isArray(d) ? d : [])).catch(() => {});
  }, [userId]);

  if (perms && !perms.sales_view && !perms.sales_order_manage && !perms.sales_partner_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }
  // Never swap an open edit form for the spinner — a background refetch must not
  // discard what the user is typing.
  if (loading && !editing) return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!partner) return <div style={{ padding: 24, color: 'var(--t3)' }}>Partner not found.</div>;

  async function save(data) {
    setSaving(true);
    try {
      const res = await workerFetch('updateSalesPartner', { data: { id, ...data } }, session);
      if (!res.ok) throw new Error(res.error || 'Update failed');
      showToast('Partner updated', 'success');
      setEditing(false);
      load();
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    } finally { setSaving(false); }
  }

  if (editing) {
    return (
      <div style={{ color: 'var(--t1)' }}>
        <div style={{ marginBottom: 16 }}><h1 style={pageH1}>Edit {partner.partner_code}</h1></div>
        <PartnerForm initial={partner} channels={channels} saving={saving} onSubmit={save} onCancel={() => setEditing(false)} />
      </div>
    );
  }

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 };

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 860 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>{partner.name}</h1>
          <p style={pageSub}><span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{partner.partner_code}</span> · {partner.channel_key || '—'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnSecondary} onClick={() => router.push('/sales/partners')}>← Back</button>
          {canManage && <button style={btnPrimary} onClick={() => setEditing(true)}>Edit</button>}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Details</span><StatusBadge label={partner.is_active ? 'Active' : 'Inactive'} tone={partner.is_active ? 'green' : 'gray'} /></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Row label="Channel" value={partner.channel_key} />
            <Row label="Type" value={partner.partner_type} />
            <Row label="GSTIN" value={partner.gstin} />
            <Row label="State" value={partner.state} />
            <Row label="City" value={partner.city} />
            <Row label="Pincode" value={partner.pincode} />
            <Row label="Credit days" value={`${partner.default_credit_days} days`} />
            <Row label="Contact" value={partner.contact_person} />
            <Row label="Phone" value={partner.phone} />
            <Row label="Email" value={partner.email} />
            <Row label="Billing address" value={partner.billing_address} />
            <Row label="Shipping address" value={partner.shipping_address || partner.billing_address} />
            {partner.notes && <Row label="Notes" value={partner.notes} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PartnerDetailPage() {
  return <Suspense fallback={<div style={{ padding: 24 }}><Spinner /></div>}><PartnerDetailInner /></Suspense>;
}
