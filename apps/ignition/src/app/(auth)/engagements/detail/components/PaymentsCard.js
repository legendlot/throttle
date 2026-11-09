'use client';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { NewPaymentModal } from '../../../../../components/NewPaymentModal.js';
import { paymentKindLabel } from '../../../../../lib/paymentKinds.js';
import { commissionRequestLabel } from '../../../../../lib/commission.js';
import { Card, KV, miniBtn } from './shared.js';
import { DealPaymentModal } from './DealPaymentModal.js';

// Snorkel payment requests on this deal (Reann #2 S4). The worker sends no bank number or PAN, and
// every refusal is a sentence written for the team, so errors are shown exactly as they come back.
// 'commission' (Reann #3) is raised by D2C's verify on the Commission page, never from this card; it
// sits outside the fee, so it never blocks a fee raise and is in none of the Agreed/Raised/Paid figures.
const KIND_WORDS = { advance: 'Advance', balance: 'Balance', full: 'Full payment', commission: 'Commission' };
const STATE = {
  waiting_for_invoice: ['Waiting for invoice', 'warning'],
  sending: ['Sending', 'info'],
  send_failed: ['Send failed', 'error'],
  submitted: ['Submitted', 'info'],
  pending_approval: ['Awaiting approval', 'warning'],
  approved: ['Approved', 'info'],
  held: ['Held', 'warning'],
  rejected: ['Rejected', 'error'],
  paid: ['Paid', 'success'],
  cancelled: ['Cancelled', 'neutral'],
};
const DEAD = ['rejected', 'cancelled'];
const CLOSED_STAGES = ['cancelled', 'dropped', 'ghosted'];   // deal_payment_refusal refuses these
// What a cancel click actually did, from the row it returns (it may have been adopted from Snorkel).
const CANCEL_WORDS = {
  cancelled: ['Cancelled', 'success'],
  rejected: ['Not cancelled — Snorkel had already rejected it', 'error'],
  paid: ['Not cancelled — Finance had already paid it', 'error'],
  held: ['Not cancelled — it is already in Snorkel, held', 'error'],
};
const inr = n => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const istDay = d => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function StateBadge({ state }) {
  const [label, tone] = STATE[state] || [state, 'neutral'];
  const fg = tone === 'neutral' ? 'var(--text-3)' : `var(--state-${tone}-fg)`;
  const bg = tone === 'neutral' ? 'var(--chip-neutral)' : `var(--state-${tone}-bg)`;
  return <span style={{ display: 'inline-flex', padding: '2px 9px', borderRadius: 99, fontSize: 12, fontWeight: 600, color: fg, background: bg, whiteSpace: 'nowrap' }}>{label}</span>;
}

/** Payments for THIS deal: Snorkel requests, then the hand log as history (Reann #7, 2026-08-27). */
export function PaymentsCard({ payments, paidTotal, agreed, engagement, influencer, canEdit, session, onSaved, commissionMonths = {}, onCommissionRequests }) {
  const { showToast: toast } = useToast();
  const [open, setOpen] = useState(false);
  const [dp, setDp] = useState(null);
  const [dpErr, setDpErr] = useState('');
  const [modal, setModal] = useState(null);   // { mode: 'raise', kind } | { mode: 'attach', request }
  const [busyId, setBusyId] = useState(null);
  const seq = useRef(0);

  // Only the latest call may land: a slow earlier reply must not overwrite a newer one. A failed
  // read clears `dp`, so no gate (+ Add, Raise) is ever decided on stale data.
  function loadDp() {
    if (!session) return;
    const n = ++seq.current;
    ignitionopsGet('getDealPayments', { engagement_id: engagement.id }, session)
      .then(d => {
        if (n !== seq.current) return;
        setDp(d); setDpErr('');
        onCommissionRequests?.((d?.requests || []).some(r => r.kind === 'commission'));
      })
      .catch(e => { if (n === seq.current) { setDp(null); setDpErr(e.message); } });
  }
  // `payments` is a fresh array on every page reload, so a save anywhere on the page refreshes this too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadDp, [engagement.id, payments, session]);
  function saved() { loadDp(); onSaved?.(); }

  async function viewProof(id) {
    try {
      // Signed, short-lived URL — the bucket is private (ignition-payment-proofs), so the
      // screenshot is never a public link.
      const r = await ignitionopsGet('getPaymentProofUrl', { id }, session);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      else toast('No screenshot on this payment', 'error');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function viewInvoice(id) {
    try {
      const r = await ignitionopsGet('getDealInvoiceUrl', { id }, session);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
    } catch (e) { toast(e.message, 'error'); }
  }
  const kindWords = r => (r.kind === 'commission' ? commissionRequestLabel(commissionMonths[r.statement_id]) : KIND_WORDS[r.kind] || r.kind);
  async function act(action, r) {
    if (action === 'cancelDealPayment' && !window.confirm(`Cancel this ${kindWords(r)} request for ${inr(r.amount)}?`)) return;
    setBusyId(r.id);
    try {
      const res = await ignitionopsPost(action, { request_id: r.id }, session);
      const st = res?.request?.state;
      if (action === 'retryDealPayment') toast(st === 'send_failed' ? (res.request.last_error || 'Send failed again') : 'Sent to Snorkel', st === 'send_failed' ? 'error' : 'success');
      else {
        const [msg, tone] = CANCEL_WORDS[st] || [`Not cancelled — it is already in Snorkel (${STATE[st]?.[0] || st})`, 'error'];
        toast(msg, tone);
      }
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusyId(null); saved(); }
  }

  // Decision 1, per deal: the hand log only shows history once Snorkel can pay THIS creator (wording
  // published AND bank details from #1). Unknown (loading, or the read failed) offers neither.
  const snorkelReady = dp?.snorkel_ready === true;
  const canHandLog = canEdit && !!dp && !(snorkelReady && dp.bank_on_file === true);
  // Snorkel payouts also write ignition.payments (so "₹X paid of ₹Y" has one source); they are shown
  // on their request row, not twice.
  const hand = payments.filter(p => p.snorkel_request_id == null);
  const requests = dp?.requests || [];
  const live = requests.filter(r => !DEAD.includes(r.state));
  const hasLive = k => live.some(r => r.kind === k);
  // Only a live FEE request (advance/balance/full) holds back "Raise full" — a commission one does not.
  const liveFees = live.filter(r => r.kind !== 'commission');
  const commissionPaid = Number(dp?.commission_paid_total || 0);
  const paid = Number(dp ? dp.paid_total : paidTotal || 0);
  const owed = Number(dp ? dp.agreed : agreed || 0);
  const cleared = owed > 0 && paid >= owed;
  // Raise stays on without bank details: Snorkel may already hold a payee with a bank (Decision 3),
  // and its refusal is shown as it comes back.
  const canRaise = canEdit && snorkelReady && owed > 0 && !CLOSED_STAGES.includes(engagement.stage);

  return (
    <Card title="Payments" action={canHandLog ? '+ Add' : null} onAction={() => setOpen(true)}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
        {[['Agreed', owed], ['Raised', dp?.raised_live_total], ['Paid', paid]].map(([l, v]) => (
          <div key={l} style={{ flex: '1 1 80px', minWidth: 0, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 'var(--r-ctl)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{l}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: l === 'Paid' && cleared ? 'var(--state-success-fg)' : 'var(--text-1)', overflowWrap: 'anywhere' }}>
              {v == null ? '—' : inr(v)}
            </div>
          </div>
        ))}
      </div>

      {dpErr && (
        <div style={{ fontSize: 13, color: 'var(--state-error-fg)', padding: '4px 0' }}>
          Could not load Snorkel requests: {dpErr}{' '}
          <button type="button" className="ig-card-action" onClick={loadDp} style={{ color: 'var(--accent-hi)', fontSize: 13 }}>Retry</button>
        </div>
      )}
      {canHandLog && (
        <div style={{ fontSize: 13, color: 'var(--text-3)', padding: '4px 0 6px', lineHeight: 1.5 }}>
          {snorkelReady
            ? 'No bank details from this creator yet — send the contract, or log a payment made outside Snorkel here.'
            : 'Pay through Snorkel from the Payments card when bank details are on file.'}
        </div>
      )}

      {requests.map(r => {
        const gross = r.paid_amount != null ? Number(r.paid_amount) + Number(r.tds_amount || 0) : Number(r.amount);
        const busy = busyId === r.id;
        return (
          <div key={r.id} style={{ padding: '8px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 }}>
            <div style={rowLine}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                <span style={{ color: 'var(--text-1)' }}>{kindWords(r)}</span>
                <StateBadge state={r.state} />
                {r.snorkel_request_no && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>{r.snorkel_request_no}</span>}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', flexShrink: 0 }}>{inr(r.amount)}</span>
            </div>
            {r.state === 'send_failed' && r.last_error && <div style={{ ...detail, color: 'var(--state-error-fg)' }}>{r.last_error}</div>}
            {r.state === 'held' && <div style={{ ...detail, color: 'var(--state-warning-fg)' }}>{r.held_reason || 'No reason given'}</div>}
            {r.state === 'rejected' && <div style={{ ...detail, color: 'var(--state-error-fg)' }}>{r.rejection_note || 'No note given'}</div>}
            {r.state === 'paid' && (
              <div style={detail}>
                {istDay(r.paid_at)} · {inr(gross)}{r.utr ? <> · UTR <span style={{ fontFamily: 'var(--font-mono)' }}>{r.utr}</span></> : ' · no UTR yet'}
                {Number(r.tds_amount) > 0 && ` · TDS ${inr(r.tds_amount)}`}
              </div>
            )}
            {(r.invoice_no || r.invoice_id) && (
              <div style={detail}>
                Invoice {r.invoice_no || ''}{r.invoice_total != null ? ` · total ${inr(r.invoice_total)}` : ''}
                {r.invoice_id && <> · <button type="button" className="ig-card-action" onClick={() => viewInvoice(r.invoice_id)} style={{ color: 'var(--accent-hi)', fontSize: 12 }}>file ↗</button></>}
              </div>
            )}
            {canEdit && ['waiting_for_invoice', 'send_failed'].includes(r.state) && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {r.state === 'send_failed' && <button type="button" disabled={busy} onClick={() => act('retryDealPayment', r)} className="ig-ghost-btn" style={miniBtn}>Retry</button>}
                <button type="button" disabled={busy} onClick={() => setModal({ mode: 'attach', request: r })} className="ig-ghost-btn" style={miniBtn}>
                  {r.state === 'send_failed' ? 'Change invoice' : 'Add invoice'}
                </button>
                <button type="button" disabled={busy} onClick={() => act('cancelDealPayment', r)} className="ig-ghost-btn" style={miniBtn}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}

      {canRaise && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 0', borderTop: requests.length ? '1px solid var(--row-divider)' : 'none' }}>
          {!hasLive('advance') && !hasLive('full') && <button type="button" onClick={() => setModal({ mode: 'raise', kind: 'advance' })} className="ig-ghost-btn" style={miniBtn}>Raise advance</button>}
          {liveFees.length === 0 && <button type="button" onClick={() => setModal({ mode: 'raise', kind: 'full' })} className="ig-ghost-btn" style={miniBtn}>Raise full</button>}
          {engagement.stage === 'live' && !hasLive('balance') && !hasLive('full') && <button type="button" onClick={() => setModal({ mode: 'raise', kind: 'balance' })} className="ig-ghost-btn" style={miniBtn}>Raise balance</button>}
        </div>
      )}

      {hand.length > 0 && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.04em', textTransform: 'uppercase', padding: '10px 0 2px' }}>Paid by hand</div>
      )}
      {hand.length === 0 && requests.length === 0 ? (
        <div style={{ color: 'var(--text-4)', fontSize: 13, padding: '4px 0 8px' }}>Nothing recorded yet.</div>
      ) : (
        hand.map(p => (
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
      {/* Commission payouts, apart from the fee above (the worker leaves them out of every fee sum). */}
      {commissionPaid > 0 && <KV label="Commission paid" value={<span style={{ fontFamily: 'var(--font-mono)' }}>{inr(commissionPaid)}</span>} />}

      {canHandLog && <NewPaymentModal
        open={open}
        onClose={() => setOpen(false)}
        session={session}
        onSaved={onSaved}
        presetInfluencer={influencer}
        presetEngagementId={engagement.id}
        presetEngagementNo={engagement.engagement_no}
      />}
      {modal && dp && (
        <DealPaymentModal
          mode={modal.mode}
          kind={modal.kind}
          request={modal.request}
          engagement={engagement}
          dp={dp}
          session={session}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); saved(); }}
          onInvoiceAdded={loadDp}
        />
      )}
    </Card>
  );
}

const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 };
const rowLine = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 };
const detail = { fontSize: 12, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5, overflowWrap: 'anywhere' };
