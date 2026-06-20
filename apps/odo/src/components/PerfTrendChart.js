'use client';
import { useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';

// ── theme ────────────────────────────────────────────────────────────────────
const YELLOW = '#F2CD1A';   // --accent  (spend / sessions)
const ORANGE = '#FF7A1A';   // revenue / purchases
const GREEN  = '#34D27B';   // --green   (ROAS / secondary)
const GRID   = '#33343D';   // --border
const T2 = '#A4A6AE', T3 = '#6E6F79', SURFACE2 = '#26272E';

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
const mult = (v) => (Number(v) || 0).toFixed(2) + '×';
const mmdd = (d) => (d ? String(d).slice(5) : '');

// Each tab = a set of series mapped onto a left/right axis.
const TABS = {
  spend: {
    label: 'Spend vs Revenue', title: 'Spend vs Revenue vs ROAS',
    leftFmt: rupee, rightFmt: mult, rightLabel: 'ROAS',
    series: [
      { key: 'revenue', name: 'Revenue', color: ORANGE, kind: 'area', axis: 'left',  fmt: rupee },
      { key: 'spend',   name: 'Spend',   color: YELLOW, kind: 'area', axis: 'left',  fmt: rupee },
      { key: 'roas',    name: 'ROAS',    color: GREEN,  kind: 'line', axis: 'right', fmt: mult },
    ],
  },
  traffic: {
    label: 'Traffic', title: 'Sessions vs Purchases',
    leftFmt: count, rightFmt: count, rightLabel: 'Purchases',
    series: [
      { key: 'sessions',  name: 'Sessions',  color: YELLOW, kind: 'area', axis: 'left',  fmt: count },
      { key: 'purchases', name: 'Purchases', color: ORANGE, kind: 'line', axis: 'right', fmt: count },
    ],
  },
  conv: {
    label: 'Conversion Performance', title: 'Conversions vs Cost-per-Acquisition',
    leftFmt: count, rightFmt: rupee, rightLabel: 'CAC',
    series: [
      { key: 'conversions', name: 'Conversions', color: YELLOW, kind: 'area', axis: 'left',  fmt: count },
      { key: 'cac',         name: 'CAC',         color: ORANGE, kind: 'line', axis: 'right', fmt: rupee },
    ],
  },
};

function ChartTooltip({ active, payload, label, cfg }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: SURFACE2, border: `1px solid ${GRID}`, borderRadius: 8,
      padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 12, minWidth: 150,
      boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
    }}>
      <div style={{ color: T2, marginBottom: 6, fontSize: 11 }}>Date: {label}</div>
      {payload.map((p) => {
        const s = cfg.series.find((x) => x.key === p.dataKey);
        return (
          <div key={p.dataKey} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 16, lineHeight: 1.7 }}>
            <span>{s?.name || p.name}</span>
            <strong>{(s?.fmt || count)(p.value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

export default function PerfTrendChart({ data }) {
  const [tab, setTab] = useState('spend');
  const cfg = TABS[tab];
  const hasRight = cfg.series.some((s) => s.axis === 'right');

  return (
    <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${GRID}` }}>
        {Object.entries(TABS).map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{
              flex: 1, padding: '13px 16px', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 13, fontWeight: tab === k ? 700 : 500,
              background: tab === k ? YELLOW : 'transparent',
              color: tab === k ? '#282828' : T2,
              borderRadius: tab === k ? '8px 8px 0 0' : 0, transition: 'background .12s',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: '18px 16px 8px' }}>
        <div className="so-kpi-lbl" style={{ marginBottom: 14 }}>{cfg.title}</div>
        {(!data || data.length === 0) ? (
          <div style={{ color: T3, fontFamily: 'var(--mono)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>
            No data in this range yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={330}>
            <ComposedChart data={data} margin={{ top: 6, right: hasRight ? 8 : 12, left: 0, bottom: 0 }}>
              <defs>
                {cfg.series.filter((s) => s.kind === 'area').map((s) => (
                  <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"  stopColor={s.color} stopOpacity={0.34} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={mmdd} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--mono)' }}
                axisLine={{ stroke: GRID }} tickLine={false} minTickGap={28} />
              <YAxis yAxisId="left" tickFormatter={cfg.leftFmt} tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--mono)' }}
                axisLine={false} tickLine={false} width={56} />
              {hasRight && (
                <YAxis yAxisId="right" orientation="right" tickFormatter={cfg.rightFmt}
                  tick={{ fill: T3, fontSize: 11, fontFamily: 'var(--mono)' }} axisLine={false} tickLine={false} width={48} />
              )}
              <Tooltip content={<ChartTooltip cfg={cfg} />} cursor={{ stroke: '#FFFFFF', strokeOpacity: 0.35, strokeWidth: 1 }} />
              <Legend wrapperStyle={{ fontFamily: 'var(--mono)', fontSize: 12, paddingTop: 6 }} iconType="plainline" />
              {cfg.series.map((s) => (
                s.kind === 'area' ? (
                  <Area key={s.key} yAxisId={s.axis} type="monotone" dataKey={s.key} name={s.name}
                    stroke={s.color} strokeWidth={2} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 4 }} />
                ) : (
                  <Line key={s.key} yAxisId={s.axis} type="monotone" dataKey={s.key} name={s.name}
                    stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                )
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
