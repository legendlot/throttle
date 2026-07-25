'use client';
import { useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts';
import { PanelHead } from './prism.js';
import { SegmentedToggle } from './kit.js';

// ── theme (PRISM) ────────────────────────────────────────────────────────────
// Per handoff §7 the combo chart reads: revenue area #34D27B (.42 → .04), spend area
// #4C63F0 (.5 → .05), and the right-axis series as a 2px #F2CD1A line. That rule
// generalises across all three tabs — AREAS carry a data hue, the RIGHT-AXIS LINE is
// always the accent. Which series are plotted, and how their values are derived, is
// unchanged: only colour, gradient and chrome move.
const GREEN  = '#34D27B';   // revenue
const BLUE   = '#4C63F0';   // spend / sessions
const ACCENT = '#F2CD1A';   // the one accent — always the right-axis line
const VIOLET = '#A78BFA';   // derived counts (conversions)
// Chart grid + axis ink stay on the prototype's chart literals (comboChart / lineChart /
// stacked all use these) so PerfTrendChart, DailyTrend and the untouched StackedTrendChart
// read as one family. Do NOT repoint these to the quieter panel-border ramp.
const GRID   = '#33343D';
const AXIS   = '#6E6F79';

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

// Each tab = a set of series mapped onto a left/right axis. `from`/`to` are the area
// gradient stops (§7 gives revenue .42→.04 and spend .5→.05).
const TABS = {
  spend: {
    label: 'Spend vs Revenue', title: 'Spend vs revenue vs ROAS',
    leftFmt: rupee, rightFmt: mult, rightLabel: 'ROAS',
    series: [
      { key: 'revenue', name: 'Revenue', color: GREEN,  kind: 'area', axis: 'left',  fmt: rupee, from: 0.42, to: 0.04 },
      { key: 'spend',   name: 'Spend',   color: BLUE,   kind: 'area', axis: 'left',  fmt: rupee, from: 0.50, to: 0.05 },
      { key: 'roas',    name: 'ROAS',    color: ACCENT, kind: 'line', axis: 'right', fmt: mult },
    ],
  },
  traffic: {
    label: 'Traffic', title: 'Sessions vs purchases',
    leftFmt: count, rightFmt: count, rightLabel: 'Purchases',
    series: [
      { key: 'sessions',  name: 'Sessions',  color: BLUE,   kind: 'area', axis: 'left',  fmt: count, from: 0.50, to: 0.05 },
      { key: 'purchases', name: 'Purchases', color: ACCENT, kind: 'line', axis: 'right', fmt: count },
    ],
  },
  conv: {
    label: 'Conversion Performance', title: 'Conversions vs cost-per-acquisition',
    leftFmt: count, rightFmt: rupee, rightLabel: 'CAC',
    series: [
      { key: 'conversions', name: 'Conversions', color: VIOLET, kind: 'area', axis: 'left',  fmt: count, from: 0.42, to: 0.04 },
      { key: 'cac',         name: 'CAC',         color: ACCENT, kind: 'line', axis: 'right', fmt: rupee },
    ],
  },
};

// Legend — mono, one mark per series; an area gets a swatch, the right-axis line a rule.
function Legend({ cfg }) {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'flex-end', marginBottom: 4 }}>
      {cfg.series.map(s => (
        <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
          {s.kind === 'area'
            ? <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
            : <span style={{ width: 14, height: 2, background: s.color }} />}
          {s.name}{s.axis === 'right' ? ' (right)' : ''}
        </span>
      ))}
    </div>
  );
}

function ChartTooltip({ active, payload, label, cfg }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: 'var(--surface-solid)', border: '1px solid #2a2d35', borderRadius: 12,
      padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 12, minWidth: 150,
      boxShadow: '0 18px 40px -20px rgba(0,0,0,.9)',
    }}>
      <div style={{ color: 'var(--t3)', marginBottom: 6, fontSize: 11 }}>Date: {label}</div>
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
    <div className="so-card">
      <PanelHead title={cfg.title} qual="· daily, blended"
        right={<SegmentedToggle options={Object.entries(TABS).map(([k, t]) => [k, t.label])}
          value={tab} onChange={setTab} size="sm" />} />

      {/* Empty state is --t3, not the --t5 em-dash token: it's a sentence the user has to read. */}
      {(!data || data.length === 0) ? (
        <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>
          No data in this range yet.
        </div>
      ) : (
        <>
          <Legend cfg={cfg} />
          {/* plain (non-blurred) wrapper: never put backdrop-filter on a chart's direct parent */}
          <div>
            <ResponsiveContainer width="100%" height={330}>
              <ComposedChart data={data} margin={{ top: 6, right: hasRight ? 8 : 12, left: 0, bottom: 0 }}>
                <defs>
                  {cfg.series.filter((s) => s.kind === 'area').map((s) => (
                    <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"  stopColor={s.color} stopOpacity={s.from ?? 0.42} />
                      <stop offset="100%" stopColor={s.color} stopOpacity={s.to ?? 0.04} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
                <XAxis dataKey="date" tickFormatter={mmdd} tick={{ fill: AXIS, fontSize: 11, fontFamily: 'var(--mono)' }}
                  axisLine={{ stroke: GRID }} tickLine={false} minTickGap={28} />
                <YAxis yAxisId="left" tickFormatter={cfg.leftFmt} tick={{ fill: AXIS, fontSize: 11, fontFamily: 'var(--mono)' }}
                  axisLine={false} tickLine={false} width={56} />
                {hasRight && (
                  <YAxis yAxisId="right" orientation="right" tickFormatter={cfg.rightFmt}
                    tick={{ fill: AXIS, fontSize: 10, fontFamily: 'var(--mono)' }} axisLine={false} tickLine={false} width={48} />
                )}
                <Tooltip content={<ChartTooltip cfg={cfg} />} cursor={{ stroke: '#FFFFFF', strokeOpacity: 0.35, strokeWidth: 1 }} />
                {cfg.series.map((s) => (
                  s.kind === 'area' ? (
                    <Area key={s.key} yAxisId={s.axis} type="monotone" dataKey={s.key} name={s.name}
                      stroke={s.color} strokeWidth={1.6} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 4 }} />
                  ) : (
                    <Line key={s.key} yAxisId={s.axis} type="monotone" dataKey={s.key} name={s.name}
                      stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  )
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
