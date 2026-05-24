'use client';

/**
 * Panel — the canonical card / panel container.
 *
 * Replaces ~166 hand-rolled `<div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:4, padding:14 }}>`
 * inside Redline/Garage/Throttle pages. Per DESIGN.md "Cards / Panels".
 *
 * Usage:
 *   <Panel header="Customer Repairs">                content...           </Panel>
 *   <Panel header="..." headerAction={<Link>View all →</Link>}>  ...  </Panel>
 *   <Panel compact>  tight body, no header  </Panel>
 *   <Panel padding={0}>  custom inner layout — table fills edge-to-edge  </Panel>
 *
 * Props:
 *   header        — string or node. Renders the panel-header bar above the body.
 *   headerAction  — node. Right-aligned inside the header (link, button, etc.).
 *   compact       — boolean. Tighter body padding (12px 14px) for dense lists.
 *   padding       — overrides body padding entirely. `0` removes padding.
 *   style         — merged into outer div style.
 */
export function Panel({ header, headerAction, compact, padding, children, style }) {
  const bodyPad = padding !== undefined ? padding : (compact ? '12px 14px' : 16);

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 4,
      ...style,
    }}>
      {header && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--cond)',
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--t2)',
        }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {header}
          </div>
          {headerAction && (
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: '0.04em',
              textTransform: 'none',
              color: 'var(--t2)',
              flexShrink: 0,
            }}>
              {headerAction}
            </div>
          )}
        </div>
      )}
      <div style={{ padding: bodyPad }}>
        {children}
      </div>
    </div>
  );
}
