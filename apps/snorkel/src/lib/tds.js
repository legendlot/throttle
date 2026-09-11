// The TDS maths behind the Mark-as-Paid flow — no React import here on purpose, so the same
// functions are importable from a plain node:test file in snorkelops-worker/test without
// pulling in Next/React. Keep this file free of JSX/hooks.
//
// ⚠️ snorkelops-worker is a zero-import single file and cannot import out of apps/, so it holds
// an INLINE copy of computeTds (search `TDS — VERBATIM PORT` in snorkelops-worker/src/index.js).
// Same arrangement as poTax.js/computeTax. The tests are the spec both sides must satisfy, and
// test/tds-parity.test.mjs lifts the worker copy and asserts it agrees with this one.
//
// Finance types a RATE (%) and picks the invoice's GST rate. The BASE (taxable value) and the
// AMOUNT are always derived — a hand-typed rupee figure is the error class Priya asked to close
// (2026-09-09), so nothing here accepts one.

// PostgREST hands back `numeric` columns as STRINGS ('1500.00'), and the rate arrives from an
// <input> as a string too. Everything below goes through this, never through a bare arithmetic op.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Money rounds to 2 decimals. + Number.EPSILON so 1.005 does not land on 1.00.
export function round2(v) {
  const n = num(v);
  if (n === null) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The GST rates Finance picks from at Mark-as-Paid. The picker offers these and nothing else, and
// computeTds refuses anything else, so a typo can never silently shrink the base.
export const GST_RATES = [0, 5, 12, 18, 28];

// Absent = null / undefined / blank-or-whitespace string. Shared by the rate and the GST rate.
// ⚠️ WHITESPACE COUNTS AS ABSENT, and that is not cosmetic: `Number('  ') === 0`, so a
// space-only rate used to write a REAL "0% TDS applied" — the same Number('')===0
// false-positive this workspace has been bitten by before, and the same consequence as the
// non-scalar case below. Not reachable from the UI (the client `.trim()`s before sending) but
// reachable by any direct POST. Trim only for the ABSENT test; the raw value still flows on,
// so '  5  ' keeps working.
function absent(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// The single definition of the maths.
//   { tdsAmount: null, tdsBase: null, error: null } → no TDS on this payment. NULL is "not
//                                       applicable", which is NOT the same as a 0% rate (that IS
//                                       applicable, and is stored as 0/0 for the Tally export's
//                                       audit trail).
//   { tdsAmount: null, tdsBase: null, error: '…' }  → the caller must refuse the payment and say why.
// BASE = the TAXABLE value, ex-GST (Mahesh, 2026-09-11 — reference/decisions.md, "Payment-request
// TDS base = the TAXABLE value"). It is DERIVED from invoice_total and the GST rate Finance picks:
// taxable = invoice_total ÷ (1 + GST%/100). Finance never types a rupee figure. The base is still
// the whole invoice, not amount_to_pay: a part payment deducts TDS on the full invoice's taxable
// value (the prior-TDS warning covers the tranche-2 case).
// tdsAmount is computed from the ROUNDED base, so it reproduces exactly from the two stored
// columns (tds_base × tds_rate / 100) — the Tally export shows both.
export function computeTds({ invoiceTotal, rate, gstRate }) {
  // Absent = not applicable. Checked FIRST, because `null` is typeof 'object' and would be
  // caught by the type guard below.
  if (absent(rate)) return { tdsAmount: null, tdsBase: null, error: null };
  const fail = error => ({ tdsAmount: null, tdsBase: null, error });
  // S370: reject on TYPE before coercing — same guard shape, and the same defect class, as
  // parseDeliveryAddressId in deliveryAddress.js (fixed the same day). Number() coerces:
  // `[]`→0, `true`→1, `[5]`→5, `false`→0, so a non-scalar payload used to write a FALSE
  // "0% TDS applied". A 0 here is NOT harmless — hasTds() calls it real, the UIs render
  // "less 0% TDS" and buildPaymentsExportCsv writes it into a column Finance reconciles
  // against a bank statement.
  if (typeof rate !== 'string' && typeof rate !== 'number') return fail('TDS rate must be a number');
  const r = num(rate);
  // Unparseable: '12x' must not silently mean no TDS.
  if (r === null) return fail('TDS rate must be a number');
  if (r < 0 || r > 100) return fail('TDS rate must be between 0 and 100');
  // A rate is present, so the GST rate is REQUIRED — same absent/type guards as the rate. An
  // absent GST rate must never default to 0 here: ÷1 would deduct on the GST-inclusive total,
  // which is the exact error this field was changed to close.
  if (absent(gstRate)) return fail("Pick the invoice's GST rate");
  if (typeof gstRate !== 'string' && typeof gstRate !== 'number')
    return fail('GST rate must be one of 0, 5, 12, 18, 28');
  const g = num(gstRate);
  if (g === null || !GST_RATES.includes(g)) return fail('GST rate must be one of 0, 5, 12, 18, 28');
  const total = num(invoiceTotal);
  if (total === null) return fail('TDS needs an invoice total to compute on');
  if (total < 0) return fail('Invoice total cannot be negative');
  const tdsBase = round2(total / (1 + g / 100));
  return { tdsAmount: round2(tdsBase * r / 100), tdsBase, error: null };
}

// The GST% the Mark-as-Paid picker starts on (decisions.md, 2026-09-11): the linked PO's rate →
// else the payee's VENDOR's usual PO rate → else 18 if the payee has a GSTIN → else 0.
// `poGstRate` is the worker's `po_gst_rate` — the ONE distinct po_lines.gst_percent on the linked
// PO, or null when there is no PO, no rate, or the PO mixes rates. `vendorGstRate` is the worker's
// `vendor_gst_rate` (view store.v_vendor_po_gst_rate — every INR PO line of that vendor at one
// rate, else null). The vendor step exists because GSTINs are simply not recorded for most vendors
// (27 of 41 requests' payees had none, 18 of them vendors billing GST at one rate — S376), so the
// GSTIN test alone started registered vendors at 0% and reproduced the over-deduction.
// A rate outside GST_RATES is not a picker option, so it falls through too.
// A default only: Finance can change it, and computeTds validates whatever is finally picked.
export function defaultGstRate({ poGstRate, vendorGstRate, payeeGstin } = {}) {
  const pick = v => {
    const n = (typeof v === 'string' || typeof v === 'number') ? num(v) : null;
    return n !== null && GST_RATES.includes(n) ? n : null;
  };
  const po = pick(poGstRate);
  if (po !== null) return po;
  const vendor = pick(vendorGstRate);
  if (vendor !== null) return vendor;
  return typeof payeeGstin === 'string' && payeeGstin.trim() !== '' ? 18 : 0;
}

// What actually leaves the bank. No TDS → the amount to pay, unchanged, byte for byte.
export function netPayable({ amountToPay, tdsAmount }) {
  const amt = num(amountToPay);
  if (amt === null) return null;
  const tds = num(tdsAmount);
  if (tds === null) return round2(amt);
  return round2(amt - tds);
}

// True only when a request actually carries TDS. Every display site gates on this rather than on
// truthiness — a 0% rate is real and must render, and a NULL one must render NOTHING (never "0%").
export function hasTds(r) {
  return r?.tds_rate !== null && r?.tds_rate !== undefined && r?.tds_rate !== '';
}
