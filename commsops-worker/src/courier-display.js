// Customer-facing display name for `public.ecom_shipments.courier`.
//
// ⚠️ THIS IS AN ALLOW-LIST, NOT A CAPITALISER, AND THAT IS THE WHOLE POINT.
// The column is not a courier *name* field — it is a routing enum, and two of its seven live
// values are placeholders that read as English words in a sentence:
//
//   measured 2026-09-01 (27,528 non-null rows)
//     delhivery 15,329 · self 6,019 · shadowfax 2,335 · other 2,278
//     shiprocket 795 · xpressbees 628 · bluedart 144
//
// `self` (own delivery) and `other` (unmapped) are 8,297 rows — 30% — and a naive
// `.toUpperCase()` on the first letter ships "your order is on its way with Self." to a real
// customer. So anything not explicitly named here falls back to the generic phrase, which is
// also what a NEW courier value does until someone adds it. Silent generic > confidently wrong.
const COURIER_DISPLAY = {
  delhivery:  'Delhivery',
  shadowfax:  'Shadowfax',
  shiprocket: 'Shiprocket',
  xpressbees: 'XpressBees',
  bluedart:   'Blue Dart',
  // self  -> deliberately absent: LOT's own delivery, not a courier brand.
  // other -> deliberately absent: the unmapped bucket, carries no brand at all.
};

const GENERIC = 'our courier';

// `courierName(v)` -> a brand string safe to drop into customer copy, or 'our courier'.
function courierName(v) {
  if (!v) return GENERIC;
  return COURIER_DISPLAY[String(v).trim().toLowerCase()] || GENERIC;
}

// ⚠️ EVENTS DELIBERATELY CARRY THE RAW VALUE, NOT THIS. `shipment-events.js` and
// `rto-stages.js` emit `courier: s.courier` into the event payload — an event is a DATA record
// and must stay faithful to the column, so segments and analytics can filter on `self` vs
// `delhivery`. Formatting is a RENDER concern and belongs here.
// ⛔ But that means a template variable bound to the `courier` event field would print `self`
// straight to a customer. No live template binds it today (checked 2026-09-01 — the only
// courier-mentioning template, `RTO Picked Up — WhatsApp`, says "our courier partner" as
// literal prose with no such variable). If one ever does, route it through `courierName`
// at render rather than normalising the event.
module.exports = { COURIER_DISPLAY, GENERIC, courierName };
