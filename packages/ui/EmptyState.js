'use client';
import { createElement, isValidElement } from 'react';

// icon may be: an emoji/text string ('📊', '⚠'), the literal 'search' (→ ⌕),
// a JSX element (<SomeIcon />), or a component reference (e.g. a Lucide icon,
// which is a forwardRef object). Rendering a component reference directly as a
// child throws React error #31 — so instantiate it, mirroring Sidebar.renderIcon.
function renderIcon(icon) {
  if (!icon) return null;
  if (icon === 'search') return '⌕';
  if (typeof icon === 'string') return icon;
  if (isValidElement(icon)) return icon;
  return createElement(icon, { size: 28, strokeWidth: 1.5 });
}

export function EmptyState({ message, icon, title }) {
  const renderedIcon = renderIcon(icon);
  return (
    <div style={{
      textAlign: 'center', color: '#666', padding: '32px 16px',
      fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)', fontSize: 13,
    }}>
      {renderedIcon != null && <div style={{ fontSize: 28, marginBottom: 8 }}>{renderedIcon}</div>}
      {title && <div style={{ color: 'var(--t2, #b0b0b0)', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</div>}
      <div>{message}</div>
    </div>
  );
}
