'use client';
import { useEffect } from 'react';

export function useAutoRefresh(fn, intervalMs = 60000, skip = false) {
  useEffect(() => {
    fn();
    if (skip) return;
    const id = setInterval(fn, intervalMs);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
