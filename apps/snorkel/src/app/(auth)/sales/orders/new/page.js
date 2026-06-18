'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { pageH1, pageSub } from '@/lib/snorkelui';
import OrderForm from '../OrderForm';

export default function NewOrderPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [partners, setPartners] = useState([]);
  const [channels, setChannels] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session) return;
    garageFetch('getSalesPartners', { active: '1' }, session).then(d => setPartners(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getSalesChannels', {}, session).then(d => setChannels(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.sales_order_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  async function submit(data) {
    if (!data.partner_id) { showToast('Select a partner', 'error'); return; }
    if (!data.lines.length) { showToast('Add at least one line', 'error'); return; }
    setSaving(true);
    try {
      const res = await workerFetch('createSalesOrder', { data }, session);
      if (!res.ok) throw new Error(res.error || 'Create failed');
      showToast(`Order ${res.data.order_no} created`, 'success');
      router.push(`/sales/orders/detail?id=${encodeURIComponent(res.data.id)}`);
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
      setSaving(false);
    }
  }

  // Inline partner quick-create — persists, prepends to the dropdown, returns the
  // new row so the form can select it without waiting for a reload.
  async function createPartner(data) {
    const res = await workerFetch('createSalesPartner', { data }, session);
    if (!res.ok) throw new Error(res.error || 'Create failed');
    const np = { ...data, id: res.data.id, partner_code: res.data.partner_code };
    setPartners(prev => [np, ...prev]);
    showToast(`Partner ${np.partner_code} created`, 'success');
    return np;
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>New Sales Order</h1>
        <p style={pageSub}>Saved as Draft. Confirm it to hand off to dispatch.</p>
      </div>
      <OrderForm partners={partners} channels={channels} saving={saving} onSubmit={submit} onCancel={() => router.push('/sales/orders')} onCreatePartner={perms?.sales_partner_manage ? createPartner : null} />
    </div>
  );
}
