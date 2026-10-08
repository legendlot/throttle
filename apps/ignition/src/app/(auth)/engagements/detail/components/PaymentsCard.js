'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsGet } from '../../../../../lib/ignitionopsFetch.js';
import { NewPaymentModal } from '../../../../../components/NewPaymentModal.js';
import { paymentKindLabel } from '../../../../../lib/paymentKinds.js';
import { Card, KV } from './shared.js';

/** Payments for THIS deal, with the screenshot reachable here (Reann #7, 2026-08-27). */
export function PaymentsCard({ payments, paidTotal, agreed, engagement, influencer, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [open, setOpen] = useState(false);

  async function viewProof(id) {
    try {
      // Signed, short-lived URL — the bucket is private (ignition-payment-proofs), so the
      // screenshot is never a public link.
      const r = await ignitionopsGet('getPaymentProofUrl', { id }, session);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      else toast('No screenshot on this payment', 'error');
    } catch (e) { toast(e.message, 'error'); }
  }

  const paid = Number(paidTotal || 0);
  const owed = Number(agreed || 0);
  const cleared = owed > 0 && paid >= owed;

  return (
    <Card title="Payments" action={canEdit ? '+ Add' : null} onAction={() => setOpen(true)}>

      {payments.length === 0 ? (
        <div style={{ color: 'var(--text-4)', fontSize: 13, padding: '4px 0 8px' }}>Nothing recorded yet.</div>
      ) : (
        payments.map(p => (
          <div key={p.id} style={row}>
            <span style={{ color: 'var(--text-3)', minWidth: 0 }}>
              {p.paid_on || '—'} · {paymentKindLabel(p.kind)}
            </span>
            <span style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexShrink: 0 }}>
              {p.proof_path ? (
                <button onClick={() => viewProof(p.id)} title={p.proof_name || 'View screenshot'} className="ig-card-action"
                  style={{ color: 'var(--accent-hi)', fontSize: 12 }}>
                  screenshot ↗
                </button>
              ) : (
                // A payment with no proof is worth SEEING, not hiding: the screenshot has been
                // mandatory since S138 #12, so a blank one is an old row or a gap.
                <span style={{ color: 'var(--text-4)', fontSize: 12 }}>no proof</span>
              )}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>₹{Number(p.amount || 0).toLocaleString('en-IN')}</span>
            </span>
          </div>
        ))
      )}

      <KV label="Paid so far" value={
        <span style={{ fontFamily: 'var(--font-mono)', color: cleared ? 'var(--state-success-fg)' : paid > 0 ? 'var(--state-warning-fg)' : 'var(--text-3)', fontWeight: 600 }}>
          ₹{paid.toLocaleString('en-IN')} of ₹{owed.toLocaleString('en-IN')}{cleared ? ' ✓ cleared' : ''}
        </span>
      } />

      <NewPaymentModal
        open={open}
        onClose={() => setOpen(false)}
        session={session}
        onSaved={onSaved}
        presetInfluencer={influencer}
        presetEngagementId={engagement.id}
        presetEngagementNo={engagement.engagement_no}
      />
    </Card>
  );
}

const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 };
