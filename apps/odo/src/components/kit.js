'use client';
// Shared dashboard primitives — the single vocabulary for KPI tiles, deltas, sparklines,
// range selection and segmented toggles. Every page (cockpit, Performance, Marketing, Funnel,
// Channels) renders these, so the controls + tiles look and behave identically everywhere.
import { useState } from 'react';
import { rangePresets, istToday } from '../lib/api.js';
import { HUE, hueStyle } from '../lib/hues.js';

const PRESETS = rangePresets();

// ── sortable tables ───────────────────────────────────────────────────────
// useTableSort: click-to-sort any data table. valueOf(row,key) lets a table sort by a COMPUTED
// column (e.g. ROAS = conv_value/spend) instead of a raw field. Numeric values sort numerically,
// everything else alphabetically (numeric-aware). Pair with <SortHeader> for clickable headers.
export function useTableSort(rows, opts = {}) {
  const { initialKey = null, initialDir = 'desc' } = opts;
  // Read `valueOf` ONLY when the caller actually passed it. Destructuring `{ valueOf }` off the
  // options object walks the prototype chain and picks up `Object.prototype.valueOf` (a function)
  // whenever no accessor was supplied — so `g` below became Object.prototype.valueOf, `get()` threw
  // (this=undefined), the try/catch swallowed it to null, every comparison returned 0, and the
  // stable sort silently preserved input order in BOTH directions (the arrow flipped, rows never
  // moved). hasOwnProperty avoids the inherited value entirely. (S189 — was a silent no-op on every
  // table without a custom valueOf: cockpit, Performance, Funnel daily history.)
  const valueOf = Object.prototype.hasOwnProperty.call(opts, 'valueOf') ? opts.valueOf : null;
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState(initialDir);
  const toggle = (k) => {
    if (k === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('desc'); }
  };
  // A generic sort util must tolerate ANY cell value — a single exotic/non-primitive
  // value (e.g. an object whose valueOf coerces with this=null) must never throw inside
  // render and white-screen the whole app. Coercion is the comparator's job, not the caller's.
  const g = valueOf || ((row, k) => row?.[k]);
  const get = (row, k) => { try { return g(row, k); } catch { return null; } };
  const num = (x) => { try { return Number(x); } catch { return NaN; } };
  const str = (x) => { if (x == null) return ''; try { return String(x); } catch { return ''; } };
  let sorted = Array.isArray(rows) ? rows : (rows || []);
  if (sortKey) {
    sorted = [...sorted].sort((a, b) => {
      const av = get(a, sortKey), bv = get(b, sortKey);
      const an = num(av), bn = num(bv);
      const numeric = av != null && av !== '' && bv != null && bv !== '' && !Number.isNaN(an) && !Number.isNaN(bn);
      const cmp = numeric ? an - bn : str(av).localeCompare(str(bv), undefined, { numeric: true });
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
      {label}<span style={{ marginLeft: 4, fontSize: 8, opacity: active ? 0.9 : 0.28, color: active ? 'var(--accent)' : 'inherit' }}>{active ? (sort.sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
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
  const color = tone === 'neutral' ? 'var(--t4)' : (up ? 'var(--green-fg)' : 'var(--red)');
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500, color, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
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
// The signature Prism element. EVERY colour on the tile derives from one metric `hue`,
// so a new metric needs no new tokens — pass a hex (see lib/hues.js HUE) and the swatch,
// tint, border and glow all follow.
//   hero  (default) — 5-up rows: glow + optional sparkline
//   dense (dense)   — 8-up / 4-up rows: tuned down, no glow, mono sub-line
// Optional spark (sparkline data) + sparkColor; optional badge slot; deltaNote shows
// what the delta compares against. `accent` is accepted for back-compat and, when it's a
// hex, is used as the hue (older call sites passed a semantic colour there).
export function Kpi({ lbl, val, sub, now, prev, pct, tone, badge, spark, sparkColor, deltaNote, accent, hue, dense }) {
  const h = hue || (typeof accent === 'string' && accent.startsWith('#') ? accent : HUE.neutral);
  return (
    <div className={`so-stat${dense ? ' dense' : ''}`} style={hueStyle(h)}>
      <div className="so-stat-top">
        <span className="so-stat-swatch" />
        <span className="so-stat-lbl">{lbl}</span>
        {badge}
        <Delta now={now} prev={prev} pct={pct} tone={tone} />
      </div>
      <span className="so-stat-val">{val}</span>
      {sub && <div className="so-stat-sub">{sub}</div>}
      {deltaNote && <div className="so-stat-sub">{deltaNote}</div>}
      {spark && <div style={{ marginTop: 8 }}><Spark data={spark} color={sparkColor || h} height={28} /></div>}
    </div>
  );
}

// ── segmented toggle ────────────────────────────────────────────────────────
// options: ['gross','units'] | [['variant','Variant'],['product','Product']] | [{key,label}]
export function SegmentedToggle({ options, value, onChange, size = 'md' }) {
  const opts = (options || []).map(o =>
    Array.isArray(o) ? { key: o[0], label: o[1] } : (typeof o === 'object' ? o : { key: o, label: o }));
  const pad = size === 'sm' ? '4px 10px' : '6px 11px';
  const fs = size === 'sm' ? 10 : 11;
  return (
    <div className={`so-seg${size === 'sm' ? ' inpanel' : ''}`}>
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
  // Sticky filter bar: pins to the top of the scrolling area (.so-scroll) so the range controls
  // stay reachable while the page scrolls. top:-22px cancels .so-scroll's 22px top padding so the
  // bar pins FLUSH under the app header (top:0 would pin at the padding edge, leaving a gap where
  // cards peek through). It stays a PAGE-LEVEL header — never nest it inside a .so-card.
  // Near-opaque canvas tint + blur so content scrolls under a clean edge without showing a flat
  // black band across the canvas glow; z-index above cards but below portal popovers (.so-pop = 40).
  return (
    <div style={{ position: 'sticky', top: -22, zIndex: 30, background: 'rgba(8,9,12,.86)', backdropFilter: 'blur(8px)', borderBottom: '1px solid var(--row-border)', padding: '10px 0', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
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
      <span style={{ color: 'var(--t5)', fontFamily: 'var(--mono)' }}>→</span>
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
  const color = pct >= 80 ? 'var(--green-fg)' : pct >= 40 ? '#F59E0B' : 'var(--t3)';
  const bd = pct >= 80 ? 'rgba(52,211,153,.35)' : pct >= 40 ? 'rgba(245,158,11,.35)' : 'var(--border-ctl)';
  return (
    <span
      title={`${pct}% of this period's GST is confirmed by marketplace settlement. The rest is estimated live at 18% and sharpens as settlement posts (marketplace events can lag the sale by up to ~4 weeks). Net revenue itself is live regardless.`}
      // Keep the word "settled". The tile's top row also carries the period <Delta> (e.g. "▲ 8%"),
      // so a bare "◐ 62%" next to it reads as a second delta — two unrelated percentages in the
      // same mono ramp. The word is what disambiguates them; the title alone isn't enough.
      style={{ fontFamily: 'var(--mono)', fontSize: 9, color, border: `1px solid ${bd}`, borderRadius: 999,
        padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
      {glyph} {pct}% settled
    </span>
  );
}
