// TDS on products (section 194R), Reann #bugs 1794284934.757279 (2026-11-10): product value a creator
// received per financial year, flagged over ₹20,000. The SQL (ignition.creator_product_value_fy,
// migration 0010) does the counting; this file only reads its rows against today's FY, so every
// rule here is unit-tested in test/tds.test.mjs.

export const TDS_THRESHOLD = 20000;
// "Getting close" starts at 75%: one or two more parcels can cross ₹20,000.
export const TDS_NEAR_AT = 15000;

/** The 1 April that starts the financial year containing an IST date (YYYY-MM-DD). */
export function fyStartOf(isoDate) {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(isoDate || ''));
  if (!m) return null;
  const y = Number(m[1]);
  return `${Number(m[2]) >= 4 ? y : y - 1}-04-01`;
}

/** "FY 2026-27" for 2026-04-01. */
export function fyLabel(fyStart) {
  const y = Number(String(fyStart || '').slice(0, 4));
  return Number.isFinite(y) && y > 0 ? `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}` : null;
}

/**
 * The current FY's figure and flag, plus earlier years that crossed. `rows` are the RPC's rows
 * (numeric columns arrive as strings). A year with no received deal has no row and reads as ₹0.
 */
export function tdsSummary(rows, todayIst) {
  const fy = fyStartOf(todayIst);
  const list = (Array.isArray(rows) ? rows : []).map(r => ({
    fy_start: String(r?.fy_start || '').slice(0, 10),
    value: Math.round((Number(r?.value) || 0) * 100) / 100,
    deals: Number(r?.deals) || 0,
    lines: Number(r?.lines) || 0,
    unpriced_lines: Number(r?.unpriced_lines) || 0,
  }));
  const cur = list.find(r => r.fy_start === fy) || { fy_start: fy, value: 0, deals: 0, lines: 0, unpriced_lines: 0 };
  const status = cur.value > TDS_THRESHOLD ? 'over' : cur.value >= TDS_NEAR_AT ? 'near' : 'clear';
  return {
    ...cur,
    fy_label: fyLabel(cur.fy_start),
    threshold: TDS_THRESHOLD,
    status,
    earlier_over: list
      .filter(r => r.fy_start && fy && r.fy_start < fy && r.value > TDS_THRESHOLD)
      .map(r => ({ fy_label: fyLabel(r.fy_start), value: r.value })),
  };
}
