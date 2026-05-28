'use client';

const STYLES = {
  answered:    { bg: 'rgba(34,197,94,0.15)',  color: '#16a34a', label: 'Answered' },
  missed:      { bg: 'rgba(239,68,68,0.15)',  color: '#dc2626', label: 'Missed' },
  abandoned:   { bg: 'rgba(245,158,11,0.15)', color: '#d97706', label: 'Abandoned' },
  in_progress: { bg: 'rgba(99,102,241,0.15)', color: '#4f46e5', label: 'Live' },
};

export function CallStatusBadge({ status }) {
  const s = STYLES[status] || STYLES.abandoned;
  return (
    <span style={{
      display: 'inline-block',
      background: s.bg,
      color: s.color,
      padding: '2px 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.02em',
    }}>{s.label}</span>
  );
}
