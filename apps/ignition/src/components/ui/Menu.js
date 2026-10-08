'use client';
import { useEffect, useRef } from 'react';

// Dropdown menu: --menu bg, --border-3, radius 14, padding 6, igPop 180ms, menu shadow.
// Positioned absolutely — wrap the trigger + <Menu> in a position:relative element.
// items: [{ label, onClick, icon?, danger?, disabled?, active? }]. Closes on outside mousedown,
// on Escape, and after an item is picked.
// `anchorRef`: the trigger element. A mousedown on it is NOT "outside" — otherwise the trigger's own
// toggle would reopen the menu the listener just closed (React's listener and this one share `document`).
export function Menu({ open, onClose, anchorRef, items = [], align = 'right', width = 220, style, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (anchorRef?.current?.contains(e.target)) return;
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    // deferred so the click that opened the menu does not immediately close it
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return (
    <div ref={ref} role="menu" className="ig-pop" style={{
      position: 'absolute', top: 'calc(100% + 8px)', [align === 'left' ? 'left' : 'right']: 0, zIndex: 400,
      width, padding: 6, background: 'var(--menu)', border: '1px solid var(--border-3)',
      borderRadius: 'var(--r-row)', boxShadow: 'var(--shadow-menu)', animationDuration: '180ms', ...style,
    }}>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          className="ig-menu-item"
          onClick={() => { it.onClick?.(); onClose?.(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
            padding: '10px 12px', borderRadius: 'var(--r-seg)', border: 'none', cursor: it.disabled ? 'not-allowed' : 'pointer',
            background: it.active ? 'var(--accent-bg-soft)' : 'transparent',
            color: it.danger ? 'var(--state-error-fg)' : it.active ? 'var(--accent)' : 'var(--text-1)',
            fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 500, opacity: it.disabled ? 0.5 : 1,
          }}
        >
          {it.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{it.icon}</span>}
          <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
        </button>
      ))}
      {children}
    </div>
  );
}

export default Menu;
