'use client';

/**
 * ProductTag — a per-product coloured dot + name (vehicle characters).
 * Added for the Garage redesign (S128). Colour is keyed by product name to the
 * --p-* accent tokens (Garage globals.css); unknown products fall back to --t3.
 *
 * Props:
 *   name  — product display name (e.g. "FLARE", "NIGHT WOLF").
 *   style — merged into the wrapper.
 */
const PRODUCT_COLORS = {
  FLARE: 'var(--p-flare)', 'NIGHT WOLF': 'var(--p-wolf)', GHOST: 'var(--p-ghost)',
  IRIS: 'var(--p-iris)', TITAN: 'var(--p-titan)', SHADOW: 'var(--p-shadow)',
  KNOX: 'var(--p-knox)', 'MC CLOUD': 'var(--blue-bright)', BUMBLE: 'var(--brand-orange)',
};

export function ProductTag({ name, style }) {
  if (!name) return <span style={{ color: 'var(--t4)', fontSize: 12, ...style }}>Common</span>;
  const c = PRODUCT_COLORS[String(name).toUpperCase()] || 'var(--t3)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--t2)', textTransform: 'uppercase', whiteSpace: 'nowrap', ...style }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: c, flexShrink: 0 }} />{name}
    </span>
  );
}
