// Courier-agnostic tracking model + the Delhivery B2B (LTL) normalizer. PURE (no I/O) so it is
// unit-tested and reusable by future couriers/returns.
//
// LOT ships B2B/LTL, NOT last-mile. The B2B Track API (GET ltl-clients-api.delhivery.com/lrn/track
// ?lrnum=<LRN>, UMS Bearer JWT) returns ONLY the latest status of the whole shipment — there is NO
// scan history in the response (explicit in the docs). So the journey TIMELINE is ACCUMULATED by
// courierops itself: mergeCheckpoint() appends a checkpoint each time the observed status CHANGES.
// Checkpoint timestamps are therefore "first observed at" (our sync time), not courier event times.
//
// ⚠️ CONFIRM ON FIRST LIVE SMOKE — the B2B track RESPONSE BODY is login-gated and is NOT in the
//    public docs (only the 14-value status vocabulary + the curl are). The exact field names for
//    the status string / expected-delivery date / delivered timestamp are unknown. extractB2BTrack()
//    is written resiliently (priority field list + a deep scan for a known status token), so it
//    should work regardless of nesting, but once we have creds: hit a real in-transit + delivered
//    LRN, eyeball the JSON, and tighten STATUS_FIELDS / EDD_FIELDS / DELIVERED_FIELDS below.

export const TERMINAL_STAGES = ['delivered', 'rto_delivered', 'lost', 'cancelled'];

// Delhivery B2B status vocabulary (14) → normalized stage + human label.
// Source: one.delhivery.com developer portal, B2B → shipment-tracking status table.
export const B2B_STATUS = {
  MANIFESTED:                { stage: 'manifested',       label: 'Manifested' },
  PICKED_UP:                 { stage: 'picked_up',        label: 'Picked up' },
  LEFT_ORIGIN:               { stage: 'in_transit',       label: 'Left origin' },
  REACH_DESTINATION:         { stage: 'in_transit',       label: 'Reached destination' },
  UNDEL_REATTEMPT:           { stage: 'undelivered',      label: 'Undelivered — reattempting' },
  PART_DEL:                  { stage: 'part_delivered',   label: 'Partially delivered' },
  OFD:                       { stage: 'out_for_delivery', label: 'Out for delivery' },
  DELIVERED:                 { stage: 'delivered',        label: 'Delivered' },
  RETURNED_INTRANSIT:        { stage: 'rto_in_transit',   label: 'Return in transit' },
  RECEIVED_AT_RETURN_CENTER: { stage: 'rto_in_transit',   label: 'Received at return center' },
  RETURN_OFD:                { stage: 'rto_in_transit',   label: 'Return out for delivery' },
  RETURN_DELIVERED:          { stage: 'rto_delivered',    label: 'Return delivered' },
  NOT_PICKED:                { stage: 'not_picked',       label: 'Not picked' },
  LOST:                      { stage: 'lost',             label: 'Lost' },
};

// Tolerate verbose / human-worded variants of the canonical codes the API might return.
const STATUS_ALIASES = {
  OUT_FOR_DELIVERY: 'OFD',
  OUT_FOR_DISPATCH: 'OFD',
  PARTIALLY_DELIVERED: 'PART_DEL',
  PARTIAL_DELIVERY: 'PART_DEL',
  IN_TRANSIT: 'LEFT_ORIGIN',
  INTRANSIT: 'LEFT_ORIGIN',
  REACHED_DESTINATION: 'REACH_DESTINATION',
  PICKEDUP: 'PICKED_UP',
  RETURN_IN_TRANSIT: 'RETURNED_INTRANSIT',
  RTO_IN_TRANSIT: 'RETURNED_INTRANSIT',
  RTO_DELIVERED: 'RETURN_DELIVERED',
  NOT_PICKED_UP: 'NOT_PICKED',
};

// Candidate field names, most-specific first. Used by extractB2BTrack until the live shape is confirmed.
const STATUS_FIELDS    = ['status', 'current_status', 'shipment_status', 'lr_status', 'lrn_status', 'master_status', 'statusType', 'shipmentStatus'];
const EDD_FIELDS       = ['edd', 'expected_delivery_date', 'expectedDeliveryDate', 'expected_date', 'promised_delivery_date', 'pdd', 'sla_eta', 'eta'];
const DELIVERED_FIELDS = ['delivered_date', 'delivery_date', 'delivered_on', 'deliveredDate', 'delivered_at', 'del_date', 'status_datetime', 'statusDateTime', 'last_status_time'];

// Normalize any raw status string to a canonical B2B key (uppercase, alphanum→_), via aliases.
function statusKey(raw) {
  if (raw == null) return null;
  const k = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!k) return null;
  if (B2B_STATUS[k]) return k;
  if (STATUS_ALIASES[k] && B2B_STATUS[STATUS_ALIASES[k]]) return STATUS_ALIASES[k];
  return null;
}

function humanize(raw) {
  if (raw == null) return null;
  return String(raw).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || null;
}

// raw status → { stage, label, raw }. Unknown → stage 'unknown' (UI shows the raw text; ingestion never breaks).
export function mapB2BStatus(raw) {
  const key = statusKey(raw);
  if (key) return { stage: B2B_STATUS[key].stage, label: B2B_STATUS[key].label, raw: key };
  return { stage: 'unknown', label: humanize(raw), raw: raw == null ? null : String(raw) };
}

// "2024-06-20" / "2024-06-20T18:30:00..." → "2024-06-20" (calendar date only).
export function toDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);                                    // tolerate "20 Jun 2024" / "20-06-2024" etc.
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// IST-without-tz ISO (Delhivery's usual format) → UTC ISO. Kept for any timestamped field that surfaces.
export function istToUtc(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) { const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); }
  const ms = (m[3] || '').slice(0, 3).padEnd(3, '0');
  const tz = m[4] ? m[4].replace(/(\d{2})(\d{2})$/, '$1:$2') : '+05:30';   // no tz ⇒ assume IST
  const d = new Date(`${m[1]}T${m[2]}.${ms}${tz === 'Z' ? 'Z' : tz}`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// First value found among candidate keys, searching top-level then one nesting level (data/result/...).
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const ci = {};                                            // case-insensitive top-level index
  for (const k of Object.keys(obj)) ci[k.toLowerCase()] = obj[k];
  for (const k of keys) { const v = ci[k.toLowerCase()]; if (v != null && v !== '') return v; }
  for (const nest of ['data', 'result', 'response', 'shipment', 'lrn', 'lr']) {
    const sub = ci[nest];
    if (sub && typeof sub === 'object') {
      const v = pick(Array.isArray(sub) ? sub[0] : sub, keys);
      if (v != null && v !== '') return v;
    }
  }
  return undefined;
}

// Fallback: deep-scan every string value for one that maps to a known B2B status. Returns the raw key.
function deepFindStatus(obj, depth = 0) {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === 'string') return statusKey(obj);
  if (Array.isArray(obj)) { for (const x of obj) { const k = deepFindStatus(x, depth + 1); if (k) return k; } return null; }
  if (typeof obj === 'object') { for (const v of Object.values(obj)) { const k = deepFindStatus(v, depth + 1); if (k) return k; } }
  return null;
}

// Parse one B2B /lrn/track response into a TrackResult. `lrn` is the queried LR number (the source of truth
// for which shipment this is — we never rely on it appearing in the body). Returns null only if no LRN.
export function extractB2BTrack(json, lrn) {
  if (!lrn) return null;
  const body = (json && typeof json === 'object') ? json : {};

  let rawStatus = pick(body, STATUS_FIELDS);
  if (statusKey(rawStatus) == null) {                       // top-level field absent/unmapped → deep scan
    const found = deepFindStatus(body);
    if (found) rawStatus = found;
  }
  const m = mapB2BStatus(rawStatus);

  const expected_delivery_date = toDate(pick(body, EDD_FIELDS));
  // Delivered timestamp only matters for forward delivery (drives the Snorkel payment-due clock).
  let delivered_at = null;
  if (m.stage === 'delivered') {
    delivered_at = istToUtc(pick(body, DELIVERED_FIELDS)) || new Date().toISOString();   // fall back to now
  }

  return {
    courier: 'delhivery',
    lrn: String(lrn),
    stage: m.stage,
    stage_label: m.label,
    raw_status: m.raw,
    expected_delivery_date,
    delivered_at,
    fetched_at: new Date().toISOString(),
  };
}

// Accumulate our own timeline. existing = current tracking_checkpoints (newest-first array) or null.
// Append a checkpoint ONLY when the observed stage changes (so repeated polls don't pile up dupes).
// observedIso = the sync time we want to stamp the change at (caller passes a single run timestamp).
export function mergeCheckpoint(existing, result, observedIso) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  if (list.length && list[0] && list[0].stage === result.stage) return list;   // unchanged → no new row
  list.unshift({
    timestamp: result.delivered_at || observedIso || result.fetched_at,
    stage: result.stage,
    label: result.stage_label,
    status_code: result.raw_status || null,
    source: 'b2b-poll',                                     // these are observed-at marks, not courier event times
  });
  return list;
}
