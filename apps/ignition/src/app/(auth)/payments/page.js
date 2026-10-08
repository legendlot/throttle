'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Trash2, Paperclip } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';
import { NewPaymentModal } from '../../../components/NewPaymentModal.js';
import { paymentKindLabel } from '../../../lib/paymentKinds.js';

const rupee = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function PaymentsPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(false);
  const canManage = !!session;

  function load() {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getPayments', {}, session)
      .then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }
  useEffect(load, [session]);

  async function del(id) {
    // The bin is a bigger target in the Pit Control row; a payment row is money history (S412).
    if (!window.confirm('Remove this payment record?')) return;
    try { await ignitionopsPost('deletePayment', { id }, session); toast('Payment removed', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function viewProof(id) {
    try {
      const r = await ignitionopsGet('getPaymentProofUrl', { id }, session);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      else toast('No screenshot on this payment', 'error');
    } catch (e) { toast(e.message, 'error'); }
  }

  const s = data?.summary;
  const payments = data?.payments || [];

  return (
    <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header className="ig-up" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: 'var(--text-4)' }}>WORK · MONEY OUT, WITH PROOF</div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Payments</h1>
        </div>
        <button onClick={() => setModal(true)} style={newBtn}><Plus size={15} strokeWidth={2.25} /> Record payment</button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <PayTile label="Today" tile={s?.today} d={60} />
        <PayTile label="This week" tile={s?.week} d={110} />
        <PayTile label="This month" tile={s?.month} d={160} accent />
        <PayTile label="All time" tile={s?.all} d={210} muted />
      </div>

      {loading ? <Spinner /> : (
        <div className="ig-up" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', overflowX: 'auto', animationDelay: '220ms' }}>
          <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th style={th}>Date</th><th style={th}>Influencer</th><th style={th}>Deal</th>
                <th style={th}>Kind</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Note</th><th style={th}>Proof</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 && (
                <tr><td colSpan={8} style={{ ...td, color: 'var(--text-4)', textAlign: 'center' }}>No payments recorded yet</td></tr>
              )}
              {payments.map(p => (
                <tr key={p.id} className="ig-row" style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-2)' }}>{p.paid_on}</td>
                  <td style={td}>
                    {p.influencer
                      ? <><span style={{ color: 'var(--accent-hi)', fontWeight: 600 }}>{p.influencer.influencer_code}</span> <span style={{ fontWeight: 600 }}>{p.influencer.channel_name || p.influencer.person_name || ''}</span></>
                      : '—'}
                  </td>
                  <td style={td}>
                    {p.engagement
                      ? <span onClick={() => router.push(`/engagements/detail/?id=${p.engagement_id}`)} style={{ cursor: 'pointer', color: 'var(--accent-hi)', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 }}>{p.engagement.engagement_no}{p.engagement.product_code ? ` · ${p.engagement.product_code}` : ''}</span>
                      : '—'}
                  </td>
                  <td style={td}><span style={kindChip(p.kind)}>{paymentKindLabel(p.kind)}</span></td>
                  <td className="num" style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, whiteSpace: 'nowrap' }}>{rupee(p.amount)}</td>
                  <td style={{ ...td, color: 'var(--text-2)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.note || '—'}</td>
                  <td style={{ ...td, fontSize: 13, whiteSpace: 'nowrap' }}>
                    {p.proof_path ? (
                      <button onClick={() => viewProof(p.id)} title={p.proof_name || 'View screenshot'} style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--accent-hi)', cursor: 'pointer', font: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Paperclip size={13} /> View ↗
                      </button>
                    ) : <span style={{ color: 'var(--state-error-fg)' }}>Missing</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canManage && (
                      <button className="ig-ctl" onClick={() => del(p.id)} title="Remove" style={{ background: 'transparent', border: 'none', borderRadius: 8, width: 30, height: 30, color: 'var(--text-4)', cursor: 'pointer' }}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewPaymentModal open={modal} onClose={() => setModal(false)} session={session} onSaved={load} />
    </div>
  );
}

function PayTile({ label, tile, d, accent, muted }) {
  return (
    <div className="ig-up" style={{ animationDelay: `${d}ms`, background: muted ? 'var(--surface-sunk)' : 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, color: accent ? 'var(--accent-hi)' : muted ? 'var(--text-2)' : 'var(--text-1)' }}>
        {tile ? rupee(tile.amount) : '–'}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text-4)' }}>
        {tile ? `${tile.count} payment${tile.count === 1 ? '' : 's'} · ${tile.influencers} influencer${tile.influencers === 1 ? '' : 's'}` : ''}
      </span>
    </div>
  );
}

const th = { padding: '12px 18px', fontSize: 12, color: 'var(--text-4)', fontWeight: 600 };
const td = { padding: '10px 18px' };
const newBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 42, padding: '0 16px', background: 'var(--text-1)', color: 'var(--bg, #0e1015)',
  border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
};
function kindChip(kind) {
  const [fg, bg] = kind === 'advance' ? ['#fbbf24', 'rgba(251,191,36,.14)']
    : kind === 'final' ? ['#4ade80', 'rgba(34,197,94,.14)']
    : ['var(--text-2)', 'rgba(169,176,194,.12)'];
  return { display: 'inline-block', fontSize: 12, fontWeight: 600, color: fg, background: bg, borderRadius: 8, padding: '3px 9px' };
}
