/* ── scan-derived line product (S392) ─────────────────────────────────────────
   A line with no run assigned still scans real units (L4/L5 on 2026-09-21). The
   worker returns `scan_products` — one row per (line, product, model, color) with a
   car/drone scan count — from get_line_scan_products. This turns that into a label
   the Lines cards and the Overview shift panel can show next to "No run assigned".
   Pure; no I/O. */

export function scanProductLabel(rows, line) {
  const mine = (Array.isArray(rows) ? rows : [])
    .filter(r => r && r.line === line && r.product)
    .map(r => ({ ...r, cnt: Number(r.cnt) || 0 }))
    .sort((a, b) => b.cnt - a.cnt);
  if (!mine.length) return null;
  const total = mine.reduce((a, r) => a + r.cnt, 0);   // production SCANS (INW/QC/PKG/RTE/RTR), not units
  const top = mine[0];
  const products = new Set(mine.map(r => r.product)).size;
  return {
    label: [top.product, top.model, top.color].filter(Boolean).join(' · '),
    product: top.product,
    topCount: top.cnt,
    total,
    share: total ? Math.round((top.cnt / total) * 100) : 0,
    others: products - 1,          // OTHER PRODUCTS on the line, not other colourways
    variants: mine.length,
    rows: mine,
  };
}
