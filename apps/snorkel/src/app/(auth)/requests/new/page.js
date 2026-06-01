'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, pageH1, pageSub,
} from '@/lib/snorkelui';

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
      router.push(`/requests/detail/?request_no=${encodeURIComponent(result.request_no)}`);
    } catch (e) {
      showToast(e.message || 'Failed to submit request', 'error');
      setSubmitting(false);
    }
  }

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 760 }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>New PO Request</h1>
        <p style={pageSub}>Tell procurement what you need. Be specific — quantities, links, specs all help.</p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Request Details</span></div>
        <div style={panelBodyStyle}>
          <div style={{ marginBottom: 12 }}>
            <span style={labelStyle}>Title *</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 20× ceiling fans for the new floor"
                   style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
          </div>

          <div style={{ marginBottom: 12 }}>
            <span style={labelStyle}>What do you need? *</span>
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={6}
                      placeholder="Describe the item(s), quantity, specs, links, and why. The more detail, the faster procurement can act."
                      style={{ ...inputStyle, width: '100%', resize: 'vertical' }} disabled={submitting} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <span style={labelStyle}>Category</span>
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Office / Consumable / Component / Machine…"
                     style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
            </div>
            <div>
              <span style={labelStyle}>Suggested Vendor (optional)</span>
              <input value={suggestedVendor} onChange={(e) => setSuggestedVendor(e.target.value)}
                     style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <span style={labelStyle}>Est. Cost</span>
              <input type="number" min="0" value={estCost} onChange={(e) => setEstCost(e.target.value)}
                     style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submitting} />
            </div>
            <div>
              <span style={labelStyle}>Currency</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                <option>INR</option><option>USD</option><option>CNY</option><option>EUR</option>
              </select>
            </div>
            <div>
              <span style={labelStyle}>Urgency</span>
              <select value={urgency} onChange={(e) => setUrgency(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                <option>Low</option><option>Normal</option><option>High</option><option>Urgent</option>
              </select>
            </div>
            <div>
              <span style={labelStyle}>Needed By</span>
              <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)}
                     style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submitting} />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <span style={labelStyle}>Notes (optional)</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button style={btnSecondary} onClick={() => router.push('/requests')} disabled={submitting}>Cancel</button>
            <button style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
                    onClick={submit} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
