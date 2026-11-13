'use client';

/**
 * Skeleton — a muted placeholder block with a subtle shimmer, shown where content is
 * still loading. Lay several out in the shape of the content they stand in for.
 * Decorative only (aria-hidden); the shimmer stops under prefers-reduced-motion.
 *
 * Relies on --surface-2 / --surface-3.
 */
const CSS = `
.throttle-skel{background:linear-gradient(90deg,var(--surface-2) 25%,var(--surface-3) 50%,var(--surface-2) 75%) !important;background-size:200% 100%;animation:throttle-skel 1.4s ease-in-out infinite}
@keyframes throttle-skel{from{background-position:100% 0}to{background-position:-100% 0}}
@media (prefers-reduced-motion: reduce){.throttle-skel{animation:none;background:var(--surface-2) !important}}
`;

// The keyframes go into <head> ONCE per page, not one <style> per instance.
const STYLE_ID = 'throttle-skel-style';
function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function Skeleton({ width = '100%', height = 14, radius = 6, style }) {
  ensureStyle();
  return (
    <span aria-hidden="true" className="throttle-skel" style={{
      // Inline background = the plain block before the stylesheet exists (static HTML,
      // pre-hydration); the class's !important shimmer takes over once it is injected.
      display: 'block', width, height, borderRadius: radius, flexShrink: 0,
      background: 'var(--surface-2)', ...style,
    }} />
  );
}
