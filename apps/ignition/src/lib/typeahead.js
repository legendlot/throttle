// Typeahead search — the pure parts (no React), unit-tested in test/typeahead.test.mjs.
// Used by lib/useTypeahead.js and components/ui/Typeahead.js (plan 2026-10-08-ignition-typeahead-search).

// Trim + collapse inner whitespace. The box's raw text is kept as typed; only the searched term is normalised.
export function normQuery(q) {
  return String(q ?? '').replace(/\s+/g, ' ').trim();
}

// Results arrive as [{ group, items: [...] }] (or a bare item array → one unlabelled group).
// A group with `error: true` is kept (shown as "Couldn't load …"); an empty group is dropped.
export function cleanGroups(res) {
  if (!Array.isArray(res)) return [];
  if (res.length && !('items' in Object(res[0])) && !('error' in Object(res[0]))) {
    return [{ group: '', items: res.filter(Boolean) }];
  }
  return res
    .filter(g => g && (g.error || (Array.isArray(g.items) && g.items.length)))
    .map(g => ({ group: g.group || '', error: !!g.error, items: g.error ? [] : g.items.filter(Boolean) }));
}

// The pickable rows in display order — the keyboard highlight indexes into this.
export function flatItems(groups) {
  const out = [];
  for (const g of groups || []) for (const it of g.items || []) out.push(it);
  return out;
}

// ↑/↓ with wrap. -1 = nothing highlighted; ↓ from -1 → first row, ↑ from -1 → last row.
export function moveIndex(i, delta, n) {
  if (!n || n < 1) return -1;
  if (i < 0 || i >= n) return delta > 0 ? 0 : n - 1;
  return ((i + delta) % n + n) % n;
}

// Split `text` into [{ text, hit }] around every case-insensitive occurrence of each query word (the
// list boxes match word by word — matchRows — so "petrol 575" bolds both). A regex (not indexOf on
// lower-cased copies) so characters whose lower case has a different length cannot shift the slices.
export function highlightParts(text, q) {
  const s = String(text ?? '');
  const toks = normQuery(q).split(' ').filter(Boolean).sort((a, b) => b.length - a.length);
  if (!s || !toks.length) return [{ text: s, hit: false }];
  const re = new RegExp(toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), hit: false });
  return out.length ? out : [{ text: s, hit: false }];
}

const isAbort = (e) => e?.name === 'AbortError';

// The debounce + abort + stale guard, as a plain object so it can be tested with fake timers.
// run(query) cancels whatever is pending, then (after debounceMs) calls fetchResults(q, signal).
// A response is reported only if no later run()/cancel() happened since — so a slow "pe" response can
// never overwrite "petrol". onState receives:
//   { status: 'idle' }                 — empty box
//   { status: 'short', q }             — fewer than minChars characters
//   { status: 'loading', q }           — waiting (the caller keeps the previous rows on screen)
//   { status: 'done', q, groups }      — cleanGroups(result)
//   { status: 'error', q, error }      — the call failed (never shown as an empty list)
export function createSearchRunner({ fetchResults, onState, minChars = 2, debounceMs = 200, timers = globalThis }) {
  let timer = null;
  let ctl = null;
  let seq = 0;

  function stop() {
    if (timer != null) { timers.clearTimeout(timer); timer = null; }
    if (ctl) { ctl.abort(); ctl = null; }
  }

  function run(raw) {
    stop();
    const my = ++seq;
    const q = normQuery(raw);
    if (!q) { onState({ status: 'idle', q: '' }); return; }
    if (q.length < minChars) { onState({ status: 'short', q }); return; }
    onState({ status: 'loading', q });
    const c = ctl = new AbortController();
    timer = timers.setTimeout(async () => {
      timer = null;
      try {
        const res = await fetchResults(q, c.signal);
        if (my !== seq || c.signal.aborted) return;
        ctl = null;
        onState({ status: 'done', q, groups: cleanGroups(res) });
      } catch (e) {
        if (my !== seq || c.signal.aborted || isAbort(e)) return;
        ctl = null;
        onState({ status: 'error', q, error: e?.message || 'Search failed' });
      }
    }, debounceMs);
  }

  return {
    run,
    // Unmount / close: drop the pending call and ignore anything still in flight.
    cancel() { stop(); seq++; },
  };
}

// Client-side search over rows a page already holds (Connects, Campaigns, Payments, Roster, Users).
// Every word of the query must appear in one of the row's fields (case-insensitive), so "petrol 575"
// finds petrol_hunter IN575. fieldsOf(row) → array of values; null / '' are skipped.
export function matchRows(rows, q, fieldsOf) {
  const list = Array.isArray(rows) ? rows : [];
  const toks = normQuery(q).toLowerCase().split(' ').filter(Boolean);
  if (!toks.length) return list;
  return list.filter((r) => {
    const hay = (fieldsOf(r) || []).filter((v) => v != null && v !== '').map(String).join(' \u0001 ').toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}
