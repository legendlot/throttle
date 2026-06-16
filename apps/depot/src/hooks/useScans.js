'use client';
import { useState, useCallback, useEffect } from 'react';
import { garageFetch } from '@throttle/db';

/**
 * Fetches scans from getAllScans for a date range.
 * Supports a single server-side activity filter OR an activities[] allow-list
 * (Depot's dispatch feed restricts to the dispatch scan activities), plus
 * cursor-based load-more. activityFilter (single) takes precedence over
 * activities[] when both are present.
 *
 * @param {{ dateFrom, dateTo, showVoided, activityFilter, activities }} params
 * @param {object|null} session
 */
export function useScans({ dateFrom, dateTo, showVoided = false, activityFilter = '', activities = [] }, session) {
  const [scans,   setScans]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [offset,  setOffset]  = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const PAGE_SIZE = 500;
  const activitiesKey = (activities || []).join(',');

  const load = useCallback(async (newOffset = 0, append = false) => {
    if (!session || !dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const params = { date_from: dateFrom, date_to: dateTo, offset: newOffset };
      if (showVoided)          params.voided     = 'true';
      if (activityFilter)      params.activity   = activityFilter;
      else if (activitiesKey)  params.activities = activitiesKey;
      const data = await garageFetch('getAllScans', params, session);
      const rows = Array.isArray(data) ? data : [];
      setScans(prev => append ? [...prev, ...rows] : rows);
      setOffset(newOffset);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (e) {
      setError(e.message || 'Failed to load scans');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, showVoided, activityFilter, activitiesKey, session]);

  useEffect(() => { load(0, false); }, [load]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading) return;
    load(offset + PAGE_SIZE, true);
  }, [hasMore, loading, load, offset]);

  return { scans, loading, error, hasMore, loadMore, reload: () => load(0, false) };
}
