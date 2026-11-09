'use client';
// Button: primary (yellow — create actions only, D5) · neutral · ghost · danger;
// sm 24 / md 28 / lg 32.
import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cx, renderIcon } from './util.js';

const ICON = { sm: 13, md: 14, lg: 16 };

export const Button = forwardRef(function Button(
  { variant = 'neutral', size = 'md', icon, iconRight, loading = false, disabled, type = 'button', className, children, ...rest },
  ref,
) {
  const s = ICON[size] || 14;
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx('ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`, !children && 'ui-btn-icon-only', className)} {...rest}>
      {loading ? <Loader2 size={s} className="ui-spin" aria-hidden /> : renderIcon(icon, s)}
      {children != null && children !== false && <span className="ui-btn-label">{children}</span>}
      {renderIcon(iconRight, s)}
    </button>
  );
});
