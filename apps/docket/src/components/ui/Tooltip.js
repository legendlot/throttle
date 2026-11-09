'use client';
// Hover/focus tooltip (400ms delay), portalled + `fixed` so overflow-clipping
// ancestors can't cut it. Optional `shortcut` renders as Kbd chips.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from './Kbd.js';
import { cx } from './util.js';

export function Tooltip({ content, shortcut, side = 'top', delay = 400, children, className, ...rest }) {
  const ref = useRef(null);
  const timer = useRef(null);
  const [pos, setPos] = useState(null);

  function show() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ x: r.left + r.width / 2, y: side === 'bottom' ? r.bottom + 6 : r.top - 6 });
    }, delay);
  }
  function hide() { clearTimeout(timer.current); setPos(null); }
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!content && !shortcut) return children;
  const keys = shortcut == null ? [] : (Array.isArray(shortcut) ? shortcut : [shortcut]);
  return (
    <span ref={ref} className={cx('ui-tip-host', className)} {...rest}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onMouseDown={hide}>
      {children}
      {pos && typeof document !== 'undefined' && createPortal(
        <span role="tooltip" className={cx('ui-tip', side === 'bottom' && 'below')} style={{ left: pos.x, top: pos.y }}>
          {content}
          {keys.length > 0 && <span className="ui-tip-keys">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>}
        </span>,
        document.body,
      )}
    </span>
  );
}
