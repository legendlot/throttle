'use client';
// Podium-local UI atoms for the "Pit Wall v2" reskin. Pixel-matched to
// Podium-Prototype.html. Pure presentation — no data fetching here.
import { Plus } from 'lucide-react';

// ── Avatar tint palette (mirrors --av1..6 in globals; index → {bg,fg}) ──
export const AV_PAL = [
  { bg: 'rgba(242,205,26,0.16)', fg: '#F2CD1A' },
  { bg: 'rgba(109,131,255,0.20)', fg: '#9fb0ff' },
  { bg: 'rgba(74,222,128,0.16)', fg: '#4ade80' },
  { bg: 'rgba(249,115,22,0.18)', fg: '#fb923c' },
  { bg: 'rgba(251,191,36,0.16)', fg: '#fbbf24' },
  { bg: 'rgba(255,138,138,0.16)', fg: '#ff8a8a' },
];

// Stable hash → palette index, so a given person always keeps the same tint
// regardless of list position (handoff §3.6 "stable index hash").
export function avatarTint(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AV_PAL[h % AV_PAL.length];
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

// Rounded-square initials tile. `tintKey` defaults to the name so the colour is stable.
export function Avatar({ name, photoUrl, size = 34, tintKey, radius }) {
  const t = avatarTint(tintKey ?? name);
  const r = radius ?? (size >= 40 ? 11 : size >= 30 ? 9 : 7);
  const fs = Math.max(10, Math.round(size * 0.36));
  if (photoUrl) {
    return (
      <span style={{ width: size, height: size, borderRadius: r, overflow: 'hidden', flex: 'none', display: 'inline-flex' }}>
        <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    );
  }
  return (
    <span style={{
      width: size, height: size, borderRadius: r, background: t.bg, color: t.fg,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: fs, flex: 'none',
    }}>{initials(name)}</span>
  );
}

// ── Page title (Tomorrow uppercase). Most screens now get the title from the
//    topbar, but pages that want an inline H1 use this. ──
export const pageTitle = {
  fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700,
  letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t1)',
};

// ── Buttons ──
export const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1b1b1e',
  border: 'none', borderRadius: 'var(--r-sm)', padding: '7px 13px', fontFamily: 'var(--font-display)',
  fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
export const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface)', color: 'var(--t2)',
  border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 13px', fontFamily: 'var(--font-display)',
  fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
export const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
  background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)', cursor: 'pointer',
};

// New / create button — orange action cue (matches the "New Person" nav accent).
export function PrimaryButton({ icon: Ic = Plus, children, onClick, style, ...rest }) {
  return (
    <button onClick={onClick} style={{ ...btnPrimary, ...style }} {...rest}>
      {Ic && <Ic size={14} strokeWidth={2.2} />}{children}
    </button>
  );
}

// ── Cards / panels ──
export const card = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)', padding: '15px 17px',
};
export const cardLabel = {
  fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 12,
};

// ── KPI tile (eyebrow + mono value + sub; optional 3px yellow tone stripe) ──
export function KpiTile({ label, value, sub, subColor = 'var(--t4)', stripe = false }) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: 150, background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 11, padding: '13px 16px', position: 'relative', overflow: 'hidden',
    }}>
      {stripe && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: 'var(--yellow)' }} />}
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t4)' }}>{label}</div>
      <div className="num" style={{ fontSize: 25, fontWeight: 600, color: 'var(--t1)', marginTop: 3 }}>{value}</div>
      {sub != null && sub !== '' && <div style={{ fontSize: 11, color: subColor, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Filter chip (Tomorrow uppercase; active = yellow bg + dark text) ──
export function FilterChip({ active, onClick, children }) {
  return (
    <span onClick={onClick} style={{
      fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: active ? 700 : 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', padding: '6px 13px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
      background: active ? 'var(--yellow)' : 'var(--surface)', color: active ? '#1b1b1e' : 'var(--t2)',
      border: active ? '1px solid var(--yellow)' : '1px solid var(--border)', userSelect: 'none',
    }}>{children}</span>
  );
}

// ── Grid table primitives (CSS grid rows, not <table>) ──
// `cols` = a grid-template-columns string. Header cells + rows share it.
export function GridTable({ cols, children }) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
      {children}
    </div>
  );
}
export function GridHead({ cols, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', background: 'var(--bg-2)', borderBottom: '1px solid var(--divider)' }}>
      {children}
    </div>
  );
}
export const gridTh = {
  fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: 'var(--t4)', padding: '12px 16px',
};
export function GridRow({ cols, onClick, onMouseEnter, focused, children, hover = true }) {
  return (
    <div onClick={onClick} onMouseEnter={onMouseEnter}
      className={hover && !focused ? 'pd-grid-row' : undefined}
      style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', borderTop: '1px solid var(--hairline)', cursor: onClick ? 'pointer' : 'default', background: focused ? 'var(--surface)' : undefined }}>
      {children}
    </div>
  );
}

// ── Dark form input chrome (yellow focus ring) ──
export const formLabel = {
  fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: 'var(--t4)', marginBottom: 6,
};
export const formInput = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
  padding: '9px 11px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none',
};

// Department-style soft pill.
export function SoftPill({ children }) {
  return <span style={{ fontSize: 12, color: 'var(--t2)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '3px 10px', borderRadius: 'var(--r-full)' }}>{children}</span>;
}
