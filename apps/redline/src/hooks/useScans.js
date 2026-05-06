'use client';
import { useState, useCallback, useEffect } from 'react';
import { garageFetch } from '@throttle/db';

/**
 * Fetches scans from getAllScans for a date range.
 * Both Scans and Corrections pages use this hook.
 * Client-side filtering (activity, search, voided display) is done in the caller.
 *
 * @param {{ dateFrom: string, dateTo: string, showVoided: boolean }} params
 * @param {object|null} session  — Supabase session from useAuth()
 * @returns {{ scans: array, loading: boolean, error: string|null, reload: function }}
 */
export function useScans({ dateFrom, dateTo, showVoided = false }, session) {
  const [scans,   setScans]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    if (!session || !dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const params = { date_from: dateFrom, date_to: dateTo };
      if (showVoided) params.voided = 'true';
      const data = await garageFetch('getAllScans', params, session);
      setScans(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load scans');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, showVoided, session]);

  useEffect(() => { load(); }, [load]);

  return { scans, loading, error, reload: load };
}
