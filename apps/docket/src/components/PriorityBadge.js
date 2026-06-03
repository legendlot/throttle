'use client';
import { PRIORITY_MAP } from '../lib/tasks.js';

export function PriorityBadge({ priority }) {
  const p = PRIORITY_MAP[priority] || { short: priority, color: 'var(--text-3)', bg: 'var(--surface-2)' };
  return (
    <span title={p.label} style={{
      display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
      color: p.color, background: p.bg, border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '1px 6px', whiteSpace: 'nowrap',
    }}>{p.short}</span>
  );
}

export default PriorityBadge;
