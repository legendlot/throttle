'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { Tile, StagePill, FilterSelect, TableCard, Row, NumCell } from '../../../components/ui/index.js';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import {
  UGC_STAGE_VALUES, UGC_STAGE_LABELS, roasTone, roasToneColor,
} from '../../../lib/ugcStages.js';

function inr(n) {
  const v = Number(n || 0);
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

const COLS = 'minmax(180px,1.4fr) 150px 110px 150px 100px 100px 90px 110px';

function RoasCell({ roas }) {
  if (roas == null) return <span style={{ color: 'var(--text-4)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>—</span>;
  const color = roasToneColor(roasTone(roas));
  const pct = Math.max(0, Math.min(100, (Number(roas) / 6) * 100));
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color, width: 52 }}>{Number(roas).toFixed(2)}×</span>
      <span style={{ flex: 1, height: 6, background: 'var(--border-3)', borderRadius: 3, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: color }} />
      </span>
    </span>
  );
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>
          Lists · Commission creators
        </div>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>UGC</h1>
      </header>

      {error && <div style={{ padding: 12, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-md)' }}>{error}</div>}

      {loading || !data ? <Spinner /> : (
        <>
          {/* Dashboard tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Tile size={26} label="Active creatives" value={Number(summary.active_creatives || 0).toLocaleString()} />
            <Tile size={26} label="Ad spend (mo)" value={inr(summary.month_ad_spend)} color="var(--accent-hi)" />
            <Tile size={26} label="Blended ROAS" value={summary.blended_roas != null ? `${Number(summary.blended_roas).toFixed(2)}×` : '—'} color={blendedTone ? roasToneColor(blendedTone) : undefined} />
            <Tile size={26} label="Revenue (mo)" value={inr(summary.month_revenue)} />
            <Tile size={26} label="Commissions owed" value={inr(summary.commissions_owed)} color="var(--accent-hi)" />
          </div>

          {/* Per-stage count chips.
              ⚠️ `strayStages` is the backstop for a UGC deal sitting in a stage this board has no
              column for. That used to be reachable — the shared Advance modal offered the VIDEO
              stage list to UGC deals — and the deal then vanished from every chip and from the
              stage filter while still sitting in the table below, i.e. uncountable rather than
              missing. The modal and the worker both refuse those transitions now (S317), so this
              should always be empty; it renders LOUDLY rather than silently if it ever is not,
              because silence is what made the original bug survive. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.keys(byStage)
              .filter(s => byStage[s] && !UGC_STAGE_VALUES.includes(s))
              .map(s => (
                <span key={s} title="Not a UGC stage — this deal cannot be filtered to. Report it."
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px',
                    fontSize: 12, fontWeight: 600, color: 'var(--state-error-fg)', background: 'var(--state-error-bg)',
                    border: '1px solid currentColor', borderRadius: 99,
                  }}>
                  ⚠ {s} <strong style={{ color: 'inherit', fontFamily: 'var(--font-mono)' }}>{byStage[s]}</strong>
                </span>
              ))}
            {UGC_STAGE_VALUES.filter(s => byStage[s]).map(s => (
              <StagePill key={s} stage={s} ugc dot label={`${UGC_STAGE_LABELS[s]} ${byStage[s]}`} />
            ))}
          </div>

          {/* Stage filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <FilterSelect value={stageFilter} onChange={e => setStageFilter(e.target.value)} aria-label="Stage">
              <option value="all">All stages</option>
              {UGC_STAGE_VALUES.map(s => <option key={s} value={s}>{UGC_STAGE_LABELS[s]}</option>)}
            </FilterSelect>
            <span style={{ fontSize: 13, color: 'var(--text-4)' }}>{filtered.length} deal{filtered.length === 1 ? '' : 's'}</span>
          </div>

          {/* Pipeline table */}
          <TableCard columns={COLS} minWidth={1110}
            head={['Creator', 'IG handle', 'Stage', 'ROAS', { label: 'Ad spend', align: 'right' }, { label: 'Revenue', align: 'right' }, { label: 'Days active', align: 'right' }, { label: 'Amount owed', align: 'right' }]}>
            {filtered.length === 0 && <div style={{ padding: 18, color: 'var(--text-4)', textAlign: 'center', fontSize: 14 }}>No UGC deals.</div>}
            {filtered.map((r, i) => (
              <Row key={r.id} columns={COLS} index={i} animate onClick={() => router.push(`/ugc/detail/?id=${r.id}`)}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>{r.creator_name || '—'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-4)' }}>{r.engagement_no}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.ig_handle
                    ? (r.channel_link
                      ? <a href={r.channel_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'var(--accent-hi)' }}>{r.ig_handle}</a>
                      : <span>{r.ig_handle}</span>)
                    : <span style={{ color: 'var(--text-4)' }}>—</span>}
                </div>
                <div><StagePill stage={r.stage} ugc /></div>
                <RoasCell roas={r.roas} />
                <NumCell>{inr(r.ad_spend)}</NumCell>
                <NumCell>{inr(r.revenue)}</NumCell>
                <NumCell color="var(--text-2)">{r.days_active != null ? r.days_active : '—'}</NumCell>
                <NumCell color={Number(r.amount_owed) > 0 ? 'var(--accent-hi)' : 'var(--text-4)'} style={{ fontWeight: 700 }}>{inr(r.amount_owed)}</NumCell>
              </Row>
            ))}
          </TableCard>
        </>
      )}
    </div>
  );
}
