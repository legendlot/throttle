'use client';
import { DISPOSITION_LABELS, DISPOSITION_PALETTE } from '../lib/dispositions.js';

/**
 * DispositionBadge — Volt (handoff §5).
 * Tomorrow 9.5px UPPERCASE, *-fg on *-bg with 1px *-bd, radius 5px.
 *
 * Props:
 *   disposition — string key (pending | query | no_action | awaiting_info | replacement | refund | repair)
 *   compact     — boolean. true → queue-table size (9.5px). false (default) → header size (11px).
 */
export function DispositionBadge({ disposition, compact = false }) {
  const p = DISPOSITION_PALETTE[disposition] || DISPOSITION_PALETTE.pending;
  const label = DISPOSITION_LABELS[disposition] || (disposition || 'pending');
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: compact ? '2px 8px' : '4px 11px',
      background: p.bg,
      color: p.fg,
      border: `1px solid ${p.border}`,
      borderRadius: compact ? 5 : 6,
      fontFamily: 'var(--f-display)',
      fontSize: compact ? 9.5 : 11,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}
