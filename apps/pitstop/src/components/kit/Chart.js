'use client';
/* ════════════════════════════════════════════════════════════
   TrendChart — the modern Recharts area/line chart (ported from
   Odo's PerfTrendChart styling, re-themed to Volt tokens).
   Reusable for hourly call volume, hourly ticket creation, and
   the ticket-history time series.
   ════════════════════════════════════════════════════════════ */
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';

// Volt hex (recharts SVG fills want concrete colors, like Odo's chart).
const GRID = '#34343b', T2 = '#b6b6be', T3 = '#8c8c96', SURFACE2 = '#2e2e34';
export const CHART_COLORS = {
  accent: '#F2CD1A', info: '#8fa2ff', ok: '#4ade80', warn: '#fbbf24', bad: '#ff7a7a',
};

export const countFmt = (v) => {
  const n = Number(v) || 0, a = Math.abs(n);
  if (a >= 1e5) return (n / 1e5).toFixed(1) + 'L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};
export const hourFmt = (h) => {
  const n = Number(h);
  if (Number.isNaN(n)) return h;
  if (n === 0) return '12a';
  if (n < 12) return n + 'a';
  if (n === 12) return '12p';
  return (n - 12) + 'p';
};

// `yFmt` (S349b): the tooltip must format a value the way the axis beside it does — a minutes
// series read '2.4h' on the axis and '146' in the tooltip before this was threaded through.
function ChartTooltip({ active, payload, label, series, xLabel, xFmt, yFmt = countFmt }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: SURFACE2, border: `1px solid ${GRID}`, borderRadius: 8, padding: '10px 12px',
      fontFamily: 'var(--f-mono)', fontSize: 12, minWidth: 140, boxShadow: '0 8px 24px rgba(0,0,0,.5)' }}>
      <div style={{ color: T2, marginBottom: 6, fontSize: 11 }}>{xLabel}: {xFmt ? xFmt(label) : label}</div>
      {payload.map((p) => {
        const s = (series || []).find((x) => x.key === p.dataKey);
        return (
          <div key={p.dataKey} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 16, lineHeight: 1.7 }}>
            <span>{s?.name || p.name}</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{yFmt(p.value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

/**
 * TrendChart
 *  data    — array of row objects
 *  xKey    — key for the x axis
 *  series  — [{ key, name, color (CHART_COLORS key or hex), kind:'area'|'line', stackId? }]
 *  xFmt    — x tick/tooltip formatter · yFmt — y tick formatter
 *  height  — px (default 300) · xLabel — tooltip x label
 */
export function TrendChart({ data, xKey = 'x', series = [], xFmt, yFmt = countFmt, height = 300, xLabel = 'Hour', showLegend = false }) {
  const norm = series.map(s => ({ ...s, color: CHART_COLORS[s.color] || s.color || CHART_COLORS.accent, kind: s.kind || 'area' }));
  if (!data || data.length === 0) {
    return <div style={{ color: T3, fontFamily: 'var(--f-mono)', fontSize: 12, padding: '48px 0', textAlign: 'center' }}>No data in this range yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
        <defs>
          {norm.filter(s => s.kind === 'area').map(s => (
            <linearGradient key={s.key} id={`pg-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.34} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} tickFormatter={xFmt} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--f-mono)' }}
          axisLine={{ stroke: GRID }} tickLine={false} minTickGap={16} />
        <YAxis tickFormatter={yFmt} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--f-mono)' }}
          axisLine={false} tickLine={false} width={40} allowDecimals={yFmt !== countFmt} />
        <Tooltip content={<ChartTooltip series={norm} xLabel={xLabel} xFmt={xFmt} yFmt={yFmt} />}
          cursor={{ stroke: '#FFFFFF', strokeOpacity: 0.3, strokeWidth: 1 }} />
        {showLegend && <Legend wrapperStyle={{ fontFamily: 'var(--f-mono)', fontSize: 12, paddingTop: 6 }} iconType="plainline" />}
        {norm.map(s => (
          s.kind === 'area' ? (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stackId={s.stackId}
              stroke={s.color} strokeWidth={2} fill={`url(#pg-${s.key})`} dot={false} activeDot={{ r: 4 }} />
          ) : (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.name}
              stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          )
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
