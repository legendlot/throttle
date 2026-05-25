'use client';
import { useEffect } from 'react';

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
