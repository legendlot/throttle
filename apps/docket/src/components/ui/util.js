// Small helpers shared by the ui/ kit (ClickUp redesign P0).
import { createElement, isValidElement } from 'react';

export function cx(...parts) { return parts.filter(Boolean).join(' '); }

// `icon` may be a lucide component (Plus) or an element (<Plus size={12} />).
export function renderIcon(icon, size = 14) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  return createElement(icon, { size, strokeWidth: 2, 'aria-hidden': true });
}
