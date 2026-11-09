'use client';
// Square icon-only button (24/28/32), ghost by default. `label` is required:
// it is the aria-label and the tooltip text.
import { forwardRef } from 'react';
import { Tooltip } from './Tooltip.js';
import { cx, renderIcon } from './util.js';

const ICON = { sm: 14, md: 16, lg: 18 };

export const IconButton = forwardRef(function IconButton(
  { icon, label, shortcut, variant = 'ghost', size = 'md', active = false, disabled, type = 'button', tooltip = true, className, ...rest },
  ref,
) {
  const btn = (
    <button ref={ref} type={type} aria-label={label} disabled={disabled} aria-pressed={active || undefined}
      className={cx('ui-btn', 'ui-iconbtn', `ui-btn-${variant}`, `ui-btn-${size}`, active && 'is-active', className)} {...rest}>
      {renderIcon(icon, ICON[size] || 16)}
    </button>
  );
  return tooltip ? <Tooltip content={label} shortcut={shortcut}>{btn}</Tooltip> : btn;
});
