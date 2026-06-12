'use client';
/* ════════════════════════════════════════════════════════════
   REDLINE kit — Pit Wall v2 shared building blocks.
   Ported from redesign-reference/app/kit.jsx (prototype is the
   source of truth for markup + spacing). Differences from the
   prototype: lucide-react icons instead of the hand-rolled set,
   everything parameterized (no RL.* mock globals), L4/L5 line
   colors added (fresh runs allow L4/L5 since S125).
   ════════════════════════════════════════════════════════════ */
import { useState } from 'react';
import {
  Gauge, Factory, Truck, Bell, ShieldCheck, Wrench, Clock, Search, Plus,
  Package, Undo2, ClipboardCheck, ChevronRight, ChevronLeft, ChevronDown,
  SlidersHorizontal, ArrowUpRight, AlertTriangle, Users, Send, Command,
  Activity, FileText, LayoutGrid, Layers, Flag, ArrowDown, ArrowUp, Pin,
  LogOut, ScanLine, Edit3, QrCode, Printer, CalendarClock, Tag, Network,
  ArrowLeftRight, X, BookOpen, BarChart3, GitBranch, Workflow, FilePlus2,
} from 'lucide-react';

/* ── Icon — prototype name → lucide map (1.75px stroke) ─────── */
const ICONS = {
  gauge: Gauge, factory: Factory, truck: Truck, bell: Bell, shield: ShieldCheck,
  wrench: Wrench, clock: Clock, search: Search, plus: Plus, box: Package,
  undo: Undo2, clipboard: ClipboardCheck, chevR: ChevronRight, chevL: ChevronLeft,
  chevD: ChevronDown, settings: SlidersHorizontal, upRight: ArrowUpRight,
  alert: AlertTriangle, users: Users, send: Send, command: Command,
  activity: Activity, file: FileText, grid: LayoutGrid, layers: Layers,
  flag: Flag, arrowDown: ArrowDown, arrowUp: ArrowUp, pin: Pin, logout: LogOut,
  scan: ScanLine, edit: Edit3, qr: QrCode, printer: Printer,
  calendar: CalendarClock, tag: Tag, network: Network, swap: ArrowLeftRight,
  x: X, book: BookOpen, chart: BarChart3, branch: GitBranch, flow: Workflow,
  filePlus: FilePlus2,
};
export function Icon({ name, size = 16, stroke = 1.75, style }) {
  const C = typeof name === 'string' ? ICONS[name] : name;
  if (!C) return null;
  return <C size={size} strokeWidth={stroke} style={{ flexShrink: 0, ...style }} />;
}

/* ── line color map (L1–L3 per handoff §3.2; L4/L5 extended) ── */
export const LINE_COLOR = { L1: '#F2CD1A', L2: '#6d83ff', L3: '#4ade80', L4: '#f97316', L5: '#c084fc' };
export const LINE_RGB   = { L1: '242,205,26', L2: '109,131,255', L3: '74,222,94', L4: '249,115,22', L5: '192,132,252' };
export const lineColor = id => LINE_COLOR[id] || '#8c8c96';
export const lineRgb   = id => LINE_RGB[id]   || '140,140,150';

export const fmt = n => (n == null || Number.isNaN(Number(n)) ? '0' : Number(n).toLocaleString('en-IN'));

/* ── IST clock helpers (en-IN / Asia-Kolkata everywhere) ────── */
export function istNow() {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value || '';
  let hour = Number(get('hour')) % 12;
  if ((get('dayPeriod') || '').toLowerCase().includes('pm')) hour += 12;
  return { hour, minute: Number(get('minute')), label: `${get('hour')}:${get('minute')} ${(get('dayPeriod') || '').toUpperCase()}` };
}
export function istToday() {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date());
}

/* ── severity helpers ───────────────────────────────────────── */
export const SEV = {
  high: { fg: 'var(--bad-fg)',  bg: 'var(--bad-bg)',  bd: 'var(--bad-bd)',  dot: 'var(--red)' },
  med:  { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', bd: 'var(--warn-bd)', dot: 'var(--amber)' },
  low:  { fg: 'var(--t2)',      bg: 'var(--surface-2)', bd: 'var(--border-2)', dot: 'var(--t3)' },
};

/* ── Spark — tiny inline trend line ─────────────────────────── */
export function Spark({ data = [0], color = 'var(--t2)', w = 64, h = 22 }) {
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const rng = max - min || 1;
  const pts = data.map((v, i) =>
    `${(i / Math.max(data.length - 1, 1)) * w},${h - ((v - min) / rng) * (h - 3) - 1.5}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ════════════════════════════════════════════════════════════
   ShiftBattery — the signature. Horizontal battery for ONE line:
   segmented cells fill toward the daily target; a pace marker
   shows where you SHOULD be by now; color = met/close/behind.
   Props: lineId, done, target, shiftStart/shiftEnd (24h IST),
   nowHour (defaults to IST now), paceTolerance (units).
   ════════════════════════════════════════════════════════════ */
export function ShiftBattery({ lineId, done = 0, target = 0, segments = 20, height = 30,
  shiftStart = 9, shiftEnd = 18, nowHour = null, paceTolerance = null }) {
  const now = nowHour != null ? nowHour : istNow().hour;
  const shiftHrs = Math.max(shiftEnd - shiftStart, 1);
  const tgt = Math.max(Number(target) || 0, 0);
  const pct = tgt ? Math.min(done / tgt, 1) : 0;
  const filled = pct * segments;
  const hrsElapsed = Math.max(0, Math.min(now - shiftStart, shiftHrs));
  const paceDone = (tgt * hrsElapsed) / shiftHrs;
  const paceSeg = (tgt ? Math.min(paceDone / tgt, 1) : 0) * segments;
  const gap = Math.round(paceDone - done);
  const tol = paceTolerance != null ? paceTolerance : Math.max(8, Math.round((tgt / shiftHrs) * 0.15));
  const onPace = Math.abs(gap) <= tol;
  const behind = gap > tol;
  const fillColor = behind ? 'var(--red)' : onPace ? lineColor(lineId) : 'var(--green)';
  const rgb = lineRgb(lineId);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, position: 'relative', display: 'flex', gap: 2,
        background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 5,
        padding: 3, height }}>
        {Array.from({ length: segments }).map((_, i) => {
          const on = i < Math.floor(filled);
          const partial = i === Math.floor(filled) ? filled - Math.floor(filled) : 0;
          return (
            <div key={i} style={{ flex: 1, borderRadius: 1.5, position: 'relative',
              background: on ? fillColor : `rgba(${rgb},0.07)`, overflow: 'hidden',
              transition: 'background 400ms var(--ease)' }}>
              {partial > 0 && (
                <div style={{ position: 'absolute', inset: 0, width: `${partial * 100}%`,
                  background: fillColor }} />
              )}
            </div>
          );
        })}
        <div title="where you should be now" style={{ position: 'absolute', top: -3, bottom: -3,
          left: `calc(${(paceSeg / segments) * 100}% )`, width: 2,
          background: 'var(--t1)', borderRadius: 2, opacity: 0.85 }}>
          <div style={{ position: 'absolute', top: -5, left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent',
            borderTop: '5px solid var(--t1)' }} />
        </div>
      </div>
      <div style={{ width: 4, height: height * 0.5, background: 'var(--border-2)', borderRadius: 2 }} />
      <div style={{ minWidth: 120, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', whiteSpace: 'nowrap' }}>
          {fmt(done)}<span style={{ color: 'var(--t4)', fontWeight: 400 }}> / {fmt(tgt)}</span>
        </div>
        <div className="num" style={{ fontSize: 11, fontWeight: 600, marginTop: 2, whiteSpace: 'nowrap',
          color: behind ? 'var(--bad-fg)' : onPace ? 'var(--t3)' : 'var(--ok-fg)' }}>
          {behind ? `▼ ${gap} behind` : onPace ? `${Math.round(pct * 100)}% · on pace` : `▲ ${Math.abs(gap)} ahead`}
        </div>
      </div>
    </div>
  );
}

/* ── HourStrip — per-line hour cells (mini batteries) ───────── */
export function HourStrip({ lineId, hourly = {}, target = 0, cellH = 56,
  shiftStart = 9, shiftEnd = 18, nowHour = null }) {
  const now = nowHour != null ? nowHour : istNow().hour;
  const shiftHrs = Math.max(shiftEnd - shiftStart, 1);
  const hrTarget = (Number(target) || 0) / shiftHrs;
  const hours = Array.from({ length: shiftEnd - shiftStart + 1 }, (_, i) => i + shiftStart);
  const rgb = lineRgb(lineId);
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {hours.map(h => {
        const count = Number(hourly[h]) || 0;
        const future = h > now;
        const current = h === now;
        const ratio = hrTarget ? count / hrTarget : 0;
        let fill = 'transparent';
        if (!future && count > 0) {
          if (current) fill = `rgba(${rgb},0.55)`;
          else if (ratio >= 1) fill = 'rgba(34,197,94,0.85)';
          else if (ratio >= 0.7) fill = 'rgba(251,191,36,0.85)';
          else fill = 'rgba(222,42,42,0.8)';
        }
        const pct = Math.min(ratio, 1) * 100;
        const met = !future && !current && ratio >= 1;
        return (
          <div key={h} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 5 }}>
            <div style={{ width: '100%', height: cellH, borderRadius: 4, position: 'relative',
              overflow: 'hidden', background: 'var(--bg-2)',
              border: `1px solid ${future ? 'var(--border)' : `rgba(${rgb},0.3)`}`,
              boxShadow: current ? `0 0 0 1px rgba(${rgb},0.5)` : 'none' }}>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${pct}%`,
                background: fill, transition: 'height 500ms var(--ease)' }} />
              <div className="num" style={{ position: 'absolute', inset: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, zIndex: 1,
                color: pct > 50 ? '#fff' : future ? 'var(--t4)' : lineColor(lineId) }}>
                {!future && count > 0 ? count : ''}
              </div>
              {met && <div style={{ position: 'absolute', top: 4, right: 4, width: 4, height: 4,
                borderRadius: '50%', background: 'var(--green)' }} />}
              {current && <div className="rl-pulse" style={{ position: 'absolute', top: 4, right: 4,
                width: 5, height: 5, borderRadius: '50%', background: lineColor(lineId) }} />}
            </div>
            <div className="num" style={{ fontSize: 10, color: future ? 'var(--t4)' : 'var(--t3)' }}>
              {h > 12 ? h - 12 : h}{h >= 12 ? 'p' : 'a'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── ExceptionRow — drill row used in feeds ─────────────────── */
export function ExceptionRow({ ex, compact, onClick }) {
  const s = SEV[ex.sev] || SEV.low;
  const [hover, setHover] = useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: compact ? '9px 12px' : '12px 14px',
        borderRadius: 'var(--r-sm)', cursor: onClick ? 'pointer' : 'default',
        background: hover ? 'var(--surface-2)' : 'transparent',
        border: '1px solid', borderColor: hover ? 'var(--border-2)' : 'transparent',
        transition: 'all var(--fast) var(--ease)' }}>
      <div style={{ width: 30, height: 30, borderRadius: 'var(--r-sm)', flexShrink: 0,
        display: 'grid', placeItems: 'center', background: s.bg, color: s.fg,
        border: `1px solid ${s.bd}` }}>
        <Icon name={ex.icon} size={15} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {ex.line && <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(ex.line),
            background: `rgba(${lineRgb(ex.line)},0.12)`, padding: '1px 5px', borderRadius: 3 }}>{ex.line}</span>}
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--t1)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.title}</span>
        </div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.detail}</div>
      </div>
      <span className="num" style={{ fontSize: 14, fontWeight: 700, color: s.fg, flexShrink: 0 }}>{ex.metric}</span>
      <div style={{ width: 16, color: hover ? 'var(--t2)' : 'var(--t4)', flexShrink: 0,
        transform: hover ? 'translateX(2px)' : 'none', transition: 'all var(--fast) var(--ease)' }}>
        <Icon name="chevR" size={16} />
      </div>
    </div>
  );
}

/* ── KpiTile — mono value + Tomorrow eyebrow + tone stripe ────
   `proj` (optional) = a month-end projection string (e.g. "~1,405"),
   rendered as a small "month proj" trend line at the top of the card. */
export function KpiTile({ label, value, sub, tone, spark, big, proj, projTitle }) {
  const toneColor = { ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', bad: 'var(--bad-fg)',
    brand: 'var(--yellow)', blue: 'var(--blue-bright)' }[tone];
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)', padding: big ? '16px 18px' : '13px 15px', position: 'relative',
      overflow: 'hidden' }}>
      {tone && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: toneColor }} />}
      {proj != null && (
        <div title={projTitle || 'Projected month-end at the current pace'}
          style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 9, paddingBottom: 8,
            borderBottom: '1px dashed var(--border-2)' }}>
          <Icon name="arrowUp" size={11} style={{ color: 'var(--t3)' }} />
          <span className="num" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--t2)' }}>{proj}</span>
          <span className="eyebrow" style={{ fontSize: 9 }}>proj / mo</span>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span className="eyebrow">{label}</span>
        {spark && <Spark data={spark} color={toneColor || 'var(--t3)'} />}
      </div>
      <div className="num" style={{ fontSize: big ? 30 : 23, fontWeight: 700, color: 'var(--t1)',
        lineHeight: 1, marginTop: 9, whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

/* ── Panel — canonical card ─────────────────────────────────── */
export function Panel({ title, icon, action, pad = 16, children, style }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', ...style }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 16px',
          borderBottom: '1px solid var(--border)' }}>
          {icon && <span style={{ color: 'var(--t3)', display: 'flex' }}><Icon name={icon} size={15} /></span>}
          <span className="label" style={{ fontSize: 12, color: 'var(--t1)', flex: 1 }}>{title}</span>
          {action}
        </div>
      )}
      <div style={{ padding: pad, flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

/* ── SectionHead — Tomorrow eyebrow over a content block ────── */
export function SectionHead({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
      <h2 className="label" style={{ fontSize: 12, color: 'var(--t2)' }}>{children}</h2>
      {action}
    </div>
  );
}

/* ── DateChips — Today / Week / Month presets + date readout ── */
export function DateChips({ value = 'today', onChange, dateLabel }) {
  const opts = [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month']];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 11px',
        color: 'var(--t2)' }}>
        <Icon name="clock" size={14} />
        <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)' }}>{dateLabel || istToday()}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
        {opts.map(([k, l]) => (
          <button key={k} onClick={() => onChange && onChange(k)} style={{ border: 'none', cursor: 'pointer', borderRadius: 'var(--r-xs)',
            padding: '5px 11px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            background: value === k ? 'var(--yellow)' : 'transparent',
            color: value === k ? '#1a1a1a' : 'var(--t3)' }}>{l}</button>
        ))}
      </div>
    </div>
  );
}

/* ── FilterChip — pill filter with count + active state ─────── */
export function FilterChip({ active, onClick, dot, children, count }) {
  return (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
      background: active ? 'var(--surface-3)' : 'transparent', color: active ? 'var(--t1)' : 'var(--t3)',
      border: `1px solid ${active ? 'var(--border-3)' : 'var(--border)'}`, borderRadius: 'var(--r-full)',
      padding: '4px 11px', fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot }} />}
      {children}
      {count != null && <span className="num" style={{ opacity: 0.7 }}>{count}</span>}
    </button>
  );
}

/* ── Tone badge — semantic pill (StatusBadge equivalent) ────── */
const TONES = {
  ok:    { fg: 'var(--ok-fg)',    bg: 'var(--ok-bg)',    bd: 'var(--ok-bd)' },
  warn:  { fg: 'var(--warn-fg)',  bg: 'var(--warn-bg)',  bd: 'var(--warn-bd)' },
  bad:   { fg: 'var(--bad-fg)',   bg: 'var(--bad-bg)',   bd: 'var(--bad-bd)' },
  info:  { fg: 'var(--info-fg)',  bg: 'var(--info-bg)',  bd: 'var(--info-bd)' },
  brand: { fg: 'var(--brand-fg)', bg: 'var(--brand-bg)', bd: 'var(--brand-bd)' },
  mute:  { fg: 'var(--t2)',       bg: 'var(--surface-2)', bd: 'var(--border-2)' },
};
export function ToneBadge({ tone = 'mute', children, style }) {
  const t = TONES[tone] || TONES.mute;
  return (
    <span className="label" style={{ fontSize: 10, color: t.fg, background: t.bg,
      border: `1px solid ${t.bd}`, borderRadius: 3, padding: '2px 7px', whiteSpace: 'nowrap', ...style }}>
      {children}
    </span>
  );
}

/* ── Button styles (shared inline-style objects) ────────────── */
export const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  background: 'var(--yellow)', color: '#1a1a1a', border: 'none',
  borderRadius: 'var(--r-sm)', padding: '8px 14px', fontFamily: 'var(--font-display)',
  fontWeight: 700, fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer',
};
export const btnGhost = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border-2)',
  borderRadius: 'var(--r-sm)', padding: '8px 13px', fontFamily: 'var(--font-ui)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
export const inputStyle = {
  background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
  padding: '9px 11px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 14,
  outline: 'none', width: '100%',
};

/* ── Drawer — right-hand drill-down surface ─────────────────── */
export function Drawer({ open, onClose, width = 430, children }) {
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 40 }} />
      <aside style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width, zIndex: 41,
        background: 'var(--surface)', borderLeft: '1px solid var(--border-2)', boxShadow: 'var(--shadow-pop)',
        display: 'flex', flexDirection: 'column', animation: 'rl-drawer-in 220ms var(--ease)' }}>
        {children}
      </aside>
    </>
  );
}
