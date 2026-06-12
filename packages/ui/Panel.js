'use client';
import { createElement, isValidElement } from 'react';

function renderIcon(icon, size) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === 'function') return createElement(icon, { size, strokeWidth: 1.75 });
  return null;
}

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
export function Panel({ header, title, headerAction, action, icon, compact, padding, children, style }) {
  // `title`/`action` are redesign-friendly aliases for `header`/`headerAction`.
  const head = header !== undefined ? header : title;
  const headAction = headerAction !== undefined ? headerAction : action;
  const bodyPad = padding !== undefined ? padding : (compact ? '12px 14px' : 16);

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 4,
      ...style,
    }}>
      {head && (
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, overflow: 'hidden', minWidth: 0 }}>
            {icon && <span style={{ color: 'var(--t3)', display: 'flex', flexShrink: 0 }}>{renderIcon(icon, 15)}</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{head}</span>
          </div>
          {headAction && (
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: '0.04em',
              textTransform: 'none',
              color: 'var(--t2)',
              flexShrink: 0,
            }}>
              {headAction}
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
