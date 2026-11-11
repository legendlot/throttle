// Hiring C1 (openings) + C2 (candidates, applications, documents) — the PURE rules.
// No I/O here: index.js loads the rows and asks these functions who may do what, so the
// permission table is unit-tested in test/hiring.test.mjs rather than re-derived per handler.
// Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c1-c2.md · Spec v3.2 (same folder, specs/).

// Mirrors index.js hasPerm/isHr/canComp exactly (this module may not import index.js — index
// imports it). Keep the three in step with RULE-PODIUM-001/002 if those ever change.
const perm = (auth, k) => !!auth?.permissions?.[k];
const hrOf = (auth) => perm(auth, 'podium_admin') || perm(auth, 'podium_hr');
const compOf = (auth) => auth?.compAccess === true;

// ── Application statuses ─────────────────────────────────────────────────────
export const ACTIVE_APP_STATUSES = ['new', 'screening', 'interviewing', 'offer', 'accepted', 'on_hold'];
export const TERMINAL_APP_STATUSES = ['joined', 'rejected', 'declined', 'withdrawn', 'no_show'];
export const isActiveStatus = (s) => ACTIVE_APP_STATUSES.includes(s);
export const isTerminalStatus = (s) => TERMINAL_APP_STATUSES.includes(s);

// Manual moves. →offer and →accepted are set ONLY by the offer flow (first sent revision / recorded
// acceptance, C3 plan §0.8); →joined is C3b's. A declined / expired / withdrawn offer leaves the
// application at `offer`, and these manual moves close it: offer → declined | withdrawn | rejected, and
// accepted → withdrawn (LOT withdraws before joining). The handler refuses them while a live offer
// revision exists (close_offers_first).
export const APP_TRANSITIONS = {
  new:          ['screening', 'rejected', 'withdrawn', 'on_hold'],
  screening:    ['interviewing', 'rejected', 'withdrawn', 'on_hold'],
  interviewing: ['rejected', 'withdrawn', 'on_hold'],
  on_hold:      ['new', 'screening', 'interviewing', 'rejected', 'withdrawn'],
  offer:        ['declined', 'withdrawn', 'rejected'],
  accepted:     ['withdrawn'],
};
export const REASON_REQUIRED = ['rejected', 'withdrawn', 'declined'];

// null when allowed, else an error code. `reason` is a category code (OUTCOME_REASON_CODES, below) —
// required for rejected / withdrawn / declined, optional otherwise; free text travels separately as a note.
export function checkTransition(from, to, reason) {
  if (!(APP_TRANSITIONS[from] || []).includes(to)) return 'invalid_transition';
  const r = String(reason ?? '').trim();
  if (REASON_REQUIRED.includes(to) && !r) return 'reason_required';
  if (r && !OUTCOME_REASON_CODES.includes(r)) return 'bad_reason';
  return null;
}

export const APP_SOURCES = ['referral', 'linkedin', 'naukri', 'campus', 'walk_in', 'agency', 'careers_page', 'other'];
export const OPENING_STATUSES = ['draft', 'open', 'on_hold', 'filled', 'cancelled'];

// ── Approver resolution ──────────────────────────────────────────────────────
// Nobody approves a band on an opening they sit on (decisions.md §S445-Hiring): the requester, the
// hiring owner and the reporting manager are all skipped. a = the RM's own manager; if there is none
// or a is one of those three → the first founder who is none of them. Degenerate founder-only chains
// (e.g. one founder requests with the other as RM) fall to a founder ≠ the requester, because the
// requester is the one hard rule (the DB check refuses self-approval). `founders` = active,
// manager_id IS NULL, users_profile.role = 'super_admin', ordered by employee_code. → id or null.
export function resolveApprover(edges, founders, reportingManagerId, requesterEmpId, ownerEmpId = null) {
  const fs = (founders || []).filter(Boolean);
  const skip = new Set([reportingManagerId, requesterEmpId, ownerEmpId].filter(Boolean));
  const rm = (edges || []).find(e => e.id === reportingManagerId);
  const a = rm?.manager_id || null;
  if (a && !skip.has(a)) return a;
  return fs.find(f => !skip.has(f)) || fs.find(f => f !== requesterEmpId) || null;
}

// Who may decide a pending band: the snapshotted approver, or a founder — never its requester.
export function checkBandDecider(meEmpId, isFounder, budget) {
  if (!meEmpId) return 'forbidden';
  if (budget?.requested_by_employee_id && budget.requested_by_employee_id === meEmpId) return 'no_self_approval';
  if (budget?.approver_employee_id === meEmpId || isFounder) return null;
  return 'forbidden';
}

// ── Roles on one opening ─────────────────────────────────────────────────────
// `budgets` = that opening's CURRENT (approved) and/or PENDING budget rows (one object or an array).
export function openingRoles(auth, me, opening, budgets) {
  const meId = me?.id || null;
  const list = Array.isArray(budgets) ? budgets : (budgets ? [budgets] : []);
  const relevant = list.filter(b => b && b.opening_id === opening?.id
    && (b.status === 'pending' || b.id === opening?.current_budget_id));
  return {
    hiring:   perm(auth, 'podium_hiring'),
    owner:    !!meId && opening?.hiring_owner_employee_id === meId,
    manager:  !!meId && opening?.reporting_manager_employee_id === meId,
    approver: !!meId && relevant.some(b => b.approver_employee_id === meId),
    hr:       hrOf(auth),
    comp:     compOf(auth),
  };
}

export const canSeeOpening  = (r) => !!(r && (r.hiring || r.owner || r.manager || r.approver || r.hr));
export const canEditOpening = (r) => !!(r && (r.hiring || r.owner));
export const canManageApps  = (r) => !!(r && (r.hiring || r.owner || r.manager));
// podium_hiring alone does NOT see salary numbers; nor does HR without the allow-list.
export const canSeeSalary   = (r) => !!(r && (r.comp || r.owner || r.manager || r.approver));
export const canChangeChain = (r) => !!(r && r.hiring);

// ── Candidate documents ──────────────────────────────────────────────────────
export const CANDIDATE_DOC_TYPES = ['cv', 'payslip', 'signed_offer', 'offer_evidence', 'id_proof', 'pan', 'address_proof', 'education',
  'experience_letter', 'relieving_letter', 'bank', 'photo', 'other'];
const DOC_TIER = {
  cv: 'opening', education: 'opening', experience_letter: 'opening', photo: 'opening', other: 'opening',
  // offer_evidence (C3) = the offer as sent (email print / the PDF sent) — it carries the figures.
  payslip: 'salary', signed_offer: 'salary', offer_evidence: 'salary',
  id_proof: 'hr', pan: 'hr', address_proof: 'hr', bank: 'hr',
  // relieving_letter is in the schema but not in the plan's table; it is a joining-stage document
  // (spec §joining) so it fails closed to HR until someone decides otherwise.
  relieving_letter: 'hr',
};
export function docTier(docType) { return DOC_TIER[docType] || 'hr'; }

// rolesList = openingRoles() for each of the candidate's openings; hr = isHr(auth).
export function canSeeCandidateDoc(docType, rolesList, hr) {
  const tier = docTier(docType);
  const rs = rolesList || [];
  if (tier === 'hr') return !!hr;
  if (tier === 'salary') return rs.some(canSeeSalary);
  return !!hr || rs.some(canSeeOpening);
}

// One document row. ctx = { rolesByOpening: {openingId: roles} for the openings the caller can SEE,
// appOpening: {applicationId: openingId}, hr }. A salary-tier doc tied to an application is visible
// only to the salary chain of THAT application's opening; untied, to the salary chain of any.
export function canSeeDocRow(docType, applicationId, ctx) {
  const byOp = ctx?.rolesByOpening || {};
  if (docTier(docType) === 'salary' && applicationId) {
    return canSeeSalary(byOp[(ctx?.appOpening || {})[applicationId]]);
  }
  return canSeeCandidateDoc(docType, Object.values(byOp), !!ctx?.hr);
}

// ── Reasons + notes ──────────────────────────────────────────────────────────
// Reject / withdraw reasons are a category code (applications.outcome_reason, event.reason); any free
// text goes to application_events.detail.note. Free text can quote a salary, so it is shown only to
// viewers who can see salary on that opening; the code is shown to everyone who sees the row.
export const OUTCOME_REASON_CODES = ['not_a_fit', 'skills', 'experience', 'compensation', 'location', 'notice_period',
  'candidate_withdrew', 'no_response', 'duplicate', 'other'];
// System-written reasons that carry no free text.
const SYSTEM_REASON_RE = /^(moved to OPN-\d+|JD added)$/;
export function isSafeReason(r) { return r == null || OUTCOME_REASON_CODES.includes(r) || SYSTEM_REASON_RE.test(String(r)); }
export function redactReason(r, salaryOk) { return salaryOk || isSafeReason(r) ? (r ?? null) : null; }
export function redactEvent(ev, salaryOk) {
  if (salaryOk || !ev) return ev;
  const out = { ...ev, reason: redactReason(ev.reason, false) };
  if (ev.detail && typeof ev.detail === 'object' && 'note' in ev.detail) {
    const { note, ...rest } = ev.detail;
    out.detail = rest;
  }
  return out;
}

// A candidate's timeline for one viewer (ctx as canSeeDocRow). Opening-scoped rows → that opening must be
// visible (redacted by its salary gate). Document rows → the viewer must be able to see that doc type
// (and never learn a hidden doc's id). Application-only rows → via the application's opening. Bare
// candidate rows (created/updated) → shown, notes stripped unless salary on any opening.
export function candidateEventsFor(events, ctx) {
  const byOp = ctx?.rolesByOpening || {};
  const appOp = ctx?.appOpening || {};
  const anySal = Object.values(byOp).some(canSeeSalary);
  const out = [];
  for (const ev of events || []) {
    const opId = ev.opening_id || null;
    const docType = ev.detail && typeof ev.detail === 'object' ? ev.detail.doc_type : null;
    if (opId) {
      if (!byOp[opId]) continue;
      out.push(redactEvent(ev, canSeeSalary(byOp[opId])));
    } else if (docType) {
      if (!canSeeDocRow(docType, ev.application_id || null, ctx)) continue;
      out.push(redactEvent(ev, anySal));
    } else if (ev.application_id) {
      const r = byOp[appOp[ev.application_id]];
      if (!r) continue;
      out.push(redactEvent(ev, canSeeSalary(r)));
    } else {
      out.push(redactEvent(ev, anySal));
    }
  }
  return out;
}

// ── Gates + small helpers ────────────────────────────────────────────────────
export const JD_REQUIRED_MSG = 'Add the JD to this opening first';
export function jdGate(opening) { return opening?.current_jd_id ? null : 'jd_required'; }

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const JD_EXTS = ['pdf', 'docx'];
export const CANDIDATE_DOC_EXTS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'webp'];
export function fileExt(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
export function fileOk(name, exts, size) {
  if (!exts.includes(fileExt(name))) return 'bad_file_type';
  if (size != null && size !== '' && !(Number(size) >= 1 && Number(size) <= MAX_FILE_BYTES)) return 'file_too_large';
  return null;
}

// Recorded file sizes: a positive integer ≤ 15 MB, required (the client sends file.size).
export function checkFileSize(size) {
  const n = typeof size === 'string' && /^\d+$/.test(size.trim()) ? Number(size) : size;
  if (!Number.isInteger(n) || n < 1 || n > MAX_FILE_BYTES) return 'bad_file_size';
  return null;
}

// ── Storage paths ────────────────────────────────────────────────────────────
// The worker mints these; the record call must hand back EXACTLY that shape, or a caller could point
// a row at another candidate's / opening's object (path traversal). Names are reduced to
// [A-Za-z0-9._-] with no '..' run, so a minted path always passes its own check.
const UUID_PAT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_ONLY = new RegExp(`^${UUID_PAT}$`, 'i');
const NAME_PAT = '\\d+_[A-Za-z0-9._-]+';
export function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const s = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._-]+/, '').slice(-120);
  return s || 'file';
}
function badSegments(path) {
  const p = String(path || '');
  return /%2e/i.test(p) || p.split('/').some(seg => seg === '' || seg === '.' || seg === '..' || seg.includes('..'));
}
export function candidateDocPath(candidateId, docType, fileName, ts = Date.now()) {
  return `candidates/${candidateId}/${docType}/${Math.trunc(ts)}_${safeFileName(fileName)}`;
}
export function jdPath(openingId, fileName, ts = Date.now()) {
  return `openings/${openingId}/jd/${Math.trunc(ts)}_${safeFileName(fileName)}`;
}
// null when the path is exactly what candidateDocPath would mint for this candidate + doc type.
export function checkCandidateDocPath(path, candidateId, docType) {
  if (!UUID_ONLY.test(String(candidateId || '')) || !CANDIDATE_DOC_TYPES.includes(docType)) return 'bad_storage_path';
  if (typeof path !== 'string' || badSegments(path)) return 'bad_storage_path';
  const re = new RegExp(`^candidates/${candidateId}/${docType}/${NAME_PAT}$`);
  return re.test(path) ? null : 'bad_storage_path';
}
export function checkJdPath(path, openingId) {
  if (!UUID_ONLY.test(String(openingId || ''))) return 'bad_storage_path';
  if (typeof path !== 'string' || badSegments(path)) return 'bad_storage_path';
  const re = new RegExp(`^openings/${openingId}/jd/${NAME_PAT}$`);
  return re.test(path) ? null : 'bad_storage_path';
}

// PostgREST or=() / ilike value: drop the filter grammar characters before encoding.
export function cleanSearch(s) { return encodeURIComponent(String(s || '').trim().replace(/[,()*"\\]/g, ' ').trim()); }

// Retention: 12 months from the day the last application closes without a join.
export function retainUntil(todayIso) {
  const d = new Date(String(todayIso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 12);
  return d.toISOString().slice(0, 10);
}

export function normEmailKey(s) { const v = String(s || '').trim().toLowerCase(); return v || null; }
export function normPhoneKey(s) { const v = String(s || '').replace(/\D/g, '').slice(-10); return v || null; }

export function openingCode(n) { return `OPN-${String(n).padStart(3, '0')}`; }
export function candidateCode(n) { return `CAN-${String(n).padStart(4, '0')}`; }

// Band input → { band_min, band_max } or an error code. PostgREST numerics come back as strings.
export function parseBand(min, max) {
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  if (blank(min) || blank(max)) return { error: 'band_required' };
  const a = Number(min), b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0) return { error: 'bad_band' };
  if (b < a) return { error: 'band_max_below_min' };
  return { band_min: Math.round(a), band_max: Math.round(b) };
}

// ── Offers (C3) ──────────────────────────────────────────────────────────────
// Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c3-offers.md. One row per revision.
export const OFFER_STATUSES = ['draft', 'pending_approval', 'approved', 'approval_rejected', 'ready', 'sent',
  'accepted', 'declined', 'expired', 'withdrawn', 'superseded'];
// Pre-ready revisions: at most one per application (DB partial unique); only these are edited in place.
export const OFFER_OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'approval_rejected'];
export const OFFER_EDITABLE_STATUSES = ['draft', 'approval_rejected'];
// Revisions that still bind LOT or the candidate — an application can't be closed by hand while one exists.
export const OFFER_LIVE_STATUSES = [...OFFER_OPEN_STATUSES, 'ready', 'sent', 'accepted'];
// LOT may withdraw at any point before joining (spec §C3), including after acceptance or expiry.
export const OFFER_WITHDRAWABLE = [...OFFER_LIVE_STATUSES, 'expired'];
// Application statuses an offer can be made from; `accepted` → the new revision is an amendment.
export const OFFER_APP_STATUSES = ['interviewing', 'offer', 'accepted'];
export const OFFER_TEMPLATE_KEYS = ['employment', 'internship'];
export const VARIABLE_LABELS = ['variable pay', 'incentive pay'];
// Only what the payouts reader understands (bonus_type Half-Yearly / Monthly) — see componentsContract.
export const VARIABLE_FREQUENCIES = ['half-yearly', 'monthly'];
export const OFFER_DOC_KINDS = ['sent_evidence', 'signed'];

// Create / revise / send = the opening's hiring owner or reporting manager (spec permission table) —
// NOT podium_hiring and NOT HR unless they sit on that chain.
export const canManageOffers = (r) => !!(r && (r.owner || r.manager));

// Roles for one offer: the snapshotted OFFER approver sees the opening (and that offer's figures) even
// when they are not the band approver — they cannot decide what they cannot read.
export function offerRoles(roles, offer, meId) {
  const r = { ...(roles || {}) };
  if (meId && offer?.approver_employee_id === meId) r.approver = true;
  return r;
}

// IST calendar date (offers expire and date by India time). → 'YYYY-MM-DD'
export function istToday(nowMs = Date.now()) { return new Date(nowMs + 330 * 60000).toISOString().slice(0, 10); }
export function addDaysIso(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
}
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Rupee amounts: a whole number ≥ 0 (numeric strings allowed — PostgREST and form inputs). → n | NaN | null
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : NaN;
}

const OFFER_TERM_KEYS = ['designation', 'department_name', 'location', 'start_date', 'probation_months', 'signatory_id',
  'fixed_annual', 'variable_annual', 'variable_label', 'variable_frequency', 'joining_bonus', 'retention_bonus',
  'stipend_monthly', 'internship_months', 'pf_opt_out', 'pf_opt_out_reason', 'valid_days'];

// Offer terms from a request (merged over `defaults` for keys the request leaves out) → { terms } or
// { error: code }. Error codes never carry a figure. `mode` = 'salary' | 'stipend' (from the template key).
export function cleanOfferTerms(d, mode, defaults = {}) {
  const src = {};
  for (const k of OFFER_TERM_KEYS) src[k] = (d && d[k] !== undefined) ? d[k] : defaults[k];
  const t = {};
  t.designation = String(src.designation ?? '').trim();
  if (!t.designation) return { error: 'designation_required' };
  t.department_name = String(src.department_name ?? '').trim() || null;
  t.location = String(src.location ?? '').trim() || null;
  if (!t.location) return { error: 'location_required' };
  if (!isIsoDate(src.start_date)) return { error: 'start_date_required' };
  t.start_date = src.start_date;
  if (src.probation_months === null || src.probation_months === undefined || src.probation_months === '') t.probation_months = null;
  else {
    const p = Number(src.probation_months);
    if (!(Number.isInteger(p) && p >= 0 && p <= 12)) return { error: 'bad_probation_months' };
    t.probation_months = p;
  }
  if (src.signatory_id === null || src.signatory_id === undefined || src.signatory_id === '') t.signatory_id = null;
  else if (!UUID_ONLY.test(String(src.signatory_id))) return { error: 'bad_signatory_id' };
  else t.signatory_id = src.signatory_id;
  const vd = src.valid_days === null || src.valid_days === undefined || src.valid_days === '' ? 7 : Number(src.valid_days);
  if (!(Number.isInteger(vd) && vd >= 1 && vd <= 60)) return { error: 'bad_valid_days' };
  t.valid_days = vd;
  for (const k of ['joining_bonus', 'retention_bonus']) {
    const n = money(src[k]);
    if (Number.isNaN(n)) return { error: `bad_${k}` };
    t[k] = n ?? 0;
  }
  if (mode === 'stipend') {
    const s = money(src.stipend_monthly);
    if (!(s > 0)) return { error: 'bad_stipend_monthly' };
    const m = Number(src.internship_months);
    if (!(Number.isInteger(m) && m >= 1 && m <= 24)) return { error: 'bad_internship_months' };
    Object.assign(t, { stipend_monthly: s, internship_months: m, fixed_annual: null, variable_annual: 0,
      variable_label: 'variable pay', variable_frequency: 'half-yearly', pf_opt_out: false, pf_opt_out_reason: null });
    return { terms: t };
  }
  const f = money(src.fixed_annual);
  if (!(f > 0)) return { error: 'bad_fixed_annual' };
  const v = money(src.variable_annual);
  if (Number.isNaN(v)) return { error: 'bad_variable_annual' };
  const label = String(src.variable_label ?? 'variable pay').trim().toLowerCase() || 'variable pay';
  if (!VARIABLE_LABELS.includes(label)) return { error: 'bad_variable_label' };
  const freq = String(src.variable_frequency ?? 'half-yearly').trim().toLowerCase() || 'half-yearly';
  if (!VARIABLE_FREQUENCIES.includes(freq)) return { error: 'bad_variable_frequency' };
  const optOut = src.pf_opt_out === true || src.pf_opt_out === 'true';
  const reason = String(src.pf_opt_out_reason ?? '').trim() || null;
  if (optOut && !reason) return { error: 'pf_opt_out_reason_required' };
  Object.assign(t, { fixed_annual: f, variable_annual: v ?? 0, variable_label: label, variable_frequency: freq,
    pf_opt_out: optOut, pf_opt_out_reason: optOut ? reason : null, stipend_monthly: null, internship_months: null });
  return { terms: t };
}

// Storage: the issued PDF, and the two uploads an offer takes (the evidence of sending, the signed copy).
const REF_PAT = 'OFR-\\d{4}-\\d{3,}';
// Hash-suffixed and written WITHOUT upsert: a slow, stale render can never overwrite the issued file.
export function offerPdfPath(applicationId, offerRef, revision, sha256) {
  return `offers/${applicationId}/${offerRef}-r${Number(revision)}-${String(sha256 || '').slice(0, 8)}.pdf`;
}
export function offerDocPath(candidateId, offerRef, revision, kind, ts = Date.now()) {
  return `candidates/${candidateId}/offers/${offerRef}-r${Number(revision)}-${kind}-${Math.trunc(ts)}.pdf`;
}
// null when the path is exactly what offerDocPath mints for this candidate / offer revision / kind.
export function checkOfferDocPath(path, candidateId, offerRef, revision, kind) {
  if (!UUID_ONLY.test(String(candidateId || '')) || !OFFER_DOC_KINDS.includes(kind)) return 'bad_storage_path';
  if (!new RegExp(`^${REF_PAT}$`).test(String(offerRef || '')) || !Number.isInteger(Number(revision))) return 'bad_storage_path';
  if (typeof path !== 'string' || badSegments(path)) return 'bad_storage_path';
  const re = new RegExp(`^candidates/${candidateId}/offers/${offerRef}-r${Number(revision)}-${kind}-\\d+\\.pdf$`);
  return re.test(path) ? null : 'bad_storage_path';
}

// What a viewer WITHOUT salary on the opening may see of an offer revision: status and dates, no figures,
// no annexure, no free-text notes (a decision / outcome note can quote a number).
const OFFER_META_KEYS = ['id', 'application_id', 'opening_id', 'candidate_id', 'offer_ref', 'revision', 'status', 'mode',
  'designation', 'start_date', 'issue_date', 'valid_until', 'sent_at', 'accepted_at', 'declined_at', 'created_at', 'updated_at'];
const OFFER_NUM_KEYS = ['fixed_annual', 'variable_annual', 'joining_bonus', 'retention_bonus', 'stipend_monthly', 'total_ctc'];
export function offerView(o, salaryOk) {
  if (!o) return null;
  if (!salaryOk) return Object.fromEntries(OFFER_META_KEYS.map(k => [k, o[k] ?? null]));
  const out = { ...o };
  for (const k of OFFER_NUM_KEYS) out[k] = o[k] === null || o[k] === undefined || o[k] === '' ? null : Number(o[k]);
  return out;
}

// ── Offer integrity (review fixes) ───────────────────────────────────────────
// The terms that drive the letter. terms_hash = SHA-256 of offerTermsCanonical(row); the transition RPC
// refuses a freeze / approve / issue / send / accept step whose expected_terms_hash is not the row's.
const TERMS_HASH_KEYS = ['template_id', 'rule_set_id', 'mode', 'fixed_annual', 'variable_annual', 'variable_label',
  'variable_frequency', 'joining_bonus', 'retention_bonus', 'stipend_monthly', 'internship_months', 'total_ctc',
  'pf_opt_out', 'pf_opt_out_reason', 'designation', 'department_name', 'location', 'start_date', 'probation_months',
  'signatory_id', 'annexure'];
const TERMS_NUM_KEYS = new Set(['fixed_annual', 'variable_annual', 'joining_bonus', 'retention_bonus', 'stipend_monthly',
  'internship_months', 'total_ctc', 'probation_months']);
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
// Same terms → same string, whether the row came from the worker (numbers) or PostgREST (numeric strings).
export function offerTermsCanonical(row) {
  const o = {};
  for (const k of TERMS_HASH_KEYS) {
    const v = row?.[k];
    o[k] = v === undefined || v === null || v === '' ? null
      : TERMS_NUM_KEYS.has(k) ? Number(v) : k === 'pf_opt_out' ? !!v : v;
  }
  return stable(o);
}

// On send, these other revisions of the application are superseded (an older expired one too, so it can't
// be accepted late after a newer one went out). Mirrors hiring_offer_transition in 0008.
export const SUPERSEDE_ON_SEND = ['ready', 'sent', 'expired'];

// Only the newest revision that was ever sent can be accepted.
export function isLatestSent(offers, offerId) {
  const sent = (offers || []).filter(o => o.sent_at).sort((a, b) => Number(b.revision) - Number(a.revision));
  return !!sent.length && sent[0].id === offerId;
}

// May this ready revision go out? In / below band, or approved for exactly these terms.
export function canSendOffer(o) {
  if (o?.status !== 'ready') return false;
  if (o.band_check === 'in_band' || o.band_check === 'below_band') return true;
  return !!o.terms_hash && o.approved_terms_hash === o.terms_hash;
}

// Manual moves that close or park an application must not strand a live offer revision.
export const CLOSE_OR_HOLD_STATUSES = ['rejected', 'withdrawn', 'on_hold', 'declined'];
export const needsNoLiveOffer = (to) => CLOSE_OR_HOLD_STATUSES.includes(to) || TERMINAL_APP_STATUSES.includes(to);
// Moving to another opening is never allowed once an offer stage is reached (offers stay with their opening).
export const canMoveFrom = (status) => !['offer', 'accepted'].includes(status);

// A DB error from an offer write → { code, status }. 23505 is split by constraint name so each unique
// index gets its own message; RPC raises ('stale', 'not_latest') pass through. Never echoes row values.
export function offerDbErrorCode(data) {
  const d = data && typeof data === 'object' ? data : {};
  const msg = String(d.message || '');
  if (msg === 'stale') return { code: 'stale', status: 409 };
  if (msg === 'not_latest') return { code: 'not_latest', status: 409 };
  if (d.code === '23505') {
    const m = msg.match(/constraint "([^"]+)"/);
    const c = m ? m[1] : '';
    if (c === 'offers_one_accepted') return { code: 'already_accepted', status: 409 };
    if (c === 'offers_one_open_draft') return { code: 'draft_exists', status: 409 };
    if (c === 'candidate_documents_storage_path_key') return { code: 'doc_already_recorded', status: 409 };
    if (c === 'offers_pdf_path_key') return { code: 'pdf_path_in_use', status: 409 };
    return { code: 'conflict', status: 409 };
  }
  if (d.code === '23514') return { code: 'offer_check_failed', status: 409 };
  return null;
}
