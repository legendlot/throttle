'use client';
import { STAGE_LABELS, STAGE_PALETTE } from '../lib/stages.js';

export default function StageBadge({ stage, size = 'sm' }) {
  if (!stage) return null;
  const label = STAGE_LABELS[stage] || stage;
  const palette = STAGE_PALETTE[stage] || { fg: 'var(--text-2)', bg: 'var(--surface-2)' };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: size === 'lg' ? '4px 10px' : '2px 8px',
      fontSize: size === 'lg' ? 12 : 11,
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: palette.fg,
      background: palette.bg,
      border: '1px solid currentColor',
      borderRadius: 'var(--radius-sm)',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}
