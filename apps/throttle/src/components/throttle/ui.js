'use client';
/* Shared UI atoms — themed via CSS vars, ported from the prototype ui.jsx.
   Avatar/ProductTag are data-driven so live-data screens can pass display
   props directly (name/initial/accent) instead of seed ids. */
import React from 'react';
import { Icon } from './Icon';
import { productByCode, teamById, initialsOf } from '@/lib/throttleData';

export function Card({ children, style, pad = 16, hover, className = '', ...rest }) {
  return (
    <div className={'t-card' + (hover ? ' t-card-hover' : '') + (className ? ' ' + className : '')} style={{
      background: 'var(--card-bg)', border: '1px solid var(--card-bd)', borderRadius: 'var(--card-radius)',
      boxShadow: 'var(--card-shadow)', padding: pad, ...style }} {...rest}>
      {children}
    </div>
  );
}

export function SectionHead({ eyebrow, title, action, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, ...style }}>
      <div>
        {eyebrow && <div className="eyebrow" style={{ padding: 0, marginBottom: 5 }}>{eyebrow}</div>}
        <h2 className="t-h2" style={{ margin: 0 }}>{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function ProductTag({ code, accent, size = 'sm' }) {
  if (!code) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: size === 'sm' ? 11.5 : 12.5, color: 'var(--t3)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--t4)' }} />Brand
    </span>
  );
  const p = productByCode[code];
  const dot = accent || p?.accent || 'var(--t4)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: size === 'sm' ? 11.5 : 12.5, color: 'var(--t2)' }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: dot }} />
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: '0.04em' }}>{code}</span>
    </span>
  );
}

export function Avatar({ id, name, initial, size = 22 }) {
  const u = id ? teamById[id] : null;
  const label = name || u?.name || '';
  const ini = initial || u?.initial || initialsOf(label);
  if (!ini) return null;
  return (
    <span title={label || undefined} style={{ width: size, height: size, borderRadius: '50%', background: 'var(--yellow)', display: 'grid',
      placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: size * 0.42, color: '#15140b', flexShrink: 0 }}>
      {ini}
    </span>
  );
}

export const TONE = {
  ok:   { fg: 'var(--ok-fg)',   bg: 'var(--ok-bg)',   bd: 'var(--ok-bd)' },
  warn: { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', bd: 'var(--warn-bd)' },
  bad:  { fg: 'var(--bad-fg)',  bg: 'var(--bad-bg)',  bd: 'var(--bad-bd)' },
  info: { fg: 'var(--info-fg)', bg: 'var(--info-bg)', bd: 'var(--info-bd)' },
  brand:{ fg: 'var(--yellow)',  bg: 'var(--brand-bg)',bd: 'var(--brand-bd)' },
};

export function Pill({ tone = 'info', children, dot }) {
  const t = TONE[tone] || TONE.info;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999,
      background: t.bg, border: `1px solid ${t.bd}`, color: t.fg, fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-ui)' }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.fg }} />}
      {children}
    </span>
  );
}

export function PrimaryBtn({ children, icon, onClick, kind = 'primary', type = 'button', disabled }) {
  const styles = {
    primary:   { background: 'var(--yellow)', color: '#15140b', border: '1px solid var(--yellow)' },
    blue:      { background: 'var(--brand-blue)', color: '#fff', border: '1px solid var(--brand-blue)' },
    ghost:     { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border-2)' },
  };
  return (
    <button onClick={onClick} type={type} disabled={disabled} className="t-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', whiteSpace: 'nowrap',
      borderRadius: 'var(--r-sm)', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5,
      letterSpacing: '0.08em', textTransform: 'uppercase', opacity: disabled ? 0.6 : 1, ...styles[kind] }}>
      {icon && <Icon name={icon} size={15} />}{children}
    </button>
  );
}
