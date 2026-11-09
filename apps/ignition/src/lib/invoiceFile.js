// A creator invoice file (Reann #1 / #2): the creator's link and the deal page's upload check the
// same things before asking for an upload URL. The worker (INVOICE_MIMES) and the bucket
// (ignition-creator-invoices: 10 MB, these three types) enforce it again.
export const INVOICE_TYPES = { 'application/pdf': 1, 'image/jpeg': 1, 'image/png': 1 };
export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
export const INVOICE_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
