'use client';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';

const GRID = '#33343D', T2 = '#A4A6AE', T3 = '#6E6F79', SURFACE2 = '#26272E';

const rupee = (v) => {
  const n = Number(v) || 0, a = Math.abs(n);
  if (a >= 1e7) return '₹' + (n / 1e7).toFixed(2) + 'Cr';
  if (a >= 1e5) return '₹' + (n / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return '₹' + Math.round(n / 1e3) + 'K';
  return '₹' + Math.round(n);
};
const count = (v) => {
  const n = Number(v) || 0, a = Math.abs(n);
  if (a >= 1e5) return (n / 1e5).toFixed(1) + 'L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};
const mmdd = (d) => (d ? String(d).slice(5) : '');

// days: sorted date strings · dayVals: { date: { groupKey: value } } · groups: [{key,label,color}]
export default function StackedTrendChart({ days, dayVals, metric, groups }) {
  const fmt = metric === 'units' ? count : rupee;
  if (!days || days.length < 2) {
    return <div style={{ padding: 32, textAlign: 'center', color: T3, fontFamily: 'var(--mono)', fontSize: 12 }}>Pick a range of 2+ days to see the trend.</div>;
  }
  const active = (groups || []).filter(g => days.some(d => (dayVals[d]?.[g.key] || 0) > 0));
  const data = days.map(d => {
    const o = { date: d };
    active.forEach(g => { o[g.key] = dayVals[d]?.[g.key] || 0; });
    return o;
  });

  const TT = ({ active: on, payload, label }) => {
    if (!on || !payload || !payload.length) return null;
    const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
    return (
      <div style={{ background: SURFACE2, border: `1px solid ${GRID}`, borderRadius: 8, padding: '9px 11px', fontFamily: 'var(--mono)', fontSize: 11.5, minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
        <div style={{ color: T2, marginBottom: 5, fontSize: 10.5 }}>{label}</div>
        {payload.slice().reverse().map(p => {
          const g = active.find(x => x.key === p.dataKey);
          if (!p.value) return null;
          return (
            <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
              <span style={{ color: T2, flex: 1 }}>{g?.label || p.dataKey}</span>
              <span style={{ color: '#F2F3F0' }}>{fmt(p.value)}</span>
            </div>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderTop: `1px solid ${GRID}`, marginTop: 5, paddingTop: 4, fontWeight: 600 }}>
          <span style={{ color: T2 }}>Total</span><span style={{ color: '#F2F3F0' }}>{fmt(total)}</span>
        </div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
        <defs>
          {active.map(g => (
            <linearGradient key={g.key} id={`st-${g.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={g.color} stopOpacity={0.6} />
              <stop offset="100%" stopColor={g.color} stopOpacity={0.06} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={mmdd} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--mono)' }} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={28} />
        <YAxis tickFormatter={fmt} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--mono)' }} axisLine={false} tickLine={false} width={56} />
        <Tooltip content={<TT />} cursor={{ stroke: '#FFFFFF', strokeOpacity: 0.35, strokeWidth: 1 }} />
        {active.map(g => (
          <Area key={g.key} type="monotone" dataKey={g.key} name={g.label} stackId="s"
            stroke={g.color} strokeWidth={1.5} fill={`url(#st-${g.key})`} dot={false} activeDot={{ r: 3 }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
