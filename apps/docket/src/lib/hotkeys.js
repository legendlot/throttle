'use client';
import { useEffect, useRef } from 'react';

// Bare single-key shortcut with the same input-guard as @throttle/ui useSearchShortcut:
// ignores modifier combos and any keystroke while focus is in a field / contentEditable,
// so it never fires mid-typing. `key` is matched against e.key (case-sensitive — a bare
// lowercase key won't fire while Shift is held, since e.key would be uppercase).
// Pass { enabled:false } to suspend it (e.g. while a modal/drawer covers the page).
export function useHotkey(key, handler, { enabled = true } = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e) {
      if (e.key !== key) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      if (ae) {
        const tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (ae.isContentEditable) return;
      }
      ref.current?.(e);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, enabled]);
}
