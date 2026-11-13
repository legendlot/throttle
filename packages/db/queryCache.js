// queryCache — last-known read results in sessionStorage, so a page can paint the
// previous numbers immediately and refresh behind them. No React here; the hook that
// drives it is useCachedQuery.js.
//
// Every entry is { u: userId, at: epochMs, d: data } under `lotq:v1:<key>`. An entry
// written by a different user means a different person is now in this tab, so EVERY
// `lotq:` key is purged rather than trusted. Nothing in here may throw into a page:
// storage can be full, disabled, or blocked (private mode), and the answer to all of
// those is "no cache".

const NS = 'lotq:';
const PREFIX = NS + 'v1:';
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 h
const MAX_CHARS = 300000;

function defaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch { /* access itself can throw (SecurityError) */ }
  return null;
}

function remove(s, k) {
  try { s.removeItem(k); } catch { /* ignore */ }
}

// Remove every `lotq:` key (any version) and nothing else.
function purge(s) {
  try {
    const keys = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (typeof k === 'string' && k.startsWith(NS)) keys.push(k);
    }
    keys.forEach((k) => remove(s, k));
  } catch { /* ignore */ }
}

export function readCache(userId, key, { storage, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!userId || !key) return null;
  const s = storage || defaultStorage();
  if (!s) return null;
  const k = PREFIX + key;
  let raw;
  try { raw = s.getItem(k); } catch { return null; }
  if (raw == null) return null;
  let v = null;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !('d' in v)) {
    remove(s, k);
    return null;
  }
  if (v.u !== userId) {
    purge(s);
    return null;
  }
  if (Date.now() - v.at > maxAgeMs) {
    remove(s, k);
    return null;
  }
  return { data: v.d, at: v.at };
}

// A skipped write also REMOVES the key's existing entry: otherwise an older, smaller
// value would keep re-seeding the page after the data outgrew the cap (or the quota).
export function writeCache(userId, key, data, { storage } = {}) {
  if (!userId || !key) return false;
  const s = storage || defaultStorage();
  if (!s) return false;
  const k = PREFIX + key;
  let json = null;
  if (data !== undefined) {
    try { json = JSON.stringify({ u: userId, at: Date.now(), d: data }); } catch { json = null; }
  }
  if (typeof json !== 'string' || json.length > MAX_CHARS) {
    remove(s, k);
    return false;
  }
  try {
    s.setItem(k, json);
    return true;
  } catch {
    remove(s, k);
    return false;
  }
}

export function clearCache({ storage } = {}) {
  const s = storage || defaultStorage();
  if (s) purge(s);
}
