'use client';
// ui-kit popover: portals to <body>, `fixed` against an anchor, flips above
// when there's no room below, clamps into the viewport, closes on outside
// click / Esc. Not AnchoredPopover (primitives.js): that one hard-codes the
// calendar's padding + height estimate and the legacy `.pop` class.
import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './util.js';

export function Popover({ anchorRef, open, onClose, align = 'left', width, offset = 4, className, style, children, ...rest }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    function place() {
      const a = anchorRef?.current; const el = ref.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const m = 8;
      const w = el ? el.offsetWidth : (width || 200);
      const h = el ? el.offsetHeight : 0;
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(m, Math.min(left, window.innerWidth - w - m));
      let top = r.bottom + offset;
      if (top + h > window.innerHeight - m && r.top - h - offset > m) top = r.top - h - offset;
      setPos({ top: Math.max(m, top), left });
    }
    place();
    const raf = requestAnimationFrame(place);       // re-place once the panel has a measured size
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, anchorRef, align, width, offset]);

  useEffect(() => {
    if (!open) return undefined;
    function down(e) {
      if (ref.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;
      onClose?.();
    }
    function key(e) { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); anchorRef?.current?.focus?.(); } }
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open, anchorRef, onClose]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} className={cx('ui-pop', className)} {...rest}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, visibility: pos ? 'visible' : 'hidden', ...style }}>
      {children}
    </div>,
    document.body,
  );
}
