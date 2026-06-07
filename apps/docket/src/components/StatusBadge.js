'use client';
import { STATUS_MAP } from '../lib/tasks.js';

// Status pill — colored dot + label in a rounded pill, tinted to the status.
// Pass `onClick` to make it the clickable trigger for a status menu.
export function StatusBadge({ status, onClick }) {
  const s = STATUS_MAP[status] || { label: status, color: 'var(--text-3)', bg: 'var(--surface-3)' };
  return (
    <span className="status" onClick={onClick} style={{ color: s.color, background: s.bg }}>
      <span className="si" style={{ background: s.color }} />{s.label}
    </span>
  );
}

export default StatusBadge;
