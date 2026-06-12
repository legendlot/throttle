'use client';

/**
 * ProgressBar — value-toward-target bar with an optional pace marker.
 * Added for the Garage redesign (S128) — shift dispatch vs target, flow funnels.
 *
 * Props:
 *   value   — current value.
 *   target  — target value (bar fills value/target, capped 100%).
 *   tone    — ok | warn | bad | info | brand (uses --<tone>-fg). Default ok.
 *   height  — px. Default 8.
 *   pace    — optional 0–100; draws a thin vertical "expected pace" marker.
 *
 * Relies on the semantic --<tone>-fg tokens + --surface-2 / --r-full / --t1.
 */
const TONE_FG = {
  ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', bad: 'var(--bad-fg)',
  info: 'var(--info-fg)', brand: 'var(--brand-fg)',
};

export function ProgressBar({ value, target, tone = 'ok', height = 8, pace }) {
  const t = Number(target) || 0;
  const pct = t > 0 ? Math.min(100, Math.round((Number(value) / t) * 100)) : 0;
  const fg = TONE_FG[tone] || TONE_FG.ok;
  return (
    <div style={{ position: 'relative', height, background: 'var(--surface-2)', borderRadius: 'var(--r-full)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, width: pct + '%', background: fg, opacity: 0.85, borderRadius: 'var(--r-full)', transition: 'width var(--base) var(--ease)' }} />
      {pace != null && (
        <div style={{ position: 'absolute', top: -2, bottom: -2, left: Math.min(100, pace) + '%', width: 2, background: 'var(--t1)', opacity: 0.55 }} />
      )}
    </div>
  );
}
