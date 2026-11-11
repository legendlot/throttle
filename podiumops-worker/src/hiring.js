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

// null when allowed, else an error code.
export function checkTransition(from, to, reason) {
  if (!(APP_TRANSITIONS[from] || []).includes(to)) return 'invalid_transition';
  if (REASON_REQUIRED.includes(to) && !String(reason || '').trim()) return 'reason_required';
  return null;
}

export const APP_SOURCES = ['referral', 'linkedin', 'naukri', 'campus', 'walk_in', 'agency', 'careers_page', 'other'];
export const OPENING_STATUSES = ['draft', 'open', 'on_hold', 'filled', 'cancelled'];

// ── Approver resolution ──────────────────────────────────────────────────────
// a = the reporting manager's own manager. RM has none (a founder) → a founder other than the RM.
// a would be the requester → a founder other than the requester (preferring one who is not the RM
// either). `founders` = active, manager_id IS NULL, users_profile.role = 'super_admin', in a stable
// order (employee_code). Returns an employee id or null.
export function resolveApprover(edges, founders, reportingManagerId, requesterEmpId) {
  const fs = (founders || []).filter(Boolean);
  const rm = (edges || []).find(e => e.id === reportingManagerId);
  let a = rm?.manager_id || null;
  if (!a) a = fs.find(f => f !== reportingManagerId) || null;
  if (a && requesterEmpId && a === requesterEmpId) {
    a = fs.find(f => f !== requesterEmpId && f !== reportingManagerId) || fs.find(f => f !== requesterEmpId) || null;
  }
  return a;
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
  const a = Number(min), b = Number(max);
  if (min === null || min === undefined || min === '' || max === null || max === undefined || max === '') return { error: 'band_required' };
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0) return { error: 'bad_band' };
  if (b < a) return { error: 'band_max_below_min' };
  return { band_min: Math.round(a), band_max: Math.round(b) };
}
