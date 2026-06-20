'use client';
/* Production-history trend — stacked-area Fresh (RTE/RTR) vs Returns (RTD_RETURN)
   packed-out units over time. Modern Recharts look, mirrors Odo's StackedTrendChart
   adapted to the Redline palette. Bucketing (hourly / daily / weekly) is decided by
   the page from the active date filter; this component just renders the points it's
   given. data = [{ label, fresh, returns }] in ascending (left→right) order. */
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';

const FRESH = '#f2cd1a';   // brand yellow (Produced/fresh)
const RETURNS = '#60a5fa'; // blue — clearly distinct from brand yellow
const GRID = '#34343b', T2 = '#b6b6be', T3 = '#8c8c96', SURFACE2 = '#2e2e34', INK = '#f5f5f6';

const SERIES = [
  { key: 'fresh',   label: 'Fresh',   color: FRESH },
  { key: 'returns', label: 'Returns', color: RETURNS },
];

const count = (v) => {
  const n = Number(v) || 0, a = Math.abs(n);
  if (a >= 1e5) return (n / 1e5).toFixed(1) + 'L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};

function TT({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return (
    <div style={{ background: SURFACE2, border: `1px solid ${GRID}`, borderRadius: 8, padding: '9px 11px', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 11.5, minWidth: 150, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
      <div style={{ color: T2, marginBottom: 5, fontSize: 10.5 }}>{label}</div>
      {payload.slice().reverse().map(p => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
          <span style={{ color: T2, flex: 1 }}>{SERIES.find(s => s.key === p.dataKey)?.label || p.dataKey}</span>
          <span style={{ color: INK }}>{count(p.value)}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderTop: `1px solid ${GRID}`, marginTop: 5, paddingTop: 4, fontWeight: 600 }}>
        <span style={{ color: T2 }}>Total</span><span style={{ color: INK }}>{count(total)}</span>
      </div>
    </div>
  );
}

export default function ProductionTrendChart({ data, height = 240 }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T3, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Not enough data points to chart this range yet.
      </div>
    );
  }
  const hasReturns = data.some(d => (Number(d.returns) || 0) > 0);
  const series = hasReturns ? SERIES : SERIES.filter(s => s.key === 'fresh');

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
        <defs>
          {series.map(s => (
            <linearGradient key={s.key} id={`pt-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.55} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.05} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--font-mono)' }} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={20} />
        <YAxis tickFormatter={count} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
        <Tooltip content={<TT />} cursor={{ stroke: '#FFFFFF', strokeOpacity: 0.3, strokeWidth: 1 }} />
        {series.map(s => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stackId="s"
            stroke={s.color} strokeWidth={1.5} fill={`url(#pt-${s.key})`} dot={false} activeDot={{ r: 3 }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
