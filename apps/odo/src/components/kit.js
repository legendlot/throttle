'use client';
// Shared dashboard primitives — the single vocabulary for KPI tiles, deltas, sparklines,
// range selection and segmented toggles. Every page (cockpit, Performance, Marketing, Funnel,
// Channels) renders these, so the controls + tiles look and behave identically everywhere.
import { useState } from 'react';
import { rangePresets, istToday } from '../lib/api.js';

const PRESETS = rangePresets();

// ── sortable tables ───────────────────────────────────────────────────────
// useTableSort: click-to-sort any data table. valueOf(row,key) lets a table sort by a COMPUTED
// column (e.g. ROAS = conv_value/spend) instead of a raw field. Numeric values sort numerically,
// everything else alphabetically (numeric-aware). Pair with <SortHeader> for clickable headers.
export function useTableSort(rows, { initialKey = null, initialDir = 'desc', valueOf } = {}) {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState(initialDir);
  const toggle = (k) => {
    if (k === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('desc'); }
  };
  const get = valueOf || ((row, k) => row[k]);
  let sorted = rows || [];
  if (sortKey) {
    sorted = [...sorted].sort((a, b) => {
      const av = get(a, sortKey), bv = get(b, sortKey);
      const an = Number(av), bn = Number(bv);
      const numeric = av != null && av !== '' && bv != null && bv !== '' && !Number.isNaN(an) && !Number.isNaN(bn);
      const cmp = numeric ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }
  return { sorted, sortKey, sortDir, toggle };
}

// Clickable column header. k = sort key; numeric → right-align (so-num). Shows ▲/▼ on the active column.
export function SortHeader({ k, label, sort, numeric, style }) {
  const active = sort.sortKey === k;
  return (
    <th className={numeric ? 'so-num' : undefined} onClick={() => sort.toggle(k)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }} title="Click to sort">
      {label}<span style={{ marginLeft: 3, fontSize: 9, opacity: active ? 0.9 : 0.3 }}>{active ? (sort.sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}

// ── period-over-period delta ──────────────────────────────────────────────
// Pass now/prev (preferred) OR a precomputed pct. tone:'pos' colours up=green/down=red;
// 'neutral' stays grey (cost/volume metrics where direction isn't inherently good/bad).
export function Delta({ now, prev, pct: pctIn, tone = 'pos' }) {
  let pct = pctIn;
  if (pct == null) {
    if (prev == null || !isFinite(prev) || prev === 0) return null;
    pct = (now - prev) / Math.abs(prev) * 100;
  }
  if (!isFinite(pct)) return null;
  const up = pct >= 0;
  const color = tone === 'neutral' ? 'var(--t3)' : (up ? 'var(--green)' : 'var(--red)');
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {up ? '↗' : '↘'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

// ── dependency-free sparkline ─────────────────────────────────────────────
export function Spark({ data, color = 'var(--accent)', height = 30 }) {
  if (!data || data.length < 2) return <div style={{ height }} />;
  const W = 130, H = height, max = Math.max(...data), min = Math.min(...data, 0), span = (max - min) || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - ((v - min) / span) * (H - 2) - 1}`);
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polyline points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill={color} fillOpacity="0.10" stroke="none" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── KPI tile ───────────────────────────────────────────────────────────────
// One tile used everywhere. Optional spark (sparkline data) + sparkColor; optional badge slot;
// deltaNote shows what the delta compares against.
export function Kpi({ lbl, val, sub, now, prev, pct, tone, badge, spark, sparkColor = 'var(--accent)', deltaNote, accent }) {
  // Left accent: explicit `accent` wins; else tone-aware (green up / red down) when there's a
  // directional delta; else a neutral edge. Gives the Redline at-a-glance read without per-tile config.
  let acc = accent;
  if (!acc) {
    let p = pct;
    if (p == null && prev != null && isFinite(prev) && prev !== 0) p = (now - prev) / Math.abs(prev) * 100;
    acc = (tone !== 'neutral' && p != null && isFinite(p)) ? (p >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--border-strong)';
  }
  return (
    <div className="so-stat" style={{ '--stat-accent': acc }}>
      <div className="so-stat-top">
        <div className="so-stat-lbl">{lbl}</div>
        <Delta now={now} prev={prev} pct={pct} tone={tone} />
      </div>
      <span className="so-stat-val">{val}</span>
      {sub && <div className="so-stat-sub">{sub}</div>}
      {spark && <Spark data={spark} color={sparkColor} />}
      {deltaNote && <div className="so-stat-sub" style={{ fontSize: 9.5 }}>{deltaNote}</div>}
      {badge}
    </div>
  );
}

// ── segmented toggle ────────────────────────────────────────────────────────
// options: ['gross','units'] | [['variant','Variant'],['product','Product']] | [{key,label}]
export function SegmentedToggle({ options, value, onChange, size = 'md' }) {
  const opts = (options || []).map(o =>
    Array.isArray(o) ? { key: o[0], label: o[1] } : (typeof o === 'object' ? o : { key: o, label: o }));
  const pad = size === 'sm' ? '5px 9px' : '6px 11px';
  const fs = size === 'sm' ? 11 : 12;
  return (
    <div className="so-seg">
      {opts.map(o => (
        <button key={o.key} className={value === o.key ? 'on' : ''} onClick={() => onChange(o.key)}
          style={{ padding: pad, fontSize: fs, textTransform: o.label === o.key ? 'capitalize' : 'none' }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── range picker ─────────────────────────────────────────────────────────────
// Preset segmented control + from/to date inputs. One control for every page's date range.
// onChange({ from, to, preset }). `right` renders extra controls flush-right on the same row.
export function RangePicker({ from, to, onChange, right }) {
  const activePreset = PRESETS.find(p => p.from === from && p.to === to)?.key || '';
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <div className="so-seg">
        {PRESETS.map(p => (
          <button key={p.key} className={activePreset === p.key ? 'on' : ''}
            onClick={() => onChange({ from: p.from, to: p.to, preset: p.key })}>
            {p.label}
          </button>
        ))}
      </div>
      <input className="so-input" type="date" value={from} max={to}
        onChange={e => onChange({ from: e.target.value, to, preset: '' })} />
      <span style={{ color: 'var(--t3)' }}>→</span>
      <input className="so-input" type="date" value={to} min={from} max={istToday()}
        onChange={e => onChange({ from, to: e.target.value, preset: '' })} />
      {right && <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' }}>{right}</div>}
    </div>
  );
}

// Settlement-confidence pill for the Net Revenue tile: how much of a period's GST is confirmed by
// marketplace settlement vs the live 18% estimate. ● ≥80% reconciled · ◐ 40–79% · ○ <40% (recent
// marketplace sales whose settlement hasn't posted yet). Net revenue itself is live regardless.
export function SettledBadge({ pct }) {
  if (pct == null) return null;
  const glyph = pct >= 80 ? '●' : pct >= 40 ? '◐' : '○';
  const color = pct >= 80 ? 'var(--green)' : pct >= 40 ? '#d9a441' : 'var(--t3)';
  return (
    <span
      title={`${pct}% of this period's GST is confirmed by marketplace settlement. The rest is estimated live at 18% and sharpens as settlement posts (marketplace events can lag the sale by up to ~4 weeks). Net revenue itself is live regardless.`}
      style={{ fontFamily: 'var(--mono)', fontSize: 11, color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {glyph} {pct}% settled
    </span>
  );
}
