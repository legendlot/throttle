// Pure helpers for the Depot Overview (dashboard/page.js) instant-load: what each call is
// slimmed to before it is held or cached, the two values built from more than one call, and
// the freshness line. No I/O, no React — unit-tested in test/overview.test.mjs.
//
// Every slimmer keeps exactly the fields the page renders and the same fallbacks the page
// applied before, so a cached result and a fresh one render identically. What is dropped is
// what the page never shows: unit rows, request rows (customer details), operator names.

// The floor reads (getManpowerLog, getOperatorAttendance) are canManageFloor-gated in the
// worker and answer 403 by design for everyone else; the page has always shown its
// no-access figures then. Matched on the status alone — any other failure is an error.
export function isForbidden(e) {
  return e?.status === 403;
}

// getDispatchDashboard → its counts object (the one unit row it carries is never shown).
export function pickCounts(d) {
  return d?.counts || null;
}

// getDispatchLineView → dispatch_lines, each cut to what LineCard + "packed" read.
// operator_stats (per-operator names and scans) is dropped: nothing here shows it.
export function pickLines(d) {
  const rows = Array.isArray(d?.dispatch_lines) ? d.dispatch_lines : [];
  return rows.map(l => ({
    line: l.line,
    pack_count: l.pack_count,
    alloc_count: l.alloc_count,
    dout_count: l.dout_count,
    active_operators: l.active_operators,
    last_scan_at: l.last_scan_at,
    active_channels: l.active_channels,
  }));
}

// getAllocatedByChannel / getShippedByChannel → the four fields ChannelCard and the totals read.
export function pickChannelRows(d) {
  return (Array.isArray(d) ? d : []).map(r => ({
    channel_name: r.channel_name,
    channel_type: r.channel_type,
    is_sale: r.is_sale,
    unit_count: r.unit_count,
  }));
}

// getDispatchScanSummary → the two figures the stat cards read.
export function pickScanSummary(d) {
  if (!d) return null;
  return { DOUT: d.DOUT, shipments_out: d.shipments_out };
}

// getFulfilmentRequests → only how many are pending. The rows carry customer and order
// details the card never shows; they are not held, let alone cached.
export function countRequests(d) {
  return Array.isArray(d) ? d.length : 0;
}

// getManpowerLog → rostered headcount per dispatch line. A reply that is not an object
// leaves the line cards without a roster, as before.
export function rosterByLine(res) {
  const log = res?.data;
  if (!log || typeof log !== 'object' || Array.isArray(log)) return {};
  return {
    D1: Array.isArray(log.D1) ? log.D1.length : 0,
    D2: Array.isArray(log.D2) ? log.D2.length : 0,
  };
}

// getOperatorAttendance → distinct dispatch operators on the floor now (open shift AND
// present — see isPresent() in @throttle/domain). Only the count is held.
export function floorOpsCount(res, isPresent) {
  const rows = Array.isArray(res?.data) ? res.data
    : Array.isArray(res) ? res : [];
  return new Set(rows.filter(r => !r.clock_out && isPresent(r)).map(r => r.operator_id)).size;
}

// getDispatchPipeline → per product, only the totals the on-hand table and the At Vendors
// card add up. The per-variant breakdown is dropped.
export function slimPipeline(d) {
  return (Array.isArray(d?.products) ? d.products : []).map(p => {
    const t = p.totals || {};
    return {
      product: p.product,
      totals: {
        with_production: t.with_production,
        unallocated_retail: t.unallocated_retail,
        unallocated_ecom: t.unallocated_ecom,
        unallocated_export: t.unallocated_export,
        unallocated_unknown: t.unallocated_unknown,
        vendor_at: t.vendor_at,
        vendor_in_transit: t.vendor_in_transit,
        vendor_receiving: t.vendor_receiving,
        channels: t.channels || {},
      },
    };
  });
}

// A query's state, as the page reads it off useCachedQuery.
const has = (q) => q.data !== undefined;
const failedEmpty = (q) => !!q.error && q.data === undefined;

// "Dispatched today" = the scan summary's DOUT, or — when the summary carries none — the
// sum of the line cards' dout_count. Two calls, so it shows only once the figure it would
// use is actually in: never the line sum standing in for a summary that has not arrived.
//   → { state: 'loading' | 'error' | 'ready', value, retry: [queries to retry] }
export function dispatchedToday(scanQ, linesQ) {
  if (failedEmpty(scanQ)) return { state: 'error', retry: [scanQ] };
  if (!has(scanQ)) return { state: 'loading' };
  const today = scanQ.data;
  if (today?.DOUT != null) return { state: 'ready', value: Number(today.DOUT) };
  if (failedEmpty(linesQ)) return { state: 'error', retry: [linesQ] };
  if (!has(linesQ)) return { state: 'loading' };
  return { state: 'ready', value: (linesQ.data || []).reduce((s, l) => s + (l.dout_count || 0), 0) };
}

// IST stamp: "21:04" today, "12 Nov 21:04" otherwise (same as Garage's freshness line).
export function istStamp(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day === today) return hhmm;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${hhmm}`;
}

// The header freshness line — Garage's wording and rule (the stamp is the OLDEST data
// showing) — over the POLLED calls only (the 30/60 s loop). The once-loaded panels
// (On-Hand, Sent Out) are never polled and are kept out of it entirely: they carry their
// own stamp (panelAsOf), so this line can never vouch for data it does not refresh.
export function freshness(polled, nowMs = Date.now()) {
  const inFlight = polled.some(q => q.loading || q.refreshing);
  const failed = polled.some(q => q.error);
  const stamps = polled.map(q => q.updatedAt).filter(Boolean);
  const oldest = stamps.length ? istStamp(Math.min(...stamps), nowMs) : null;
  const text = inFlight ? (oldest ? `Updating… (showing ${oldest})` : 'Updating…')
    : failed ? (oldest ? `Couldn't refresh — showing ${oldest}` : "Couldn't refresh")
    : oldest ? `Updated ${oldest}` : '';
  return { text, warn: failed && !inFlight };
}

// A once-loaded panel's own stamp, shown whenever it shows data: "as of HH:MM", or
// "Couldn't refresh — as of HH:MM" when its last refresh failed over stale data.
// Null with no data (the panel shows its skeleton or its error instead).
export function panelAsOf(q, nowMs = Date.now()) {
  if (q.data === undefined || !q.updatedAt) return null;
  const at = istStamp(q.updatedAt, nowMs);
  return q.error ? { text: `Couldn't refresh — as of ${at}`, warn: true } : { text: `as of ${at}`, warn: false };
}
