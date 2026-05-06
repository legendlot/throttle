'use client';

/**
 * Redline system icon — 5-bar signal pattern: 3 yellow + 2 red.
 * Matches legacy 03_dashboard/index.html lines 121–139.
 *
 * Heights: 6, 8, 12, 14, 10 (px when size=2 baseline). Scales by `bar` width.
 * Props:
 *   bar — bar width in px (default 2). Heights scale relative.
 *   gap — gap between bars in px (default 2).
 */
export function RedlineIcon({ bar = 2, gap = 2 }) {
  const heights = [6, 8, 12, 14, 10];
  const colors  = ['#F2CD1A', '#F2CD1A', '#F2CD1A', '#DE2A2A', '#DE2A2A'];
  const scale = bar / 2;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap, flexShrink: 0 }}>
      {heights.map((h, i) => (
        <span key={i} style={{
          width: bar,
          height: h * scale,
          background: colors[i],
          borderRadius: 1,
          display: 'inline-block',
        }} />
      ))}
    </span>
  );
}
