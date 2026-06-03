'use client';
import { STATUS_MAP } from '../lib/tasks.js';

export function StatusBadge({ status }) {
  const s = STATUS_MAP[status] || { label: status, color: 'var(--text-3)', bg: 'var(--surface-3)' };
  return (
    <span style={{
      display: 'inline-block', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700,
      letterSpacing: '0.04em', textTransform: 'uppercase', color: s.color, background: s.bg,
      borderRadius: 'var(--radius-sm)', padding: '2px 8px', whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

export default StatusBadge;
