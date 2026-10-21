// GET getProduction request shape (O13). Pure — no I/O — so it is unit-tested.
// vendor_id `all` = every Outpost vendor (owner_production's null); from `all` = all time (from the first pack).
// A missing or malformed from is refused rather than read as all time, so a bad link never silently widens the range.
export const isoDay = v => {
  const s = String(v || '');
  if (!/^(19|2\d)\d{2}-\d{2}-\d{2}$/.test(s) || s < '2000-01-01') return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};

export function productionRequest(P) {
  const p = P || {};
  const all = p.vendor_id === 'all';
  const vid = !all && /^[1-9]\d{0,14}$/.test(String(p.vendor_id ?? '')) ? Number(p.vendor_id) : null;
  if (!all && vid == null) return { error: 'vendor_id must be a vendor id or all' };
  const allTime = p.from === 'all';
  const from = allTime ? null : isoDay(p.from);
  if (!allTime && !from) return { error: 'from must be YYYY-MM-DD or all' };
  const to = p.to == null || p.to === '' ? null : isoDay(p.to);
  if (p.to != null && p.to !== '' && !to) return { error: 'to must be YYYY-MM-DD' };
  if (from && to && from > to) return { error: 'the range starts after it ends' };
  return { vendorId: vid, from, to };
}
