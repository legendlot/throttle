// Lightweight fuzzy matcher for the ⌘K bar (no dependency). `q` and `text` are already
// lowercased by the caller (precomputed once per item, not per keystroke).
// Score: prefix > word-start substring > substring > subsequence (consecutive runs and
// word starts score higher). Returns { score, idx } (matched char positions) or null.
const isWordStart = (t, i) => i === 0 || !/[a-z0-9]/.test(t[i - 1]);

export function fuzzyMatch(q, text) {
  if (!q) return { score: 0, idx: [] };
  if (!text) return null;
  const run = (at) => Array.from({ length: q.length }, (_, k) => at + k);
  if (text.startsWith(q)) return { score: 1000 - (text.length - q.length) * 0.1, idx: run(0) };
  let at = text.indexOf(q);
  if (at >= 0) {
    let ws = at;
    while (ws >= 0 && !isWordStart(text, ws)) ws = text.indexOf(q, ws + 1);
    if (ws >= 0) return { score: 700 - ws * 0.5, idx: run(ws) };
    return { score: 500 - at * 0.5, idx: run(at) };
  }
  // Subsequence: first preferring word starts for each char; if that dead-ends (a later
  // word start skipped chars needed after it), a plain greedy left-to-right pass.
  return subsequence(q, text, true) || subsequence(q, text, false);
}

function subsequence(q, text, preferWordStart) {
  const idx = [];
  let score = 100, prev = -2, from = 0;
  for (const ch of q) {
    let i = text.indexOf(ch, from);
    if (i < 0) return null;
    if (preferWordStart && prev !== i - 1) {
      for (let j = i; j >= 0; j = text.indexOf(ch, j + 1)) { if (isWordStart(text, j)) { i = j; break; } }
    }
    if (i === prev + 1) score += 8;
    if (isWordStart(text, i)) score += 6;
    score -= (i - from) * 0.2;
    idx.push(i); prev = i; from = i + 1;
  }
  return { score, idx };
}

// Order result groups by their best item's score (desc) — the strongest match leads,
// whatever group it's in. A stable sort, so ties keep the given order. Each group's
// items must already be sorted best-first. Pure; used by the ⌘K bar when searching.
export function rankGroups(groups) {
  const best = (g) => (g.items.length ? (g.items[0]._score ?? 0) : -Infinity);
  return groups.map((g, i) => ({ g, i })).sort((a, b) => (best(b.g) - best(a.g)) || (a.i - b.i)).map(x => x.g);
}

// DKT id query: "DKT-123", "dkt123", "#123" or "123" (same grammar as the worker's searchTasks).
// Returns the number string, or null.
export function dktQuery(q) {
  const m = /^\s*(?:dkt[-\s]?)?#?(\d+)\s*$/i.exec(q || '');
  return m ? m[1].replace(/^0+(?=\d)/, '') : null;
}

// ⌘K task scoring (F5), shared by the page's loaded rows and the cross-space server hits.
// `it` carries lc (title, lowercased), lcSub (task_no, lowercased) and num (DKT digits).
// An exact DKT id scores 3000, a DKT prefix 2000-, then the fuzzy title score; a task_no
// substring counts only when strong (≥500). `floor` (from serverFloor) lifts a hit the server
// matched in ways fuzzy can't see — terms out of order, a typo — so it isn't dropped or buried.
// Returns { score, idx } or null.
export function scoreTask(it, query, num, floor = null) {
  let m = fuzzyMatch(query, it.lc);
  let score = m ? m.score : -1;
  if (num && it.num === num) score = Math.max(score, 3000);
  else if (num && it.num && it.num.startsWith(num)) score = Math.max(score, 2000 - (it.num.length - num.length));
  else if (!m) { const ms = fuzzyMatch(query, it.lcSub); if (ms && ms.score >= 500) { score = ms.score; m = { idx: [] }; } }
  if (floor != null && floor > score) { score = floor; m = m || { idx: [] }; }
  if (score < 0) return null;
  return { score, idx: m?.idx || [] };
}

// Server match_rank (migration 0012) → a score floor. pos = the row's place in the server's
// order, so ties keep it. Rank 2 (title prefix) is already ~1000 on fuzzy; 3 = all terms, any
// order; 4 = typo fallback (only returned when nothing matched exactly).
export function serverFloor(rank, pos = 0) {
  if (rank == null || rank === '') return 250 - pos;   // Number(null) is 0 — never the exact-id floor
  const r = Number(rank);
  if (r === 0) return 3000;
  if (r === 1) return 1900 - pos;
  if (r === 2) return 900 - pos;
  if (r === 3) return 450 - pos;
  return 250 - pos;
}
