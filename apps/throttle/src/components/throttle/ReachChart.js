'use client';
/* ReachChart — daily Instagram reach, Recharts area (Odo StackedTrendChart sibling,
   Night Circuit palette). series: [{ date: 'YYYY-MM-DD', reach: number }]. */
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

const GRID = '#2E2A33', T3 = '#8A8690', T2 = '#B6B2BC', SURFACE = '#211D24', YELLOW = '#F2CD1A';

const count = (v) => {
  const n = Number(v) || 0, a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
};
const mmdd = (d) => (d ? String(d).slice(5) : '');

function TT({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: SURFACE, border: `1px solid ${GRID}`, borderRadius: 8, padding: '8px 11px',
      fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
      <div style={{ color: T3, marginBottom: 4, fontSize: 10.5 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: YELLOW }} />
        <span style={{ color: T2 }}>Reach</span>
        <span style={{ color: '#F2F3F0', fontWeight: 600, marginLeft: 6 }}>{count(payload[0].value)}</span>
      </div>
    </div>
  );
}

export default function ReachChart({ series }) {
  const data = (series || []).map(d => ({ date: d.date, reach: Number(d.reach || 0) }));
  if (data.length < 2) {
    return <div style={{ fontSize: 12, color: T3, padding: '24px 0' }}>Not enough history yet — the daily sync builds this out.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="reach-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={YELLOW} stopOpacity={0.55} />
            <stop offset="100%" stopColor={YELLOW} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={mmdd} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--font-mono, monospace)' }} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={28} />
        <YAxis tickFormatter={count} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--font-mono, monospace)' }} axisLine={false} tickLine={false} width={48} />
        <Tooltip content={<TT />} cursor={{ stroke: '#FFFFFF', strokeOpacity: 0.3, strokeWidth: 1 }} />
        <Area type="monotone" dataKey="reach" stroke={YELLOW} strokeWidth={2} fill="url(#reach-grad)" dot={false} activeDot={{ r: 3 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
