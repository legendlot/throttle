'use client';

// Brand palette — reconciled with KpiCard.js + DESIGN.md.
// Previously red=#ef4444 and blue=#3b82f6 (Tailwind defaults), which conflicted
// with the LOT brand colors used everywhere else.
const COLORS = {
  red:    '#DE2A2A',
  orange: '#f97316',
  green:  '#22c55e',
  blue:   '#213CE2',
  yellow: '#F2CD1A',
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
