'use client';

/**
 * Ignition system icon — a stylized spark / lit-fuse.
 * Three short vertical bars with a flame-orange top step.
 * Same visual rhythm as PitstopIcon but rotated 90° and with a flame
 * accent — the "ignition" cue.
 *
 * Props:
 *   bar — bar HEIGHT in px (default 2).
 *   gap — gap between bars in px (default 2).
 */
export function IgnitionIcon({ bar = 2, gap = 2 }) {
  const heights = [6, 10, 14];
  const scale = bar / 2;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap, flexShrink: 0 }}>
      {heights.map((h, i) => (
        <span key={i} style={{
          width: bar,
          height: h * scale,
          background: i === 2 ? '#FF6B00' : i === 1 ? '#F2CD1A' : '#DE2A2A',
          borderRadius: 1,
          display: 'inline-block',
        }} />
      ))}
    </span>
  );
}
