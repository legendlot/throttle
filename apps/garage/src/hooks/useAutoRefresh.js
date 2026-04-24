'use client';
import { useEffect, useRef } from 'react';

export function useAutoRefresh(fn, intervalMs = 60000, skip = false) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    if (skip) return;
    fnRef.current();
    const id = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [skip, intervalMs]);
}
