// The faint icon an empty Owner / Deadline / Priority / Program cell shows;
// full strength on row (.row / .ui-ghost-host) or cell hover.
import { forwardRef } from 'react';
import { cx, renderIcon } from './util.js';

export const GhostCell = forwardRef(function GhostCell({ icon, label, size = 16, type = 'button', className, ...rest }, ref) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cx('ui-ghost', className)} {...rest}>
      {renderIcon(icon, size)}
    </button>
  );
});
