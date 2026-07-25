'use client';
// Prism atoms — the small shared pieces the redesign repeats on every screen.
// Deliberately presentational only: no data fetching, no domain logic.
import { rgb } from '../lib/hues.js';

// ── family / channel swatch ─────────────────────────────────────────────────
// Every reference to a channel carries its family colour. 8×8, radius 2.
export function Swatch({ color, size = 8, glow = false, style }) {
  return <span className="so-swatch" style={{ background: color, width: size, height: size,
    boxShadow: glow ? `0 0 8px 0 rgba(${rgb(color)},.32)` : undefined, ...style }} />;
}

// ── panel header ────────────────────────────────────────────────────────────
// Sora title + optional mono qualifier ("· Razorpay", "· vs prior MTD") + right slot.
export function PanelHead({ title, qual, right, style }) {
  return (
    <div className="so-cardhead" style={style}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span className="so-h2">{title}</span>
        {qual && <span className="so-qual">{qual}</span>}
      </div>
      {right}
    </div>
  );
}

// ── page header ─────────────────────────────────────────────────────────────
export function PageHead({ title, sub, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <h1 className="so-h1">{title}</h1>
        {sub && <div className="so-sub" style={{ marginTop: 5 }}>{sub}</div>}
      </div>
      {right && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{right}</div>}
    </div>
  );
}

// ── status pill ─────────────────────────────────────────────────────────────
// fg = hue, bg = 12%, bd = 30%. Optional leading dot.
export function Pill({ color = 'var(--t3)', dot = false, children, title, style }) {
  const solid = /^#|^rgb/.test(String(color));
  return (
    <span className="so-pill" title={title} style={{
      color,
      background: solid ? `rgba(${rgb(color)},.12)` : 'rgba(255,255,255,.05)',
      border: `1px solid ${solid ? `rgba(${rgb(color)},.3)` : 'var(--border-ctl)'}`,
      ...style,
    }}>
      {dot && <span className="so-dot" style={{ width: 6, height: 6, background: color }} />}
      {children}
    </span>
  );
}

// ── scope tab strip (Channels / P&L / Products) ─────────────────────────────
// The change that emptied the rail. Each tab still maps 1:1 to its existing route.
export function ScopeTab({ on, color, label, note, onClick, title }) {
  // A selected tab must be unmistakably selected. When the caller gives a family colour we tint
  // with it; when it doesn't (e.g. the Products strip, which has no family), fall back to the
  // accent — otherwise "selected" degrades to a font-weight shift nobody can see.
  const hue = color || '#F2CD1A';
  return (
    <button className={`so-scope${on ? ' on' : ''}`} onClick={onClick} title={title}
      style={on ? { background: `rgba(${rgb(hue)},.14)`, borderColor: `rgba(${rgb(hue)},.42)` } : undefined}>
      {color && <Swatch color={color} />}
      {label}
      {note != null && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: on ? 'var(--t2)' : 'var(--t5)' }}>{note}</span>}
    </button>
  );
}

// ── bar-in-cell ─────────────────────────────────────────────────────────────
export function Bar({ pct, color = 'var(--accent)', height = 6, width, style }) {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <span className="so-bar" style={{ display: 'block', height, width: width || '100%', ...style }}>
      <i style={{ width: `${w}%`, background: color }} />
    </span>
  );
}

// ── channel-mix donut ───────────────────────────────────────────────────────
// One arc per family with a 2px gap; total centred in Sora with a mono eyebrow.
// segments: [{ key, label, value, color }] — zero/negative values are skipped.
export function Donut({ segments, total, centerLabel = 'GROSS', size = 148, stroke = 24 }) {
  const segs = (segments || []).filter(s => Number(s.value) > 0);
  const sum = segs.reduce((a, s) => a + Number(s.value), 0);
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const GAP = 2;
  let acc = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.04)" strokeWidth={stroke} />
          {sum > 0 && segs.map(s => {
            const len = Math.max(0, (Number(s.value) / sum) * C - GAP);
            const el = (
              <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
                strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} />
            );
            acc += (Number(s.value) / sum) * C;
            return el;
          })}
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 2, pointerEvents: 'none' }}>
        <span className="so-eyebrow" style={{ fontSize: 9 }}>{centerLabel}</span>
        <span style={{ fontFamily: 'var(--cond)', fontWeight: 800, fontSize: 18, color: 'var(--t1)' }}>{total}</span>
      </div>
    </div>
  );
}

// ── em-dash null ────────────────────────────────────────────────────────────
export const Nil = () => <span className="so-null">—</span>;
