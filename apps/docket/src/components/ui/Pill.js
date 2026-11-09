// 20px pill: neutral, or status-tinted (bg = color at 16% alpha, fg = color).
import { cx, renderIcon } from './util.js';

export function Pill({ tone = 'neutral', color, dot = false, icon, className, style, children, ...rest }) {
  const tinted = tone === 'status' && color;
  const st = tinted ? { background: `color-mix(in srgb, ${color} 16%, transparent)`, color, ...style } : style;
  return (
    <span className={cx('ui-pill', `ui-pill-${tone}`, !dot && !icon && 'no-lead', className)} style={st} {...rest}>
      {dot && <span className="ui-pill-dot" style={{ background: color || 'currentColor' }} />}
      {!dot && renderIcon(icon, 12)}
      {children}
    </span>
  );
}
