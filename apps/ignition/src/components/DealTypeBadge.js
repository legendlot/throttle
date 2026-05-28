'use client';
import { DEAL_TYPE_LABELS, DEAL_TYPE_PALETTE } from '../lib/dealTypes.js';

export default function DealTypeBadge({ dealType }) {
  if (!dealType) return null;
  const p = DEAL_TYPE_PALETTE[dealType] || { fg: 'var(--text-2)', bg: 'var(--surface-2)' };
  return (
    <span style={{
      display: 'inline-flex',
      padding: '2px 8px',
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: p.fg,
      background: p.bg,
      border: '1px solid currentColor',
      borderRadius: 'var(--radius-sm)',
    }}>
      {DEAL_TYPE_LABELS[dealType] || dealType}
    </span>
  );
}
