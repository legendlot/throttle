'use client';
import { DISPOSITION_LABELS, DISPOSITION_PALETTE } from '../lib/dispositions.js';

/**
 * DispositionBadge
 *
 * Props:
 *   disposition — string key (pending | query | no_action | awaiting_info | replacement | refund | repair)
 *   compact     — boolean. true → queue-table size (2px 8px / 10px). false (default) → header size (3px 10px / 11px).
 */
export function DispositionBadge({ disposition, compact = false }) {
  const p = DISPOSITION_PALETTE[disposition] || DISPOSITION_PALETTE.pending;
  const label = DISPOSITION_LABELS[disposition] || (disposition || 'pending');
  return (
    <span style={{
      display: 'inline-block',
      padding: compact ? '2px 8px' : '3px 10px',
      background: p.bg,
      color: p.fg,
      border: `1px solid ${p.border}`,
      borderRadius: 'var(--radius-sm)',
      fontFamily: 'var(--font-mono)',
      fontSize: compact ? 10 : 11,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    }}>{label}</span>
  );
}
