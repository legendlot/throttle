'use client';

/**
 * Pitstop system icon — 3 horizontal bars representing the 3 case branches.
 * Colors map to the type-badge palette used across queue + detail:
 *   replacement → state-info  (blue)
 *   refund      → state-warning-fg (amber)
 *   repair      → state-success-fg (green)
 *
 * Same visual rhythm as Redline's 5-bar mark (RedlineIcon) but laid horizontally
 * and shorter, suggesting a pit-board signal stack.
 *
 * Props:
 *   bar — bar HEIGHT in px (default 2). Widths scale relative.
 *   gap — gap between bars in px (default 2).
 */
export function PitstopIcon({ bar = 2, gap = 2 }) {
  const widths = [12, 14, 10];
  const colors = ['#7b93ff', '#fbbf24', '#4ade80'];
  const scale = bar / 2;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap, flexShrink: 0 }}>
      {widths.map((w, i) => (
        <span key={i} style={{
          height: bar,
          width: w * scale,
          background: colors[i],
          borderRadius: 1,
          display: 'inline-block',
        }} />
      ))}
    </span>
  );
}
