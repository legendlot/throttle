'use client';

// Table card: a Card with overflow-x auto and a min-width inner grid. `columns` is a CSS
// grid-template-columns string shared by the header and every Row; `head` is an array of header
// cells (strings or { label, align }). Rows are CSS grids (animatable, clean hover).
export function TableCard({ columns, head, minWidth = 720, children, style }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
      overflowX: 'auto', minWidth: 0, ...style,
    }}>
      <div style={{ minWidth }}>
        {head && (
          <div style={{
            display: 'grid', gridTemplateColumns: columns, gap: 12, alignItems: 'center',
            padding: '12px 18px', borderBottom: '1px solid var(--border)',
            fontSize: 12, fontWeight: 600, color: 'var(--text-4)',
          }}>
            {head.map((h, i) => {
              const c = h && typeof h === 'object' ? h : { label: h };
              return <div key={i} style={{ textAlign: c.align || 'left', minWidth: 0 }}>{c.label}</div>;
            })}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// Body row: 10–11px 18px padding, top divider, hover --surface-hover; the whole row is clickable.
// `focused` draws the useListNav focus ring (2px #FF6B00, offset -2, radius 12). `first` drops the
// divider when there is no header. `index` staggers the igSlide entrance (+40ms, capped at 12 rows).
export function Row({ columns, onClick, focused = false, first = false, index, animate = false, children, style, ...rest }) {
  const delay = animate && index != null ? `${200 + Math.min(index, 12) * 40}ms` : undefined;
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? -1 : undefined}
      onClick={onClick}
      className={`ig-row${focused ? ' ig-row-focus' : ''}${animate ? ' ig-slide' : ''}`}
      style={{
        display: 'grid', gridTemplateColumns: columns, gap: 12, alignItems: 'center',
        padding: '11px 18px', borderTop: first ? 'none' : '1px solid var(--row-divider)',
        fontSize: 14, cursor: onClick ? 'pointer' : undefined, animationDelay: delay, ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

// Right-aligned mono numeric cell.
export function NumCell({ children, color, style }) {
  return (
    <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 13, color: color || 'var(--text-1)', minWidth: 0, ...style }}>
      {children}
    </div>
  );
}

export default TableCard;
