'use client';
import { useState, useCallback, useEffect } from 'react';
import { garageFetch } from '@throttle/db';

/**
 * Polls Garage alert counts for nav badge display.
 * Sources: reorder flags + submitted production runs awaiting store issue.
 * Polling is silent — badge failures never disrupt the page.
 *
 * @param {object|null} session
 * @param {number} intervalMs - default 30 000ms
 * @returns {{ alertCount: number }}
 */
export function useGarageAlerts(session, intervalMs = 30000) {
  const [alertCount, setAlertCount] = useState(0);

  const poll = useCallback(async () => {
    if (!session) return;
    try {
      const data = await garageFetch('getGarageAlerts', {}, session);
      setAlertCount(typeof data?.total === 'number' ? data.total : 0);
    } catch (_) {
      // silent
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, session, intervalMs]);

  return { alertCount };
}
