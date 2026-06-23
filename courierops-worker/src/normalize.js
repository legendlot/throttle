// Courier-agnostic tracking model + the Delhivery normalizer. PURE (no I/O) so it is unit-tested
// and reused by future couriers/returns. Delhivery quirks handled here: map on StatusType+StatusCode
// (not the free-text status) for terminal decisions; IST→UTC on every timestamp; preserve raw codes.

export const TERMINAL_STAGES = ['delivered', 'rto_delivered', 'cancelled', 'lost'];

// Delhivery timestamps are ISO-8601 WITHOUT timezone = IST; may carry microseconds. → UTC ISO (ms).
export function istToUtc(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const ms = (m[3] || '').slice(0, 3).padEnd(3, '0');
  const d = new Date(`${m[1]}T${m[2]}.${ms}+05:30`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// EDD is an IST end-of-day stamp; we only want the calendar date.
function toDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// StatusType + StatusCode → normalized stage. text only refines the non-terminal UD bucket display.
function mapStage(statusType, statusCode, statusText) {
  const t = (statusType || '').toUpperCase();
  const c = (statusCode || '').toUpperCase();
  const txt = (statusText || '').toLowerCase();
  if (t === 'DL') return c.startsWith('DTO') ? 'rto_delivered' : 'delivered';
  if (t === 'CN') return 'cancelled';
  if (t === 'RT' || c.startsWith('RTO')) return c.startsWith('DTO') ? 'rto_delivered' : 'rto_in_transit';
  if (t === 'PU' || t === 'PP') return 'rto_in_transit';            // reverse-pickup legs (returns, V2)
  if (t === 'UD') {
    if (txt.includes('manifest')) return 'manifested';
    if (txt.includes('out for delivery') || txt.includes('out-for-delivery') || txt.includes('dispatched for delivery')) return 'out_for_delivery';
    if (txt.includes('undelivered') || txt.includes('not delivered') || txt.includes('ndr')) return 'undelivered';
    return 'in_transit';
  }
  return 'unknown';
}

function checkpoint(detail) {
  return {
    timestamp: istToUtc(detail.ScanDateTime),
    stage: mapStage(detail.ScanType, detail.StatusCode, detail.Scan),
    label: detail.Scan || null,
    status_code: detail.StatusCode || null,   // raw — never whitelisted, so new codes never break ingestion
    location: detail.ScannedLocation || null,
    description: detail.Instructions || null,
  };
}

// shipment = one ShipmentData[].Shipment object (pull API). Returns a TrackResult, or null if no AWB.
export function normalizeDelhivery(shipment) {
  if (!shipment) return null;
  const st = shipment.Status || {};
  const stage = mapStage(st.StatusType, st.StatusCode, st.Status);
  const checkpoints = (shipment.Scans || [])
    .map(s => checkpoint(s.ScanDetail || {}))
    .filter(c => c.timestamp)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));   // newest-first
  const delivered_at = stage === 'delivered'
    ? istToUtc(shipment.DeliveryDate || st.StatusDateTime)
    : null;
  return {
    courier: 'delhivery',
    awb: shipment.AWB || shipment.Waybill || null,
    stage,
    stage_label: st.Status || null,
    expected_delivery_date: toDate(shipment.ExpectedDeliveryDate),
    delivered_at,
    checkpoints,
    fetched_at: new Date().toISOString(),
  };
}
