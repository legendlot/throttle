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

// Manual moves only (this slice). →offer is C3's offer flow; offer/accepted/joined/declined/no_show
// are never set by hand here, so they appear as neither a source nor a target.
export const APP_TRANSITIONS = {
  new:          ['screening', 'rejected', 'withdrawn', 'on_hold'],
  screening:    ['interviewing', 'rejected', 'withdrawn', 'on_hold'],
  interviewing: ['rejected', 'withdrawn', 'on_hold'],
  on_hold:      ['new', 'screening', 'interviewing', 'rejected', 'withdrawn'],
};
export const REASON_REQUIRED = ['rejected', 'withdrawn'];

// null when allowed, else an error code. `reason` is a category code (OUTCOME_REASON_CODES, below) —
// required for rejected / withdrawn, optional otherwise; free text travels separately as a note.
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
export const CANDIDATE_DOC_TYPES = ['cv', 'payslip', 'signed_offer', 'id_proof', 'pan', 'address_proof', 'education',
  'experience_letter', 'relieving_letter', 'bank', 'photo', 'other'];
const DOC_TIER = {
  cv: 'opening', education: 'opening', experience_letter: 'opening', photo: 'opening', other: 'opening',
  payslip: 'salary', signed_offer: 'salary',
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
