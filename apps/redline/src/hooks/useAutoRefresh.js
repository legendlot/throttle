'use client';
import { useEffect } from 'react';

export function useAutoRefresh(fn, intervalMs = 30000, skip = false) {
  useEffect(() => {
    fn();
    if (skip) return;
    const id = setInterval(fn, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
