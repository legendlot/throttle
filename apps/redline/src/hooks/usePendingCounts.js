'use client';
import { garageFetch, useCachedQuery } from '@throttle/db';
import { useAutoRefresh } from './useAutoRefresh.js';
import { countOf } from '../lib/execData.js';

/**
 * Polls alert + returns pending counts for nav badge display.
 * Runs once on mount, then on the provided interval (paused while the tab is hidden).
 *
 * The SAME two queries feed the Overview's "Unacknowledged scan alerts" / "Returns
 * awaiting action" rows: the layout exposes them through PendingContext, so the page reads
 * this one request and result instead of making its own (it used to fetch both again on
 * its own 30 s loop). Only the counts are held/cached, never the rows.
 *
 * Badge values are unchanged: a failed poll keeps the last count, and with none yet the
 * badge reads 0, as before — the page itself shows the failure.
 *
 * @param {object|null} session  — Supabase session
 * @param {string|null} userId   — cache owner (useAuth().userId)
 * @param {number} intervalMs    — poll interval (default 30 000 ms)
 */
export function usePendingCounts(session, userId, intervalMs = 30000) {
  const live = !!session;
  // Unacknowledged violations — no date filter so we catch all open ones
  const alertsQ = useCachedQuery({ key: 'redline:pending:alerts', userId, enabled: live,
    fetcher: () => garageFetch('getViolations', { acknowledged: 'false' }, session).then(countOf) });
  const returnsQ = useCachedQuery({ key: 'redline:pending:returns', userId, enabled: live,
    fetcher: () => garageFetch('getReturnQueue', {}, session).then(countOf) });

  useAutoRefresh(() => {
    if (!session) return;
    alertsQ.refresh();
    returnsQ.refresh();
  }, intervalMs, !session);

  return {
    alertCount:  alertsQ.data ?? 0,
    returnCount: returnsQ.data ?? 0,
    alertsQ,
    returnsQ,
  };
}
