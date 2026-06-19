'use client';
// Manifest "Pit Wall" — shared primitives, generic table, SVG charts.
import React from 'react';

export const MONO = 'var(--font-mono)';
export const DISP = 'var(--font-display)';

// breakpoint hook — SSR-safe (false until mounted; the shell gates render on
// `hydrated` so there's no flash). 768px matches the globals.css media query.
export function useIsMobile(bp = 768) {
  const [m, setM] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [bp]);
  return m;
}

export function toneVar(tone) {
  switch (tone) {
    case 'green': return 'var(--green)';
    case 'red': return 'var(--red)';
    case 'blue': return 'var(--blue)';
    case 'yellow': return 'var(--accent)';
    default: return 'var(--t3)';
  }
}

export function Eyebrow({ children, style }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.13em',
      textTransform: 'uppercase', color: 'var(--t3)', ...style }}>{children}</div>
  );
}

export function Badge({ tone = 'gray', children, style }) {
  const c = toneVar(tone);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 999,
      fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase',
      whiteSpace: 'nowrap', lineHeight: 1.4,
      background: `color-mix(in srgb, ${c} 14%, transparent)`, color: c,
      border: `1px solid color-mix(in srgb, ${c} 32%, transparent)`, ...style }}>{children}</span>
  );
}

export function Card({ title, action, children, bodyPad, style, headStyle }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      boxShadow: 'var(--shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column', ...style }}>
      {title != null && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '15px 20px', borderBottom: '1px solid var(--border)', ...headStyle }}>
          <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 15, color: 'var(--t1)' }}>{title}</div>
          {action}
        </div>
      )}
      <div style={{ padding: bodyPad === undefined ? 0 : bodyPad, flex: 1 }}>{children}</div>
    </div>
  );
}

export function Btn({ variant = 'primary', children, onClick, type = 'button', style }) {
  const base = { fontFamily: DISP, fontWeight: 700, fontSize: 12.5, letterSpacing: '.04em',
    textTransform: 'uppercase', borderRadius: 8, padding: '9px 16px', cursor: 'pointer', whiteSpace: 'nowrap' };
  const skin = variant === 'primary'
    ? { background: 'var(--accent)', color: 'var(--accent-fg)', border: '1px solid var(--accent)' }
    : { background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)' };
  return <button type={type} onClick={onClick} className="mf-btn" style={{ ...base, ...skin, ...style }}>{children}</button>;
}

export function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase',
        color: 'var(--t3)', marginBottom: 7 }}>{label}</div>
      {children}
    </label>
  );
}

const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, background: 'var(--surface2)',
  border: '1px solid var(--border)', color: 'var(--t1)', fontFamily: DISP, fontSize: 13, outline: 'none' };

export function Input(props) { return <input {...props} className="mf-input" style={{ ...inputStyle, ...(props.style || {}) }} />; }
export function Textarea(props) {
  return <textarea {...props} className="mf-input" style={{ ...inputStyle, minHeight: 70, resize: 'vertical', lineHeight: 1.5, ...(props.style || {}) }} />;
}
export function Select({ options = [], ...props }) {
  // options may be plain strings, or { value, label } objects (value submitted, label shown)
  return (
    <select {...props} className="mf-input" style={{ ...inputStyle, appearance: 'none', cursor: 'pointer', ...(props.style || {}) }}>
      {options.map((o) => {
        const val = (o && typeof o === 'object') ? o.value : o;
        const lbl = (o && typeof o === 'object') ? o.label : o;
        return <option key={val} value={val}>{lbl}</option>;
      })}
    </select>
  );
}

// ── generic table ────────────────────────────────────────────────
// cols: [{ label, align, render:(row)=>node }]
// Desktop: a real table inside a horizontal-scroll wrapper (wide column sets
// scroll rather than forcing the page wider). Mobile: each row restacks into a
// label:value card — every list screen becomes phone-native with no per-screen work.
export function Table({ cols, rows, onRowClick, rowKey }) {
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((row, ri) => (
          <div key={rowKey ? rowKey(row, ri) : ri} className={'mf-tr' + (onRowClick ? ' click' : '')}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '14px 16px',
              borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
            {cols.map((c, ci) => (
              <div key={ci} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14 }}>
                <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.1em',
                  textTransform: 'uppercase', color: 'var(--t3)', flexShrink: 0 }}>{c.label}</span>
                <span style={{ minWidth: 0, textAlign: 'right', color: 'var(--t2)', fontSize: 13.5,
                  overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.render(row)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="mf-tablewrap">
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={i} style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.1em',
              textTransform: 'uppercase', color: 'var(--t3)', textAlign: c.align || 'left',
              padding: '11px 12px', paddingLeft: i === 0 ? 20 : 12, paddingRight: i === cols.length - 1 ? 20 : 12,
              borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={rowKey ? rowKey(row) : ri} className={'mf-tr' + (onRowClick ? ' click' : '')}
            onClick={onRowClick ? () => onRowClick(row) : undefined}>
            {cols.map((c, ci) => (
              <td key={ci} style={{ textAlign: c.align || 'left', color: 'var(--t2)', fontSize: 12.5,
                padding: 'var(--rowpy) 12px', paddingLeft: ci === 0 ? 20 : 12, paddingRight: ci === cols.length - 1 ? 20 : 12,
                borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)', verticalAlign: 'middle' }}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

// mono cell helpers
export const Mono = ({ children, color = 'var(--t2)', size = 12, weight = 500, style }) =>
  <span style={{ fontFamily: MONO, fontSize: size, fontWeight: weight, color, ...style }}>{children}</span>;

// ── running-balance chart (area + line), viewBox 0..100, stretched ──
export function BalanceChart({ values, height = 150, color = 'var(--accent)', gridlines = 2 }) {
  const n = values.length;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const padTop = 8, padBot = 8;
  const X = (i) => (n === 1 ? 0 : (i / (n - 1)) * 100);
  const Y = (v) => padTop + (1 - (v - min) / span) * (100 - padTop - padBot);
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(2)} ${Y(v).toFixed(2)}`).join(' ');
  const area = `${line} L100 100 L0 100 Z`;
  const gid = 'mfgrad' + Math.round(min) + n;
  const lastY = Y(values[n - 1]);
  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: gridlines }).map((_, i) => {
          const y = padTop + ((i + 1) / (gridlines + 1)) * (100 - padTop - padBot);
          return <line key={i} x1="0" y1={y} x2="100" y2={y} stroke="var(--border)" strokeWidth="1"
            vectorEffect="non-scaling-stroke" opacity="0.5" />;
        })}
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
          strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={{ position: 'absolute', right: 0, top: `${lastY}%`, width: 9, height: 9, borderRadius: 999,
        background: color, transform: 'translate(50%,-50%)', boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)` }} />
    </div>
  );
}

export function Sparkline({ values, min, max, height = 90, color = 'var(--blue)' }) {
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const n = values.length;
  const X = (i) => (n === 1 ? 0 : (i / (n - 1)) * 100);
  const Y = (v) => 8 + (1 - (v - lo) / span) * 84;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(2)} ${Y(v).toFixed(2)}`).join(' ');
  const area = `${line} L100 100 L0 100 Z`;
  const gid = 'mfspark' + n;
  const lastY = Y(values[n - 1]);
  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
          strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={{ position: 'absolute', right: 0, top: `${lastY}%`, width: 8, height: 8, borderRadius: 999,
        background: color, transform: 'translate(50%,-50%)' }} />
    </div>
  );
}
