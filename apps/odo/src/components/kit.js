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

export function Kpi({ lbl, val, sub, now, prev, tone }) {
  return (
    <div className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="so-kpi-lbl">{lbl}</div>
        <Delta now={now} prev={prev} tone={tone} />
      </div>
      <span className="so-kpi-val">{val}</span>
      {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{sub}</div>}
    </div>
  );
}
