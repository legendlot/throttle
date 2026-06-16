// Manifest "Pit Wall" — formatters + semantic tone helpers.
// (All entity data now comes live from the manifestops worker via getBootstrap;
//  these are the pure presentation helpers the screens share.)

const MINUS = '−'; // U+2212 true minus
export const inr = (n) => (Number(n) < 0 ? MINUS : '') + '₹' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-IN');
export const rmb = (n) => '¥' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
export const signedInr = (n) => (Number(n) < 0 ? MINUS : '+') + '₹' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-IN');
export const label = (s) => (s || '').replace(/_/g, ' ');

// ── status → semantic tone ───────────────────────────────────────
export function orderTone(s) {
  if (['placed', 'shipped', 'in_transit'].includes(s)) return 'blue';
  if (['in_production', 'ready'].includes(s)) return 'yellow';
  if (['delivered', 'closed'].includes(s)) return 'green';
  if (s === 'cancelled') return 'red';
  return 'gray';
}
// cost_state (the invoice-billing model's real axis) → tone
export function costStateTone(s) {
  if (s === 'invoiced') return 'green';
  if (s === 'delivered') return 'blue';
  if (s === 'in_flight') return 'yellow';
  return 'gray';
}
export function shipTone(s) {
  if (s === 'in_transit') return 'blue';
  if (s === 'customs') return 'yellow';
  if (['cleared', 'delivered'].includes(s)) return 'green';
  return 'gray';
}
export function ddTone(s) {
  if (s === 'requested') return 'yellow';
  if (s === 'partially_paid') return 'blue';
  if (['paid', 'settled'].includes(s)) return 'green';
  return 'gray';
}
// running_account view kinds
export function kindTone(kind) {
  if (['payment', 'opening_balance'].includes(kind)) return 'green';
  if (['reserved_lien', 'commission_base'].includes(kind)) return 'yellow';
  if (['order_cost', 'commission', 'charge', 'goods'].includes(kind)) return 'red';
  return 'gray';
}
export function docTone(type) {
  if (['PI', 'QC Report'].includes(type)) return 'blue';
  if (type === 'Packing List') return 'gray';
  if (type === 'Bill of Lading') return 'yellow';
  if (['Commercial Invoice', 'Wire Receipt'].includes(type)) return 'green';
  return 'gray';
}
export function userStatusTone(s) { return s === 'active' ? 'green' : 'yellow'; }
