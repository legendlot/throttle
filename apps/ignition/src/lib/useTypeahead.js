'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSearchRunner, normQuery } from './typeahead.js';

const IDLE = { status: 'idle', q: '', groups: [], groupsQ: '', error: null };

// React wrapper around createSearchRunner (lib/typeahead.js): 2-char minimum, 200 ms debounce,
// abort + stale guard. `fetchResults(q, signal)` may change every render — the latest one is used.
// `refreshKey`: bump it to re-run the same query against new data (client-side boxes whose rows reload).
// While a new query loads, the previous rows stay on screen (status 'loading', groups kept).
export function useTypeahead({ query, fetchResults, minChars = 2, debounceMs = 200, enabled = true, refreshKey }) {
  const fetchRef = useRef(fetchResults);
  useEffect(() => { fetchRef.current = fetchResults; });

  const [state, setState] = useState(IDLE);
  const runner = useMemo(() => createSearchRunner({
    fetchResults: (q, signal) => fetchRef.current(q, signal),
    // groupsQ = the query the rows on screen answer (bold matches use it, not the new text).
    onState: (s) => setState((prev) => s.status === 'loading'
      ? { ...prev, status: 'loading', q: s.q, error: null }
      : { groups: [], error: null, ...s, groupsQ: s.status === 'done' ? s.q : '' }),
    minChars,
    debounceMs,
  }), [minChars, debounceMs]);
  useEffect(() => () => runner.cancel(), [runner]);

  const [nonce, setNonce] = useState(0);
  const q = enabled ? normQuery(query) : '';
  useEffect(() => { runner.run(q); }, [runner, q, nonce, refreshKey]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, retry };
}

export default useTypeahead;
