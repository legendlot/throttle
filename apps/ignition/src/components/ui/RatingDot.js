'use client';

export const RATING_COLORS = { green: '#4ade80', yellow: '#fbbf24', red: '#ff7b7b', unrated: '#5a6278' };
const LABELS = { green: 'Green', yellow: 'Yellow', red: 'Red', unrated: 'Unrated' };

// Rating dot (8–9px circle) + capitalised 13px --text-2 label. `showLabel={false}` = dot only.
export function RatingDot({ rating, showLabel = true, size = 8, style }) {
  const key = RATING_COLORS[rating] ? rating : 'unrated';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--text-2)', whiteSpace: 'nowrap', ...style }}>
      <span style={{ width: size, height: size, borderRadius: '50%', background: RATING_COLORS[key], flexShrink: 0,
        transition: 'background 300ms' }} />
      {showLabel && LABELS[key]}
    </span>
  );
}

export default RatingDot;
