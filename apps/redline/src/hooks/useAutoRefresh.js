'use client';
import { useEffect, useRef } from 'react';

// Ref-held pattern: fn reference is always current; effect re-runs when skip or
// intervalMs changes. When skip flips false (session arrives), fires immediately
// and starts the interval. No stale closures, no work before auth is ready.
export function useAutoRefresh(fn, intervalMs = 30000, skip = false) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    if (skip) return;
    fnRef.current();
    const id = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [skip, intervalMs]);
}
