'use client';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// A list keeps its scroll position across "open a row → Back" (Nandeswari, #bugs
// 1791356178.730839: updating deals in sequence meant re-scrolling from the top every time).
// Filters already survive the trip (sessionStorage, see engagements/page.js FILTER_KEY); this is
// the scroll half, same storage and the same per-browser-tab scope as Snorkel's useSessionState.
//
// The position is saved ONLY when a row is opened (`remember()`), and taken back ONCE on the
// next mount of the list — so a fresh load, a deep link, or a list reached without opening a row
// from it starts at the top, and a later filter change never jumps. It is applied only when the
// caller says the rows have rendered (`ready`): the list re-fetches on every mount, and a scroll
// set over a spinner clamps to 0. Once `ready`, the saved position is applied AND dropped even when
// the list came back empty or the fetch failed, so it can never surface on a later filter change.
// A saved position older than MAX_AGE_MS is ignored: open a deal, wander off via the sidebar, come
// back to Deals an hour later → top of the list, not a stale offset.
//
// The scroller is found by walking up from `ref` to the nearest overflow-y:auto/scroll ancestor
// (`.ig-main` today) rather than named, so a new app shell does not break it.

const PREFIX = 'ignition.scroll.';
export const MAX_AGE_MS = 30 * 60 * 1000;

export function rememberScroll(storage, key, top, now = Date.now()) {
  try {
    storage.setItem(PREFIX + key, JSON.stringify({ top: Math.max(0, Math.round(Number(top) || 0)), at: now }));
  } catch { /* private mode */ }
}

/** Read and FORGET the saved position — null when there is none worth restoring (absent, zero,
 *  malformed, or older than MAX_AGE_MS). */
export function takeScroll(storage, key, now = Date.now()) {
  try {
    const raw = storage.getItem(PREFIX + key);
    if (raw == null) return null;
    storage.removeItem(PREFIX + key);
    const { top, at } = JSON.parse(raw) || {};
    const n = Number(top);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (!Number.isFinite(Number(at)) || now - Number(at) > MAX_AGE_MS) return null;
    return n;
  } catch { return null; }
}

function scrollerOf(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    if (/(auto|scroll|overlay)/.test(window.getComputedStyle(n).overflowY)) return n;
  }
  return document.scrollingElement || document.documentElement;
}

// useLayoutEffect so the restored position lands before paint (no flash of the top of the
// list); plain useEffect during the static export's prerender, where there is no layout.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Returns `ref` (put it on the list page's root element) and `remember` (call it just before
 *  navigating into a row). `ready` = the rows are on screen. */
export function useListScroll(key, ready) {
  const ref = useRef(null);
  const pending = useRef(null);

  // Only ever SET pending here: React StrictMode (on in `next dev`) runs this twice on mount, and
  // the second read finds the key already taken — assigning its null would wipe the first read.
  useIsoLayoutEffect(() => {
    let v = null;
    try { v = takeScroll(window.sessionStorage, key); } catch { /* private mode */ }
    if (v != null) pending.current = v;
  }, [key]);

  useIsoLayoutEffect(() => {
    if (!ready || pending.current == null) return;
    if (ref.current) scrollerOf(ref.current).scrollTop = pending.current;   // clamps harmlessly on 0 rows
    pending.current = null;
  }, [ready]);

  const remember = useCallback(() => {
    if (!ref.current) return;
    try { rememberScroll(window.sessionStorage, key, scrollerOf(ref.current).scrollTop); } catch { /* private mode */ }
  }, [key]);

  return { ref, remember };
}
