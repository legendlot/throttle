// Hiring J1 — Podium creates the work account, then confirms joining. The PURE rules (no I/O):
// names → address proposals, local-part checks, the temp password, "is this Google user the one our
// earlier call created", document mapping and the DB error map. index.js does the I/O.
// Plan: docs/superpowers/plans/2026-11-11-podium-j1-work-accounts.md · tests: test/workaccount.test.mjs
import { safeFileName } from './hiring.js';

export const WORK_DOMAIN = 'legendoftoys.com';
export const toEmail = (local) => `${String(local || '').toLowerCase()}@${WORK_DOMAIN}`;

const HONORIFICS = new Set(['mr', 'ms', 'mrs', 'dr', 'miss', 'mx']);

// "Dr. Asha  K Rao" → { given: 'Asha', family: 'Rao' }. One token → family = given (Google needs both).
export function splitName(full) {
  const toks = String(full || '').trim().split(/\s+/).filter(Boolean)
    .filter(t => !HONORIFICS.has(t.toLowerCase().replace(/\.$/, '')));
  if (!toks.length) return { given: '', family: '' };
  return { given: toks[0], family: toks[toks.length - 1] };
}

// Lowercase ASCII letters/digits only: diacritics folded (NFKD + strip combining marks), the rest dropped.
export function asciiLocal(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// L1: firstname, then firstname.lastinitial. Deduped, empties dropped.
export function proposeLocalParts(given, family) {
  const g = asciiLocal(given);
  const f = asciiLocal(family);
  const out = [];
  if (g) out.push(g);
  if (g && f) out.push(`${g}.${f[0]}`);
  return [...new Set(out)];
}

// null when the local part is usable, else an error code.
export function checkLocalPart(s) {
  const v = String(s ?? '');
  if (!v) return 'local_required';
  if (v.length > 64) return 'local_too_long';
  if (!/^[a-z0-9.]+$/.test(v)) return 'local_bad_chars';
  if (v.startsWith('.') || v.endsWith('.') || v.includes('..')) return 'local_bad_dots';
  return null;
}

// ── Temp password ────────────────────────────────────────────────────────────
// 16 chars, no look-alikes (0 O 1 l I), at least one upper / lower / digit / symbol. `randomBytes(n)`
// returns n random bytes (the worker passes crypto.getRandomValues); rejection sampling keeps it uniform.
// The result exists only in the createWorkAccount response — never logged, never stored.
export const PW_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PW_LOWER = 'abcdefghijkmnopqrstuvwxyz';
export const PW_DIGIT = '23456789';
export const PW_SYMBOL = '!@#$%*?-+=';
export const PW_ALPHABET = PW_UPPER + PW_LOWER + PW_DIGIT + PW_SYMBOL;
export const PW_LENGTH = 16;

export function tempPassword(randomBytes) {
  const n = PW_ALPHABET.length;
  const limit = 256 - (256 % n);
  for (let attempt = 0; attempt < 200; attempt++) {
    let out = '';
    while (out.length < PW_LENGTH) {
      for (const b of randomBytes(32)) {
        if (b >= limit) continue;
        out += PW_ALPHABET[b % n];
        if (out.length === PW_LENGTH) break;
      }
    }
    if ([PW_UPPER, PW_LOWER, PW_DIGIT, PW_SYMBOL].every(set => [...out].some(c => set.includes(c)))) return out;
  }
  throw new Error('temp_password_failed');
}

// ── Retry safety ─────────────────────────────────────────────────────────────
// Ownership is PROVEN, not inferred from timing: users.insert stamps the Google user with an externalId
// carrying our work_accounts.id. A retry adopts an existing Google user only when that exact id is on
// it — so a stranger's account (older, or created after our failed attempt) is never adopted.
export const WA_EXTERNAL_ID_TYPE = 'podium_work_account';
export function workAccountExternalIds(workAccountId) {
  return [{ type: 'custom', customType: WA_EXTERNAL_ID_TYPE, value: String(workAccountId) }];
}
export function isOurPendingAccount(row, gUser) {
  if (!row?.id || !gUser) return false;
  if (!['pending', 'failed'].includes(row.status)) return false;
  if (String(row.email || '').toLowerCase() !== String(gUser.primaryEmail || '').toLowerCase()) return false;
  return (Array.isArray(gUser.externalIds) ? gUser.externalIds : []).some(x => x && x.type === 'custom'
    && x.customType === WA_EXTERNAL_ID_TYPE && String(x.value) === String(row.id));
}

// One create attempt at a time per row. A claim takes the row only when it is pending/failed and no
// other attempt started within ATTEMPT_LEASE_MS; every later write is guarded on (attempt_id, pending),
// so a losing or timed-out attempt can never overwrite — or downgrade — the winner's result.
export const ATTEMPT_LEASE_MS = 2 * 60 * 1000;
// PostgREST filter for the claim PATCH (the row is identified separately by id=eq.).
export function attemptClaimFilter(nowMs = Date.now()) {
  const stale = new Date(nowMs - ATTEMPT_LEASE_MS).toISOString();
  return `status=in.(pending,failed)&or=(attempt_started_at.is.null,attempt_started_at.lt.${encodeURIComponent(stale)})`;
}
export function attemptGuard(attemptId) { return `attempt_id=eq.${attemptId}&status=eq.pending`; }
// The same rule as a predicate over a row — what the DB filter above decides (pure, for tests).
export function canClaimAttempt(row, nowMs = Date.now()) {
  if (!row || !['pending', 'failed'].includes(row.status)) return false;
  if (!row.attempt_started_at) return true;
  return Date.parse(row.attempt_started_at) < nowMs - ATTEMPT_LEASE_MS;
}
export function attemptGuardMatches(row, attemptId) { return !!row && row.attempt_id === attemptId && row.status === 'pending'; }

// ── Joining: documents ───────────────────────────────────────────────────────
// Candidate doc type → podium.documents doc type. PAN goes to id_proof (not `other`): PAN is HR/self only,
// and `other` is visible to the managing chain.
const DOC_MAP = {
  cv: 'resume', signed_offer: 'offer_letter', offer_evidence: 'offer_letter', id_proof: 'id_proof', pan: 'id_proof',
  address_proof: 'address_proof', education: 'education_cert', bank: 'bank_details',
};
export function candidateDocToEmployeeDocType(t) { return DOC_MAP[t] || 'other'; }
// Previous employers' payslips are hiring evidence of someone else's pay: they are NOT carried onto the
// employee record (data minimisation; and `other` is visible to the managing chain).
// Relieving / experience letters stay on the candidate record too (previous employers' paperwork).
export const NOT_COPIED_ON_JOINING = new Set(['payslip', 'relieving_letter', 'experience_letter']);

export function employeeDocPath(employeeId, candidateDocId, fileName) {
  return `${employeeId}/hiring/${candidateDocId}_${safeFileName(fileName)}`;
}

// L2: the department's most common Google OU among its active employees, else root.
export function defaultOu(departmentId, employees) {
  if (!departmentId) return '/';
  const counts = new Map();
  for (const e of employees || []) {
    if (e?.department_id !== departmentId || e.status !== 'active' || !e.google_org_unit) continue;
    counts.set(e.google_org_unit, (counts.get(e.google_org_unit) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [ou, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) if (n > bestN) { best = ou; bestN = n; }
  return best || '/';
}

// ── Gates shared by the handlers ─────────────────────────────────────────────
// The accepted offer an application joins on: the accepted revision, unless a NEWER revision is still live
// — in flight (0008 statuses draft / pending_approval / approved / approval_rejected / ready / sent) or
// accepted. A newer declined / expired / withdrawn / superseded revision is history and does not block.
// Mirrored in hiring_confirm_joining (0009). → { offer } | { error }
export const JOINING_BLOCKING_STATUSES = ['draft', 'pending_approval', 'approved', 'approval_rejected', 'ready', 'sent', 'accepted'];
export function joiningOffer(offers) {
  const list = offers || [];
  const acc = list.filter(o => o.status === 'accepted').sort((a, b) => Number(b.revision) - Number(a.revision))[0];
  if (!acc) return { error: 'offer_not_accepted' };
  const newer = list.some(o => o.id !== acc.id && Number(o.revision) > Number(acc.revision) && JOINING_BLOCKING_STATUSES.includes(o.status));
  return newer ? { error: 'offer_not_latest' } : { offer: acc };
}

// After this join: fill the opening only when headcount is reached AND nobody else is still active on it.
// → 'filled' | 'needs_resolution' | 'open'. Mirrored in hiring_confirm_joining (0009).
export function openingAfterJoin(joinedIncludingThis, headcount, otherActiveCount) {
  if (joinedIncludingThis < Number(headcount || 1)) return 'open';
  return otherActiveCount > 0 ? 'needs_resolution' : 'filled';
}

// Start date: a real date, on/after the acceptance date, at most 7 days past today (IST). → null | code
export function checkStartDate(start, today, acceptedAt) {
  if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return 'bad_start_date';
  const d = new Date(start + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== start) return 'bad_start_date';
  const max = new Date(String(today).slice(0, 10) + 'T00:00:00Z');
  max.setUTCDate(max.getUTCDate() + 7);
  if (start > max.toISOString().slice(0, 10)) return 'start_date_too_far';
  if (acceptedAt && start < String(acceptedAt).slice(0, 10)) return 'start_date_before_acceptance';
  return null;
}

// Suspension is for people who never joined (X1 widens this later).
export const SUSPENDABLE_APP_STATUSES = ['no_show', 'withdrawn'];

// A DB error from the J1 writes → { code, status }. RPC raises are 'podium_<code>'. Never echoes a row.
export function workAccountDbErrorCode(data) {
  const d = data && typeof data === 'object' ? data : {};
  const msg = String(d.message || '');
  const m = msg.match(/^podium_([a-z_]+)$/);
  if (m) return { code: m[1], status: 409 };
  if (d.code === '23505') {
    if (/work_accounts_email/.test(msg)) return { code: 'email_taken', status: 409 };
    if (/work_accounts_application_id/.test(msg)) return { code: 'account_exists', status: 409 };
    if (/employees_employee_code_key|employees_pkey/.test(msg)) return { code: 'stale', status: 409 };
    return { code: 'conflict', status: 409 };
  }
  if (d.code === '23514') return { code: 'check_failed', status: 409 };
  return null;
}
