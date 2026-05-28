'use client';
import { useEffect, useState, useCallback } from 'react';

/**
 * Close a raw <div> overlay modal on Escape. The shared <Modal> component
 * already handles this internally; this hook is for the older raw-overlay
 * modals that bypass <Modal> (corrections Void/Amend, dispatch-shipments
 * Create/Edit, audit modals, etc.).
 *
 * Usage:
 *   useEscapeClose(open, onClose);
 */
export function useEscapeClose(open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    function handle(e) {
      if (e.key === 'Escape') onClose?.();
    }
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [open, onClose]);
}

/**
 * Global "/" keybind — focus the primary search input on the active page.
 * The target input is identified by the `data-search-primary` attribute.
 * Mirrors GitHub / Linear / Vercel patterns.
 *
 * Does nothing when the user is already typing in an input / textarea /
 * contenteditable, when a modifier key is held, or when no element on the
 * page carries the data-search-primary marker.
 *
 * Mount once at the (auth) layout level.
 */
export function useSearchShortcut() {
  useEffect(() => {
    function handle(e) {
      if (e.key !== '/') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      if (ae) {
        const tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (ae.isContentEditable) return;
      }
      const target = document.querySelector('[data-search-primary]');
      if (!target) return;
      e.preventDefault();
      try { target.focus(); target.select?.(); } catch { /* ignore */ }
    }
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, []);
}

/**
 * Keyboard navigation for list tables: ↑/↓ moves a "focused row" index,
 * Enter calls onActivate(index). Does nothing while the user is typing
 * in an input/textarea/contenteditable (so search + filters keep working).
 *
 * Usage:
 *   const { focusedIdx, setFocusedIdx } = useListNav(items.length, (i) => router.push(...));
 *   // In each row: style={{ outline: focusedIdx===i ? '2px solid var(--accent)' : 'none' }} onClick={() => setFocusedIdx(i)}
 *
 * Resets to 0 whenever the item count changes (filter applied, new page loaded).
 */
export function useListNav(itemCount, onActivate) {
  const [focusedIdx, setFocusedIdx] = useState(0);

  useEffect(() => {
    // Clamp / reset when the list shrinks or grows.
    setFocusedIdx(prev => {
      if (itemCount === 0) return 0;
      if (prev >= itemCount) return itemCount - 1;
      return prev;
    });
  }, [itemCount]);

  const activate = useCallback(() => {
    if (itemCount === 0) return;
    onActivate?.(focusedIdx);
  }, [focusedIdx, itemCount, onActivate]);

  useEffect(() => {
    function isTypingTarget(e) {
      const ae = document.activeElement;
      if (!ae) return false;
      const tag = ae.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (ae.isContentEditable) return true;
      return false;
    }
    function handle(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e)) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx(i => (itemCount === 0 ? 0 : Math.min(itemCount - 1, i + 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx(i => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        if (itemCount === 0) return;
        e.preventDefault();
        activate();
      }
    }
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [itemCount, activate]);

  return { focusedIdx, setFocusedIdx };
}
