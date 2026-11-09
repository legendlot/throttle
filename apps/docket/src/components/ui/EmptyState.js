// Empty state: icon, title (14/600), body (13, --text-2), optional action.
import { cx, renderIcon } from './util.js';

export function EmptyState({ icon, title, children, body, action, className, ...rest }) {
  return (
    <div className={cx('ui-empty', className)} {...rest}>
      {icon && <span className="ui-empty-ic">{renderIcon(icon, 20)}</span>}
      {title && <div className="ui-empty-title">{title}</div>}
      {(body || children) && <div className="ui-empty-body">{body || children}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
