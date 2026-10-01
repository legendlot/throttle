'use client';
import { useEffect, useState } from 'react';

// useState that survives leaving the page and pressing Back, for this browser tab only
// (sessionStorage). For list-page search / filters / tabs, so opening a row and coming back
// keeps what you were looking at (Prarthi #bugs 1790835540, SO ↔ Tally reconciliation).
// Pages under (auth) render only on the client (RequireAuth spinner first), so reading storage in
// the initialiser cannot cause a hydration mismatch. Storage can throw (private mode, blocked
// site data) — every access is guarded and falls back to plain useState behaviour.
// `revive(stored)` (optional) corrects a stored value before first render — e.g. re-deriving a
// date preset's dates so a tab left open overnight does not bring back yesterday's "Today".
export function useSessionState(key, initial, revive) {
  const k = `snorkel:${key}`;
  const [value, setValue] = useState(() => {
    try {
      const raw = window.sessionStorage.getItem(k);
      if (raw != null) {
        let v = JSON.parse(raw);
        const def = typeof initial === 'function' ? initial() : initial;
        // A filter object gains keys over time — fill any the stored copy predates.
        if (isPlainObject(v) && isPlainObject(def)) v = { ...def, ...v };
        return revive ? revive(v) : v;
      }
    } catch {}
    return typeof initial === 'function' ? initial() : initial;
  });
  useEffect(() => {
    try { window.sessionStorage.setItem(k, JSON.stringify(value)); } catch {}
  }, [k, value]);
  return [value, setValue];
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Forget remembered list state: every key under a prefix (e.g. 'payments:mine'), or all of
// Snorkel's when called with no prefix (sign-out, so the next person on a shared PC starts clean).
export function clearSessionState(prefix = '') {
  try {
    const full = `snorkel:${prefix}`;
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const key = window.sessionStorage.key(i);
      if (key && key.startsWith(full)) window.sessionStorage.removeItem(key);
    }
  } catch {}
}
