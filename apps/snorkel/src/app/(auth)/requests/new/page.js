'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { Send } from 'lucide-react';
import { PageHead, Panel, Btn } from '@/components/ui.js';

function FormField({ label, children, full }) {
  return <div className={`ff ${full ? 'ff-full' : ''}`}><label className="kv-k">{label}</label>{children}</div>;
}

export default function NewRequestPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [category, setCategory] = useState('');
  const [suggestedVendor, setSuggestedVendor] = useState('');
  const [estCost, setEstCost] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [urgency, setUrgency] = useState('Normal');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!title.trim()) { showToast('Title required', 'error'); return; }
    if (!details.trim()) { showToast('Describe what you need', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('postRequest', {
        data: {
          title: title.trim(), details: details.trim(),
          category: category.trim() || null,
          suggested_vendor: suggestedVendor.trim() || null,
          estimated_cost: estCost !== '' ? Number(estCost) : null,
          currency, urgency,
          needed_by: neededBy || null,
          notes: notes.trim() || null,
        },
      }, session);
      const result = res.data || res;
      showToast(`${result.request_no} submitted`, 'success');
      router.push(`/requests/detail?request_no=${encodeURIComponent(result.request_no)}`);
    } catch (e) {
      showToast(e.message || 'Failed to submit request', 'error');
      setSubmitting(false);
    }
  }

  return (
    <div className="pg" style={{ maxWidth: 760 }}>
      <PageHead title="New PO Request" sub="Tell procurement what you need. The more context, the faster they can raise a PO." />
      <Panel title="Request details" pad>
        <div className="form-grid">
          <FormField label="Title" full><input className="f-inp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 20× ceiling fans for the new floor" disabled={submitting} /></FormField>
          <FormField label="What do you need?" full><textarea className="f-inp" rows="5" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Item(s), quantity, specs, links, and why. The more detail, the faster procurement can act." disabled={submitting} /></FormField>
          <FormField label="Category"><input className="f-inp" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Office / Consumable / Component / Machine…" disabled={submitting} /></FormField>
          <FormField label="Suggested vendor (optional)"><input className="f-inp" value={suggestedVendor} onChange={(e) => setSuggestedVendor(e.target.value)} disabled={submitting} /></FormField>
          <FormField label="Estimated cost"><input className="f-inp mono" type="number" min="0" value={estCost} onChange={(e) => setEstCost(e.target.value)} placeholder="0" disabled={submitting} /></FormField>
          <FormField label="Currency">
            <select className="sel f-inp" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={submitting}>
              <option>INR</option><option>USD</option><option>CNY</option><option>EUR</option>
            </select>
          </FormField>
          <FormField label="Urgency">
            <select className="sel f-inp" value={urgency} onChange={(e) => setUrgency(e.target.value)} disabled={submitting}>
              <option>Low</option><option>Normal</option><option>High</option><option>Urgent</option>
            </select>
          </FormField>
          <FormField label="Needed by"><input className="f-inp mono" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} disabled={submitting} /></FormField>
          <FormField label="Notes (optional)" full><input className="f-inp" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} /></FormField>
        </div>
        <div className="form-foot">
          <Btn onClick={() => router.push('/requests')} disabled={submitting}>Cancel</Btn>
          <Btn kind="primary" onClick={submit} disabled={submitting}><Send size={14} /> {submitting ? 'Submitting…' : 'Submit request'}</Btn>
        </div>
      </Panel>
    </div>
  );
}
