// Keyboard-shortcut chip: 16px tall, mono 11px.
import { cx } from './util.js';

export function Kbd({ children, className, ...rest }) {
  return <kbd className={cx('ui-kbd', className)} {...rest}>{children}</kbd>;
}
