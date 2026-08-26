// Verified order-status lookup for the web bot (spec §guards). The ingress is PUBLIC and
// LOT order numbers are SEQUENTIAL: an unverified lookup is an enumeration hole over
// names/addresses/purchases. So: the collected identity must match the order's own
// phone/email, server-side, before ANY status is revealed. order_not_found and
// identity_mismatch return the SAME customer-facing branch (not_found) upstream —
// distinguishing them would confirm which order numbers exist.
const SHOP = require('./shopify.js');
const A = require('./auth.js');
const sbPublic = A.sbProfile('public');

function identityMatches(given, order) {
  if (given?.phone && order?.phone) return String(order.phone).replace(/\D/g, '').slice(-10) === String(given.phone).replace(/\D/g, '').slice(-10);
  if (given?.email && order?.email) return String(order.email).toLowerCase() === String(given.email).toLowerCase();
  return false;   // no overlap of kinds, or nothing collected -> NEVER a match
}

function statusTextFor(sh) {
  if (!sh) return 'Your order is confirmed and being processed — we will message you as soon as it ships.';
  const trk = sh.tracking_link ? `\nTrack it live: ${sh.tracking_link}` : '';
  switch (sh.lifecycle) {
    case 'delivered':        return `Your order was delivered${sh.delivered_at ? ` on ${new Date(sh.delivered_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}. Enjoy!`;
    case 'out_for_delivery': return `Great news — your order is out for delivery today with ${sh.courier || 'our courier'}.${trk}`;
    case 'in_transit':       return `Your order is on its way with ${sh.courier || 'our courier'}.${trk}`;
    case 'manifested':       return `Your order is packed and ready for pickup by ${sh.courier || 'our courier'}.${trk}`;
    case 'rto':              return 'This shipment is returning to us. Our support team can help — pick "Chat with an agent".';
    case 'cancelled':        return 'This order shows as cancelled. If that is unexpected, pick "Chat with an agent".';
    default:                 return 'Your order is confirmed and being prepared for dispatch.';
  }
}

async function defaultFetchOrder(env, orderName) {
  const q = `{ orders(first: 1, query: "name:${orderName.replace(/"/g, '')}") { nodes { name email phone customer { phone email } } } }`;
  const d = await SHOP.shopifyGraphQL(env, q).catch(() => null);
  const o = d?.orders?.nodes?.[0];
  if (!o) return null;
  return { name: o.name, phone: o.phone || o.customer?.phone || null, email: o.email || o.customer?.email || null };
}

async function defaultFetchShipment(env, orderName) {
  const r = await sbPublic(`/rest/v1/ecom_shipments?shopify_order_name=eq.${A.enc(orderName)}&select=lifecycle,courier,tracking_link,delivered_at&order=updated_at.desc&limit=1`, env)
    .catch(() => ({ ok: false }));
  return (r.ok && r.data?.[0]) || null;
}

async function lookupOrderStatus(env, { orderNumber, identity }, deps = {}) {
  if (!identity || (!identity.phone && !identity.email)) return { ok: false, reason: 'no_identity' };
  const fetchOrder = deps.fetchOrder || ((n) => defaultFetchOrder(env, n));
  const fetchShipment = deps.fetchShipment || ((n) => defaultFetchShipment(env, n));
  const order = await fetchOrder(orderNumber);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (!identityMatches(identity, order)) return { ok: false, reason: 'identity_mismatch' };
  const sh = await fetchShipment(orderNumber);
  return { ok: true, statusText: statusTextFor(sh) };
}

module.exports = { lookupOrderStatus, statusTextFor, identityMatches };
