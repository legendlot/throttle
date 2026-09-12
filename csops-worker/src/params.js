// Query-param parsing. ESM to match the rest of csops src/*.js modules.
//
// ⛔ The whole point of this file: `parseInt(get('limit') || '100')` puts the default INSIDE the
// parseInt, so `?limit=abc` yields NaN — and Math.min/Math.max both PROPAGATE NaN straight into
// the PostgREST URL as `&limit=NaN`. `parseInt(get('limit')) || 100` is the safe spelling. The two
// look identical at a glance, which is why the broken one kept being written: the S370 sweep
// closed the `Number()` spelling fleet-wide and left this one standing at 10 sites. Use intParam
// and neither spelling has to be remembered.
//
// Ported from commsops/src/params.js (itself from ignitionops, S369 `5ef95c85`) — keep the
// semantics identical across workers.
// ⚠️ ONE DELIBERATE WIDENING: this copy also accepts a bare `URLSearchParams`, because csops
// hands its handlers `params` rather than the whole URL. A `URL` behaves exactly as it does in
// the other copies, so the contract has not drifted — it has only widened to cover both shapes.

/**
 * Read an integer query param, never returning NaN.
 * Missing, empty, non-numeric, non-finite or below `min` → `dflt`. Above `max` → clamped to max.
 * NB `min` defaults to 0, so a `limit` wanting 1..N must pass `{ min: 1 }` — that is what makes
 * `?limit=0` fall back to the default rather than asking PostgREST for zero rows.
 * `src` may be a `URL` or a `URLSearchParams`.
 */
export function intParam(src, name, dflt, { min = 0, max = Infinity } = {}) {
  const sp = src instanceof URLSearchParams ? src : src.searchParams;
  const raw = sp.get(name);
  if (raw === null || raw === '') return dflt;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < min) return dflt;
  return Math.min(n, max);
}
