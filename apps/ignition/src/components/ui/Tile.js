'use client';

// KPI tile: radius 16, padding 14px 16px. Label 13/600 --text-3, value mono (24 list / 22 detail /
// 28 dashboard via `size`), hint 12px --text-4. `color` tints the value; `right` sits beside the
// label (a % or delta). `hover` lifts 2px.
export function Tile({ label, value, hint, color, size = 24, right, hover = false, onClick, style, children }) {
  return (
    <div
      className={hover || onClick ? 'ig-card-hover' : undefined}
      onClick={onClick}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-tile)',
        padding: '14px 16px', minWidth: 0, cursor: onClick ? 'pointer' : undefined, ...style,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>{label}</span>
        {right}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: size, fontWeight: 700, marginTop: 4,
        color: color || 'var(--text-1)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
      {hint != null && <div style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 4 }}>{hint}</div>}
      {children}
    </div>
  );
}

export default Tile;
