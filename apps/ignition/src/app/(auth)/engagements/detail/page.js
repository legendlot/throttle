'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import StageBadge from '../../../../components/StageBadge.js';
import StageStepper from '../../../../components/StageStepper.js';
import DealTypeBadge from '../../../../components/DealTypeBadge.js';
import AdvanceModal from '../../../../components/AdvanceModal.js';
import OpenPitstopButton from '../../../../components/OpenPitstopButton.js';

export default function EngagementDetailPage() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const eno = sp.get('engagement_no');
  const { session } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [note, setNote] = useState('');

  function reload() {
    if (!session || (!id && !eno)) return;
    const params = id ? { id } : { engagement_no: eno };
    ignitionopsGet('getEngagement', params, session).then(setData).catch(e => setErr(e.message));
  }
  useEffect(reload, [id, eno, session]);

  async function doAdvance({ to_stage, note }) {
    await ignitionopsPost('advanceStage', { engagement_id: data.engagement.id, to_stage, note }, session);
    toast(`Advanced to ${to_stage}`, 'success');
    reload();
  }

  async function addNote() {
    if (!note.trim()) return;
    await ignitionopsPost('addNote', { engagement_id: data.engagement.id, body: note }, session);
    setNote('');
    toast('Note added', 'success');
    reload();
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;
  const e = data.engagement;
  const inf = e.influencer || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1200 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#FF6B00', fontWeight: 700, fontSize: 18 }}>{e.engagement_no}</span>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {inf.channel_name || inf.influencer_code || '—'}
        </h1>
        <StageBadge stage={e.stage} size="lg" />
        <DealTypeBadge dealType={e.deal_type} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <OpenPitstopButton engagement={e} onLinked={reload} />
          <button
            onClick={() => setAdvOpen(true)}
            disabled={data.allowed_next.length === 0}
            style={{
              padding: '6px 14px', background: '#FF6B00', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              cursor: data.allowed_next.length === 0 ? 'not-allowed' : 'pointer',
              opacity: data.allowed_next.length === 0 ? 0.5 : 1,
            }}
          >Advance →</button>
        </div>
      </div>

      <Card title="Pipeline">
        <StageStepper stage={e.stage} />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <Card title="Deal Terms">
          <KV label="Type" value={e.engagement_type === 'ugc' ? 'UGC' : 'Video'} />
          <KV label="Deal type" value={e.deal_type} />
          <KV label="Payment terms" value={e.payment_terms || '—'} />
          <KV label="Payment amount" value={`₹${Number(e.payment_amount || 0).toLocaleString()}`} />
          {e.affiliate_pct != null && <KV label="Affiliate %" value={`${e.affiliate_pct}%`} />}
          {e.commission_amount != null && <KV label="Commission" value={`₹${Number(e.commission_amount).toLocaleString()}`} />}
        </Card>

        <Card title="Product">
          <KV label="Code" value={e.product_code || '—'} />
          <KV label="Variant" value={e.product_variant || '—'} />
          <KV label="Directed to" value={e.directed_to || '—'} />
        </Card>

        <Card title="Costs">
          <KV label="Goodies" value={`₹${Number(e.goodies_cost || 0).toLocaleString()}`} />
          <KV label="Shipping" value={`₹${Number(e.shipping_cost || 0).toLocaleString()}`} />
          <KV label="Return" value={`₹${Number(e.return_cost || 0).toLocaleString()}`} />
          <KV label="Ad spend" value={`₹${Number(e.ad_spend || 0).toLocaleString()}`} />
          <KV label="CPM" value={e.cpm != null ? `₹${Number(e.cpm).toFixed(2)}` : '—'} />
          <KV label="TOTAL" value={<strong style={{ color: '#FF6B00' }}>₹{Number(e.total_cost || 0).toLocaleString()}</strong>} />
        </Card>

        <Card title="Logistics">
          <KV label="Shipping order" value={e.shipping_order_id || '—'} />
          <KV label="Tracking" value={e.tracking_id || '—'} />
          <KV label="Shipping date" value={e.shipping_date || '—'} />
          {e.cs_ticket_no && <KV label="Pitstop ticket" value={<span style={{ color: 'var(--state-error-fg)' }}>{e.cs_ticket_no}</span>} />}
        </Card>

        <Card title="Post-live">
          <KV label="Expected post" value={e.expected_post_date || '—'} />
          <KV label="Actual post" value={e.post_date || '—'} />
          <KV label="Video link" value={e.video_link ? <a href={e.video_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{e.video_link.slice(0, 40)}…</a> : '—'} />
          <KV label="UTM link" value={e.utm_link ? <a href={e.utm_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>open</a> : '—'} />
        </Card>

        <Card title="Performance">
          <KV label="Views" value={(e.views || 0).toLocaleString()} />
          <KV label="Likes" value={(e.likes || 0).toLocaleString()} />
          <KV label="Comments" value={(e.comments || 0).toLocaleString()} />
          <KV label="Shares" value={(e.shares || 0).toLocaleString()} />
          <KV label="Sessions" value={(e.sessions || 0).toLocaleString()} />
          <KV label="Orders" value={(e.orders || 0).toLocaleString()} />
          <KV label="Conversions ₹" value={`₹${Number(e.conversions_value || 0).toLocaleString()}`} />
          {e.actual_roas != null && <KV label="Actual ROAS" value={Number(e.actual_roas).toFixed(2)} />}
        </Card>
      </div>

      <Card title="Notes">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={note} onChange={(ev) => setNote(ev.target.value)}
            placeholder="Add a note…"
            onKeyDown={(ev) => { if (ev.key === 'Enter') addNote(); }}
            style={{
              flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
            }}
          />
          <button onClick={addNote} style={{
            padding: '8px 14px', background: 'var(--surface-3)', color: 'var(--text-1)',
            border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
          }}>Add</button>
        </div>
        {data.notes.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No notes yet.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.notes.map(n => (
              <div key={n.id} style={{ padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                  {new Date(n.created_at).toLocaleString()}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="History">
        {data.history.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No history yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: 'var(--surface-2)' }}>
              <th style={th}>When</th><th style={th}>Action</th><th style={th}>From</th><th style={th}>To</th><th style={th}>Note</th>
            </tr></thead>
            <tbody>
              {data.history.map(h => (
                <tr key={h.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{new Date(h.created_at).toLocaleString()}</td>
                  <td style={td}>{h.action}</td>
                  <td style={td}>{h.stage_from || '—'}</td>
                  <td style={td}>{h.stage_to || '—'}</td>
                  <td style={td}>{h.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <AdvanceModal
        open={advOpen}
        engagement={e}
        onClose={() => setAdvOpen(false)}
        onAdvance={doAdvance}
      />
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: 16,
    }}>
      <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>{title}</h2>
      {children}
    </section>
  );
}

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
      <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ color: 'var(--text-1)', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}
const th = { padding: '6px 10px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, textAlign: 'left' };
const td = { padding: '6px 10px' };
