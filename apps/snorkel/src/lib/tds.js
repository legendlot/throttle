// The TDS maths behind the Mark-as-Paid flow — no React import here on purpose, so the same
// functions are importable from a plain node:test file in snorkelops-worker/test without
// pulling in Next/React. Keep this file free of JSX/hooks.
//
// ⚠️ snorkelops-worker is a zero-import single file and cannot import out of apps/, so it holds
// an INLINE copy of computeTds (search `TDS — VERBATIM PORT` in snorkelops-worker/src/index.js).
// Same arrangement as poTax.js/computeTax. The tests are the spec both sides must satisfy.
//
// Finance types a RATE (%). The AMOUNT is always derived — a hand-typed rupee figure is the
// error class Priya asked to close (2026-09-09), so nothing here accepts one.

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

// The single definition of the maths.
//   { tdsAmount: null, error: null }  → no TDS on this payment. NULL is "not applicable",
//                                       which is NOT the same as a 0% rate (that IS applicable,
//                                       and is stored as 0/0 for the Tally export's audit trail).
//   { tdsAmount: null, error: '…' }   → the caller must refuse the payment and say why.
// Base is invoice_total, not amount_to_pay: TDS is statutorily computed on the invoice value.
// A part payment (amount_to_pay < invoice_total) is the case flagged back to Priya — see
// reference/decisions.md, "Payment-request TDS".
export function computeTds({ invoiceTotal, rate }) {
  const r = num(rate);
  if (r === null) {
    // Distinguish "absent" from "unparseable": '12x' must not silently mean no TDS.
    if (rate === null || rate === undefined || rate === '') return { tdsAmount: null, error: null };
    return { tdsAmount: null, error: 'TDS rate must be a number' };
  }
  if (r < 0 || r > 100) return { tdsAmount: null, error: 'TDS rate must be between 0 and 100' };
  const total = num(invoiceTotal);
  if (total === null) return { tdsAmount: null, error: 'TDS needs an invoice total to compute on' };
  if (total < 0) return { tdsAmount: null, error: 'Invoice total cannot be negative' };
  return { tdsAmount: round2(total * r / 100), error: null };
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
