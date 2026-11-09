'use client';
import { requestStatus } from '../lib/commission.js';

// The commission payment status pill (Reann #3) — the Commission page and the deal's Commission card
// read a statement's request the same way. Same pill shape as the Payments card's StateBadge.
export function CommissionBadge({ statement }) {
  const { label, tone } = requestStatus(statement);
  return <Pill label={label} tone={tone} />;
}

export function Pill({ label, tone = 'neutral' }) {
  const fg = tone === 'neutral' ? 'var(--text-3)' : `var(--state-${tone}-fg)`;
  const bg = tone === 'neutral' ? 'var(--chip-neutral)' : `var(--state-${tone}-bg)`;
  return <span style={{ display: 'inline-flex', padding: '2px 9px', borderRadius: 99, fontSize: 12, fontWeight: 600, color: fg, background: bg, whiteSpace: 'nowrap' }}>{label}</span>;
}
