'use client';
import { Card, KV } from './shared.js';

export function LogisticsCard({ e }) {
  return (
    <Card title="Logistics">
      <KV label="Shipping order" value={e.shipping_order_id || '—'} />
      <KV label="Tracking" value={e.tracking_id || '—'} />
      <KV label="Shipping date" value={e.shipping_date || '—'} />
      <KV label="Delivered" value={e.delivered_date || '—'} />
      <ShipmentRows shipment={e.shipment} orderId={e.shipping_order_id} />
      {e.cs_ticket_no && <KV label="Pitstop ticket" value={<span style={{ color: 'var(--state-error-fg)' }}>{e.cs_ticket_no}</span>} />}
    </Card>
  );
}

// ── Shipment status (read-only, derived) ─────────────────────────────────────────────────────
// Courier truth from Uniware, shown ALONGSIDE the hand-entered shipping/delivered dates — it
// never overwrites them. The worker attaches `engagement.shipment`; no `shipment` key means the
// deal has no order id typed and nothing is rendered.
const LIFECYCLE_LABELS = {
  pending: 'Pending', manifested: 'Manifested', in_transit: 'In transit',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered',
  rto: 'RTO', cancelled: 'Cancelled', unknown: 'Unknown',
};
// Same shape as STAGE_PALETTE. ⚠️ RTO deliberately wears the error red and cancelled a neutral
// grey — neither may read like the success green of `delivered`: an RTO is a parcel that came
// BACK, and a glance that mistakes it for a delivery is the exact failure this block exists to stop.
const LIFECYCLE_PALETTE = {
  pending:          { fg: 'var(--text-3)',           bg: 'var(--surface-2)' },
  manifested:       { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  in_transit:       { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  out_for_delivery: { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  delivered:        { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  rto:              { fg: 'var(--state-error-fg)',   bg: 'var(--state-error-bg)' },
  cancelled:        { fg: 'var(--text-3)',           bg: 'var(--surface-2)' },
  unknown:          { fg: 'var(--text-3)',           bg: 'var(--surface-2)' },
};

// The typed courier name, cased for reading. Only an all-lowercase value is touched
// ("porter" → "Porter"); "DTDC" is an acronym and title-casing it to "Dtdc" is damage
// (same reasoning as titleish(), which would do exactly that).
// ⚠️ courierText / courierLabel / trackingUrlFor are COPIED into
// `ignitionops-worker/test/shipment.test.mjs` (this file is JSX and node:test cannot import it).
// Change one, change the other.
function courierText(raw) {
  const s = String(raw || '').trim();
  return s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Courier stamps are IST, always — pinned rather than left to the viewer's machine clock
// (same form as the `Approved` stamp above). A parcel time read in the wrong zone is a
// wrong answer that looks right.
const istStamp = ts => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

// `courier` and `shipping_provider` are two Uniware fields that usually say the SAME thing:
// measured 2026-09-10 over the 256 matched deals, 64 read "self"/"SELF" and 4 "shiprocket"/
// "SHIPROCKET" — 27% would render the name twice. Only Delhivery's provider adds anything
// ("DELHIVERY_SURFACE" = the surface service), so keep the extra and drop the echo.
function courierLabel(courier, provider) {
  const norm = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = String(courier || '').trim();
  const p = String(provider || '').trim();
  if (!c) return courierText(p);
  const cn = norm(c), pn = norm(p);
  if (!pn || pn === cn) return courierText(c);
  // "DELHIVERY_SURFACE" under courier "delhivery" -> "Delhivery · Surface"
  if (pn.startsWith(cn)) {
    // ⚠️ Walk the RAW provider until `cn.length` ALPHANUMERICS are consumed. Slicing it by the raw
    // courier's length instead compared a normalised prefix against raw offsets:
    // courierLabel('D.T.D.C.', 'DTDC Express') rendered "D.T.D.C. · Ress". `courier='other'` with
    // a real provider name exists on 3,029 fleet rows, so this path is reached.
    let seen = 0, i = 0;
    while (i < p.length && seen < cn.length) { if (/[A-Za-z0-9]/.test(p[i])) seen++; i++; }
    const extra = p.slice(i).replace(/^[^A-Za-z0-9]+/, '');
    return extra ? `${courierText(c)} · ${courierText(extra.toLowerCase())}` : courierText(c);
  }
  return `${courierText(c)} · ${courierText(p)}`;
}

// Where the AWB should take you. `ecom_shipments.tracking_link` is the intended source but is a
// DEAD column — 0 of 30,969 rows carry one, ever (measured 2026-09-10) — so it is honoured first
// and then fallen back on.
//
// Delhivery's public tracking page needs no login for status and reflects real per-package state
// (verified 2026-09-10 on two live AWBs: a delivered one reads "Order Delivered", an RTO reads
// "Out for Return" with an expected return date). It covers 187 of the 256 matched deals.
// ⛔ Only Delhivery. `self` has no carrier to link to, and Shiprocket's URL pattern was NOT
// verified — guessing a vendor URL and shipping it to the team is how a dead link gets trusted.
function trackingUrlFor(shipment) {
  // A stored link goes straight into an href, so it is validated first — anything that is not
  // http(s) (a `javascript:` value, say) falls through to the derived URL rather than shipping a
  // click-to-run link onto the deal page.
  const link = String(shipment.tracking_link || '').trim();
  if (/^https?:\/\//i.test(link)) return link;
  const awb = String(shipment.tracking_number || '').trim();
  // ⛔ `courier` ALONE decides the carrier. Concatenating `shipping_provider` matched
  // {courier:'shiprocket', shipping_provider:'Delhivery Surface'} and emitted a Delhivery URL for
  // a Shiprocket parcel — a page that loads and says "not found", which is worse than no link.
  const carrier = String(shipment.courier || '').toLowerCase();
  if (!awb || !carrier.includes('delhivery')) return null;
  return `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`;
}

function LifecycleBadge({ lifecycle }) {
  const p = LIFECYCLE_PALETTE[lifecycle] || LIFECYCLE_PALETTE.unknown;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 8px', fontSize: 11,
      fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: p.fg, background: p.bg,
      border: '1px solid currentColor', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap',
    }}>
      {LIFECYCLE_LABELS[lifecycle] || lifecycle || 'Unknown'}
    </span>
  );
}

function ShipmentRows({ shipment, orderId }) {
  if (!shipment) return null;

  // Neither of these is an error: an id we have not seen yet is usually days old, and a courier
  // NAME typed into the order field is a real hand-delivery record. Muted, never red.
  if (shipment.state === 'pending_sync') {
    return <KV label="Courier" value={<span style={{ color: 'var(--text-3)' }}>Awaiting courier sync</span>} />;
  }
  if (shipment.state === 'other_courier') {
    return (
      <KV label="Courier" value={
        <span style={{ color: 'var(--text-3)' }}>Sent via {courierText(orderId)} — no tracking</span>
      } />
    );
  }

  const name = courierLabel(shipment.courier, shipment.shipping_provider);
  return (
    <>
      <KV label="Courier" value={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <LifecycleBadge lifecycle={shipment.lifecycle} />
          {name && <span>{name}</span>}
          {/* A prefix match came off the leading LOT token of a typed id like "#LOT43838 Complete".
              It is right often enough to show, and a guess often enough to say so. */}
          {shipment.match === 'prefix' && (
            <span style={{ color: 'var(--text-3)', fontSize: 11 }}>matched by order prefix</span>
          )}
        </span>
      } />
      {shipment.tracking_number && (() => {
        const url = trackingUrlFor(shipment);
        return <KV label="AWB" value={url
          ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--state-info-fg)' }}>{shipment.tracking_number}</a>
          : shipment.tracking_number} />;
      })()}
      {shipment.dispatched_at && <KV label="Dispatched" value={istStamp(shipment.dispatched_at)} />}
      {shipment.delivered_at && <KV label="Delivered (courier)" value={istStamp(shipment.delivered_at)} />}
    </>
  );
}
