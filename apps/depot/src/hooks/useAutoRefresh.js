'use client';
import { useEffect, useRef } from 'react';

// Ref-held pattern: fn reference is always current; effect re-runs when skip or
// intervalMs changes. When skip flips false (session arrives), fires immediately
// and starts the interval. No stale closures, no work before auth is ready.
//
// Ticks are skipped while the tab is hidden — a background tab kept polling (with an
// expiring token, 401s by the hundred) for nobody to read. If a tick was skipped, one
// refresh fires as soon as the tab is visible again, so it never shows a missed update.
export function useAutoRefresh(fn, intervalMs = 30000, skip = false) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    if (skip) return;
    let missed = false;
    fnRef.current();
    const id = setInterval(() => {
      if (document.hidden) { missed = true; return; }
      fnRef.current();
    }, intervalMs);
    const onVisible = () => {
      if (document.hidden || !missed) return;
      missed = false;
      fnRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [skip, intervalMs]);
}
