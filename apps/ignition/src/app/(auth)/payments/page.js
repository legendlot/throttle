'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Trash2 } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';
import { NewPaymentModal } from '../../../components/NewPaymentModal.js';

const rupee = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const KIND_LABEL = { advance: 'Advance', final: 'Final', other: 'Other' };

export default function PaymentsPage() {
  const { session } = useAuth();
  const { toast } = useToast();
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
    try { await ignitionopsPost('deletePayment', { id }, session); toast('Payment removed', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const s = data?.summary;
  const payments = data?.payments || [];

  return (
    <div style={{ maxWidth: 1100 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Payments</h1>
        <button onClick={() => setModal(true)} style={newBtn}><Plus size={15} strokeWidth={2.25} /> Record Payment</button>
      </header>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Tile label="Today" tile={s?.today} />
        <Tile label="This Week" tile={s?.week} />
        <Tile label="This Month" tile={s?.month} />
        <Tile label="All Time" tile={s?.all} muted />
      </div>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Date</th><th style={th}>Influencer</th><th style={th}>Deal</th>
                <th style={th}>Kind</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Note</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 && (
                <tr><td colSpan={7} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No payments recorded yet</td></tr>
              )}
              {payments.map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{p.paid_on}</td>
                  <td style={td}>
                    {p.influencer
                      ? <><span style={{ color: '#FF6B00', fontWeight: 600 }}>{p.influencer.influencer_code}</span> {p.influencer.channel_name || p.influencer.person_name || ''}</>
                      : '—'}
                  </td>
                  <td style={td}>
                    {p.engagement
                      ? <span onClick={() => router.push(`/engagements/detail/?id=${p.engagement_id}`)} style={{ cursor: 'pointer', color: 'var(--text-1)' }}>{p.engagement.engagement_no}{p.engagement.product_code ? ` · ${p.engagement.product_code}` : ''}</span>
                      : '—'}
                  </td>
                  <td style={td}><span style={kindChip(p.kind)}>{KIND_LABEL[p.kind] || p.kind}</span></td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{rupee(p.amount)}</td>
                  <td style={{ ...td, color: 'var(--text-3)' }}>{p.note || '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {canManage && (
                      <button onClick={() => del(p.id)} title="Remove" style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>
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

function Tile({ label, tile, muted }) {
  return (
    <div style={{ flex: '1 1 200px', minWidth: 180, background: 'var(--surface)', border: `1px solid ${muted ? 'var(--border)' : '#FF6B00'}`, borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: muted ? 'var(--text-3)' : '#FF6B00', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-1)', fontFamily: 'var(--font-cond)', marginTop: 4 }}>
        {tile ? `₹${Number(tile.amount).toLocaleString('en-IN')}` : '–'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
        {tile ? `${tile.count} payment${tile.count === 1 ? '' : 's'} · ${tile.influencers} influencer${tile.influencers === 1 ? '' : 's'}` : ''}
      </div>
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
const newBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: '#FF6B00', color: '#fff',
  border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 14px',
  fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
function kindChip(kind) {
  const c = kind === 'advance' ? '#F2CD1A' : kind === 'final' ? '#FF6B00' : 'var(--text-3)';
  return { fontSize: 11, color: c, border: `1px solid ${c}`, borderRadius: 'var(--radius-sm)', padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' };
}
