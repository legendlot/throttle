'use client';
import { useEffect, useRef } from 'react';

// Hidden tabs do not poll: a tab left in the background kept calling the worker every
// interval (and, once its token expired, kept collecting 401s — decisions.md, instant-load
// entry). Every refresh decision the hook makes goes through this one pure step, so the
// test drives the same function the hook does.
//
//   'tick'     — interval tick: run while visible; while hidden skip it and remember it
//                was missed.
//   'visible'  — tab became visible: run ONCE if a tick was missed (the data is older than
//                the interval). A quick tab-away inside one interval runs nothing extra.
//   'pageshow' — restored from the back/forward cache (event.persisted): timers were
//                frozen, so the data is of unknown age — run once if visible.
export function refreshStep(missed, event, hidden) {
  if (event === 'tick') return hidden ? { run: false, missed: true } : { run: true, missed: false };
  if (event === 'visible') return !hidden && missed ? { run: true, missed: false } : { run: false, missed };
  if (event === 'pageshow') return hidden ? { run: false, missed: true } : { run: true, missed: false };
  return { run: false, missed };
}

const isHidden = () => typeof document !== 'undefined' && document.hidden === true;

// Ref-held pattern: fn reference is always current; effect re-runs when skip or
// intervalMs changes. When skip flips false (session arrives), fires immediately
// and starts the interval. No stale closures, no work before auth is ready.
export function useAutoRefresh(fn, intervalMs = 30000, skip = false) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    if (skip) return;
    let missed = false;
    const step = (event) => {
      const r = refreshStep(missed, event, isHidden());
      missed = r.missed;
      if (r.run) fnRef.current();
    };
    fnRef.current();
    const id = setInterval(() => step('tick'), intervalMs);
    const onVisibility = () => step('visible');
    const onPageShow = (e) => { if (e.persisted) step('pageshow'); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [skip, intervalMs]);
}
