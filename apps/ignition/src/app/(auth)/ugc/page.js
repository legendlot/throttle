'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, KpiCard } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import {
  UGC_STAGE_VALUES, UGC_STAGE_LABELS, UGC_STAGE_PALETTE, roasTone, roasToneColor,
} from '../../../lib/ugcStages.js';

const ORANGE = '#FF6B00';
function inr(n) {
  const v = Number(n || 0);
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function UgcStageBadge({ stage }) {
  if (!stage) return null;
  const label = UGC_STAGE_LABELS[stage] || stage;
  const pal = UGC_STAGE_PALETTE[stage] || { fg: 'var(--text-2)', bg: 'var(--surface-2)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 8px', fontSize: 11,
      fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: pal.fg, background: pal.bg,
      border: '1px solid currentColor', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

function RoasCell({ roas }) {
  if (roas == null) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const tone = roasTone(roas);
  const color = roasToneColor(tone);
  return <span style={{ color, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{Number(roas).toFixed(2)}×</span>;
}

export default function UgcPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [stageFilter, setStageFilter] = useState('all');

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setLoading(true);
    ignitionopsGet('getUgcPipeline', {}, session)
      .then(d => { if (alive) { setData(d); setError(null); } })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session]);

  const summary = data?.summary || {};
  const byStage = summary.by_stage || {};
  const rows = data?.rows || [];

  const filtered = useMemo(
    () => (stageFilter === 'all' ? rows : rows.filter(r => r.stage === stageFilter)),
    [rows, stageFilter],
  );

  const blendedTone = roasTone(summary.blended_roas);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          UGC Pipeline
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
          Commission-based UGC creators with ad-spend + ROAS tracking.
        </div>
      </header>

      {error && <div style={{ padding: 12, marginBottom: 12, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-md)' }}>{error}</div>}

      {loading || !data ? <Spinner /> : (
        <>
          {/* Dashboard cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 12 }}>
            <KpiCard label="Active creatives" value={Number(summary.active_creatives || 0).toLocaleString()} />
            <KpiCard label="Ad spend (mo)" value={inr(summary.month_ad_spend)} accent={ORANGE} />
            <KpiCard label="Blended ROAS" value={summary.blended_roas != null ? `${Number(summary.blended_roas).toFixed(2)}×` : '—'} accent={blendedTone ? roasToneColor(blendedTone) : undefined} />
            <KpiCard label="Revenue (mo)" value={inr(summary.month_revenue)} />
            <KpiCard label="Commissions owed" value={inr(summary.commissions_owed)} accent={ORANGE} />
          </div>

          {/* Per-stage count chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            {UGC_STAGE_VALUES.filter(s => byStage[s]).map(s => {
              const pal = UGC_STAGE_PALETTE[s] || { fg: 'var(--text-2)', bg: 'var(--surface-2)' };
              return (
                <span key={s} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
                  fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.04em',
                  textTransform: 'uppercase', color: pal.fg, background: pal.bg,
                  border: '1px solid currentColor', borderRadius: 'var(--radius-sm)',
                }}>
                  {UGC_STAGE_LABELS[s]}
                  <strong style={{ color: 'inherit' }}>{byStage[s]}</strong>
                </span>
              );
            })}
          </div>

          {/* Stage filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>Stage</span>
            <select value={stageFilter} onChange={e => setStageFilter(e.target.value)}
              style={{ background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              <option value="all">All stages</option>
              {UGC_STAGE_VALUES.map(s => <option key={s} value={s}>{UGC_STAGE_LABELS[s]}</option>)}
            </select>
            <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{filtered.length} deal{filtered.length === 1 ? '' : 's'}</span>
          </div>

          {/* Pipeline table */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: 'var(--surface-2)' }}>
                <th style={th}>Creator</th>
                <th style={th}>IG handle</th>
                <th style={th}>Stage</th>
                <th style={{ ...th, textAlign: 'right' }}>ROAS</th>
                <th style={{ ...th, textAlign: 'right' }}>Ad spend</th>
                <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...th, textAlign: 'right' }}>Days active</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount owed</th>
              </tr></thead>
              <tbody>
                {filtered.length === 0 && <tr><td colSpan={8} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No UGC deals.</td></tr>}
                {filtered.map(r => (
                  <tr key={r.id} onClick={() => router.push(`/ugc/detail/?id=${r.id}`)}
                    style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                    <td style={td}>
                      <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>{r.creator_name || '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.engagement_no}</div>
                    </td>
                    <td style={td}>
                      {r.ig_handle
                        ? (r.channel_link
                          ? <a href={r.channel_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: ORANGE }}>{r.ig_handle}</a>
                          : <span>{r.ig_handle}</span>)
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td style={td}><UgcStageBadge stage={r.stage} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><RoasCell roas={r.roas} /></td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{inr(r.ad_spend)}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{inr(r.revenue)}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r.days_active != null ? r.days_active : '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: Number(r.amount_owed) > 0 ? ORANGE : 'var(--text-2)' }}>{inr(r.amount_owed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const th = { padding: '9px 12px', fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 700, fontFamily: 'var(--font-mono)', textAlign: 'left' };
const td = { padding: '9px 12px', color: 'var(--text-2)' };
