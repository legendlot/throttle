'use client';
import { useEffect, useRef } from 'react';
import { shouldRefreshOnReturn, RETURN_REFRESH_MS } from '../lib/dashboard.mjs';

// Calls fn(stale) once each time the tab becomes visible again; stale = it was hidden for longer
// than maxHiddenMs (shouldRefreshOnReturn). Also on a bfcache restore, which reports through the
// same visibility change or a persisted pageshow — whichever fires first wins, the second finds
// nothing to do. For pages that refresh on demand rather than on a loop: refresh when stale, and
// use any return to check the clock (an IST-midnight rollover). fn is ref-held, always current.
export function useRefreshOnReturn(fn, maxHiddenMs = RETURN_REFRESH_MS) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    let hiddenAt = document.hidden ? Date.now() : null;
    const onVisibility = () => {
      if (document.hidden) { if (hiddenAt == null) hiddenAt = Date.now(); return; }
      if (hiddenAt == null) return;
      const stale = shouldRefreshOnReturn(hiddenAt, Date.now(), maxHiddenMs);
      hiddenAt = null;
      fnRef.current(stale);
    };
    const onPageShow = (e) => { if (e.persisted) onVisibility(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [maxHiddenMs]);
}
