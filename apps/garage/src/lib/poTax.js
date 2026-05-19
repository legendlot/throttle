// Shared GST/tax computation for Purchase Orders.
// Used by:
//   - pos/new/page.js          (live grand-total preview)
//   - pos/[poNumber]/PODetailClient.js  (totals block + line columns)
//   - pos/print/page.js        (printed PO totals)
//
// Rules:
//   - currency !== 'INR'  → no GST shown (CN/RMB vendors are exempt)
//   - vendor GSTIN state code === company state code (default '29' / Karnataka)
//       → CGST + SGST split 50/50
//   - vendor GSTIN state code differs (or vendor has no GSTIN — assume intra-state)
//       → IGST = full GST amount, no split
//
// LOT company GSTIN: 29AAFCF7834H1ZA (state 29 = Karnataka).

const DEFAULT_COMPANY_GSTIN = '29AAFCF7834H1ZA';

function lineAmount(l) {
  const tv = parseFloat(l.total_value);
  if (Number.isFinite(tv)) return tv;
  const q = parseFloat(l.qty_ordered) || 0;
  const p = parseFloat(l.unit_price) || 0;
  return q * p;
}

export function computeTax(lines, currency, vendorGstin = null, companyGstin = DEFAULT_COMPANY_GSTIN) {
  const list = Array.isArray(lines) ? lines : [];

  const taxable = list.reduce((s, l) => s + lineAmount(l), 0);

  if (currency !== 'INR') {
    return {
      taxable,
      gst: 0, cgst: 0, sgst: 0, igst: 0,
      grand: taxable,
      showGst: false,
      isCgstSgst: false,
      halfRate: 0,
      fullRate: 0,
    };
  }

  const gst = list.reduce((s, l) => {
    const amt = lineAmount(l);
    const pct = parseFloat(l.gst_percent) || 0;
    return s + (amt * pct) / 100;
  }, 0);

  const companyState = (companyGstin || DEFAULT_COMPANY_GSTIN).substring(0, 2);
  const vendorState  = vendorGstin ? String(vendorGstin).substring(0, 2) : null;
  // No vendor GSTIN → treat as intra-state (CGST+SGST). Matches the
  // "vendor with no GSTIN → assume intra-state" rule from the spec.
  const isCgstSgst = !vendorState || vendorState === companyState;

  const blended = taxable > 0 ? (gst / taxable) * 100 : 0;
  const halfRate = Math.round((blended / 2) * 10) / 10;  // one decimal
  const fullRate = Math.round(blended * 10) / 10;

  return {
    taxable,
    gst,
    cgst: isCgstSgst ? gst / 2 : 0,
    sgst: isCgstSgst ? gst / 2 : 0,
    igst: isCgstSgst ? 0 : gst,
    grand: taxable + gst,
    showGst: true,
    isCgstSgst,
    halfRate,
    fullRate,
  };
}

export const COMPANY_GSTIN = DEFAULT_COMPANY_GSTIN;
