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

// DKT id query: "DKT-123", "dkt123" or "123". Returns the number string, or null.
export function dktQuery(q) {
  const m = /^\s*(?:dkt[-\s]?)?(\d+)\s*$/i.exec(q || '');
  return m ? m[1].replace(/^0+(?=\d)/, '') : null;
}
