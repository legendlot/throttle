'use client';
import { createElement, isValidElement } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';

const COLOR_MAP = {
  yellow: '#F2CD1A',
  green:  '#22c55e',
  red:    '#DE2A2A',
  blue:   '#213CE2',
  orange: '#f97316',
};

const TONE_FG = {
  ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', bad: 'var(--bad-fg)',
  info: 'var(--info-fg)', brand: 'var(--brand-fg)',
};

function renderIcon(icon, size, color) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === 'function') return createElement(icon, { size, strokeWidth: 1.75, color });
  return null;
}

/**
 * KpiCard — two modes, chosen by props (backward compatible):
 *
 *  LEGACY (Redline, existing Garage): { label, value, sub, color }
 *    → 2px top colour stripe, mono, value always white. Unchanged.
 *
 *  REDESIGN (Garage S128): pass any of { eyebrow, tone, icon, trend, unit, onClick }
 *    → eyebrow (Tomorrow) + mono value, optional left tone stripe, trend chip,
 *      icon, and clickable hover. Per the redesign kit.
 */
export function KpiCard({ label, eyebrow, value, unit, sub, color, tone, icon, trend, onClick, style }) {
  const isRedesign = eyebrow != null || tone != null || icon != null || trend != null || unit != null || typeof onClick === 'function';

  if (!isRedesign) {
    const stripe = COLOR_MAP[color] || 'transparent';
    return (
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4,
        padding: 16, minWidth: 140, position: 'relative', overflow: 'hidden', fontFamily: 'var(--mono)', ...style,
      }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: stripe }} />
        <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8 }}>{label}</div>
        <div style={{ fontSize: 28, color: 'var(--t1)', lineHeight: 1, fontWeight: 600 }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>{sub}</div>}
      </div>
    );
  }

  const toneFg = tone ? (TONE_FG[tone] || null) : null;
  const Tag = typeof onClick === 'function' ? 'button' : 'div';
  return (
    <Tag onClick={onClick} style={{
      textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
      padding: '13px 15px', position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      boxShadow: 'var(--shadow-card)', transition: 'border-color var(--fast) var(--ease)',
      ...style,
    }}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.borderColor = 'var(--border-3)'; }}
      onMouseLeave={(e) => { if (onClick) e.currentTarget.style.borderColor = 'var(--border)'; }}>
      {toneFg && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: toneFg }} />}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <span className="eyebrow" style={{ lineHeight: 1.25 }}>{eyebrow || label}</span>
        {icon && <span style={{ color: toneFg || 'var(--t4)', display: 'flex', flexShrink: 0 }}>{renderIcon(icon, 15, undefined)}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span className="num" style={{ fontSize: 26, fontWeight: 600, color: 'var(--t1)', lineHeight: 1 }}>{value}</span>
        {unit && <span style={{ fontSize: 12, color: 'var(--t3)', fontFamily: 'var(--font-ui)' }}>{unit}</span>}
      </div>
      {(sub || trend != null) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t3)' }}>
          {trend != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: trend >= 0 ? 'var(--ok-fg)' : 'var(--bad-fg)', fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 11 }}>
              {trend >= 0 ? <ArrowUp size={12} strokeWidth={1.75} /> : <ArrowDown size={12} strokeWidth={1.75} />}{Math.abs(trend)}%
            </span>
          )}
          {sub && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
        </div>
      )}
    </Tag>
  );
}
