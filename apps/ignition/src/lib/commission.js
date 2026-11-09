// Monthly affiliate commission (Reann #3, S3). Pure helpers shared by the Commission page, the deal
// page's Commission card and the Payments card. The money rules live in the database (0008) and the
// worker; these only decide what to show and catch the obvious mistakes before a round trip.

// Decision 2: no statement exists before November 2026 (DB check), so the picker never offers one.
export const COMMISSION_FIRST_MONTH = '2026-11';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function prevMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

export function monthLabel(m) {
  if (!m || !/^\d{4}-\d{2}/.test(m)) return m || '';
  const [y, mo] = m.slice(0, 7).split('-').map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
}

/** Months the picker offers, newest first: the current IST month back to the first commission month. */
export function commissionMonths(current) {
  const out = [];
  for (let m = current; m >= COMMISSION_FIRST_MONTH; m = prevMonth(m)) out.push(m);
  return out.length ? out : [COMMISSION_FIRST_MONTH];
}

/** The picker's default: last IST month (the one D2C verifies), never before the first month. */
export function defaultCommissionMonth(current) {
  const p = prevMonth(current);
  return p < COMMISSION_FIRST_MONTH ? (current < COMMISSION_FIRST_MONTH ? COMMISSION_FIRST_MONTH : current) : p;
}

const paise = n => Math.round(Number(n) * 100);

/** A difference from the estimate needs a reason (the DB's verified_complete check says the same). */
export function reasonRequired(amount, estimate) {
  if (amount === '' || amount == null || !Number.isFinite(Number(amount))) return false;
  return paise(amount) !== paise(estimate);
}

/** The Verify form's problem sentence, or null. Mirrors the worker: ₹0 or more, at most 2 decimals. */
export function verifyProblem(amount, estimate, reason) {
  const s = String(amount ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 'Enter the verified amount (₹0 or more, up to 2 decimals).';
  if (reasonRequired(s, estimate) && !String(reason || '').trim()) {
    return "The amount is different from Ignition's estimate — add the reason for the difference.";
  }
  return null;
}

const DEAD = ['rejected', 'cancelled'];
const IN_SNORKEL = ['sending', 'submitted', 'pending_approval', 'approved'];
const inr = n => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** What happened to a statement's payment, in words + a tone (success | warning | error | info | neutral). */
export function requestStatus(st) {
  const q = st?.request;
  if (st?.state !== 'verified') return { label: 'Not verified yet', tone: 'neutral' };
  if (!q) return Number(st.verified_amount) > 0 ? { label: 'Not raised', tone: 'warning' } : { label: 'Nothing to pay', tone: 'neutral' };
  if (q.state === 'waiting_for_invoice') return { label: 'Waiting for invoice', tone: 'warning' };
  if (q.state === 'send_failed') return { label: 'Send to Snorkel failed', tone: 'error' };
  if (q.state === 'held') return { label: 'Held in Snorkel', tone: 'warning' };
  if (IN_SNORKEL.includes(q.state)) return { label: 'In Snorkel', tone: 'info' };
  if (q.state === 'paid') {
    // Gross, as the Payments card shows it: what Finance paid plus the TDS it held back.
    const tds = Number(q.tds_amount) || 0;
    const gross = q.paid_amount != null ? Number(q.paid_amount) + tds : Number(q.amount);
    return { label: `Paid ${inr(gross)}${tds > 0 ? ` · TDS ${inr(tds)}` : ''}${q.utr ? ` · UTR ${q.utr}` : ''}`, tone: 'success' };
  }
  if (q.state === 'rejected') return { label: 'Rejected', tone: 'error' };
  if (q.state === 'cancelled') return { label: 'Cancelled', tone: 'neutral' };
  return { label: q.state, tone: 'neutral' };
}

const requestDead = st => !st.request || DEAD.includes(st.request.state);

/** Verify: an estimated month that is over. (Permission is the caller's check.) */
export const canVerify = st => st.state === 'estimated' && !st.month_open;
/** Re-raise: verified for more than ₹0 and no live or paid request on it. */
export const canReraise = st => st.state === 'verified' && Number(st.verified_amount) > 0 && requestDead(st);
/** Reopen (admins): verified and no live or paid request on it — the DB refuses otherwise. */
export const canReopen = st => st.state === 'verified' && requestDead(st);

/** Totals row: orders, net sales, estimate, and the verified amounts of verified months. */
export function commissionTotals(statements) {
  const t = { orders: 0, net_sales: 0, estimate: 0, verified: 0 };
  for (const s of statements || []) {
    t.orders += Number(s.orders) || 0;
    t.net_sales += Number(s.net_sales) || 0;
    t.estimate += Number(s.estimate) || 0;
    if (s.state === 'verified') t.verified += Number(s.verified_amount) || 0;
  }
  for (const k of ['net_sales', 'estimate', 'verified']) t[k] = paise(t[k]) / 100;
  return t;
}

/** The Payments card's label for a commission request: "Commission · Nov 2026" when the month is known. */
export function commissionRequestLabel(month) {
  return month ? `Commission · ${monthLabel(month)}` : 'Commission';
}
