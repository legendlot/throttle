'use client';

/**
 * Depot system icon — the "Shutter" mark (S1, red housing variant) from the
 * DEPOT brand kit. Red housing bar + yellow slats / jambs / floor on a 64×64
 * grid, sharp corners (crispEdges). Transparent ground so it sits on any surface.
 *
 * Props:
 *   size — rendered square size in px (default 22).
 */
export function DepotIcon({ size = 22 }) {
  const RED = '#DE2A2A';
  const YEL = '#F2CD1A';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      shapeRendering="crispEdges"
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <rect x="9"  y="10" width="46" height="8"  fill={RED} />
      <rect x="9"  y="21" width="46" height="5"  fill={YEL} />
      <rect x="9"  y="29" width="46" height="5"  fill={YEL} />
      <rect x="9"  y="37" width="46" height="5"  fill={YEL} />
      <rect x="9"  y="42" width="5"  height="10" fill={YEL} />
      <rect x="50" y="42" width="5"  height="10" fill={YEL} />
      <rect x="9"  y="52" width="46" height="4"  fill={YEL} />
    </svg>
  );
}
