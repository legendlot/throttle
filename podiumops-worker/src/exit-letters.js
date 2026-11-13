// Podium X1b — relieving + experience letters. The PURE half: merge fields, the letter view (preview + PDF share
// it), the refusals, the template check, paths and refs. index.js does the I/O; migrations/0022_exit_letters.sql
// allocates the ref + revision and writes the document + letter rows in one transaction.
// Plan: docs/superpowers/plans/2026-11-13-podium-x1b-exit-letters.md (K1–K7) · tests: test/exit-letters.test.mjs
//
// Same template language as the offers (src/offer-render.js): {{field}} merges, {{#field}}…{{/field}} keeps its
// content only when the field is truthy, blank line = new paragraph. Unknown field / unclosed section = refused.
// Deterministic: no clock — every date is passed in (the issue date), so the stored file's SHA-256 is the record.

import { mergeBody, fmtLetterDate, renderLetterPdf, letterTextCleaner } from './offer-render.js';

export const EXIT_LETTER_KINDS = ['relieving', 'experience'];
export const EXIT_LETTER_FIELDS = [
  'employee_name', 'employee_code', 'designation', 'department', 'has_department', 'date_joined', 'last_working_day',
  'issue_date', 'entity_name', 'signatory_name', 'signatory_title', 'has_signatory_title', 'letter_ref',
];
const FIELD_SET = new Set(EXIT_LETTER_FIELDS);
export const EXIT_LETTER_DOC_TYPE = { relieving: 'relieving_letter', experience: 'experience_letter' };
export const EXIT_LETTER_LABEL = { relieving: 'Relieving letter', experience: 'Experience letter' };
const REF_PREFIX = { relieving: 'REL', experience: 'EXP' };

// REL-2026-001 (3 digits minimum, grows past 999 — the SQL twin is exit_letter_issue's lpad/greatest).
export function exitLetterRef(kind, year, n) {
  return `${REF_PREFIX[kind]}-${year}-${String(Math.round(Number(n))).padStart(3, '0')}`;
}

// The ref + revision the next issue for this exit + kind should get (the RPC re-derives both under the exit lock and
// refuses a mismatch). prior = this exit's letters of this kind; counterLastN = exit_letter_counters.last_n (0 if none).
export function nextExitLetterRef({ kind, prior = [], counterLastN = 0, year }) {
  const mine = (prior || []).filter(l => l.kind === kind);
  if (mine.length) {
    const top = mine.reduce((a, b) => (Number(b.revision) > Number(a.revision) ? b : a));
    return { ref: top.letter_ref, revision: Number(top.revision) + 1 };
  }
  return { ref: exitLetterRef(kind, year, Number(counterLastN || 0) + 1), revision: 1 };
}

// Storage path: under the employee's documents prefix (getDocumentDownloadUrl requires `<employee_id>/`), named by
// ref + revision + a hash prefix + a per-attempt nonce. The nonce makes every upload its own object, so two concurrent
// issues that predicted the same ref never share a path and a failed attempt's cleanup only ever deletes its own file.
export function exitLetterPath(employeeId, ref, revision, sha, nonce) {
  const n = String(nonce || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
  if (!n) throw new Error('exitLetterPath: nonce required');
  return `${employeeId}/exit_letters/${ref}_r${revision}_${String(sha).slice(0, 12)}_${n}.pdf`;
}
export const exitLetterFileName = (ref, revision) => `${ref}${Number(revision) > 1 ? `-r${revision}` : ''}.pdf`;
export const exitLetterTitle = (kind, ref, revision) =>
  `${EXIT_LETTER_LABEL[kind]} — ${ref}${Number(revision) > 1 ? ` (r${revision})` : ''}`;

// Why this letter cannot be issued (null = it can). Order = the plan's K3 list.
// exit = employee_exits row · employee = { date_joined, job_title } · signatory = offer_signatories row or null.
export function exitLetterBlock({ kind, exit, employee, signatory, today }) {
  if (!EXIT_LETTER_KINDS.includes(kind)) return 'bad_kind';
  if (!exit) return 'exit_not_found';
  if (exit.status === 'cancelled') return 'exit_cancelled';
  if (today < exit.lwd) return 'before_lwd';
  if (kind === 'experience' && !employee?.date_joined) return 'no_joining_date';
  if (!String(employee?.job_title || '').trim()) return 'no_designation';
  // Inactive, missing, or the leaver themselves — nobody signs their own relieving letter.
  if (!signatory || signatory.active === false || (signatory.employee_id && signatory.employee_id === employee?.id)) return 'bad_signatory';
  return null;
}

export function exitLetterFields({ exit = {}, employee = {}, department = null, template = {}, signatory = null, issueDate, ref }) {
  const dept = String(department?.name || '').trim();
  const title = String(signatory?.title || '').trim();
  return {
    employee_name: employee.full_name || '',
    employee_code: employee.employee_code || '',
    designation: String(employee.job_title || '').trim(),
    department: dept,
    has_department: !!dept,
    date_joined: fmtLetterDate(employee.date_joined),
    last_working_day: fmtLetterDate(exit.lwd),
    issue_date: fmtLetterDate(issueDate),
    entity_name: template.entity_name || '',
    signatory_name: signatory?.display_name || '',
    signatory_title: title,
    has_signatory_title: !!title,
    letter_ref: ref || '',
  };
}

// → { title, letterhead, paragraphs, closing, footer } — the shape renderLetterPdf draws (and the preview shows).
// Throws TemplateError. No phone on the letterhead (the offers print the signatory's; these are company letters).
export function exitLetterView({ exit, employee, department = null, template, signatory, issueDate, ref, revision = 1 }) {
  const fields = exitLetterFields({ exit, employee, department, template, signatory, issueDate, ref });
  const paragraphs = mergeBody(template?.body, fields, FIELD_SET);
  return {
    title: template?.title || '',
    letterhead: { entity_name: template?.entity_name || '', address_lines: (template?.entity_address || []).filter(Boolean), phone: null },
    paragraphs,
    closing: { salutation: fields.entity_name ? `For ${fields.entity_name}` : 'Regards,', name: fields.signatory_name, title: fields.signatory_title || null },
    footer: [ref, Number(revision) > 1 ? `r${revision}` : null, fields.issue_date].filter(Boolean).join(' · '),
  };
}

// The first merged value (or the closing line) the PDF font would alter — a '?' for a character Helvetica cannot draw,
// or a mapped one (₹ → INR). → the field name, or null. Issue refuses it (unsupported_characters); preview shows it.
export async function unsupportedCharField(args) {
  const clean = await letterTextCleaner();
  const f = exitLetterFields(args);
  for (const k of EXIT_LETTER_FIELDS) {
    const v = f[k];
    if (typeof v === 'string' && clean(v) !== v) return k;
  }
  const sal = f.entity_name ? `For ${f.entity_name}` : 'Regards,';
  if (clean(sal) !== sal) return 'closing';
  return null;
}

export async function renderExitLetterPdf(args) {
  return renderLetterPdf(exitLetterView(args), { issueDate: args.issueDate });
}

// Synthetic sample data for template previews and the merge-field check (never a real person).
export const SAMPLE_EXIT = { lwd: '2026-01-30', status: 'closed' };
export const SAMPLE_EMPLOYEE = { full_name: 'Sample Employee', employee_code: 'EMP-000', job_title: 'Sample Designation', date_joined: '2024-04-01' };
export const SAMPLE_DEPARTMENT = { name: 'Sample Department' };
export const SAMPLE_LETTER_SIGNATORY = { display_name: 'Sample Signatory', title: 'Sample Title' };
export const sampleExitLetterArgs = (template, kind = 'relieving') => ({
  exit: SAMPLE_EXIT, employee: SAMPLE_EMPLOYEE, department: SAMPLE_DEPARTMENT, template, signatory: SAMPLE_LETTER_SIGNATORY,
  issueDate: '2026-02-02', ref: exitLetterRef(kind, 2026, 0), revision: 1,
});

// Merge-field check for the template editor: every tag known, every section closed. → null | detail
export function validateExitLetterBody(body) {
  try { mergeBody(body, exitLetterFields(sampleExitLetterArgs({ entity_name: 'Sample Entity' })), FIELD_SET); return null; }
  catch (e) { return e.detail || 'template_error'; }
}
