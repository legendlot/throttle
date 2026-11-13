'use client';
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { readCache, writeCache } from './queryCache.js';

// Layout effect on the client (seed before first paint, so cached numbers show without
// a skeleton flash); plain effect on the server, where layout effects warn and storage
// does not exist anyway.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function identityOf(userId, key) {
  return userId && key ? `${userId}\u0000${key}` : null;
}

// The two decisions the hook makes, kept pure so they are testable without a DOM.
//
// refresh(): JOIN the request already in flight for the same identity — an endpoint
// slower than the page's 60 s loop must still land, not be superseded every minute.
// A request for a DIFFERENT identity (sign-out, another user) never blocks a new one.
export function planRefresh(inFlight, id) {
  return inFlight && inFlight.id === id ? 'join' : 'start';
}

// A response is applied only if the component is still mounted and nothing newer (an
// identity change bumps the counter) has started since.
export function shouldApply(seq, latestSeq, mounted) {
  return mounted && seq === latestSeq;
}

/**
 * useCachedQuery — show the last-known result immediately, refresh behind it.
 *
 * Does NOT fetch on its own: the page calls refresh() when it wants fresh data (it
 * already owns an auto-refresh loop). `data` is undefined until the cache or a fetch
 * supplies something; null is a real value.
 *
 *   loading    — a request is in flight and there is no data yet
 *   refreshing — a request is in flight and data is already showing
 *   error      — the last request's Error (existing data is kept; cleared when a
 *                request starts with no data, so a Retry shows the skeleton again)
 *   updatedAt  — epoch ms of the data showing (from the cache, or the fetch)
 */
export function useCachedQuery({ key, userId, enabled = true, fetcher }) {
  const [data, setData] = useState(undefined);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [inFlight, setInFlight] = useState(false);

  const fetcherRef = useRef(fetcher);
  const keyRef = useRef(key);
  const userRef = useRef(userId);
  const enabledRef = useRef(enabled);
  const hasDataRef = useRef(false);
  fetcherRef.current = fetcher;
  keyRef.current = key;
  userRef.current = userId;
  enabledRef.current = enabled;
  hasDataRef.current = data !== undefined;

  const reqRef = useRef(0);          // latest request id; older responses are dropped
  const inFlightRef = useRef(null);  // { id, seq, promise } of the request in flight
  const identityRef = useRef(null);  // identity the state belongs to
  const deliveredRef = useRef(null); // identity a fetch has already delivered data for
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Seed from the cache once the identity is known; reset if it changes (sign-out, or a
  // different user) so one person's numbers never sit under another's.
  useIsoLayoutEffect(() => {
    const id = identityOf(userId, key);
    if (id === identityRef.current) return;
    const hadIdentity = identityRef.current !== null;
    identityRef.current = id;
    if (hadIdentity) {
      reqRef.current += 1; // anything in flight belongs to the old identity
      inFlightRef.current = null;
      deliveredRef.current = null;
      hasDataRef.current = false;
      setData(undefined); setUpdatedAt(null); setError(null); setInFlight(false);
    }
    if (!id || deliveredRef.current === id) return;
    const hit = readCache(userId, key);
    if (hit) { hasDataRef.current = true; setData(hit.data); setUpdatedAt(hit.at); }
  }, [userId, key]);

  const refresh = useCallback(() => {
    if (!enabledRef.current || typeof fetcherRef.current !== 'function') return Promise.resolve();
    const uid = userRef.current;
    const k = keyRef.current;
    const id = identityOf(uid, k);
    if (planRefresh(inFlightRef.current, id) === 'join') return inFlightRef.current.promise;

    const seq = ++reqRef.current;
    setInFlight(true);
    if (!hasDataRef.current) setError(null);
    // Registered BEFORE the request runs: a fetcher that fails synchronously finishes
    // inside the call below, and its `finally` must find (and clear) this entry.
    const entry = { id, seq, promise: null };
    inFlightRef.current = entry;
    entry.promise = (async () => {
      try {
        const result = await fetcherRef.current();
        if (!shouldApply(seq, reqRef.current, mountedRef.current)) return;
        deliveredRef.current = id;
        hasDataRef.current = true;
        setData(result);
        setUpdatedAt(Date.now());
        setError(null);
        setInFlight(false);
        writeCache(uid, k, result);
      } catch (e) {
        if (!shouldApply(seq, reqRef.current, mountedRef.current)) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setInFlight(false);
      } finally {
        if (inFlightRef.current === entry) inFlightRef.current = null;
      }
    })();
    return entry.promise;
  }, []);

  const hasData = data !== undefined;
  return {
    data,
    error,
    loading: inFlight && !hasData,
    refreshing: inFlight && hasData,
    updatedAt,
    refresh,
  };
}
