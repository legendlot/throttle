'use client';
// Snorkel redesign — presentational component library.
// Ported from the handoff prototype (ui.jsx). Dependency-free React + the CSS
// classes in redesign.css. Reuses formatters/tones from ./format.
import { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon.js';
import { TONES } from './format.js';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- Badge ----------------------------------------------------------- */
export function Badge({ label, tone = 'gray', dot = false, soft = true }) {
  const t = TONES[tone] || TONES.gray;
  return (
    <span className="badge" style={{
      background: soft ? t.bg : 'transparent', color: t.fg, border: `1px solid ${t.bd}`,
    }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: '50%', background: t.solid, flexShrink: 0 }} />}
      {label}
    </span>
  );
}

/* ---- Btn ------------------------------------------------------------- */
export function Btn({ kind = 'ghost', children, onClick, disabled, style, type = 'button' }) {
  return (
    <button type={type} className={`btn btn-${kind}`} onClick={onClick} disabled={disabled} style={style}>
      {children}
    </button>
  );
}

/* ---- count-up (runs once on mount, motion + visibility safe) --------- */
function useCountUp(target, dur = 700) {
  const numeric = Number(target) || 0;
  const [val, setVal] = useState(numeric);
  const raf = useRef(null);
  useEffect(() => {
    if (prefersReducedMotion() || (typeof document !== 'undefined' && document.hidden)) {
      setVal(numeric);
      return;
    }
    const t0 = performance.now();
    setVal(0);
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(numeric * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // animate only when the target changes (incl. first mount)
  }, [numeric, dur]);
  return val;
}
function CountUp({ value, format = (v) => Math.round(v).toLocaleString('en-IN') }) {
  const v = useCountUp(value);
  return <>{format(v)}</>;
}

/* ---- Sparkline ------------------------------------------------------- */
export function Sparkline({ data = [], stroke = '#9aa0a6', fill = true, w = 96, h = 30 }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const span = max - min || 1;
  const step = w / (data.length - 1 || 1);
  const pts = data.map((d, i) => [i * step, h - 4 - ((d - min) / span) * (h - 8)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  const id = useRef('sp' + Math.random().toString(36).slice(2)).current;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.4" fill={stroke} />
    </svg>
  );
}

/* ---- SpendChart (grouped bars) --------------------------------------- */
export function SpendChart({ data = [] }) {
  if (!data.length) return null;
  const max = Math.max(...data.map(d => d.cn + d.in), 1);
  return (
    <div className="spend-chart">
      {data.map((d, i) => {
        const cnH = (d.cn / max) * 100, inH = (d.in / max) * 100;
        return (
          <div className="spend-col" key={d.wk} title={`${d.wk}: ₹${d.cn + d.in}L`}>
            <div className="spend-bars">
              <div className="spend-bar" style={{ height: `${cnH}%`, background: 'var(--blue)', animationDelay: `${i * 45}ms` }} />
              <div className="spend-bar" style={{ height: `${inH}%`, background: 'var(--green)', animationDelay: `${i * 45 + 20}ms` }} />
            </div>
            <div className="spend-lbl">{String(d.wk).split(' ')[1] || d.wk}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Pipeline -------------------------------------------------------- */
export function Pipeline({ stages = [] }) {
  if (!stages.length) return null;
  const max = Math.max(...stages.map(s => s.count), 1);
  return (
    <div className="pipeline">
      {stages.map((s, i) => {
        const t = TONES[s.tone] || TONES.gray;
        return (
          <div className="pl-row" key={s.stage}>
            <div className="pl-label">{s.stage}</div>
            <div className="pl-track">
              <div className="pl-fill" style={{ width: `${(s.count / max) * 100}%`, background: t.solid, animationDelay: `${i * 60}ms` }} />
            </div>
            <div className="pl-count" style={{ color: t.fg }}>{s.count}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Kpi ------------------------------------------------------------- */
export function Kpi({ label, value, sub, tone = 'gray', series, delta, format, onClick }) {
  const t = TONES[tone] || TONES.gray;
  const accent = tone === 'gray' ? 'var(--text-1)' : t.fg;
  return (
    <div className={`kpi ${onClick ? 'kpi-click' : ''}`} onClick={onClick} style={{ '--kpi-accent': t.solid }}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {delta != null && (
          <span className="kpi-delta" style={{ color: delta >= 0 ? '#5fe08a' : '#ff7a7a' }}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
      <div className="kpi-val" style={{ color: accent }}>
        <CountUp value={value} format={format || ((v) => Math.round(v).toLocaleString('en-IN'))} />
      </div>
      <div className="kpi-bottom">
        <span className="kpi-sub">{sub}</span>
        {series && <Sparkline data={series} stroke={t.solid} w={72} h={26} />}
      </div>
    </div>
  );
}

/* ---- Panel ----------------------------------------------------------- */
export function Panel({ title, count, action, children, pad = false }) {
  return (
    <section className="panel">
      {(title != null || action) && (
        <div className="panel-head">
          <span className="panel-title">{title}{count != null && <span className="panel-count">{count}</span>}</span>
          {action}
        </div>
      )}
      <div className={pad ? 'panel-body' : 'panel-scroll'}>{children}</div>
    </section>
  );
}

/* ---- EmptyState ------------------------------------------------------ */
export function EmptyState({ icon = 'inbox', title, hint }) {
  return (
    <div className="empty">
      <div className="empty-ico"><Icon name={icon} size={22} /></div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

/* ---- PageHead -------------------------------------------------------- */
export function PageHead({ title, sub, actions }) {
  return (
    <div className="page-head">
      <div><h2 className="page-title">{title}</h2>{sub && <p className="page-sub">{sub}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
