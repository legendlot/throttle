// Deal contract (Reann #1, #bugs 1793690997.941679): send brief + contract, creator accepts through
// a tokenised link, Shipping stays locked until then. Pure functions only (no fetch), so every rule
// is unit-tested in test/contract.test.mjs. index.js owns the reads, writes and the Gmail bridge.
//
// ⚠️ No legal wording lives in this file. Dos, don'ts and terms come ONLY from
// ignition.contract_settings, which Reann owns. Until she publishes them, sending and the lock are
// both OFF (wordingPublished is the one switch for both).

// Every stage that means the goods have left or the video is out. Transitions are free (S138), so
// the lock is on the DESTINATION: `planning → live` must not walk around it.
export const SHIP_LOCK_STAGES = ['shipped', 'delivered', 'scheduled', 'posting', 'live'];

// Deal called off. `completed` is a retired legal value (S214) and `live` is the video deal's
// terminal SUCCESS: both refuse a new send or acceptance, but only DEAD_STAGES refuse bank details
// and invoices, because an on-release creator invoices after going live.
const DEAD_STAGES = ['ghosted', 'dropped', 'cancelled', 'retired'];
const TERMINAL_STAGES = [...DEAD_STAGES, 'live', 'completed'];
export const isDeadStage = (stage) => DEAD_STAGES.includes(stage);
export const isTerminalStage = (stage) => TERMINAL_STAGES.includes(stage);

const blank = (v) => v == null || String(v).trim() === '';
const trimmed = (v) => (v == null ? '' : String(v).trim());

export function validEmail(v) {
  // Single address only: a comma or angle bracket here would become extra recipients in the To header.
  return /^[^\s@,;:<>()"'*\\]+@[^\s@,;:<>()"'*\\]+\.[a-z]{2,}$/i.test(trimmed(v));
}

/** Published AND still has the two sections. The one switch for sending and for the lock. */
export function wordingPublished(settings) {
  return !!settings?.published_at && !blank(settings.dos_and_donts) && !blank(settings.terms);
}

// Paid and affiliate deals take bank details and an invoice; barter does not. `paid_plus_affiliate`
// is a legal value in the app's DEAL_TYPE_VALUES (none live today) and contains both.
export function needsPayment(deal) {
  return ['paid', 'affiliate', 'paid_plus_affiliate'].includes(deal?.deal_type);
}
const needsAmount = (deal) => ['paid', 'paid_plus_affiliate'].includes(deal?.deal_type);

const TERMS_WORDS = {
  advance: 'Paid in advance, before you post',
  on_draft: 'Paid once we have your draft',
  on_release: 'Paid once your video is live',
  n_a: 'Not applicable',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function plainDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed(iso));
  return m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : trimmed(iso);
}
const DEAL_WORDS = { paid: 'Paid', barter: 'Barter', affiliate: 'Affiliate', paid_plus_affiliate: 'Paid and affiliate' };

/**
 * The draft a person checks before sending. `blockers` refuse the send (the server re-checks them);
 * `warnings` only inform. `products` are engagement_products rows; a legacy deal with no lines falls
 * back to the mirror on the deal. Gift codes are 100% off and internal (S217): only an active
 * affiliate code is ever printed.
 */
export function composeContract(deal, products, coupons, campaign, settings) {
  const d = deal || {};
  const inf = d.influencer || {};
  const who = trimmed(inf.person_name) || trimmed(inf.channel_name) || 'there';
  const lines = Array.isArray(products) && products.length
    ? products
    : (d.product_code ? [{ product_code: d.product_code, product_variant: d.product_variant, quantity: 1 }] : []);
  const items = lines
    .map(p => `· ${[p.product_code, p.product_variant].filter(Boolean).join(' ')}${Number(p.quantity) > 1 ? ` x ${Number(p.quantity)}` : ''}`)
    .join('\n');
  const code = (coupons || []).find(c => c.kind === 'affiliate' && c.status === 'active');
  const amount = Number(d.payment_amount);
  const hasAmount = Number.isFinite(amount) && amount > 0;

  const out = [`Hi ${who},`, '', `Here are the details of your collaboration with Legend of Toys (${d.engagement_no || 'new deal'}).`, ''];
  if (campaign?.name) out.push(`Campaign: ${campaign.name}`);
  out.push(`Type: ${DEAL_WORDS[d.deal_type] || 'Collaboration'}`, '');
  out.push('What we are sending you:', items || '· (product to be confirmed)', '');
  if (!blank(d.deliverables)) out.push('What we need from you:', trimmed(d.deliverables), '');
  if (!blank(d.expected_post_date)) out.push(`Post date: ${plainDate(d.expected_post_date)}`, '');
  if (d.deal_type !== 'barter' && (hasAmount || (TERMS_WORDS[d.payment_terms] && d.payment_terms !== 'n_a'))) {
    out.push('Payment:');
    if (hasAmount) out.push(`Amount: ₹${amount.toLocaleString('en-IN')}`);
    if (TERMS_WORDS[d.payment_terms] && d.payment_terms !== 'n_a') out.push(`When: ${TERMS_WORDS[d.payment_terms]}`);
    out.push('');
  }
  if (!blank(d.utm_link)) out.push('Your tracking link, please use this one:', trimmed(d.utm_link), '');
  if (code) out.push(`Your discount code: ${code.code}`, '');
  if (!blank(settings?.dos_and_donts)) out.push("Dos and don'ts:", trimmed(settings.dos_and_donts), '');
  if (!blank(settings?.terms)) out.push('Terms:', trimmed(settings.terms), '');
  out.push('Anything unclear, just reply to this email.', '', 'Thanks,', 'Legend of Toys');

  const warnings = [];
  if (!lines.length) warnings.push('No products on this deal yet.');
  if (blank(d.utm_link)) warnings.push('No tracking link on this deal yet, so the contract will not carry one.');
  if (!code) warnings.push('No active affiliate code on this deal, so the contract will not carry one.');

  const blockers = [];
  if (!wordingPublished(settings)) blockers.push('The contract wording has not been published yet.');
  if (!validEmail(inf.email)) blockers.push('There is no valid email address to send this to.');
  if (blank(d.approved_at)) blockers.push('This deal has not been approved yet.');
  if (isTerminalStage(d.stage)) blockers.push(`This deal is closed (${d.stage}).`);
  if (d.engagement_type === 'ugc') blockers.push('UGC deals do not use this contract.');
  if (blank(d.deliverables)) blockers.push('Add the deliverables on Deal terms first.');
  if (blank(d.expected_post_date)) blockers.push('Add the expected post date first.');
  if (needsAmount(d) && !hasAmount) blockers.push('A paid deal needs a payment amount first.');

  const base = trimmed(settings?.subject) || 'Your Legend of Toys collaboration';
  return {
    to: trimmed(inf.email) || null,
    subject: d.engagement_no ? `${base} (${d.engagement_no})` : base,
    body: out.join('\n'),
    warnings,
    blockers,
  };
}

/** What the mail carries: the checked text, then the server's accept link. HTML is escaped. */
export function renderContractEmail(body, link) {
  const text = `${body}\n\nPlease read and accept here:\n${link}\n`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#14171f;white-space:pre-wrap">${esc(body)}</div>`
    + `<p style="margin-top:20px"><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#ff6b00;color:#0a0a0a;font-family:Arial,sans-serif;font-weight:700;text-decoration:none;border-radius:8px">Read and accept</a></p>`
    + `<p style="font-family:Arial,sans-serif;font-size:12px;color:#5b6272">If the button does not work, open this link: ${esc(link)}</p>`;
  return { text, html };
}

/** null = may move. Otherwise the sentence the person sees. Missing flag fails CLOSED (select bug). */
export function shipLockRefusal({ deal, settings, accepted, toStage } = {}) {
  if (!SHIP_LOCK_STAGES.includes(toStage)) return null;
  if (!wordingPublished(settings)) return null;
  if (deal?.engagement_type === 'ugc' || deal?.contract_required === false) return null;
  if (accepted) return null;
  return `The creator has not accepted the contract yet. Send it from the Contract card, or record acceptance by hand, before moving this deal to ${toStage}.`;
}

/** Field-level errors the form shows inline. `clean` is what gets stored; the confirm field is not. */
export function validateBank(input) {
  const src = input && typeof input === 'object' ? input : {};
  const str = (k) => trimmed(typeof src[k] === 'object' ? '' : src[k]);
  const clean = {
    account_name: str('account_name'),
    account_number: str('account_number'),
    ifsc: str('ifsc').toUpperCase(),
    bank_name: str('bank_name') || null,
    upi_id: str('upi_id') || null,
    pan: str('pan').toUpperCase(),
    gstin: str('gstin').toUpperCase() || null,
  };
  const errors = {};
  if (!clean.account_name) errors.account_name = 'Enter the name on the account';
  if (!/^\d{6,18}$/.test(clean.account_number)) errors.account_number = 'Account number should be 6 to 18 digits';
  else if (str('account_number_confirm') !== clean.account_number) errors.account_number_confirm = 'The two account numbers do not match';
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(clean.ifsc)) errors.ifsc = 'IFSC should look like HDFC0001234';
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(clean.pan)) errors.pan = 'PAN should look like ABCDE1234F';
  if (clean.gstin && !/^[A-Z0-9]{15}$/.test(clean.gstin)) errors.gstin = 'GSTIN should be 15 characters';
  if (clean.upi_id && !/^[^\s@]+@[^\s@]+$/.test(clean.upi_id)) errors.upi_id = 'UPI ID should look like name@bank';
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

/** Never the full number or PAN, on any surface. */
export function maskBank(row) {
  const num = row?.account_number == null ? '' : String(row.account_number);
  return {
    received: !!num,
    account_last4: num ? num.slice(-4) : null,
    ifsc: row?.ifsc || null,
    bank_name: row?.bank_name || null,
    submitted_at: row?.submitted_at || null,
  };
}

// An invoice lives at `<engagement_id>/<ts>_<name>`. Same rule as paymentProofPathOk: exact prefix,
// something after it, no empty or dot segments (fetch resolves `..`).
export function invoicePathOk(path, engagementId) {
  const p = typeof path === 'string' ? path : '';
  const prefix = `${engagementId}/`;
  if (!engagementId || !p.startsWith(prefix) || p.length === prefix.length) return false;
  return !p.split('/').some(s => s === '' || s === '.' || s === '..');
}
export const INVOICE_MIMES = ['application/pdf', 'image/jpeg', 'image/png'];

// ── Tokens: 32 random bytes in the mail, only the hash in the database ──────────────────────────
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hashToken(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value ?? '')));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const tokenShapeOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(t);
