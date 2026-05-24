'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { EmptyState, Panel, useToast } from '@throttle/ui';

const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', outline: 'none', width: '100%' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, display: 'block' };
const btnP  = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '10px 18px', fontFamily: 'var(--cond)', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t2)', cursor: 'pointer' };

const CHANNEL_OPTIONS = ['Website', 'Amazon', 'Flipkart', 'FirstCry', 'Cred', 'Offline', 'Other'];

export default function CustomerRepairNewPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const allowed = hasPermission(perms, 'customer_repair_manage') || hasPermission(perms, 'users_manage');

  const [f, setF] = useState({
    customer_name: '', customer_phone: '', customer_address: '',
    order_id: '', channel: '', product_claim: '',
    awb: '', logistics_partner: '', pickup_contact: '',
    notes: '',
  });
  const [submitting, setSubmitting] = useState(false);

  function setField(k, v) { setF(prev => ({ ...prev, [k]: v })); }

  async function submit() {
    if (!f.customer_name.trim()) { toast('Customer name required', 'err'); return; }
    setSubmitting(true);
    try {
      const r = await workerFetch('createCustomerRepair', { data: f }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'err'); return; }
      toast(`${r.data.repair_no} created`, 'ok');
      router.push(`/customer-repairs/detail?id=${r.data.id}`);
    } catch (e) {
      toast(e.message || 'Failed', 'err');
    } finally { setSubmitting(false); }
  }

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState icon="🔒" message="Access denied — you need customer_repair_manage permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 880 }}>
      <Panel header="New Customer Repair">
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 16, letterSpacing: '0.04em' }}>
          Only the customer name is required. You can come back any time to fill in pickup, AWB and logistics details.
        </div>

          {/* Customer block */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={lbl}>Customer name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input value={f.customer_name} onChange={e => setField('customer_name', e.target.value)} style={input} autoFocus />
            </div>
            <div>
              <label style={lbl}>Phone</label>
              <input value={f.customer_phone} onChange={e => setField('customer_phone', e.target.value)} placeholder="10-digit mobile" style={input} />
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Address</label>
              <textarea rows={2} value={f.customer_address} onChange={e => setField('customer_address', e.target.value)} style={{ ...input, resize: 'vertical' }} />
            </div>
          </div>

          {/* Order block */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={lbl}>Order ID</label>
              <input value={f.order_id} onChange={e => setField('order_id', e.target.value)} placeholder="e.g. AMZN-123-456" style={input} />
            </div>
            <div>
              <label style={lbl}>Channel</label>
              <input list="ch-list" value={f.channel} onChange={e => setField('channel', e.target.value)} placeholder="Website / Amazon / …" style={input} />
              <datalist id="ch-list">
                {CHANNEL_OPTIONS.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Product claim / issue description</label>
              <textarea rows={3} value={f.product_claim} onChange={e => setField('product_claim', e.target.value)} placeholder="What's the issue? e.g. Front LED not lighting up on Flare Burnout Red" style={{ ...input, resize: 'vertical' }} />
            </div>
          </div>

          {/* Pickup block — optional */}
          <h3 style={{ margin: '8px 0 10px', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, color: 'var(--t2)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Pickup & Logistics · Optional · Can fill later
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={lbl}>AWB / Tracking number</label>
              <input value={f.awb} onChange={e => setField('awb', e.target.value)} placeholder="Pickup AWB" style={input} />
            </div>
            <div>
              <label style={lbl}>Logistics partner</label>
              <input value={f.logistics_partner} onChange={e => setField('logistics_partner', e.target.value)} placeholder="Delhivery / BlueDart / Self-pickup" style={input} />
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Pickup contact (driver name + phone)</label>
              <input value={f.pickup_contact} onChange={e => setField('pickup_contact', e.target.value)} placeholder="Driver name + phone number" style={input} />
            </div>
          </div>

          {/* Notes */}
          <div style={{ marginBottom: 16 }}>
            <label style={lbl}>Internal notes</label>
            <textarea rows={2} value={f.notes} onChange={e => setField('notes', e.target.value)} style={{ ...input, resize: 'vertical' }} />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => router.push('/customer-repairs')} style={btnS} disabled={submitting}>Cancel</button>
            <button onClick={submit} style={{ ...btnP, opacity: submitting ? 0.6 : 1 }} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Repair'}
            </button>
          </div>
      </Panel>
    </div>
  );
}
