// Query-param parsing. ESM (.mjs) because src/index.js is an ES module while package.json still
// declares "type": "commonjs" — the explicit extension keeps both wrangler and `node --test` right
// without changing the package type on a payroll-facing worker.
//
// ⛔ The whole point of this file: `Number(get('limit') || 500)` puts the default INSIDE the
// Number(), so `?limit=abc` yields NaN — and Math.min/Math.max both PROPAGATE NaN straight into
// the PostgREST URL as `&limit=NaN`. `Number(get('limit')) || 500` is the safe spelling. The two
// look identical at a glance, which is why the broken one kept being written. Use intParam and
// neither spelling has to be remembered.
//
// Ported from ignitionops (S369, 5ef95c85) — keep the semantics identical across workers.

/**
 * Read an integer query param, never returning NaN.
 * Missing, empty, non-numeric, non-finite or below `min` → `dflt`. Above `max` → clamped to max.
 * NB `min` defaults to 0, so a `limit` wanting 1..N must pass `{ min: 1 }` — that is what makes
 * `?limit=0` fall back to the default rather than asking PostgREST for zero rows.
 */
export function intParam(url, name, dflt, { min = 0, max = Infinity } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return dflt;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < min) return dflt;
  return Math.min(n, max);
}
