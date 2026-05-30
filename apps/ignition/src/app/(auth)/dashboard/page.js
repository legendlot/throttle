'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { KpiCard, Spinner, useToast } from '@throttle/ui';
import { AlertTriangle } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';

const OVERDUE_DAYS = 7;

export default function DashboardPage() {
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const canManage = !!perms?.ignition_manage;
  const [kpis, setKpis] = useState(null);
  const [overdue, setOverdue] = useState(null);
  const [err, setErr] = useState(null);
  const [flagging, setFlagging] = useState(false);

  const load = useCallback(() => {
    if (!session) return;
    ignitionopsGet('getKpis', {}, session).then(setKpis).catch(e => setErr(e.message));
    ignitionopsGet('getOverdueEngagements', { days: OVERDUE_DAYS }, session)
      .then(r => setOverdue(r.overdue || [])).catch(() => setOverdue([]));
  }, [session]);
  useEffect(load, [load]);

  async function flagAll() {
    setFlagging(true);
    try {
      const r = await ignitionopsPost('flagOverdueRatings', { days: OVERDUE_DAYS }, session);
      toast(r.flagged > 0 ? `Flagged ${r.flagged} influencer${r.flagged === 1 ? '' : 's'} red` : 'Nothing to flag (all already rated)', 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setFlagging(false); }
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!kpis) return <Spinner />;

  return (
    <div style={{ padding: '8px 0' }}>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16 }}>Dashboard</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, maxWidth: 1100 }}>
        <KpiCard label="Active" value={kpis.active} />
        <KpiCard label="Live" value={kpis.live} accent="#FF6B00" />
        <KpiCard label="Closed" value={kpis.closed} />
        <KpiCard label="Ghosted" value={kpis.ghosted} accent="#ff7070" />
        <KpiCard label={`Overdue posts (>${OVERDUE_DAYS}d)`} value={kpis.overdue ?? 0} accent={kpis.overdue > 0 ? '#ff7070' : undefined} />
      </div>

      {overdue && overdue.length > 0 && (
        <section style={{ marginTop: 24, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', maxWidth: 1100 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-cond)', fontSize: 14, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#ff7070' }}>
              <AlertTriangle size={15} /> Overdue posts ({overdue.length})
            </span>
            {canManage && (
              <button onClick={flagAll} disabled={flagging} style={{ ...btnDanger, opacity: flagging ? 0.5 : 1 }}>
                {flagging ? 'Flagging…' : 'Flag overdue as red'}
              </button>
            )}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={th}>Engagement #</th><th style={th}>Influencer</th><th style={th}>Product</th>
              <th style={th}>Stage</th><th style={th}>Expected</th><th style={th}>Overdue</th><th style={th}>Rating</th>
            </tr></thead>
            <tbody>
              {overdue.map(e => (
                <tr key={e.id} onClick={() => router.push(`/engagements/detail/?id=${e.id}`)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{e.engagement_no}</span></td>
                  <td style={td}>{e.influencer?.channel_name || e.influencer?.person_name || e.influencer?.influencer_code || '—'}</td>
                  <td style={td}>{e.product_code || '—'}{e.product_variant ? ` · ${e.product_variant}` : ''}</td>
                  <td style={td}>{e.stage}</td>
                  <td style={td}>{e.expected_post_date || '—'}</td>
                  <td style={{ ...td, color: '#ff7070', fontWeight: 600 }}>{e.days_overdue != null ? `${e.days_overdue}d` : '—'}</td>
                  <td style={td}><RatingDot rating={e.influencer?.quality_rating} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function RatingDot({ rating }) {
  const map = { green: '#4ade80', yellow: '#fbbf24', red: '#ff7070', unrated: '#666' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: map[rating] || '#666' }} />
      {rating || 'unrated'}
    </span>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
const btnDanger = { padding: '7px 14px', background: 'transparent', color: '#ff7070', border: '1px solid #ff7070', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer' };
