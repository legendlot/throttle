'use client';

/**
 * Chip — filter pill with active state.
 *
 * Replaces inline `chip` / `chipActive` style objects scattered across pages
 * (customer-repairs/page.js:61, alerts, dispatch, etc.). Per DESIGN.md "Chips".
 *
 * Usage:
 *   <Chip active={stageF === ''}   onClick={() => setStageF('')}>All</Chip>
 *   <Chip active={stageF === 'open'} onClick={() => setStageF('open')}>Open</Chip>
 *   <Chip count={12}>Pending</Chip>     // shows a count alongside the label
 *
 * Props:
 *   active   — boolean. Yellow background, dark foreground.
 *   onClick  — click handler (renders as <button>).
 *   count    — optional number rendered right of the label.
 *   children — label content.
 *   style    — merged into the button style.
 */
export function Chip({ active, onClick, count, children, style, pill }) {
  const isInteractive = typeof onClick === 'function';
  const Tag = isInteractive ? 'button' : 'span';

  // `pill` = the redesign filter-chip look (rounded-full, Hanken, soft surface
  // active — no loud yellow fill). Default keeps the legacy rectangular chip so
  // existing pages across all apps are unchanged.
  const base = pill
    ? {
        gap: 6,
        background: active ? 'var(--surface-3)' : 'transparent',
        color: active ? 'var(--t1)' : 'var(--t3)',
        border: '1px solid ' + (active ? 'var(--border-3)' : 'var(--border)'),
        borderRadius: 'var(--r-full)',
        padding: '5px 11px',
        fontFamily: 'var(--font-ui)',
        fontSize: 12.5,
        fontWeight: 500,
        letterSpacing: 'normal',
        textTransform: 'none',
      }
    : {
        gap: 6,
        background: active ? 'var(--yellow)' : 'transparent',
        color: active ? '#0a0a0a' : 'var(--t2)',
        border: '1px solid ' + (active ? 'var(--yellow)' : 'var(--border)'),
        borderRadius: 3,
        padding: '5px 11px',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        fontWeight: active ? 700 : 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      };

  return (
    <Tag
      onClick={onClick}
      type={isInteractive ? 'button' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        cursor: isInteractive ? 'pointer' : 'default',
        transition: 'color 120ms, background 120ms, border-color 120ms',
        ...base,
        ...style,
      }}
    >
      <span>{children}</span>
      {count != null && (
        pill
          ? <span className="num" style={{ fontSize: 11, color: active ? 'var(--t2)' : 'var(--t4)' }}>{count}</span>
          : <span style={{ fontSize: 11, fontWeight: 700, opacity: active ? 0.85 : 0.75, letterSpacing: '0.04em' }}>{count}</span>
      )}
    </Tag>
  );
}
