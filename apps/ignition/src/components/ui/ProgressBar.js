'use client';

// Views: ≥100% green, ≥70% yellow, else orange.  Spend: >100% red, >85% yellow, else green.
// Budget (Campaigns): orange up to 85%, then yellow, then red past 100%.
export function viewsTone(pct)  { return pct >= 100 ? '#4ade80' : pct >= 70 ? '#fbbf24' : '#FF6B00'; }
export function spendTone(pct)  { return pct > 100 ? '#ff7b7b' : pct > 85 ? '#fbbf24' : '#22c55e'; }
export function budgetTone(pct) { return pct > 100 ? '#ff7b7b' : pct > 85 ? '#fbbf24' : '#FF6B00'; }

// Progress bar: --border-2 track, grows in with igGrowX. Pass `pct` (0–100+, clamped for width)
// or `value`/`max`. `color` defaults to the accent; `fuse` renders the animated in-progress stripe.
export function ProgressBar({ pct, value, max, color, height = 8, fuse = false, delay = 0, style }) {
  const p = pct != null ? Number(pct) : (max ? (Number(value) / Number(max)) * 100 : 0);
  const w = Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));
  return (
    <div style={{ height, background: 'var(--border-2)', borderRadius: height / 2, overflow: 'hidden', ...style }}>
      <div
        className={`ig-growx${fuse ? ' ig-fuse' : ''}`}
        style={{
          width: `${w}%`, height: '100%', borderRadius: height / 2,
          background: fuse ? undefined : (color || 'var(--accent)'),
          animationDuration: fuse ? undefined : '900ms', animationDelay: delay ? `${delay}ms` : undefined,
        }}
      />
    </div>
  );
}

export default ProgressBar;
