'use client';

/**
 * Garage system icon — stylised storage shelves / barcode in yellow.
 * Matches legacy 04_stores/index.html lines 957–964 (login) and 1006–1011 (topbar).
 *
 * Props:
 *   size       — px (default 20). The viewBox is 0 0 40 32; rendered preserving aspect.
 *   showDot    — render the small bottom-centre dot (login variant). Default false.
 *   strokeWidth — outline stroke. Default 2 (login) — pass 2.5 for sharper small renders.
 */
export function GarageIcon({ size = 20, showDot = false, strokeWidth = 2, color = '#F2CD1A' }) {
  const w = size;
  const h = Math.round(size * 32 / 40);
  return (
    <svg
      width={w} height={h} viewBox="0 0 40 32"
      fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <rect x="2" y="2" width="36" height="26" rx="2" stroke={color} strokeWidth={strokeWidth} />
      <line x1="2" y1="10" x2="38" y2="10" stroke={color} strokeWidth="1.5" opacity="0.5" />
      <line x1="2" y1="17" x2="38" y2="17" stroke={color} strokeWidth="1.5" opacity="0.5" />
      <line x1="2" y1="23" x2="38" y2="23" stroke={color} strokeWidth="1.5" opacity="0.5" />
      {showDot && <circle cx="20" cy="28" r="1.5" fill={color} opacity="0.5" />}
    </svg>
  );
}
