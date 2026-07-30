// Delhivery ScanPush (B2C webhook) — PURE mappers, no I/O, unit-tested.
//
// Delhivery pushes ONE scan per POST to a URL we register with them (requested 2026-07-25, form
// via Joseph). This is the per-courier BACKUP feed for order lifecycle: the Uniware poller
// (odoops → public.ecom_shipments) stays the PRIMARY normalising layer because LOT ships across
// several couriers. Backup matters because `order_delivered` has never once fired, and Uniware's
// own DTO carries an EMPTY `delivered` field even on delivered packages (reference/integrations.md).
//
// ⚠️ B2C, NOT B2B. normalize.js in this same worker maps the Delhivery **B2B/LTL** vocabulary onto
// `dispatch_shipments`. This file is the **B2C/AWB** vocabulary onto `public.ecom_shipments`. The two
// share nothing but a courier name — do not merge them.
//
// The registered payload is Delhivery's DEFAULT (we accepted it as-is on the form):
//   { "Shipment": { "Status": { "Status", "StatusDateTime", "StatusType", "StatusLocation",
//                               "Instructions" },
//                   "PickUpDate", "NSLCode", "Sortcode", "ReferenceNo", "AWB" } }
//
// LIFECYCLE VOCABULARY IS NOT OURS TO INVENT. It must match odoops' `uniLifecycle()` exactly —
// delivered · rto · out_for_delivery · in_transit · manifested · cancelled · pending — because BOTH
// feeds write the same `ecom_shipments.lifecycle` column and commsops' emitter keys
// `emitted_lifecycles` off that value. A vocabulary drift here would double-emit (one event per
// spelling) instead of dedup.

// Delhivery StatusType is the coarse bucket and is the most reliable signal in the payload.
// UD = undelivered/in-transit · DL = delivered · RT = return-to-origin · PP = pickup pending ·
// CN = cancelled · LT = lost.
const STATUS_TYPE = {
  DL: 'delivered',
  RT: 'rto',
  CN: 'cancelled',
  PP: 'manifested',
  UD: null,          // too coarse on its own — refine via Status text below
  LT: null,
};

// Free-text `Status` refinements, checked in order. First match wins, so the most specific
// phrasings come first ("out for delivery" before "transit").
const STATUS_TEXT = [
  [/\brto\b|return to origin|returned to origin|return accepted/i, 'rto'],
  [/\bdelivered\b/i,                                              'delivered'],
  [/out for delivery|\bofd\b/i,                                   'out_for_delivery'],
  [/manifest/i,                                                   'manifested'],
  [/cancel/i,                                                     'cancelled'],
  [/in ?transit|dispatched|picked ?up|bagged|received at|left origin|reached/i, 'in_transit'],
  [/pending|not picked/i,                                         'pending'],
];

// `Instructions` is Delhivery's own free-text description of the scan, and for out-for-delivery it
// is the ONLY field that says so. `Status` is far too coarse: measured over 7 days, a single
// `Status: "Dispatched"` covers FIVE different events, separated only by Instructions —
//   X-DDD3FD/UD "Out for delivery" 269 · ST-114/UD "Call placed to consignee" 165 ·
//   PL-105/UD "Paid through link" 37 · X-DDD3FD/RT "Dispatched for RTO" 84 ·
//   X-DDD3FP/PP "Out for pickup" 27
// So mapping OFD off `Status`+`StatusType` (the shape this fix was first scoped as) would have told
// 202 customers in 7 days that their parcel was out for delivery when Delhivery had actually placed
// a phone call or received a payment-link settlement. We read the vendor's words instead of
// inferring from a status string, and we consult Instructions ONLY for out_for_delivery so that
// every other lifecycle classification is byte-identical to before.
const OFD_TEXT = /out for delivery|\bofd\b/i;

// Delhivery NSL codes carry the RT-*/DL-*/UD-* family prefix. Used as a tie-breaker only — the
// suffix vocabulary is long and undocumented in the form, so we read ONLY the family prefix.
function nslLifecycle(nsl) {
  const c = String(nsl || '').toUpperCase();
  if (/^RT[-_]/.test(c)) return 'rto';
  if (/^DL[-_]/.test(c)) return 'delivered';
  return null;
}

/**
 * Map one scan to the shared lifecycle vocabulary. Returns null when the scan is genuinely
 * unclassifiable — the caller CAPTURES it rather than guessing, so an unseen code shows up as a
 * discovery row instead of a wrong customer message.
 */
export function scanLifecycle({ status, statusType, nslCode, instructions } = {}) {
  // RTO detection outranks everything: a return leg still emits "delivered"-ish text
  // ("RTO Delivered"), and calling that a delivery would tell a customer their order arrived
  // when it actually came back to us. Check the RT family first, always.
  const nsl = nslLifecycle(nslCode);
  if (nsl === 'rto') return 'rto';
  const st = String(statusType || '').toUpperCase().trim();
  if (st === 'RT') return 'rto';
  if (/\brto\b|return/i.test(String(status || ''))) return 'rto';

  if (STATUS_TYPE[st]) return STATUS_TYPE[st];

  // Out-for-delivery, from the vendor's own wording. Deliberately placed AFTER the coarse
  // StatusType buckets (so a DL/CN/PP scan keeps its bucket) and BEFORE the Status text ladder
  // (whose `dispatched` → in_transit rule is what swallowed every OFD scan until now). Reached
  // only on UD and on an unrecognised StatusType, which is exactly the forward-leg case — the RT
  // return leg has already returned 'rto' above and stays on its own emitter (rto-stages.js).
  if (OFD_TEXT.test(String(instructions || ''))) return 'out_for_delivery';

  for (const [re, life] of STATUS_TEXT) if (re.test(String(status || ''))) return life;
  if (nsl) return nsl;
  if (st === 'UD') return 'in_transit';   // undelivered-but-moving is the UD default
  return null;
}

// Delhivery sends "2019-01-09T17:10:42.767" with NO timezone — it is IST, not UTC. Reading it as
// UTC would date a delivery 5h30m early and could push it to the previous IST day.
export function scanTimestamp(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(' ', 'T');
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {          // already zoned — trust it
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(`${s}+05:30`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Normalize one ScanPush body into a flat record. Tolerant of shape drift (the Shopflo lesson:
 * the real wire shape differed from the vendor's own doc), so every field is looked up in both the
 * documented nesting and at the top level.
 */
export function parseScanPush(body) {
  const b = body || {};
  const sh = b.Shipment || b.shipment || b;
  const stObj = sh.Status || sh.status || {};
  const pick = (...names) => {
    for (const src of [stObj, sh, b]) {
      for (const n of names) {
        const v = src?.[n];
        if (v !== undefined && v !== null && v !== '') return v;
      }
    }
    return null;
  };
  const awb = pick('AWB', 'awb', 'waybill', 'Waybill');
  const status = pick('Status', 'status');
  const statusType = pick('StatusType', 'statusType', 'status_type');
  const nslCode = pick('NSLCode', 'nslCode', 'nsl_code');
  // Hoisted (rather than read inline below) because the lifecycle mapper needs it: Instructions is
  // the only field that distinguishes out-for-delivery from the four other things Delhivery calls
  // "Dispatched". It was already being persisted and simply never handed to scanLifecycle.
  const instructionsRaw = pick('Instructions', 'instructions') || null;
  return {
    awb: awb == null ? null : String(awb).trim(),
    status: status == null ? null : String(status),
    statusType: statusType == null ? null : String(statusType),
    nslCode: nslCode == null ? null : String(nslCode),
    statusLocation: pick('StatusLocation', 'statusLocation') || null,
    instructions: instructionsRaw,
    referenceNo: pick('ReferenceNo', 'referenceNo', 'reference_no') || null,
    statusAt: scanTimestamp(pick('StatusDateTime', 'statusDateTime', 'status_datetime')),
    lifecycle: scanLifecycle({ status, statusType, nslCode, instructions: instructionsRaw }),
  };
}

// One POST could carry a single Shipment or a batch — accept both so a future batching change on
// Delhivery's side does not silently drop scans.
export function parseScanPushBatch(body) {
  const b = body || {};
  const arr = Array.isArray(b) ? b
    : Array.isArray(b.Shipments) ? b.Shipments
    : Array.isArray(b.shipments) ? b.shipments
    : [b];
  return arr.map(parseScanPush).filter((s) => s.awb || s.status);
}

// Constant-time-ish compare so the shared token can't be probed by response timing.
export function tokenMatches(provided, expected) {
  const a = String(provided ?? ''), e = String(expected ?? '');
  if (!e || !a || a.length !== e.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ e.charCodeAt(i);
  return diff === 0;
}
