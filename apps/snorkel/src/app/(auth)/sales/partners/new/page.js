'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { pageH1, pageSub } from '@/lib/snorkelui';
import PartnerForm from '../PartnerForm';

export default function NewPartnerPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [channels, setChannels] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session) return;
    garageFetch('getSalesChannels', {}, session).then(d => setChannels(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.sales_partner_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  async function submit(data) {
    setSaving(true);
    try {
      const res = await workerFetch('createSalesPartner', { data }, session);
      if (!res.ok) throw new Error(res.error || 'Create failed');
      showToast(`Partner ${res.data.partner_code} created`, 'success');
      router.push(`/sales/partners/detail?id=${encodeURIComponent(res.data.id)}`);
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
      setSaving(false);
    }
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>New Partner</h1>
        <p style={pageSub}>An SP-code is assigned automatically.</p>
      </div>
      <PartnerForm channels={channels} saving={saving} onSubmit={submit} onCancel={() => router.push('/sales/partners')} />
    </div>
  );
}
