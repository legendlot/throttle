// Odo tools for the LOT MCP gateway. The gateway calls odoops AS THE PERSON (their own Supabase JWT,
// over a service binding), so odoops' own checks apply on top of the gateway grant:
// active profile, an Odo role, `sales_view`. Only the two read actions below are ever called.
// The headline maths is Odo's own (apps/odo/src/lib/segregation.js), imported rather than copied,
// so Claude and the Odo dashboard can never disagree.
import { hybridHeadline, hybridByChannel } from '../../apps/odo/src/lib/segregation.js';

export const MAX_RANGE_DAYS = 92;
const DAY = 86400000;

export function todayIST(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600000).toISOString().slice(0, 10);
}

// { ok, from, to } or { ok:false, error }. Dates are IST calendar days, inclusive.
export function parseRange(args, nowMs = Date.now()) {
  const a = args && typeof args === 'object' ? args : {};
  const today = todayIST(nowMs);
  const from = a.from === undefined || a.from === '' ? today : a.from;
  const to = a.to === undefined || a.to === '' ? from : a.to;
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!isDate(from) || !isDate(to)) return { ok: false, error: 'Dates must be real calendar dates written YYYY-MM-DD.' };
  if (from > to) return { ok: false, error: '`from` must be on or before `to`.' };
  if (to > today) return { ok: false, error: `\`to\` cannot be after today (${today}, IST).` };
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
  if (days > MAX_RANGE_DAYS) return { ok: false, error: `Ask for at most ${MAX_RANGE_DAYS} days at a time (this asked for ${days}).` };
  return { ok: true, from, to, days };
}

const rupees = n => Math.round(Number(n) || 0);

// Pure: odoops payloads → the tool's answer. orderRows/channels from getSegregation, productRows from getSales.
export function shapeSalesSummary({ orderRows, channels, productRows }, range) {
  const head = hybridHeadline(orderRows || [], productRows || []);
  const byCh = hybridByChannel(orderRows || [], productRows || []);
  const name = new Map((channels || []).map(c => [c.id, c.name]));
  const by_channel = Object.entries(byCh)
    .map(([id, v]) => ({ channel: name.get(id) || 'Unknown channel', net_revenue_ex_gst: rupees(v.net), gross_sales_incl_gst: rupees(v.gross) }))
    .sort((x, y) => y.net_revenue_ex_gst - x.net_revenue_ex_gst);
  return {
    period: { from: range.from, to: range.to, days: range.days, timezone: 'IST' },
    net_revenue_ex_gst: rupees(head.netExGst),
    gross_sales_incl_gst: rupees(head.grossAll),
    units: Math.round(Number(head.units) || 0),
    gst_settled_pct: head.settledPct,
    by_channel,
    notes: [
      'Net revenue (ex-GST, after discounts, cancellations and returns) is the figure to quote; gross includes GST and cancelled orders.',
      'Returns are counted on the day they come back, so a short range or one channel can show negative net.',
      'gst_settled_pct is how much of the GST is marketplace-settled rather than estimated; below 100 means net may still move a little.',
      'Same calculation as the Odo dashboard.',
    ],
  };
}

// Calls odoops as the person. Returns { ok, data } or { ok:false, reason } where reason is a refusalText key.
async function odoGet(env, sbAccess, action, params) {
  const u = new URL('https://odoops/');
  u.search = new URLSearchParams({ action, ...params }).toString();
  let res;
  try { res = await env.ODOOPS.fetch(u.toString(), { headers: { Authorization: `Bearer ${sbAccess}` } }); }
  catch { return { ok: false, reason: 'unreachable' }; }
  // odoops answers 401 for a dead session AND for a transient lookup failure (and no role, which the
  // gateway pre-checks via mcp_gate.odo_sales_view), so 401 is worded to cover both.
  if (res.status === 401) return { ok: false, reason: 'session expired' };
  if (res.status === 403) return { ok: false, reason: 'odo denied' };
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true || !j.data || typeof j.data !== 'object' || !Array.isArray(j.data.rows)) return { ok: false, reason: 'unreachable' };
  return { ok: true, data: j.data };
}

export async function odoSalesSummary(env, sbAccess, range) {
  const p = { from: range.from, to: range.to };
  const [seg, sales] = await Promise.all([
    odoGet(env, sbAccess, 'getSegregation', p),
    odoGet(env, sbAccess, 'getSales', { ...p, group: 'variant' }),
  ]);
  for (const r of [seg, sales]) if (!r.ok) return r;
  return { ok: true, data: shapeSalesSummary({ orderRows: seg.data.rows, channels: seg.data.channels, productRows: sales.data.rows }, range) };
}
