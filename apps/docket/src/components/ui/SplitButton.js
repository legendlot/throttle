'use client';
// Button + attached chevron segment (ClickUp "+ Task"): radius only on the
// outer corners.
import { ChevronDown } from 'lucide-react';
import { Button } from './Button.js';
import { cx } from './util.js';

export function SplitButton({ variant = 'primary', size = 'md', icon, children, onMain, onMenu, menuLabel = 'More options', menuRef, disabled, className, ...rest }) {
  return (
    <span className={cx('ui-split', className)} {...rest}>
      <Button variant={variant} size={size} icon={icon} onClick={onMain} disabled={disabled} className="ui-split-main">{children}</Button>
      <Button ref={menuRef} variant={variant} size={size} icon={ChevronDown} onClick={onMenu} disabled={disabled}
        aria-label={menuLabel} aria-haspopup="menu" className="ui-split-menu" />
    </span>
  );
}
