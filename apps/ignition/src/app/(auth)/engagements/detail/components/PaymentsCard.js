'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsGet } from '../../../../../lib/ignitionopsFetch.js';
import { NewPaymentModal } from '../../../../../components/NewPaymentModal.js';
import { paymentKindLabel } from '../../../../../lib/paymentKinds.js';
import { KV } from './shared.js';

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
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Payments</h2>
        {canEdit && (
          <button onClick={() => setOpen(true)} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>+ Record</button>
        )}
      </div>

      <KV label="Paid" value={
        <span style={{ color: cleared ? '#27c93f' : paid > 0 ? '#F2CD1A' : 'var(--text-3)', fontWeight: 600 }}>
          ₹{paid.toLocaleString('en-IN')} of ₹{owed.toLocaleString('en-IN')}{cleared ? ' ✓ cleared' : ''}
        </span>
      } />

      {payments.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 8 }}>Nothing recorded yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {payments.map(p => (
            <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>₹{Number(p.amount || 0).toLocaleString('en-IN')}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase' }}>{paymentKindLabel(p.kind)}</span>
              <span style={{ color: 'var(--text-3)' }}>{p.paid_on || '—'}</span>
              <span style={{ marginLeft: 'auto' }}>
                {p.proof_path ? (
                  <button onClick={() => viewProof(p.id)} title={p.proof_name || 'View screenshot'}
                    style={{ background: 'transparent', border: 'none', color: '#FF6B00', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}>
                    screenshot
                  </button>
                ) : (
                  // A payment with no proof is worth SEEING, not hiding: the screenshot has been
                  // mandatory since S138 #12, so a blank one is an old row or a gap.
                  <span style={{ color: 'var(--text-3)', fontSize: 11 }}>no proof</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <NewPaymentModal
        open={open}
        onClose={() => setOpen(false)}
        session={session}
        onSaved={onSaved}
        presetInfluencer={influencer}
        presetEngagementId={engagement.id}
        presetEngagementNo={engagement.engagement_no}
      />
    </section>
  );
}
