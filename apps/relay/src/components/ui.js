'use client';
// Snorkel redesign — presentational component library.
// Ported from the handoff prototype (ui.jsx). Dependency-free React + the CSS
// classes in redesign.css. Reuses formatters/tones from ./format.
import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';   // Modal close affordance (S282) — this module had no icon import before.
import { Icon } from './Icon.js';
import { TONES } from './format.js';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- ChannelChip ------------------------------------------------------ */
// Mono short-code pill (WA green / EM violet / SM blue), COMMAND §7.2.
// SHARED on purpose: this lived only in campaigns/page.js, so the Analytics campaigns
// table shipped with no channel marker at all — you could not tell a WhatsApp broadcast
// from an email one (Afshaan, 2026-08-10). One definition, or the colour map drifts.
// An unknown channel degrades to its first two letters rather than rendering nothing.
export function ChannelChip({ channel }) {
  const c = String(channel || '').toLowerCase();
  const map = {
    whatsapp: { short: 'WA', fg: 'var(--wa, #25D366)', bg: 'rgba(37,211,102,.13)' },
    email:    { short: 'EM', fg: 'var(--em, #a78bfa)', bg: 'rgba(167,139,250,.13)' },
    sms:      { short: 'SM', fg: 'var(--blue)', bg: 'rgba(124,155,255,.13)' },
    rcs:      { short: 'RC', fg: 'var(--blue)', bg: 'rgba(124,155,255,.13)' },
  };
  const m = map[c] || { short: (c || '?').slice(0, 2).toUpperCase(), fg: 'var(--t3)', bg: 'rgba(255,255,255,.06)' };
  return <span className="chch" style={{ color: m.fg, background: m.bg }} title={c || 'unknown channel'}>{m.short}</span>;
}

/* ---- Badge ----------------------------------------------------------- */
// `title` is the hover explanation. Added 2026-08-14 for the "out of date" member badge: a
// badge that says a count is wrong is only half the message — the reader needs to know why and
// what to do, and there is no room for that in a pill.
export function Badge({ label, tone = 'gray', dot = false, soft = true, title }) {
  const t = TONES[tone] || TONES.gray;
  return (
    <span className="badge" title={title} style={{
      background: soft ? t.bg : 'transparent', color: t.fg, border: `1px solid ${t.bd}`,
      cursor: title ? 'help' : undefined,
    }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: '50%', background: t.solid, flexShrink: 0 }} />}
      {label}
    </span>
  );
}

/* ---- Switch ---------------------------------------------------------- */
// A real on/off control for state that is genuinely binary to the reader, even when the
// underlying model has more values (a journey is draft|active|paused|archived, but the only
// question anyone actually asks is "is this sending?").
//
// Deliberately renders as a <button role="switch"> rather than a styled checkbox: it is an
// action with a side effect, not a form field, and screen readers should announce it as such.
// `label` is required — an unlabelled switch in a table row is unreadable out of context.
export function Switch({ checked, onChange, disabled = false, busy = false, label, title }) {
  const on = !!checked;
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} title={title || label}
      disabled={disabled || busy}
      onClick={(e) => { e.stopPropagation(); if (!disabled && !busy) onChange(!on); }}
      style={{
        position: 'relative', width: 34, height: 19, flexShrink: 0, padding: 0,
        borderRadius: 999, cursor: disabled || busy ? 'not-allowed' : 'pointer',
        border: `1px solid ${on ? 'rgba(52,211,153,.5)' : 'rgba(255,255,255,.14)'}`,
        background: on ? 'rgba(52,211,153,.2)' : 'rgba(255,255,255,.06)',
        opacity: disabled ? 0.45 : 1,
        transition: prefersReducedMotion() ? 'none' : 'background 140ms ease, border-color 140ms ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 1, left: on ? 16 : 2, width: 15, height: 15, borderRadius: '50%',
        background: on ? 'var(--green, #34d399)' : 'var(--t4, #71767c)',
        transition: prefersReducedMotion() ? 'none' : 'left 140ms ease, background 140ms ease',
      }} />
    </button>
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

/* ---- KpiStrip (§3.3) -------------------------------------------------- */
// The COMMAND bordered multi-cell strip: equal cells divided by hairlines, a
// 2px accent top-rule on the lead metric. Purely presentational.
// cells: [{ label, value, delta, up (delta tinted green), lead, color }]
export function KpiStrip({ cells = [] }) {
  if (!cells.length) return null;
  return (
    <div className="kstrip">
      {cells.map((c, i) => (
        <div key={c.label || i} className={`ks-cell ${c.lead ? 'lead' : ''}`}>
          <div className="ks-label">{c.label}</div>
          <div className="ks-val" style={c.color ? { color: c.color } : undefined}>{c.value}</div>
          {c.delta != null && <div className={`ks-delta ${c.up ? 'up' : ''}`}>{c.delta}</div>}
        </div>
      ))}
    </div>
  );
}

/* ---- Panel ----------------------------------------------------------- */
// `info` puts the panel's explanatory prose behind an ⓘ in its header instead of
// as a paragraph above the controls (S249). Same content, same place every time —
// a reader who wants the rules knows where they are, and one who doesn't gets a
// panel that fits on screen.
export function Panel({ title, count, action, children, pad = false, info, infoWidth }) {
  return (
    <section className="panel">
      {(title != null || action) && (
        <div className="panel-head">
          <span className="panel-title">
            {title}
            {count != null && <span className="panel-count">{count}</span>}
            {info && <InfoDot label={`About ${typeof title === 'string' ? title : 'this panel'}`} width={infoWidth}>{info}</InfoDot>}
          </span>
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

/* ---- InfoDot --------------------------------------------------------- */
// A small ⓘ that parks explanatory prose behind a hover/click popover.
//
// The journeys editor had grown ~8 paragraphs of permanently-visible guidance —
// each one earned (every note records a real incident), but together they buried
// the controls they were explaining. Prose that is right 100% of the time and
// needed 1% of the time belongs behind an affordance, not above the field.
//
// Hover OR click, deliberately: hover is the fast path for a mouse, but it is
// unreachable on touch and by keyboard, so click/focus toggles the same panel.
// Escape closes and returns focus, and `pin` (set by click) survives mouse-out
// so the text can be read without keeping the pointer perfectly still.
export function InfoDot({ children, label = 'More information', side = 'right', width = 320 }) {
  const [hover, setHover] = useState(false);
  const [pin, setPin] = useState(false);
  const wrapRef = useRef(null);
  const open = hover || pin;

  useEffect(() => {
    if (!pin) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPin(false); };
    // Click-away only applies to the PINNED state — a hover popover closes itself.
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setPin(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [pin]);

  return (
    <span ref={wrapRef} className="infodot-wrap"
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" className={`infodot${open ? ' is-open' : ''}`}
        aria-label={label} aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPin((p) => !p); }}
        onFocus={() => setHover(true)} onBlur={() => setHover(false)}>i</button>
      {open && (
        <span role="tooltip" className={`infodot-pop infodot-${side}`} style={{ width }}
          // Clicks inside the panel must not bubble to a row/card click handler.
          onClick={(e) => e.stopPropagation()}>
          {children}
        </span>
      )}
    </span>
  );
}

/* ---- FieldLabel ------------------------------------------------------ */
// A form label with its guidance folded into an InfoDot, so every field in a
// panel gets the same treatment instead of some carrying notes and some not.
export function FieldLabel({ children, hint, info, infoWidth }) {
  return (
    <div className="kv-k" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span>{children}</span>
      {hint && <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}>{hint}</span>}
      {info && <InfoDot label={`About: ${typeof children === 'string' ? children : 'this field'}`} width={infoWidth}>{info}</InfoDot>}
    </div>
  );
}

/* ---- modal ----------------------------------------------------------
   Promoted out of the Links page (S282) so the campaign tracking gate can reuse it. Relay
   deliberately does NOT use @throttle/ui's Modal here — that one is a confirm-shaped component
   (confirmLabel/onConfirm/footer) with the shared design language, and the relay surfaces built
   around this one expect a plain content shell. `maxWidth` is the only addition: the tracking
   gate carries two options and a form, and 520px forces that into a scroll tunnel. */
export function Modal({ title, children, onClose, maxWidth = 520 }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12,
        padding: 18, width: '100%', maxWidth, maxHeight: '85vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: 'var(--t1)' }}>{title}</h3>
          <button onClick={onClose} aria-label="Close"
                  style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--t3)' }}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
