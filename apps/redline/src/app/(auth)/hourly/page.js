'use client';
/* ════════════════════════════════════════════════════════════
   HOURLY — Pit Wall v2 (redesign-reference/app/hourly.jsx).
   Stage funnel Inward → QC Pass → Packaging (with yields) acting
   as metric selector over an hourly line × hour matrix, plus a
   by-line view stacking all three stages per line. Data:
   getHourlyProduction (hour, line, inw_count, qc_pass_count,
   pkg_count) — no hourly targets and no count-logging mutation
   exist on this payload, so the prototype's Pace column and Log
   Count modal are intentionally omitted. 30s auto-refresh.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, FilterChip, fmt, lineColor, lineRgb, istNow, inputStyle,
} from '../../../components/kit/index.js';

const SHIFT_START = 9;
const SHIFT_END   = 18;

const STAGES = ['inw_count', 'qc_pass_count', 'pkg_count'];
const STAGE_META = {
  inw_count:     { label: 'Inward',    icon: 'arrowDown', accent: 'var(--blue-bright)' },
  qc_pass_count: { label: 'QC Pass',   icon: 'shield',    accent: 'var(--yellow)' },
  pkg_count:     { label: 'Packaging', icon: 'box',       accent: 'var(--green)' },
};

const hLabel = (h) => `${h > 12 ? h - 12 : h}${h >= 12 ? 'p' : 'a'}`;
const hFull  = (h) => `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`;

/* ── empty state — lucide icon in a muted circle ────────────── */
function Empty({ icon = 'activity', message }) {
  return (
    <div style={{ padding: '44px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--surface-2)',
        border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center', color: 'var(--t3)' }}>
        <Icon name={icon} size={20} />
      </div>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>{message}</span>
    </div>
  );
}

/* ── stage funnel + metric selector ─────────────────────────── */
function StageFunnel({ totals, metric, setMetric }) {
  const yieldPct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);
  const y1 = yieldPct(totals.qc_pass_count, totals.inw_count);
  const y2 = yieldPct(totals.pkg_count, totals.qc_pass_count);

  const Cell = ({ m }) => {
    const meta = STAGE_META[m];
    const on = metric === m;
    return (
      <button onClick={() => setMetric(m)} style={{ flex: 1, textAlign: 'left', cursor: 'pointer',
        background: on ? 'var(--surface-2)' : 'var(--surface)', border: `1px solid ${on ? meta.accent : 'var(--border)'}`,
        boxShadow: on ? `0 0 0 1px ${meta.accent}` : 'var(--shadow-card)', borderRadius: 'var(--r-md)', padding: '15px 18px',
        position: 'relative', overflow: 'hidden', transition: 'all var(--fast)' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: meta.accent, opacity: on ? 1 : 0.4 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: meta.accent, display: 'flex' }}><Icon name={meta.icon} size={15} /></span>
          <span className="eyebrow" style={{ color: on ? 'var(--t1)' : 'var(--t3)' }}>{meta.label}</span>
        </div>
        <div className="num" style={{ fontSize: 28, fontWeight: 700, color: 'var(--t1)', marginTop: 8, lineHeight: 1 }}>{fmt(totals[m])}</div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)', marginTop: 6 }}>units · all lines</div>
      </button>
    );
  };
  const Yield = ({ pct }) => (
    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '0 4px' }}>
      <Icon name="chevR" size={18} style={{ color: 'var(--t4)' }} />
      <span className="num" style={{ fontSize: 12, fontWeight: 700,
        color: pct == null ? 'var(--t4)' : pct >= 92 ? 'var(--ok-fg)' : 'var(--warn-fg)' }}>{pct == null ? '—' : `${pct}%`}</span>
      <span className="eyebrow" style={{ fontSize: 8.5 }}>yield</span>
    </div>
  );
  return (
    <div className="rl-funnel" style={{ display: 'flex', alignItems: 'stretch', gap: 6, marginBottom: 18 }}>
      <Cell m="inw_count" />
      <Yield pct={y1} />
      <Cell m="qc_pass_count" />
      <Yield pct={y2} />
      <Cell m="pkg_count" />
    </div>
  );
}

/* ── shared hour-header cell ────────────────────────────────── */
function HourHead({ h, nowHour }) {
  const now = h === nowHour;
  const isOT = h > SHIFT_END;
  return (
    <div style={{ textAlign: 'center', position: 'relative', paddingBottom: 4 }}>
      <span className="num" style={{ fontSize: 11, fontWeight: now ? 700 : 500,
        color: now ? 'var(--yellow)' : isOT ? 'var(--t4)' : 'var(--t3)' }}>{hLabel(h)}{isOT ? '+' : ''}</span>
      {now && <div className="eyebrow" style={{ marginTop: 2, fontSize: 8, color: 'var(--yellow)' }}>Now</div>}
    </div>
  );
}

/* ── one matrix cell (no hourly targets in payload — depth is
      the count's share of that row's busiest hour) ───────────── */
function MatrixCell({ lineId, h, count, rowMax, nowHour, future, height = 44 }) {
  const current = h === nowHour;
  const rgb = lineRgb(lineId);
  const pct = future ? 0 : Math.min((count / Math.max(rowMax, 1)) * 100, 100);
  const fill = (!future && count > 0) ? `rgba(${rgb},0.55)` : 'transparent';
  const fontSize = count > 999 ? 9 : count > 99 ? 10 : 11.5;
  return (
    <div title={future ? `${lineId} · ${hFull(h)} — upcoming` : `${lineId} · ${hFull(h)} — ${fmt(count)}`}
      style={{ height, borderRadius: 4, position: 'relative', overflow: 'hidden', background: 'var(--bg-2)',
        border: `1px solid ${current ? lineColor(lineId) : future ? 'var(--border)' : `rgba(${rgb},0.3)`}`,
        boxShadow: current ? `0 0 0 1px ${lineColor(lineId)}` : 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${pct}%`, background: fill, transition: 'height 500ms var(--ease)' }} />
      <div className="num" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize, fontWeight: 700, zIndex: 1, color: pct > 48 ? '#fff' : future ? 'var(--t4)' : count > 0 ? lineColor(lineId) : 'var(--t4)' }}>
        {future ? '' : count > 0 ? fmt(count) : '·'}
      </div>
      {current && <span className="rl-pulse" style={{ position: 'absolute', top: 3, right: 3, width: 5, height: 5, borderRadius: '50%', background: lineColor(lineId) }} />}
    </div>
  );
}

/* ── BY STAGE — line × hour matrix for the selected metric ──── */
function HourlyMatrix({ model, hours, metric, lineFilter, nowHour }) {
  const lines = lineFilter === 'all' ? model.lines : model.lines.filter(l => l === lineFilter);
  const cols = `120px repeat(${hours.length}, 1fr) 76px`;
  const isFuture = (h) => nowHour != null && h > nowHour;

  const colTotals = hours.map(h => lines.reduce((s, l) => s + ((model.byLine[l][h] || {})[metric] || 0), 0));

  return (
    <div style={{ overflowX: 'auto' }}>
      {/* header */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 5, alignItems: 'end', marginBottom: 8, minWidth: 720 }}>
        <div className="eyebrow" style={{ paddingLeft: 2 }}>Line</div>
        {hours.map(h => <HourHead key={h} h={h} nowHour={nowHour} />)}
        <div className="eyebrow" style={{ textAlign: 'right' }}>Total</div>
      </div>

      {/* rows */}
      {lines.map((l, ri) => {
        const data = model.byLine[l];
        const rowMax = Math.max(1, ...hours.map(h => (data[h] || {})[metric] || 0));
        const total = hours.reduce((s, h) => s + ((data[h] || {})[metric] || 0), 0);
        return (
          <div key={l} style={{ display: 'grid', gridTemplateColumns: cols, gap: 5, alignItems: 'center', minWidth: 720,
            padding: '6px 0', borderTop: ri ? '1px solid var(--border)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: lineColor(l), flexShrink: 0 }} />
              <span className="font-display" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--t1)' }}>{l}</span>
            </div>
            {hours.map(h => (
              <MatrixCell key={h} lineId={l} h={h} count={(data[h] || {})[metric] || 0}
                rowMax={rowMax} nowHour={nowHour} future={isFuture(h)} />
            ))}
            <div className="num" style={{ textAlign: 'right', fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{fmt(total)}</div>
          </div>
        );
      })}

      {/* totals footer */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 5, alignItems: 'center', minWidth: 720,
        padding: '10px 0 2px', borderTop: '2px solid var(--border-2)', marginTop: 4 }}>
        <div className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>All lines</div>
        {colTotals.map((t, i) => (
          <div key={i} className="num" style={{ textAlign: 'center', fontSize: 11, fontWeight: 600,
            color: isFuture(hours[i]) ? 'var(--t4)' : 'var(--t2)' }}>{isFuture(hours[i]) ? '' : fmt(t)}</div>
        ))}
        <div className="num" style={{ textAlign: 'right', fontSize: 14, fontWeight: 700, color: 'var(--yellow)' }}>
          {fmt(colTotals.reduce((s, v) => s + v, 0))}
        </div>
      </div>
    </div>
  );
}

/* ── BY LINE — all three stages stacked per line ────────────── */
function HourlyByLine({ model, hours, lineFilter, nowHour }) {
  const lines = lineFilter === 'all' ? model.lines : model.lines.filter(l => l === lineFilter);
  const cols = `104px repeat(${hours.length}, 1fr) 70px`;
  const isFuture = (h) => nowHour != null && h > nowHour;

  return (
    <div style={{ overflowX: 'auto' }}>
      {/* shared hour axis */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 4, alignItems: 'end', marginBottom: 6, minWidth: 760 }}>
        <div className="eyebrow" style={{ paddingLeft: 2 }}>Stage</div>
        {hours.map(h => <HourHead key={h} h={h} nowHour={nowHour} />)}
        <div className="eyebrow" style={{ textAlign: 'right' }}>Total</div>
      </div>

      {lines.map((l, bi) => {
        const data = model.byLine[l];
        return (
          <div key={l} style={{ position: 'relative', marginTop: bi ? 14 : 0, paddingLeft: 10, minWidth: 770 }}>
            <div style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, background: lineColor(l) }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 2px 7px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: lineColor(l), flexShrink: 0 }} />
              <span className="font-display" style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--t1)' }}>{l}</span>
            </div>
            {STAGES.map(stage => {
              const rowMax = Math.max(1, ...hours.map(h => (data[h] || {})[stage] || 0));
              const total = hours.reduce((s, h) => s + ((data[h] || {})[stage] || 0), 0);
              const meta = STAGE_META[stage];
              return (
                <div key={stage} style={{ display: 'grid', gridTemplateColumns: cols, gap: 4, alignItems: 'center', padding: '2px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 2 }}>
                    <span style={{ color: meta.accent, display: 'flex' }}><Icon name={meta.icon} size={12} /></span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--t2)', whiteSpace: 'nowrap' }}>{meta.label}</span>
                  </div>
                  {hours.map(h => (
                    <MatrixCell key={h} lineId={l} h={h} count={(data[h] || {})[stage] || 0}
                      rowMax={rowMax} nowHour={nowHour} future={isFuture(h)} height={27} />
                  ))}
                  <div className="num" style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: 'var(--t1)' }}>{fmt(total)}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ── page ───────────────────────────────────────────────────── */
export default function HourlyPage() {
  const { session }                         = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [date,       setDate]       = useState(() => todayStr());
  const [hourlyData, setHourlyData] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [metric,     setMetric]     = useState('qc_pass_count');
  const [view,       setView]       = useState('stage');   // 'stage' | 'line'
  const [lineFilter, setLineFilter] = useState('all');

  const loadData = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const data = await garageFetch('getHourlyProduction', { date }, session);
      setHourlyData(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load hourly data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, date, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadData, 30000, !session);

  /* line × hour model from the flat payload */
  const model = useMemo(() => {
    const byLine = {};
    let maxHour = SHIFT_END;
    (hourlyData || []).forEach(r => {
      const l = r.line || '—';
      const h = Number(r.hour) || 0;
      if (!byLine[l]) byLine[l] = {};
      if (!byLine[l][h]) byLine[l][h] = { inw_count: 0, qc_pass_count: 0, pkg_count: 0 };
      STAGES.forEach(k => { byLine[l][h][k] += Number(r[k]) || 0; });
      if (h > maxHour) maxHour = h;
    });
    return { byLine, lines: Object.keys(byLine).sort(), maxHour };
  }, [hourlyData]);

  const hours = useMemo(
    () => Array.from({ length: model.maxHour - SHIFT_START + 1 }, (_, i) => i + SHIFT_START),
    [model.maxHour]
  );

  const totals = useMemo(() => {
    const t = { inw_count: 0, qc_pass_count: 0, pkg_count: 0 };
    (hourlyData || []).forEach(r => { STAGES.forEach(k => { t[k] += Number(r[k]) || 0; }); });
    return t;
  }, [hourlyData]);

  /* NOW marker only applies when viewing today; past dates have no future hours */
  const today = todayStr();
  const nowHour = date === today ? istNow().hour : date > today ? SHIFT_START - 1 : null;

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner /></div>;
  }

  const Seg = () => (
    <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)' }}>
      {[['stage', 'By stage', 'activity'], ['line', 'By line', 'layers']].map(([k, l, ic]) => (
        <button key={k} onClick={() => setView(k)} style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', cursor: 'pointer',
          borderRadius: 'var(--r-xs)', padding: '6px 12px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
          letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
          background: view === k ? 'var(--surface-3)' : 'transparent', color: view === k ? 'var(--t1)' : 'var(--t3)' }}>
          <Icon name={ic} size={13} />{l}</button>
      ))}
    </div>
  );

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ ...inputStyle, width: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12.5, padding: '7px 11px',
            colorScheme: 'dark' }} />
        <FilterChip active={date === today} onClick={() => setDate(today)}>Today</FilterChip>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t3)', marginLeft: 4 }}>
          <span className="rl-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} /> Auto-refresh 30s
        </span>
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)',
          padding: '12px 14px', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 18 }}>
          {error}
        </div>
      )}

      <StageFunnel totals={totals} metric={view === 'stage' ? metric : null}
        setMetric={(m) => { setMetric(m); setView('stage'); }} />

      <Panel
        title={view === 'stage' ? `Hourly · ${STAGE_META[metric].label}` : 'Hourly · all stages, by line'}
        icon={view === 'stage' ? STAGE_META[metric].icon : 'layers'}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Seg />
            <div style={{ display: 'flex', gap: 5 }}>
              <FilterChip active={lineFilter === 'all'} onClick={() => setLineFilter('all')}>All</FilterChip>
              {model.lines.map(l => (
                <FilterChip key={l} active={lineFilter === l} onClick={() => setLineFilter(l)} dot={lineColor(l)}>{l}</FilterChip>
              ))}
            </div>
          </div>
        }>
        {!model.lines.length ? (
          <Empty icon="activity" message="No production data for the selected date" />
        ) : view === 'stage' ? (
          <HourlyMatrix model={model} hours={hours} metric={metric} lineFilter={lineFilter} nowHour={nowHour} />
        ) : (
          <HourlyByLine model={model} hours={hours} lineFilter={lineFilter} nowHour={nowHour} />
        )}
        {model.lines.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex',
            alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t3)' }}>
            <Icon name="clock" size={13} />
            {view === 'line'
              ? 'Read each line top-to-bottom to follow the Inward → QC → Packaging flow across hours.'
              : 'Cell depth shows each hour against that line’s best hour of the day.'}
          </div>
        )}
      </Panel>
    </div>
  );
}
