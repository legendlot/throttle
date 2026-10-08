'use client';
import { DEAL_TYPE_LABELS } from '../../lib/dealTypes.js';

// Outlined deal-type pill (radius 8, 3px 9px, 12/600). Labels from lib/dealTypes.js.
const DEAL_PILL = {
  paid:                { fg: '#F2CD1A', bd: 'rgba(242,205,26,.4)' },
  barter:              { fg: '#a9b0c2', bd: '#2b3142' },
  affiliate:           { fg: '#8ea2ff', bd: 'rgba(142,162,255,.4)' },
  paid_plus_affiliate: { fg: '#ff8a33', bd: 'rgba(255,138,51,.4)' },
};

export function DealPill({ type, style }) {
  if (!type) return null;
  const p = DEAL_PILL[type] || { fg: 'var(--text-2)', bd: 'var(--border-3)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      padding: '3px 9px', borderRadius: 'var(--r-deal)', border: `1px solid ${p.bd}`,
      fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: p.fg, ...style,
    }}>
      {DEAL_TYPE_LABELS[type] || type}
    </span>
  );
}

export default DealPill;
