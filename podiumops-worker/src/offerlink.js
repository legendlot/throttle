// Podium O1 — the offer email + the candidate's acceptance link. The pure rules: token, name match, what a
// live link can do (D7), the MIME message, the email bodies, the joining-document paths, the bank validator.
// Copied (not shared) from Ignition S441 (ignitionops-worker/src/contract.js) and csops partner-email.js.
// Plan: docs/superpowers/plans/2026-11-12-podium-o1-offer-link.md · tests: test/offerlink.test.mjs
// No salary figure is ever put in an email body, an alert or a notice by this module.

import { addDaysIso, safeFileName } from './hiring.js';
import { fmtLetterDate } from './offer-render.js';

// ── Token: 32 random bytes, base64url (43 chars). Only the SHA-256 hex is stored. ──
export function newLinkToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hashLinkToken(t) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t ?? '')));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const linkTokenShapeOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

// ── Name match: case, spacing and Unicode width ignored ("Asha  K" = "asha k" = "ASHAK"). ──
export function normName(s) { return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }
export function namesMatch(typed, onOffer) {
  const a = normName(typed), b = normName(onOffer);
  return !!a && a === b;
}
export const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

// ── Decline reasons (offer_responses.reason) ──
export const DECLINE_REASONS = {
  compensation: 'Compensation',
  role: 'The role',
  location: 'Location',
  another_offer: 'I have accepted another offer',
  personal: 'Personal reasons',
  other: 'Something else',
};
export const declineReasonList = () => Object.entries(DECLINE_REASONS).map(([code, label]) => ({ code, label }));
export const TEXT_MAX = 2000;

// ── D6: one live link per revision ──
// A link (an offer_emails row of kind 'offer') is live when it is not revoked, its mail did not fail, and no
// NEWER kind-'offer' email of the same offer is live-ish (sending / sent / unknown). A failed resend therefore
// leaves the previous link working; a successful one revokes it. Mirrors podium.offer_link_live (0012).
export const LINK_EMAIL_STATUSES = ['sending', 'sent', 'unknown'];
export function isLinkLive(row, offerEmails) {
  if (!row || row.kind !== 'offer' || row.link_revoked_at || !LINK_EMAIL_STATUSES.includes(row.status)) return false;
  const t = Date.parse(row.created_at);
  return !(offerEmails || []).some(e => e.id !== row.id && e.offer_id === row.offer_id && e.kind === 'offer'
    && LINK_EMAIL_STATUSES.includes(e.status) && Date.parse(e.created_at) > t);
}

// ── D7: what a live link can do ──
export const LINK_INVALID = 'This link is no longer valid.';
export const PREPARING_NOTICE = 'Your offer is being prepared — please try again in a few minutes.';
export function linkState({ offer, today, startPlus7 = null, ownerFirst = '' }) {
  const who = ownerFirst || 'the Legend of Toys team';
  const notice = (n) => ({ mode: 'notice', notice: n });
  const s = offer?.status;
  if (s === 'sent') {
    if (!offer.valid_until || today <= offer.valid_until) return { mode: 'respond', notice: null };
    return notice(`This offer has expired — contact ${who}.`);
  }
  if (s === 'accepted') {
    const until = startPlus7 || (offer.start_date ? addDaysIso(offer.start_date, 7) : null);
    if (!until || today <= until) return { mode: 'documents', notice: null };
    return notice(`The joining-documents step has closed — contact ${who}.`);
  }
  // I: a live link on a still-`ready` revision = the send has not settled yet (the worker reconciles first).
  if (s === 'ready') return notice(PREPARING_NOTICE);
  if (s === 'superseded') return notice('This offer has been replaced — check your latest email.');
  if (s === 'expired') return notice(`This offer has expired — contact ${who}.`);
  return notice(`This offer is no longer open — contact ${who}.`);
}

// podium_<code> raised by the 0012 RPCs (and the transition's own stale / not_latest) → a code.
export function linkDbErrorCode(data) {
  const d = data && typeof data === 'object' ? data : {};
  const msg = String(d.message || '');
  const m = msg.match(/^podium_([a-z_]+)$/);
  if (m) return m[1];
  if (msg === 'stale' || msg === 'not_latest') return msg;
  if (d.code === '23505') return 'conflict';
  if (d.code === '23514') return 'check_failed';
  return null;
}

// ── MIME (header rules from csops partner-email.js) ──
const stripCrLf = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
const ADDR_RE = /^[^\s@,;:<>()"'*\\]+@[^\s@,;:<>()"'*\\]+\.[a-z]{2,}$/i;
const MSGID_RE = /^<[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+>$/;
export const addressOk = (a) => typeof a === 'string' && ADDR_RE.test(a);

function bytesToB64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

// RFC 2047; each encoded-word ≤ 75 chars, split on whole characters.
export function encodeHeaderWords(value) {
  const clean = stripCrLf(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const enc = new TextEncoder();
  const words = [];
  let cur = '';
  for (const ch of clean) {
    if (enc.encode(cur + ch).length > 42) { words.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${bytesToB64(enc.encode(w))}?=`).join('\r\n ');
}
// Display name: no quotes / backslashes / angle brackets; ASCII goes quoted, anything else RFC 2047.
function displayName(name) {
  const n = stripCrLf(name).replace(/["\\<>]/g, '').trim();
  if (!n) return '';
  return /^[\x20-\x7E]*$/.test(n) ? `"${n}"` : encodeHeaderWords(n);
}
// RFC 2231: an ASCII-safe filename= plus filename*=UTF-8''… for the original.
function filenameParams(name) {
  const raw = stripCrLf(name) || 'attachment';
  const ascii = raw.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/["\\;\/]/g, '_').trim() || 'attachment';
  const star = encodeURIComponent(raw).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** → { raw } (CRLF MIME text) or { error }. cc = array of bare addresses. `boundary` is injectable for tests. */
export function buildOfferMime({ from, fromName = '', to, cc = [], subject, text, html, messageId, inReplyTo = null, attachments = [] },
  boundary = `mix_${crypto.randomUUID().replace(/-/g, '')}`) {
  const fromClean = stripCrLf(from), toClean = stripCrLf(to);
  if (!ADDR_RE.test(fromClean)) return { error: 'A valid sender address is required.' };
  // One bare address per field: a comma or angle bracket would add recipients nobody checked.
  if (!ADDR_RE.test(toClean)) return { error: 'A valid recipient address is required.' };
  const ccList = (Array.isArray(cc) ? cc : []).map(stripCrLf).filter(Boolean);
  if (ccList.length > 20 || ccList.some(a => !ADDR_RE.test(a))) return { error: 'Each CC must be one valid address (20 at most).' };
  const subj = stripCrLf(subject);
  if (!subj) return { error: 'A subject is required.' };
  if (!text || !html) return { error: 'Both the text and html bodies are required.' };
  if (!MSGID_RE.test(String(messageId || ''))) return { error: 'A valid Message-ID is required.' };
  if (inReplyTo != null && !MSGID_RE.test(String(inReplyTo))) return { error: 'A valid In-Reply-To is required.' };
  const alt = `${boundary}_alt`;
  const enc = new TextEncoder();
  const textPart = (type, content) =>
    `--${alt}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    + `${wrap76(bytesToB64(enc.encode(String(content))))}\r\n`;
  const headers = [
    `From: ${fromName ? `${displayName(fromName)} <${fromClean}>` : fromClean}`,
    `To: ${toClean}`,
    ...(ccList.length ? [`Cc: ${ccList.join(', ')}`] : []),
    `Subject: ${encodeHeaderWords(subj)}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  let body = `--${boundary}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n`
    + textPart('text/plain', text) + textPart('text/html', html) + `--${alt}--\r\n`;
  for (const a of attachments || []) {
    const mime = /^[a-z]+\/[a-z0-9.+\-]+$/i.test(String(a.mime || '')) ? a.mime : 'application/octet-stream';
    const bytes = a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes || []);
    body += `--${boundary}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: base64\r\n`
      + `Content-Disposition: attachment; ${filenameParams(a.filename)}\r\n\r\n${wrap76(bytesToB64(bytes))}\r\n`;
  }
  body += `--${boundary}--`;
  return { raw: headers.join('\r\n') + '\r\n\r\n' + body };
}

// D9: every mail of an application shares one subject, so Gmail keeps them in one thread.
export const offerSubject = (designation) => `Offer — ${stripCrLf(designation)} — Legend of Toys`;
export const offerMessageId = (rowId) => `<podium-offer-${rowId}@legendoftoys.com>`;

// ── Email bodies (text + escaped html) ──
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const day = (iso) => fmtLetterDate(iso) || String(iso || '');
const htmlDoc = (inner) => `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${inner}</body></html>`;
const para = (s) => `<p>${esc(s)}</p>`;
const button = (href, label) => `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#1a1a1a;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${esc(label)}</a></p>`;
export const OFFER_BUTTON = 'View and respond to your offer';

export function renderOfferEmail({ candidateFirst, designation, startDate, validUntil, link, revised = false, ownerName = '' }) {
  const hi = `Dear ${candidateFirst || 'there'},`;
  const lead = revised
    ? `Please find attached your revised offer for the role of ${designation} at Legend of Toys. This revision replaces the earlier one.`
    : `Congratulations! We are delighted to offer you the role of ${designation} at Legend of Toys. Your offer letter is attached.`;
  const start = startDate ? `Your start date would be on or before ${day(startDate)}.` : '';
  const valid = validUntil ? `Please respond by ${day(validUntil)}.` : '';
  const how = 'Use the button below to read the offer and accept it, decline it, or ask us a question.';
  const sign = ['Warm regards,', ownerName || 'Legend of Toys', 'Legend of Toys'];
  const text = [hi, '', lead, '', [start, valid].filter(Boolean).join(' '), '', how, '', `${OFFER_BUTTON}: ${link}`, '',
    'This link is personal to you — please do not forward it.', '', ...sign].join('\n');
  const html = htmlDoc([para(hi), para(lead), para([start, valid].filter(Boolean).join(' ')), para(how), button(link, OFFER_BUTTON),
    `<p style="color:#666;font-size:12px">This link is personal to you — please do not forward it.</p>`,
    `<p>${sign.map(esc).join('<br>')}</p>`].join(''));
  return { text, html };
}

// Never carries the link (A): the candidate returns to the link in the original offer email.
export function renderConfirmationEmail({ candidateFirst, designation, joinDate, ownerName = '' }) {
  const hi = `Dear ${candidateFirst || 'there'},`;
  const lead = `Thank you — your acceptance of the role of ${designation} is recorded. The accepted offer, with its acceptance certificate, is attached.`;
  const join = joinDate ? `We look forward to having you with us on ${day(joinDate)}.` : '';
  const next = 'What happens next: please upload your joining documents (PAN, an ID proof, address proof, a photo and your bank details) '
    + 'by returning to the link in our original offer email — it stays open until a week after your joining date.';
  const sign = ['Warm regards,', ownerName || 'Legend of Toys', 'Legend of Toys'];
  const text = [hi, '', lead, '', join, '', next, '', ...sign].join('\n');
  const html = htmlDoc([para(hi), para(lead), join ? para(join) : '', para(next), `<p>${sign.map(esc).join('<br>')}</p>`].join(''));
  return { text, html };
}

// The link-free copies for the people on CC (A). staffUrl = the Podium offer page (login required).
export function renderOfferCopyEmail({ candidateName, candidateEmail, designation, startDate, validUntil, staffUrl, revised = false }) {
  const lines = [
    `Copy for the team — the ${revised ? 'revised ' : ''}offer for ${designation} went to ${candidateName || 'the candidate'} at ${candidateEmail}.`,
    [startDate ? `Start date: on or before ${day(startDate)}.` : '', validUntil ? `Valid until ${day(validUntil)}.` : ''].filter(Boolean).join(' '),
    'The letter is attached. The candidate\'s personal response link is not in this copy.',
    `Open in Podium: ${staffUrl}`,
  ].filter(Boolean);
  return { text: lines.join('\n\n'), html: htmlDoc(lines.map(para).join('')) };
}
export function renderConfirmationCopyEmail({ candidateName, candidateEmail, designation, joinDate, staffUrl }) {
  const lines = [
    `Copy for the team — ${candidateName || 'the candidate'} accepted the offer for ${designation}; the confirmation went to ${candidateEmail}.`,
    joinDate ? `Joining date confirmed: ${day(joinDate)}.` : '',
    'The accepted offer with its acceptance certificate is attached.',
    `Open in Podium: ${staffUrl}`,
  ].filter(Boolean);
  return { text: lines.join('\n\n'), html: htmlDoc(lines.map(para).join('')) };
}

const ALERT_HEAD = {
  decline: 'declined the offer',
  question: 'has a question about the offer',
  accept_blocked: 'tried to accept, but the opening\'s headcount is already full',
};
export function renderAlertEmail({ kind, candidateName, offerRef, revision, reason = null, text = null, proposedDate = null, appUrl = '' }) {
  const head = `${candidateName || 'The candidate'} ${ALERT_HEAD[kind] || 'responded to the offer'} (${offerRef} r${revision}).`;
  const lines = [head];
  if (reason) lines.push(`Reason: ${DECLINE_REASONS[reason] || reason}`);
  if (proposedDate) lines.push(`Proposed joining date: ${day(proposedDate)}`);
  if (text) lines.push('', 'Their message:', String(text));
  if (kind === 'accept_blocked') lines.push('', 'They were told "we\'ll be in touch shortly". Nothing was accepted.');
  if (appUrl) lines.push('', `Open in Podium: ${appUrl}`);
  lines.push('', 'This is an internal note from Podium — the candidate is not copied.');
  const html = htmlDoc(lines.map(l => (l === '' ? '' : para(l))).join(''));
  return { text: lines.join('\n'), html };
}

// ── Joining documents through the link ──
export const LINK_DOC_TYPES = [
  { doc_type: 'pan', label: 'PAN card', required: true },
  { doc_type: 'id_proof', label: 'ID proof (masked Aadhaar, passport, …)', required: true },
  { doc_type: 'address_proof', label: 'Address proof', required: true },
  { doc_type: 'photo', label: 'A recent photo', required: true },
  { doc_type: 'bank', label: 'Cancelled cheque', required: true },
  { doc_type: 'payslip', label: 'Last three payslips', required: false },
  { doc_type: 'relieving_letter', label: 'Relieving letter', required: false },
  { doc_type: 'education', label: 'Education certificates', required: false },
  { doc_type: 'experience_letter', label: 'Experience letters', required: false },
];
export const LINK_DOC_TYPE_KEYS = LINK_DOC_TYPES.map(t => t.doc_type);
export const LINK_DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png'];
export const LINK_UPLOAD_CAP = 30;
export const LINK_BANK_CAP = 5;
export const LINK_QUESTION_CAP = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function candidateLinkDocPath(candidateId, docType, fileName, ts = Date.now()) {
  return `candidates/${candidateId}/link/${docType}/${Math.trunc(ts)}-${safeFileName(fileName)}`;
}
// null when the path is exactly what candidateLinkDocPath mints for this candidate (+ doc type, when given).
export function checkCandidateLinkDocPath(path, candidateId, docType = null) {
  if (!UUID_RE.test(String(candidateId || ''))) return 'bad_storage_path';
  if (typeof path !== 'string' || /%2e/i.test(path) || path.split('/').some(s => s === '' || s.includes('..'))) return 'bad_storage_path';
  const m = path.match(/^candidates\/([^/]+)\/link\/([a-z_]+)\/\d+-[A-Za-z0-9._-]+$/);
  if (!m || m[1].toLowerCase() !== String(candidateId).toLowerCase() || !LINK_DOC_TYPE_KEYS.includes(m[2])) return 'bad_storage_path';
  if (docType != null && m[2] !== docType) return 'bad_storage_path';
  return null;
}

// ── Bank details (column names = employee_private's; same CHECK regexes as J2 / 0011) ──
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export function validateCandidateBank({ account_number, account_number_confirm, ifsc, account_name, bank_name } = {}) {
  const errors = {};
  const acc = String(account_number ?? '').replace(/[\s-]+/g, '');
  const conf = String(account_number_confirm ?? '').replace(/[\s-]+/g, '');
  if (!/^[0-9]{9,18}$/.test(acc)) errors.account_number = 'The account number is 9 to 18 digits.';
  else if (acc !== conf) errors.account_number_confirm = 'The two account numbers do not match.';
  const i = String(ifsc ?? '').replace(/\s+/g, '').toUpperCase();
  if (!IFSC_RE.test(i)) errors.ifsc = 'The IFSC looks like ABCD0123456 (11 characters).';
  const name = String(account_name ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 120) errors.account_name = 'Enter the name on the account.';
  const bn = String(bank_name ?? '').replace(/\s+/g, ' ').trim();
  if (bn.length > 120) errors.bank_name = 'The bank name is too long.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, clean: { bank_account_number: acc, bank_ifsc: i, bank_account_name: name, bank_name: bn || null } };
}
export function maskAccount(n) {
  const s = String(n ?? '');
  if (!s) return null;
  return 'XXXXXX' + s.slice(-4);
}

// ── The acceptance certificate page appended to the issued PDF (rendered by offer-render.js) ──
export function certificateLines({ offerRef, revision, candidateName, typedName, acceptedAtIst, joinDate, ip, userAgent,
  pdfSha256, tokenHashPrefix }) {
  return [
    `Offer: ${offerRef} revision ${revision}`,
    `Candidate on the offer: ${candidateName}`,
    `Name typed to accept: ${typedName}`,
    `Accepted at: ${acceptedAtIst}`,
    `Joining date confirmed: ${day(joinDate)}`,
    `IP address: ${ip || 'not recorded'}`,
    `Browser: ${String(userAgent || 'not recorded').slice(0, 300)}`,
    `SHA-256 of the issued offer letter file (stored separately): ${pdfSha256}`,
    `Link reference: ${tokenHashPrefix}`,
    'The candidate read the offer, confirmed the joining date, ticked "I have read and accept this offer" and typed their name. '
      + 'This is an electronic record under section 10A of the Information Technology Act, 2000.',
  ];
}
// ISO instant → "12 Nov 2026, 14:05 IST".
export function istStamp(iso) {
  const d = new Date(Date.parse(iso) + 330 * 60000);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST`;
}

// ── Mail kinds, recipients, threading (A, M) ──
export const MAIL_KINDS = ['offer', 'offer_copy', 'confirmation', 'confirmation_copy', 'alert'];
export const CANDIDATE_MAIL_KINDS = ['offer', 'confirmation'];
export const INTERNAL_MAIL_KINDS = ['offer_copy', 'confirmation_copy', 'alert'];
// The link-bearing mail goes To the candidate ONLY; everyone else gets the link-free copy, To the sender
// mailbox with the rest on CC. → { candidate: {to, cc: []}, copy: {to, cc} | null }
export function splitOfferRecipients({ to, cc = [], sender }) {
  const t = String(to || '').trim().toLowerCase(), s = String(sender || '').trim().toLowerCase();
  const rest = [...new Set((cc || []).map(e => String(e || '').trim().toLowerCase()).filter(e => e && e !== t && e !== s))];
  return { candidate: { to: t, cc: [] }, copy: rest.length ? { to: s, cc: rest } : null };
}
// Which earlier mails a new one threads on: candidate-facing on candidate-facing only; copies / alerts on earlier
// internal mails, else on the candidate thread. → [kinds…] in order of preference.
export function threadKindsFor(kind) {
  return CANDIDATE_MAIL_KINDS.includes(kind) ? [CANDIDATE_MAIL_KINDS] : [INTERNAL_MAIL_KINDS, CANDIDATE_MAIL_KINDS];
}

// ── Reconcile (I): unknown → failed only after two misses at least 2 minutes apart; a hit → sent ──
export const RECONCILE_SENDING_MS = 2 * 60000;   // a 'sending' row this old: the worker died mid-send
export const RECONCILE_UNKNOWN_MS = 60000;       // first look at an 'unknown' row after a minute
export const RECONCILE_GAP_MS = 2 * 60000;       // between two looks
export function reconcileDue(row, nowMs) {
  if (!row || !['sending', 'unknown'].includes(row.status)) return false;
  if (row.last_reconciled_at) return nowMs - Date.parse(row.last_reconciled_at) >= RECONCILE_GAP_MS;
  return nowMs - Date.parse(row.created_at) >= (row.status === 'sending' ? RECONCILE_SENDING_MS : RECONCILE_UNKNOWN_MS);
}
// found = the mailbox search result ({found, id, threadId}). → the PATCH for the row.
export function reconcileDecision(row, found, nowMs) {
  const at = new Date(nowMs).toISOString();
  if (found?.found) return { status: 'sent', gmail_message_id: found.id || null, gmail_thread_id: found.threadId || null,
    sent_at: row.created_at, last_reconciled_at: at };
  const misses = Number(row.reconcile_misses || 0) + 1;
  const spaced = !!row.last_reconciled_at && nowMs - Date.parse(row.last_reconciled_at) >= RECONCILE_GAP_MS;
  if (misses >= 2 && spaced) {
    return { status: 'failed', reconcile_misses: misses, last_reconciled_at: at, error: 'Not found in the sender\'s mailbox — it did not go out' };
  }
  return { status: 'unknown', reconcile_misses: misses, last_reconciled_at: at };
}

// ── The accepted PDF (B): a per-attempt nonce, so a failed attempt can only ever delete its own object ──
export function newPathNonce() {
  return [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function acceptedPdfPath(applicationId, offerRef, revision, sha256, nonce) {
  if (!/^[0-9a-f]{8}$/.test(String(nonce || ''))) throw new Error('bad nonce');
  return `offers/${applicationId}/${offerRef}-r${Number(revision)}-accepted-${String(sha256 || '').slice(0, 12)}-${nonce}.pdf`;
}
