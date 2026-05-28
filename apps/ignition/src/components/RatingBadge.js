'use client';

const PALETTE = {
  green:   { fg: '#4ade80', bg: 'rgba(34,197,94,0.12)',  label: 'Green' },
  yellow:  { fg: '#fbbf24', bg: 'rgba(251,191,36,0.12)', label: 'Yellow' },
  red:     { fg: '#ff7070', bg: 'rgba(222,42,42,0.15)',  label: 'Red' },
  unrated: { fg: 'var(--text-3)', bg: 'var(--surface-2)', label: '—' },
};

export default function RatingBadge({ rating = 'unrated' }) {
  const p = PALETTE[rating] || PALETTE.unrated;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: p.fg,
      background: p.bg,
      border: '1px solid currentColor',
      borderRadius: 'var(--radius-sm)',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: 'currentColor',
      }} />
      {p.label}
    </span>
  );
}
