'use client';
// Shared dashboard primitives (KPI tile + period-over-period delta).
// Used by /performance and the Channels family pages.

// % delta vs prior period; tone: 'pos' colours up=green/down=red, 'neutral' = grey (cost metrics).
export function Delta({ now, prev, tone = 'pos' }) {
  if (prev == null || !isFinite(prev) || prev === 0) return null;
  const pct = (now - prev) / Math.abs(prev) * 100;
  const up = pct >= 0;
  const color = tone === 'neutral' ? 'var(--t3)' : (up ? 'var(--green)' : 'var(--red)');
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {up ? '↗' : '↘'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export function Kpi({ lbl, val, sub, now, prev, tone, badge }) {
  return (
    <div className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="so-kpi-lbl">{lbl}</div>
        <Delta now={now} prev={prev} tone={tone} />
      </div>
      <span className="so-kpi-val">{val}</span>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{sub}</div>}
      {badge}
    </div>
  );
}

// Settlement-confidence pill for the Net Revenue tile: how much of a period's GST is confirmed by
// marketplace settlement vs the live 18% estimate. ● ≥80% reconciled · ◐ 40–79% · ○ <40% (recent
// marketplace sales whose settlement hasn't posted yet). Net revenue itself is live regardless.
export function SettledBadge({ pct }) {
  if (pct == null) return null;
  const glyph = pct >= 80 ? '●' : pct >= 40 ? '◐' : '○';
  const color = pct >= 80 ? 'var(--green)' : pct >= 40 ? '#d9a441' : 'var(--t3)';
  return (
    <span
      title={`${pct}% of this period's GST is confirmed by marketplace settlement. The rest is estimated live at 18% and sharpens as settlement posts (marketplace events can lag the sale by up to ~4 weeks). Net revenue itself is live regardless.`}
      style={{ fontFamily: 'var(--mono)', fontSize: 11, color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {glyph} {pct}% settled
    </span>
  );
}
