// Overlapping avatars (−6px) with a +N overflow chip; wraps primitives.js Avatar.
import { Avatar } from '../primitives.js';
import { cx } from './util.js';

export function AvatarStack({ names = [], max = 3, size = 22, className, ...rest }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className={cx('ui-avstack', className)} {...rest}>
      {shown.map((n, i) => (
        <span key={`${n}-${i}`} className="ui-avstack-item" style={{ marginLeft: i ? -6 : 0, zIndex: max - i }}>
          <Avatar name={n} size={size} ring />
        </span>
      ))}
      {extra > 0 && (
        <span className="ui-avstack-more" title={names.slice(max).join(', ')}
          style={{ width: size, height: size, fontSize: Math.round(size * 0.42), marginLeft: -6 }}>+{extra}</span>
      )}
    </span>
  );
}
