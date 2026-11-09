// Per-key debounced save queue (scratchpad notes, RULE-DOCKET-005). Each key keeps its own
// pending patch — fields MERGE, so a title edit never drops a body edit — and its own
// timer, so one note's edit never cancels another's. `persist(key, patch)` does the write.
export function createSaveQueue(persist, delay = 600) {
  const pending = new Map();
  const timers = new Map();
  function flush(key) {
    const t = timers.get(key); if (t) clearTimeout(t);
    timers.delete(key);
    const patch = pending.get(key);
    pending.delete(key);
    if (patch) persist(key, patch);
  }
  return {
    push(key, patch) {
      pending.set(key, { ...pending.get(key), ...patch });
      const t = timers.get(key); if (t) clearTimeout(t);
      timers.set(key, setTimeout(() => flush(key), delay));
    },
    flush,
    flushAll() { [...pending.keys()].forEach(flush); },
    drop(key) { const t = timers.get(key); if (t) clearTimeout(t); timers.delete(key); pending.delete(key); },
  };
}
