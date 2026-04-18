'use client';

const COLORS = {
  red:    '#ef4444',
  orange: '#f97316',
  green:  '#22c55e',
  blue:   '#3b82f6',
};

export function Badge({ count, color = 'red' }) {
  if (!count) return null;
  return (
    <span
      style={{
        display: 'inline-block',
        background: COLORS[color] || color,
        color: '#fff',
        borderRadius: 10,
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 6px',
        minWidth: 16,
        textAlign: 'center',
        marginLeft: 6,
      }}
    >
      {count}
    </span>
  );
}
