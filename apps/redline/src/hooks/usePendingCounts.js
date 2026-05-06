'use client';
import { useState, useCallback, useEffect } from 'react';
import { garageFetch } from '@throttle/db';

/**
 * Polls alert + returns pending counts for nav badge display.
 * Runs once on mount, then on the provided interval.
 *
 * @param {object|null} session  — Supabase session
 * @param {number} intervalMs    — poll interval (default 30 000 ms)
 * @returns {{ alertCount: number, returnCount: number }}
 */
export function usePendingCounts(session, intervalMs = 30000) {
  const [alertCount,  setAlertCount]  = useState(0);
  const [returnCount, setReturnCount] = useState(0);

  const poll = useCallback(async () => {
    if (!session) return;
    try {
      // Unacknowledged violations — no date filter so we catch all open ones
      const [violations, returnQueue] = await Promise.allSettled([
        garageFetch('getViolations',  { acknowledged: 'false' }, session),
        garageFetch('getReturnQueue', {},                         session),
      ]);
      if (violations.status  === 'fulfilled') {
        setAlertCount(Array.isArray(violations.value)  ? violations.value.length  : 0);
      }
      if (returnQueue.status === 'fulfilled') {
        setReturnCount(Array.isArray(returnQueue.value) ? returnQueue.value.length : 0);
      }
    } catch (_) {
      // Badge polling failure is silent — don't disrupt the page
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, session, intervalMs]);

  return { alertCount, returnCount };
}
