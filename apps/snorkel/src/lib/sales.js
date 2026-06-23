// Offline Sales (GT/MT) constants + helpers. Mirrors the worker's derived fields.

export const ORDER_STATUS_TONES = { draft: 'gray', confirmed: 'blue', cancelled: 'red' };
export function orderStatusLabel(s) {
  return ({ draft: 'Draft', confirmed: 'Confirmed', cancelled: 'Cancelled' })[s] || s || '—';
}

// Fulfilment status is derived from the linked Redline shipment (read-only).
export const FULFILMENT = {
  // legacy (pre-cutover single-shipment orders)
  not_dispatched: { label: 'Not dispatched', tone: 'gray' },
  pending:        { label: 'Pending',        tone: 'yellow' },
  in_progress:    { label: 'In progress',    tone: 'blue' },
  fulfilled:      { label: 'Fulfilled',      tone: 'green' },
  // fulfilment-flow statuses (request → accept → ship)
  not_submitted:       { label: 'Not submitted',       tone: 'gray' },
  awaiting_acceptance: { label: 'Awaiting acceptance', tone: 'yellow' },
  in_fulfilment:       { label: 'In fulfilment',       tone: 'blue' },
  partially_fulfilled: { label: 'Partially fulfilled', tone: 'yellow' },
  fully_fulfilled:     { label: 'Fully fulfilled',     tone: 'green' },
  not_fulfilled:       { label: 'Not fulfilled',       tone: 'red' },
  rejected:            { label: 'Rejected',            tone: 'red' },
  cancelled:           { label: 'Cancelled',           tone: 'red' },
};
// terminal "done" fulfilment states (fully shipped or closed)
export const FULFILMENT_DONE = new Set(['fulfilled', 'fully_fulfilled']);
export function fulfilmentMeta(s) { return FULFILMENT[s] || FULFILMENT.not_submitted; }

export const PAYMENT_STATUS = {
  unpaid:  { label: 'Unpaid',  tone: 'red' },
  partial: { label: 'Partial', tone: 'yellow' },
  paid:    { label: 'Paid',    tone: 'green' },
};
export function paymentMeta(s) { return PAYMENT_STATUS[s] || PAYMENT_STATUS.unpaid; }

export const PAYMENT_MODES = ['bank', 'upi', 'cheque', 'cash', 'other'];

// Indian states / UTs (place-of-supply for GST intra/inter split).
export const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat','Haryana',
  'Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Manipur',
  'Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana',
  'Tripura','Uttar Pradesh','Uttarakhand','West Bengal','Andaman and Nicobar Islands','Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu','Delhi','Jammu and Kashmir','Ladakh','Lakshadweep','Puducherry',
];

export function inr(n) {
  const v = Number(n) || 0;
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Indian FY label for an ISO date: 2026-04..2027-03 → "26-27".
export function fyLabel(dateISO) {
  if (!dateISO) return '';
  const d = new Date(dateISO + 'T00:00:00');
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return String(start % 100).padStart(2, '0') + '-' + String((start + 1) % 100).padStart(2, '0');
}

// Amount in words, Indian numbering (rupees + paise). For the tax invoice.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function threeDigits(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? twoDigits(r) : '');
}
export function amountInWords(amount) {
  const num = Math.round((Number(amount) || 0) * 100);
  let rupees = Math.floor(num / 100);
  const paise = num % 100;
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000);    rupees %= 100000;
  const thousand = Math.floor(rupees / 1000);  rupees %= 1000;
  if (crore) parts.push(threeDigits(crore) + ' Crore');
  if (lakh) parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (rupees) parts.push(threeDigits(rupees));
  let words = parts.join(' ').trim() + ' Rupees';
  if (paise) words += ' and ' + twoDigits(paise) + ' Paise';
  return words + ' Only';
}

export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
