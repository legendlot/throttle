'use client';
// Menu panel on ui/Popover: 28px items, ↑/↓ move, Enter activates, Esc closes
// (and returns focus to the anchor). Items close the menu unless `keepOpen`.
import { createContext, useContext, useEffect, useRef } from 'react';
import { Popover } from './Popover.js';
import { Kbd } from './Kbd.js';
import { cx, renderIcon } from './util.js';

const MenuCtx = createContext({ close: () => {} });
const ITEM = '[role="menuitem"]:not([disabled])';

export function Menu({ anchorRef, open, onClose, align, width = 200, label, className, children, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => ref.current?.querySelector(ITEM)?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  function onKey(e) {
    const items = Array.from(ref.current?.querySelectorAll(ITEM) || []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') { onClose?.(); }
  }

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} align={align} width={width} className={cx('ui-menu', className)} {...rest}>
      <div ref={ref} role="menu" aria-label={label} onKeyDown={onKey}>
        <MenuCtx.Provider value={{ close: () => onClose?.() }}>{children}</MenuCtx.Provider>
      </div>
    </Popover>
  );
}

export function MenuItem({ icon, shortcut, danger = false, selected = false, keepOpen = false, onClick, disabled, className, children, ...rest }) {
  const { close } = useContext(MenuCtx);
  return (
    <button type="button" role="menuitem" disabled={disabled} tabIndex={-1}
      className={cx('ui-menu-item', danger && 'is-danger', selected && 'is-selected', className)}
      onClick={e => { onClick?.(e); if (!keepOpen && !e.defaultPrevented) close(); }} {...rest}>
      {icon && <span className="ui-menu-ic">{renderIcon(icon, 14)}</span>}
      <span className="ui-menu-text">{children}</span>
      {shortcut != null && <Kbd className="ui-menu-kbd">{shortcut}</Kbd>}
    </button>
  );
}

export function MenuSeparator({ className, ...rest }) {
  return <div role="separator" className={cx('ui-menu-sep', className)} {...rest} />;
}

export function MenuLabel({ className, children, ...rest }) {
  return <div className={cx('ui-menu-label', className)} {...rest}>{children}</div>;
}
