// Pure helpers for the Procurement overview (app/(auth)/procurement/page.js) instant-load:
// what each call is slimmed to before it is held or cached, and the freshness line. No I/O,
// no React — unit-tested in test/overview.test.mjs.
//
// The page caches its two reads in this tab's sessionStorage (per user, see useCachedQuery).
// getPOs returns up to 2,000 rows with prices, vendor and invoice fields; the overview shows
// counts, one ₹ sum and six rows. So only that is kept: the same normalisation and the same
// arithmetic the page did before, run over the same rows in the same order, so a cached result
// and a fresh one render identically.
import { OPEN_PO_STATUSES } from '../components/format.js';

const FX = { INR: 1, USD: 84, RMB: 11.6, CNY: 11.6 };
const toInr = (v, cur) => (Number(v) || 0) * (FX[cur] || 1);
// The PO flow is Draft → Accepted → Approved (acceptPO sets Accepted; finalApprovePO only moves an
// Accepted PO to Approved). So Accepted is what "awaiting sign-off" means today — Pending Approval
// is kept for any legacy row — and stock is already received against Accepted POs, so it arrives.
export const TO_APPROVE_STATUSES = ['Pending Approval', 'Accepted'];
export const ARRIVING_STATUSES = ['Accepted', 'Approved', 'Sent', 'Confirmed & Payment Done'];
const ARRIVING_DAYS = 14;
const OVERVIEW_ROWS = 6;

// getReorderRequests (status=Pending) → the queue length and the six rows the panel lists,
// each cut to what its row and rrLabel() read. The worker answers an array; anything else
// THROWS — a bad reply is an error with a Retry, never a cached "queue is clear".
export function slimReorders(rrs) {
  if (!Array.isArray(rrs)) throw new Error('Unexpected getReorderRequests reply');
  const rows = rrs;
  return {
    count: rows.length,
    top: rows.slice(0, OVERVIEW_ROWS).map((r) => ({
      request_id: r.request_id,
      request_type: r.request_type,
      part_code: r.part_code,
      part_name: r.part_name,
      product: r.product,
      variant: r.variant,
      color: r.color,
      requested_qty: r.requested_qty,
      unit: r.unit,
      urgency: r.urgency,
    })),
  };
}

// getPOs → the KPI counts, the pipeline, the open-value sum and the first six open POs.
//
// ⚠️ getPOs returns { rows, … } as of S334 (a bare array is the pre-S334 shape, still read).
// Any other reply THROWS: it used to fall through to [] and render every PO KPI as 0 — now it
// is an error with a Retry, never a cached "no POs". `truncated` turns the KPI subs into
// "· partial" — the counts are floors then, not totals.
//
// PRICES: the worker already decided what this viewer may see — a China PO for a caller without
// China rights arrives with po_value / currency STRIPPED (stripChinaPOHeader), and a Soft PO not at
// all. Nothing here re-adds or re-derives a price: the open-value sum runs over exactly the rows
// it did before (a stripped row adds 0, as it always did), and a listed row keeps po_value /
// currency only if the worker sent them. The "Restricted" cell is still decided on the page from
// the viewer's live perms.
//
// "Arriving · 14d" depends on the clock, so the cache holds its inputs, not the count: the
// expected_delivery of every arriving-status PO that was not already past when fetched (a past
// date can never come back into the window). arrivingCount() applies the same window as before.
export function slimPOs(pos, nowMs = Date.now()) {
  if (!Array.isArray(pos) && !Array.isArray(pos?.rows)) throw new Error('Unexpected getPOs reply');
  const rows = Array.isArray(pos) ? pos : pos.rows;
  const truncated = Array.isArray(pos) ? false : !!pos?.truncated;
  const now = new Date(nowMs);
  const inStatus = (list) => rows.filter((p) => list.includes(p.status)).length;
  const open = rows.filter((p) => OPEN_PO_STATUSES.includes(p.status));
  return {
    truncated,
    openPO: open.length,
    pendingApproval: inStatus(TO_APPROVE_STATUSES),
    arrivingDates: rows
      .filter((p) => {
        if (!ARRIVING_STATUSES.includes(p.status)) return false;
        if (!p.expected_delivery) return false;
        const d = new Date(p.expected_delivery);
        return !isNaN(d) && d >= now;
      })
      .map((p) => p.expected_delivery),
    pipeline: [
      { stage: 'To Approve', count: inStatus(TO_APPROVE_STATUSES), tone: 'orange' },
      { stage: 'Approved', count: inStatus(['Approved']), tone: 'blue' },
      { stage: 'Sent', count: inStatus(['Sent']), tone: 'yellow' },
      { stage: 'Confirmed', count: inStatus(['Confirmed & Payment Done']), tone: 'green' },
      { stage: 'Receiving', count: inStatus(['Partially Received']), tone: 'yellow' },
    ],
    // No 'sourced China' % here (S385): China PO lines carry no unit_price, so it could only read 0.
    openValueInr: open.reduce((s, p) => s + toInr(p.po_value, p.currency), 0),
    openList: open.slice(0, OVERVIEW_ROWS).map((p) => ({
      po_number: p.po_number,
      vendor_name: p.vendor_name,
      source: p.source,
      currency: p.currency,
      po_value: p.po_value,
      expected_delivery: p.expected_delivery,
      status: p.status,
    })),
  };
}

// The viewer's price tier — the same right the page checks for the "Restricted" cell and the
// worker checks before stripping China prices (canViewChina: po_china || po_china_view).
export function canSeeChinaPrices(perms) {
  return !!(perms?.po_china || perms?.po_china_view);
}

// The PO query's cache key carries the price tier, so a total cached under wider rights is
// never read back under narrower ones (a role downgrade within the 12 h cache life).
export function poOverviewKey(perms) {
  return `snorkel:overview:pos:${canSeeChinaPrices(perms) ? 'cn' : 'std'}`;
}

// Rows someone may ACT on (Convert) must come from a successful fetch made during this visit
// and not be mid-refresh — never rows seeded from the cache.
export function rowsAreFresh(q, sinceMs) {
  return q.data !== undefined && !q.loading && !q.refreshing && !q.error
    && typeof q.updatedAt === 'number' && q.updatedAt >= sinceMs;
}

// Arriving in the next 14 days, from now — the same window the page always applied.
export function arrivingCount(dates, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const cutoff = new Date(nowMs); cutoff.setDate(cutoff.getDate() + ARRIVING_DAYS);
  return (Array.isArray(dates) ? dates : []).filter((raw) => {
    const d = new Date(raw);
    return !isNaN(d) && d <= cutoff && d >= now;
  }).length;
}

// IST stamp: "21:04" today, "12 Nov 21:04" otherwise (same as Garage's and Depot's).
export function istStamp(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day === today) return hhmm;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${hhmm}`;
}

// The page's one freshness line, over both queries (the page is not polled, so nothing is
// left out of it). The stamp is the OLDEST data showing.
export function freshness(qs, nowMs = Date.now()) {
  const inFlight = qs.some((q) => q.loading || q.refreshing);
  const failed = qs.some((q) => q.error);
  const stamps = qs.map((q) => q.updatedAt).filter(Boolean);
  const oldest = stamps.length ? istStamp(Math.min(...stamps), nowMs) : null;
  const text = inFlight ? (oldest ? `Updating… (showing ${oldest})` : 'Updating…')
    : failed ? (oldest ? `Couldn't refresh — showing ${oldest}` : "Couldn't refresh")
    : oldest ? `As of ${oldest}` : '';
  return { text, warn: failed && !inFlight };
}

// Refresh when the tab comes back — but only after it was hidden for more than a minute, so
// flicking between tabs does not re-read 2,000 POs each time.
export const RETURN_REFRESH_MS = 60000;
export function shouldRefreshOnReturn(hiddenAtMs, nowMs = Date.now()) {
  return typeof hiddenAtMs === 'number' && nowMs - hiddenAtMs > RETURN_REFRESH_MS;
}
