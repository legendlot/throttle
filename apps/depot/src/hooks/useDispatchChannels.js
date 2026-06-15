'use client';
import { useState, useEffect } from 'react';
import { garageFetch } from '@throttle/db';

/**
 * Fetches dispatch channels once on mount.
 * Used by all four dispatch pages for channel dropdowns and name lookups.
 *
 * @param {object|null} session
 * @returns {{ channels: array, channelMap: object, loading: boolean }}
 */
export function useDispatchChannels(session) {
  const [channels, setChannels] = useState([]);
  const [loading,  setLoading]  = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    garageFetch('getDispatchChannels', {}, session)
      .then(data => setChannels(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session]);

  const channelMap = {};
  channels.forEach(c => { channelMap[c.id] = c; });

  return { channels, channelMap, loading };
}
