// Podium J2 — onboarding (joiners) + one-time profile completion (everyone). The PURE rules (no I/O): input
// normalisation + validation, the completion rule, first-fill vs change-request routing, who may set which line,
// auto-line resolution, due / overdue in IST, the checklist snapshot, private-field projection + masking, policy
// applicability, the XPayroll CSV and the DB error map. index.js does the I/O; migrations/0011_onboarding.sql is
// the transactional half (profile_missing / onboarding_auto_status are the SQL twins of profileMissing / autoStatus).
// Plan: docs/superpowers/plans/2026-11-12-podium-j2-onboarding.md · tests: test/onboarding.test.mjs
import { isIsoDate } from './hiring.js';

export const ONBOARDING_STATUSES = ['open', 'complete', 'cancelled'];
export const OB_ITEM_STATUSES = ['open', 'done', 'na'];
export const OB_OWNERS = ['hr', 'manager', 'it', 'employee'];
export const OB_AUTO_SOURCES = ['profile', 'documents', 'policies', 'login', 'it_kit', 'probation_date'];
export const OB_NOTE_MAX = 2000;
export const JOINER_WINDOW_DAYS = 90;   // "joined without an onboarding" = active, joined within this many days

// ── Profile fields ───────────────────────────────────────────────────────────
// Self-editable fields on podium.employees (whitelist — nothing else is ever written by saveMyProfile).
export const PROFILE_EMPLOYEE_FIELDS = ['preferred_name', 'personal_email', 'phone', 'emergency_contact_name',
  'emergency_contact_phone', 'date_of_birth', 'gender', 'blood_group', 'pan_number'];
// podium.employee_private (every column the person may fill).
export const PROFILE_PRIVATE_FIELDS = ['current_address', 'permanent_address', 'pf_uan', 'esic_number',
  'bank_account_number', 'bank_ifsc', 'bank_account_name', 'fy_label', 'cur_fy_taxable_outside', 'cur_fy_exemptions',
  'cur_fy_tds', 'past_taxable_salary', 'past_tds'];
// Decision 4: once filled, a self-change of these becomes a change request HR approves.
export const PROTECTED_FIELDS = ['pan_number', 'bank_account_number', 'bank_ifsc', 'bank_account_name'];
// Decision 2 tiers. HR sees these (bank account masked); salary-tier fields need canComp (and are logged).
export const HR_PRIVATE_FIELDS = ['current_address', 'permanent_address', 'pf_uan', 'esic_number', 'bank_account_number',
  'bank_ifsc', 'bank_account_name'];
export const SALARY_PRIVATE_FIELDS = ['fy_label', 'cur_fy_taxable_outside', 'cur_fy_exemptions', 'cur_fy_tds',
  'past_taxable_salary', 'past_tds'];
const NUMERIC_FIELDS = new Set(['cur_fy_taxable_outside', 'cur_fy_exemptions', 'cur_fy_tds', 'past_taxable_salary', 'past_tds']);

export const FIELD_LABELS = {
  preferred_name: 'Preferred name', personal_email: 'Personal email', phone: 'Phone',
  emergency_contact_name: 'Emergency contact name', emergency_contact_phone: 'Emergency contact phone',
  date_of_birth: 'Date of birth', gender: 'Gender', blood_group: 'Blood group', pan_number: 'PAN',
  current_address: 'Current address', permanent_address: 'Permanent address', pf_uan: 'PF UAN', esic_number: 'ESIC number',
  bank_account_number: 'Bank account number', bank_ifsc: 'Bank IFSC', bank_account_name: 'Name on the bank account',
  fy_label: 'Financial year', cur_fy_taxable_outside: 'Taxable salary this FY outside XPayroll',
  cur_fy_exemptions: 'Exemptions this FY', cur_fy_tds: 'TDS deducted this FY', past_taxable_salary: 'Past taxable salary',
  past_tds: 'Past TDS',
};
export const DOC_TYPE_LABELS = { id_proof: 'ID proof', address_proof: 'Address proof', bank_details: 'Bank details (cancelled cheque / passbook)',
  education_cert: 'Education certificate', other: 'Other' };

// The completion rule (one function: the banner, the board and the `profile` auto line). The SQL twin is
// podium.profile_missing in 0011 — keep the field list and its order identical.
export const REQUIRED_PROFILE_FIELDS = ['date_of_birth', 'gender', 'personal_email', 'phone', 'emergency_contact_name',
  'emergency_contact_phone', 'pan_number', 'current_address', 'bank_account_number', 'bank_ifsc'];
export const DEFAULT_REQUIRED_DOC_TYPES = ['id_proof', 'address_proof', 'bank_details'];
// Self-upload doc types = the required ones + these (documents.doc_type has no 'photo' — 0011 header).
export const SELF_EXTRA_DOC_TYPES = ['education_cert', 'other'];
export const SELF_DOC_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

// → [{ key, label }] in rule order; doc keys are 'doc:<type>'. `docTypes` = the person's uploaded doc types.
export function profileMissing(emp, priv, docTypes, requiredDocTypes = DEFAULT_REQUIRED_DOC_TYPES) {
  const e = emp || {}, p = priv || {};
  const out = [];
  for (const f of REQUIRED_PROFILE_FIELDS) {
    const v = PROFILE_PRIVATE_FIELDS.includes(f) ? p[f] : e[f];
    if (blank(v)) out.push({ key: f, label: FIELD_LABELS[f] });
  }
  const have = new Set(docTypes || []);
  for (const t of requiredDocTypes || []) if (!have.has(t)) out.push({ key: `doc:${t}`, label: DOC_TYPE_LABELS[t] || t });
  return out;
}
export function completionPct(missing, requiredDocTypes = DEFAULT_REQUIRED_DOC_TYPES) {
  const total = REQUIRED_PROFILE_FIELDS.length + (requiredDocTypes || []).length;
  return total ? Math.round(100 * (total - (missing || []).length) / total) : 100;
}

// ── Normalisation + validation (fix trivial input at the source form) ────────
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const UAN_RE = /^[0-9]{12}$/;
export const ESIC_RE = /^[0-9]{10,17}$/;
export const BANK_AC_RE = /^[0-9]{9,18}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export const stripSpaces = (v) => String(v ?? '').replace(/[\s-]+/g, '');
export const normPan = (v) => stripSpaces(v).toUpperCase();
export const normIfsc = (v) => stripSpaces(v).toUpperCase();
export const normDigits = (v) => stripSpaces(v);
// Indian mobile: drop +91 / 91 / 0 prefixes and separators → 10 digits.
export function normPhone(v) {
  let s = String(v ?? '').replace(/[\s\-().]+/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return s;
}
export function normGender(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'm' || s === 'male') return 'm';
  if (s === 'f' || s === 'female') return 'f';
  if (s === 'other' || s === 'o') return 'other';
  return null;
}
// '1,20,000' / ' 5000 ' → 120000 / 5000; ≥ 0 only.
export function normAmount(v) {
  const s = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

const VALIDATION_COPY = {
  pan_number: 'PAN looks like ABCDE1234F (5 letters, 4 digits, 1 letter)',
  bank_ifsc: 'IFSC looks like ABCD0123456 (4 letters, 0, then 6 letters or digits)',
  bank_account_number: 'Bank account number is 9 to 18 digits',
  pf_uan: 'PF UAN is 12 digits',
  esic_number: 'ESIC number is 10 to 17 digits',
  phone: 'Phone is a 10-digit mobile number',
  emergency_contact_phone: 'Emergency contact phone is a 10-digit mobile number',
  personal_email: 'That email address does not look right',
  date_of_birth: 'Pick a real date of birth (not in the future)',
  gender: 'Pick Male, Female or Other',
  blood_group: 'Pick a blood group',
  fy_label: 'Financial year looks like 2026-27',
  amount: 'Enter an amount in rupees (digits only, 0 or more)',
  too_long: 'That is too long',
};

// fields (raw form values) → { employee, private, errors: [{ field, message }] }. A key present = write it
// ('' clears an optional field). Unknown keys are dropped (whitelist). `today` (IST) bounds the date of birth.
export function validateProfileInput(fields, today) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const employee = {}, priv = {}, errors = [];
  const bad = (field, code = field) => errors.push({ field, message: VALIDATION_COPY[code] || 'Check this field' });
  const put = (field, v) => { (PROFILE_PRIVATE_FIELDS.includes(field) ? priv : employee)[field] = v; };
  for (const field of [...PROFILE_EMPLOYEE_FIELDS, ...PROFILE_PRIVATE_FIELDS]) {
    if (!(field in f)) continue;
    const raw = f[field];
    if (blank(raw)) { put(field, null); continue; }
    let v;
    switch (field) {
      case 'pan_number': v = normPan(raw); if (!PAN_RE.test(v)) { bad(field); continue; } break;
      case 'bank_ifsc': v = normIfsc(raw); if (!IFSC_RE.test(v)) { bad(field); continue; } break;
      case 'bank_account_number': v = normDigits(raw); if (!BANK_AC_RE.test(v)) { bad(field); continue; } break;
      case 'pf_uan': v = normDigits(raw); if (!UAN_RE.test(v)) { bad(field); continue; } break;
      case 'esic_number': v = normDigits(raw); if (!ESIC_RE.test(v)) { bad(field); continue; } break;
      // Validated as 10 digits, STORED as +91XXXXXXXXXX (every existing phone row is in that form).
      case 'phone': case 'emergency_contact_phone': v = normPhone(raw); if (!/^[0-9]{10}$/.test(v)) { bad(field); continue; } v = `+91${v}`; break;
      case 'personal_email': v = String(raw).trim().toLowerCase(); if (!EMAIL_RE.test(v) || v.length > 160) { bad(field); continue; } break;
      case 'date_of_birth': {
        v = String(raw).trim();
        if (!isIsoDate(v) || (today && v >= today) || v < '1900-01-01') { bad(field); continue; }
        break;
      }
      case 'gender': v = normGender(raw); if (!v) { bad(field); continue; } break;
      case 'blood_group': v = String(raw).trim().toUpperCase(); if (!BLOOD_GROUPS.includes(v)) { bad(field); continue; } break;
      case 'fy_label': v = String(raw).trim(); if (!/^[0-9]{4}-[0-9]{2}$/.test(v)) { bad(field); continue; } break;
      default:
        if (NUMERIC_FIELDS.has(field)) { v = normAmount(raw); if (v == null) { bad(field, 'amount'); continue; } break; }
        v = String(raw).replace(/\s+/g, ' ').trim();
        if (v.length > (field.endsWith('_address') ? 500 : 120)) { bad(field, 'too_long'); continue; }
    }
    put(field, v);
  }
  return { employee, private: priv, errors };
}

// First fill vs change request (decision 4) — the testable copy of profile_save_self's loop.
// → 'write' | 'request' | 'unchanged' | 'cannot_clear'
export function routeProfileField(field, current, next) {
  const cur = blank(current) ? null : String(current).trim();
  const nxt = blank(next) ? null : String(next).trim();
  if (!PROTECTED_FIELDS.includes(field)) return cur === nxt ? 'unchanged' : 'write';
  if (cur === null) return nxt === null ? 'unchanged' : 'write';
  if (nxt === null) return 'cannot_clear';
  return cur === nxt ? 'unchanged' : 'request';
}

// ── Masking + the private projection (decision 2) ────────────────────────────
export function maskAccount(v) {
  const s = String(v ?? '');
  if (!s) return null;
  return '••••' + s.slice(-4);
}
// row = the employee_private row. self → everything; HR → HR fields with the bank account masked; comp → the
// salary fields. HR + comp → both. Nothing → null.
export function projectPrivate(row, { self = false, hr = false, comp = false } = {}) {
  if (!row) return null;
  if (self) return { ...row };
  if (!hr && !comp) return null;
  const o = { employee_id: row.employee_id, updated_at: row.updated_at ?? null };
  if (hr) {
    for (const k of HR_PRIVATE_FIELDS) o[k] = row[k] ?? null;
    o.bank_account_number = maskAccount(row.bank_account_number);
  }
  if (comp) for (const k of SALARY_PRIVATE_FIELDS) o[k] = row[k] ?? null;
  return o;
}
// A change request as HR sees it: bank account masked, IFSC / name / PAN in full (HR sees PAN already).
export function projectChangeRequest(r) {
  if (!r) return r;
  return { ...r, new_value: r.field === 'bank_account_number' ? maskAccount(r.new_value) : r.new_value };
}

// ── Who ──────────────────────────────────────────────────────────────────────
// Self wins over HR (as X1): nobody runs their own onboarding; an HR joiner's lines are set by another HR person.
export function onboardingRole({ hr = false, self = false, chain = false } = {}) {
  if (self) return 'employee';
  if (hr) return 'hr';
  if (chain) return 'manager';
  return null;
}
export const canSeeOnboarding = (role) => role === 'hr' || role === 'manager' || role === 'employee';
export const canManageOnboarding = (role) => role === 'hr';   // start · complete · cancel

// May this role set this line at all? (null = yes.) HR any line; the manager chain only owner='manager' manual
// lines; the employee none (their lines are auto). onboarding_update_item re-checks.
export function canTickOnboardingItem(role, item) {
  if (!item) return 'not_found';
  if (role === 'hr') return null;
  if (role === 'manager' && item.owner === 'manager' && !item.auto_source) return null;
  return 'forbidden_item';
}

// ── Auto lines (decision 6) ──────────────────────────────────────────────────
// facts = { missing: [], docs_missing: [], policies_applicable, policies_pending, auth_linked, assets, probation_set }
// → 'done' | 'open' | 'unverifiable'. SQL twin: podium.onboarding_auto_status.
export function autoStatus(source, facts = {}) {
  switch (source) {
    case 'profile': return (facts.missing || []).length === 0 ? 'done' : 'open';
    case 'documents': return (facts.docs_missing || []).length === 0 ? 'done' : 'open';
    case 'policies':
      if (!(Number(facts.policies_applicable) > 0)) return 'done';
      if (!facts.auth_linked) return 'unverifiable';
      return Number(facts.policies_pending) > 0 ? 'open' : 'done';
    case 'login': return facts.auth_linked ? 'done' : 'open';
    case 'it_kit':
      if (!facts.auth_linked) return 'unverifiable';
      return Number(facts.assets) > 0 ? 'done' : 'open';
    case 'probation_date': return facts.probation_set ? 'done' : 'open';
    default: return 'open';
  }
}
// An item's effective state: stored done / na win; an open auto line shows its live status.
// → { state: 'done'|'na'|'open'|'unverifiable', live, resolved }
export function itemState(item, facts) {
  const live = item.auto_source ? autoStatus(item.auto_source, facts) : null;
  if (item.status === 'done') return { state: 'done', live, resolved: true };
  if (item.status === 'na') return { state: 'na', live, resolved: !!item.allow_na };
  if (live === 'done') return { state: 'done', live, resolved: true };
  return { state: live === 'unverifiable' ? 'unverifiable' : 'open', live, resolved: !item.required };
}
export function onboardingBlockers(items, facts) {
  return (items || []).filter(i => i.required).slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    .filter(i => !itemState(i, facts).resolved).map(i => ({ code: 'item_open', line_key: i.line_key, title: i.title, owner: i.owner }));
}
export function onboardingProgress(items, facts) {
  const req = (items || []).filter(i => i.required);
  return { required: req.length, done: req.filter(i => itemState(i, facts).resolved).length };
}

// A requested item change → null when allowed, else an error code (the RPC is the authority). `live` = the auto
// line's live status ('done' | 'open' | 'unverifiable'), ignored for manual lines.
export function checkOnboardingItemUpdate(item, { status, note }, live, role) {
  if (!OB_ITEM_STATUSES.includes(status)) return 'bad_item_status';
  const te = canTickOnboardingItem(role, item);
  if (te) return te;
  const hasNote = !!String(note || '').trim();
  if (status === 'na') {
    if (!item.allow_na) return 'na_not_allowed';
    if (!hasNote) return 'na_note_required';
  }
  if (status === 'done' && item.auto_source) {
    if (live === 'done') return 'set_automatically';
    if (live !== 'unverifiable') return 'auto_line_open';
    if (!hasNote) return 'unverifiable_note_required';
  }
  return null;
}

// ── Dates (IST) ──────────────────────────────────────────────────────────────
export function dueDate(dateJoined, offsetDays) {
  if (!isIsoDate(dateJoined)) return null;
  const d = new Date(dateJoined + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Math.round(Number(offsetDays) || 0));
  return d.toISOString().slice(0, 10);
}
// Overdue = still unresolved and the due date is before IST today.
export function itemOverdue(item, facts, today) {
  if (!item?.due_date || !isIsoDate(today)) return false;
  const s = itemState(item, facts);
  return s.state !== 'done' && s.state !== 'na' && item.due_date < today;
}
// India's FY label for an IST date: April–March. 2026-11-12 → '2026-27'; 2027-03-31 → '2026-27'.
export function fyLabelFor(today) {
  if (!isIsoDate(today)) return null;
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
// Active, joined within the window (and not in the future beyond it), with no open / complete onboarding.
export function joinersWithoutOnboarding(employees, onboardings, today, days = JOINER_WINDOW_DAYS) {
  const covered = new Set((onboardings || []).filter(o => o.status === 'open' || o.status === 'complete').map(o => o.employee_id));
  const from = dueDate(today, -days);
  return (employees || []).filter(e => e.status === 'active' && isIsoDate(e.date_joined) && from && e.date_joined >= from
    && !covered.has(e.id));
}

// The snapshot: active template lines that apply to this employment type (empty applies_to = all; no employment
// type → every line — more checks, never fewer), sorted. Due dates are computed by onboarding_start.
export function snapshotOnboardingItems(lines, employmentType) {
  return (lines || [])
    .filter(l => l && l.active !== false)
    .filter(l => !Array.isArray(l.applies_to) || !l.applies_to.length || !employmentType || l.applies_to.includes(employmentType))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.key).localeCompare(String(b.key)))
    .map(l => ({ line_key: l.key, title: l.title, owner: l.owner, required: !!l.required, allow_na: !!l.allow_na,
      auto_source: l.auto_source || null, due_offset_days: Math.round(Number(l.due_offset_days) || 0), sort: Number(l.sort) || 0 }));
}

// ── Policies ─────────────────────────────────────────────────────────────────
export function policyApplies(policy, employmentType) {
  if (!policy || policy.active === false) return false;
  const a = Array.isArray(policy.applies_to) ? policy.applies_to : [];
  return !a.length || !employmentType || a.includes(employmentType);
}
// → null | code. Must be the current active version of a policy that applies to this person.
export function checkAcknowledge(policy, version, employmentType) {
  if (!policy) return 'policy_not_found';
  // An inactive row = a superseded (or withdrawn) version: the client is reading an old copy.
  if (policy.active === false) return 'policy_version_stale';
  if (!policyApplies(policy, employmentType)) return 'policy_not_applicable';
  if (Math.round(Number(version)) !== Number(policy.version)) return 'policy_version_stale';
  return null;
}
export const policyPath = (fileName, nowMs = Date.now()) => `policies/${nowMs}_${safeName(fileName)}`;

// ── Self documents ───────────────────────────────────────────────────────────
// Runs of dots collapse to one: 'scan..final.pdf' would otherwise fail isSelfDocPath's '..' guard after the
// upload succeeded, orphaning the object.
export const safeName = (s) => String(s || 'file').replace(/[^\w.\-]+/g, '_').replace(/\.{2,}/g, '.').slice(0, 120);
export function selfDocTypes(requiredDocTypes = DEFAULT_REQUIRED_DOC_TYPES) {
  return [...new Set([...(requiredDocTypes || []), ...SELF_EXTRA_DOC_TYPES])];
}
// Under <employee_id>/self/ — never an HR upload's path, and the timestamp keeps every upload a new object.
export const selfDocPath = (employeeId, docType, fileName, nowMs = Date.now()) =>
  `${employeeId}/self/${safeName(docType)}/${nowMs}_${safeName(fileName)}`;
export const isSelfDocPath = (employeeId, path) =>
  typeof path === 'string' && path.startsWith(`${employeeId}/self/`) && !path.includes('..');

// recordMyDocument trusts STORAGE, not the client: the object must exist under the person's own path, and its
// size + mime type come from the storage HEAD. head = { ok, status, size, mime } → { size, mime } | { error }.
export const SELF_DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export function checkStoredObject(head) {
  if (!head || !head.ok) return { error: head && head.status && head.status !== 404 && head.status !== 400 ? 'storage_check_failed' : 'upload_not_found' };
  const size = Number(head.size);
  if (!Number.isInteger(size) || size < 1 || size > 15 * 1024 * 1024) return { error: 'bad_file_size' };
  const mime = String(head.mime || '').split(';')[0].trim().toLowerCase();
  if (!SELF_DOC_MIMES.includes(mime)) return { error: 'bad_file_type' };
  return { size, mime };
}

// ── XPayroll export (decision 3: canComp, logged) ────────────────────────────
// The Drive sheet `XPayroll-Onboarding-v1-2`, tab "Employee Data", row 2 — verbatim, in order.
// Copied VERBATIM from Drive 'XPayroll-Onboarding-v1-2', tab 'Employee Data', row 2 (read 2026-11-12) — typos,
// asterisks and in-cell newlines included, so the CSV pastes straight into XPayroll's template.
export const XPAYROLL_HEADERS = [
  "Employee ID",
  "Name *",
  "Email *",
  "Date of Hiring * (DD/MM/YYYY format only)",
  "Professional Tax Location *\n(State)",
  "Title",
  "Department",
  "Annual CTC *",
  "PAN *",
  "Provident Fund?\n(Y/N) *",
  "PF UAN",
  "ESIC Number",
  "Taxable salary paid in current F.Y. till now by curent employer outside XPayroll *",
  "Exemptions in current F.Y. till now * (HRA exemption etc. by current employer)",
  "TDS deducted in current F.Y. till now *( Amount already deducted and paid for TDS)",
  "Past Taxable Salary(Amount paid to the employee by previous employer(s))",
  "Past TDS(Amount already deducted and paid for TDS by past employer(s))",
  "Phone Number",
  "Gender\n(M/F/Other)",
  "Date of Birth\n(dd/mm/yyyy)",
  "Bank Account Number",
  "Bank IFSC Code",
];
export function ddmmyyyy(iso) {
  if (!isIsoDate(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
export function xpGender(g) {
  const n = normGender(g);
  return n === 'm' ? 'M' : n === 'f' ? 'F' : n === 'other' ? 'Other' : '';
}
// pf_opt_out from the joining offer: true → N, false → Y, unknown → blank.
export const xpPf = (pfOptOut) => (pfOptOut === true ? 'N' : pfOptOut === false ? 'Y' : '');
// Cells: amounts are numbers; everything else is text. Annual CTC stays blank when unknown (vault off); the five
// current-FY / past-employer figures export 0 when null (nothing paid = 0).
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));
const zero = (v) => { const n = num(v); return n === '' ? 0 : n; };
// Long / leading-zero digit columns Excel and Sheets would turn into numbers (dropping zeros, 1.2E+17): PF UAN,
// ESIC, phone, bank account. The .xlsx export writes them as text cells; the CSV writes them as ="…" formula text.
export const XPAYROLL_TEXT_COLUMNS = [10, 11, 17, 20];
export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// r = { emp, priv, department, ctc, pf_opt_out, pt_state } → one row in XPAYROLL_HEADERS order.
export function xpayrollRow({ emp = {}, priv = {}, department = null, ctc = null, pf_opt_out = null, pt_state = '' } = {}) {
  const p = priv || {};
  const phone = emp.phone ? normPhone(emp.phone) : '';
  return [
    emp.employee_code || '', emp.full_name || '', emp.work_email || '', ddmmyyyy(emp.date_joined), pt_state || '',
    emp.job_title || '', department || '', num(ctc), emp.pan_number || '', xpPf(pf_opt_out), p.pf_uan || '',
    p.esic_number || '', zero(p.cur_fy_taxable_outside), zero(p.cur_fy_exemptions), zero(p.cur_fy_tds),
    zero(p.past_taxable_salary), zero(p.past_tds), phone, xpGender(emp.gender), ddmmyyyy(emp.date_of_birth),
    p.bank_account_number || '', p.bank_ifsc || '',
  ];
}
export function xpayrollCsv(rows) {
  const cell = (v, i) => (XPAYROLL_TEXT_COLUMNS.includes(i) && v !== '' && v != null ? csvCell(`="${String(v)}"`) : csvCell(v));
  return [XPAYROLL_HEADERS.map(h => csvCell(h)).join(','), ...(rows || []).map(r => r.map(cell).join(','))].join('\r\n') + '\r\n';
}
// The latest non-bonus CTC from compensation_events rows (newest first, as getCompensation reads them).
export function currentCtc(events) {
  const e = (events || []).find(x => x.event_type !== 'one_time_bonus' && x.new_ctc != null);
  return e ? Number(e.new_ctc) : null;
}

// ── Change requests: PAN alone, bank fields as ONE group ─────────────────────
// Account number + IFSC + account name pending for one person are one "Bank details" change, decided together
// (profile_change_decide takes the group + every pending row's rev, and refuses if any changed since HR looked).
export const CHANGE_GROUPS = { pan: ['pan_number'], bank: ['bank_account_number', 'bank_ifsc', 'bank_account_name'] };
export const CHANGE_GROUP_LABELS = { pan: 'PAN', bank: 'Bank details' };
export const changeGroupOf = (field) => (CHANGE_GROUPS.pan.includes(field) ? 'pan' : CHANGE_GROUPS.bank.includes(field) ? 'bank' : null);
// Pending rows → one entry per (employee, group): { employee_id, group, label, items: [{id, rev, field, …}] }.
export function groupChangeRequests(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const g = changeGroupOf(r.field);
    if (!g) continue;
    const k = `${r.employee_id}|${g}`;
    if (!by.has(k)) by.set(k, { employee_id: r.employee_id, group: g, label: CHANGE_GROUP_LABELS[g], requested_at: r.requested_at, items: [] });
    const e = by.get(k);
    e.items.push(r);
    if (String(r.requested_at || '') > String(e.requested_at || '')) e.requested_at = r.requested_at;
  }
  return [...by.values()].map(e => ({ ...e, items: e.items.sort((a, b) => CHANGE_GROUPS[e.group].indexOf(a.field) - CHANGE_GROUPS[e.group].indexOf(b.field)) }));
}
// decideProfileChange input → { employee_id, group, expected: [{id, rev}], decision, note } | { error }
export function cleanChangeDecision(d) {
  const x = d || {};
  if (!['pan', 'bank'].includes(x.group)) return { error: 'bad_group' };
  if (!['approved', 'rejected'].includes(x.decision)) return { error: 'bad_decision' };
  const items = Array.isArray(x.items) ? x.items : [];
  const expected = items.map(i => ({ id: String(i?.id || ''), rev: Number(i?.rev) }));
  if (!expected.length || expected.some(i => !/^[0-9a-f-]{36}$/i.test(i.id) || !Number.isInteger(i.rev) || i.rev < 1)) return { error: 'change_request_changed' };
  const note = String(x.note || '').trim().slice(0, 500) || null;
  if (x.decision === 'rejected' && !note) return { error: 'decision_note_required' };
  return { employee_id: x.employee_id, group: x.group, expected, decision: x.decision, note };
}

// ── Self view of an onboarding: only the person's own lines keep their notes; no cancel reason ──
export function selfViewItem(item) {
  if (!item || item.owner === 'employee') return item;
  const { note, ...rest } = item;
  return rest;
}
export function selfViewOnboarding(ob) {
  if (!ob) return ob;
  const { cancel_reason, cancelled_by, started_by, completed_by, ...rest } = ob;
  return rest;
}

// ── The template line (saveOnboardingLine) ───────────────────────────────────
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'intern', 'contractor', 'consultant'];   // employees CHECK
// → the row | { error: 'bad_line' }. sort 0 is kept (?? not ||); due_offset_days must be an integer −60…365;
// applies_to ⊆ the employment types. auto_source is never accepted (behaviour, not wording — as X1).
export function cleanOnboardingLine(d) {
  const x = d || {};
  const key = String(x.key || '').trim();
  const title = String(x.title || '').trim();
  const offRaw = x.due_offset_days;
  const off = offRaw === '' || offRaw === null || offRaw === undefined || typeof offRaw === 'boolean' ? NaN : Number(offRaw);
  const sortN = x.sort === '' || x.sort === null || x.sort === undefined ? 100 : Number(x.sort);
  const applies = Array.isArray(x.applies_to) ? [...new Set(x.applies_to.map(String))] : x.applies_to == null ? [] : null;
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key) || !title || title.length > 120 || !OB_OWNERS.includes(x.owner)
      || !Number.isInteger(off) || off < -60 || off > 365 || !Number.isInteger(sortN)
      || !applies || applies.some(t => !EMPLOYMENT_TYPES.includes(t))) return { error: 'bad_line' };
  return { key, title, owner: x.owner, required: x.required !== false, allow_na: !!x.allow_na, applies_to: applies,
    due_offset_days: off, sort: sortN, active: x.active !== false };
}

// ── DB errors ────────────────────────────────────────────────────────────────
export function onboardingDbErrorCode(data) {
  const d = data && typeof data === 'object' ? data : {};
  const m = String(d.message || '').match(/^podium_([a-z_]+)$/);
  if (m) return { code: m[1], status: 409, detail: d.details || null };
  if (d.code === '23505') {
    const msg = String(d.message || '');
    if (/employee_onboardings_one_open/.test(msg)) return { code: 'onboarding_already_open', status: 409, detail: null };
    if (/profile_change_requests_one_pending/.test(msg)) return { code: 'change_already_pending', status: 409, detail: null };
    if (/policy_acknowledgements/.test(msg)) return { code: 'already_acknowledged', status: 409, detail: null };
    return { code: 'conflict', status: 409, detail: null };
  }
  if (d.code === '23514') return { code: 'check_failed', status: 409, detail: null };
  return null;
}
