// Hiring (C1 openings + C2 candidates) — labels, colours and the client mirror of the worker's
// pure rules (podiumops-worker/src/hiring.js). The worker is the authority on every gate; these
// only decide what the UI offers. Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c1-c2.md.

// Semantic tone → token set (same tokens StatusBadge uses).
export const TONES = {
  ok:      { fg: 'var(--ok-fg)',      bg: 'var(--ok-bg)',      bd: 'var(--ok-bd)' },
  warn:    { fg: 'var(--warn-fg)',    bg: 'var(--warn-bg)',    bd: 'var(--warn-bd)' },
  bad:     { fg: 'var(--bad-fg)',     bg: 'var(--bad-bg)',     bd: 'var(--bad-bd)' },
  neutral: { fg: 'var(--neutral-fg)', bg: 'var(--neutral-bg)', bd: 'var(--neutral-bd)' },
  info:    { fg: 'var(--blue-soft)',  bg: 'rgba(109,131,255,0.14)', bd: 'rgba(109,131,255,0.35)' },
  accent:  { fg: 'var(--yellow)',     bg: 'rgba(242,205,26,0.12)',  bd: 'rgba(242,205,26,0.35)' },
};

export const OPENING_STATUSES = [
  { id: 'draft',     label: 'Draft',     tone: 'neutral' },
  { id: 'open',      label: 'Open',      tone: 'ok' },
  { id: 'on_hold',   label: 'On Hold',   tone: 'warn' },
  { id: 'filled',    label: 'Filled',    tone: 'info' },
  { id: 'cancelled', label: 'Cancelled', tone: 'bad' },
];

export const APP_STATUSES = [
  { id: 'new',          label: 'New',          tone: 'accent' },
  { id: 'screening',    label: 'Screening',    tone: 'info' },
  { id: 'interviewing', label: 'Interviewing', tone: 'info' },
  { id: 'offer',        label: 'Offer',        tone: 'ok' },
  { id: 'accepted',     label: 'Accepted',     tone: 'ok' },
  { id: 'on_hold',      label: 'On Hold',      tone: 'warn' },
  { id: 'joined',       label: 'Joined',       tone: 'ok' },
  { id: 'rejected',     label: 'Rejected',     tone: 'bad' },
  { id: 'declined',     label: 'Declined',     tone: 'bad' },
  { id: 'withdrawn',    label: 'Withdrawn',    tone: 'neutral' },
  { id: 'no_show',      label: 'No Show',      tone: 'bad' },
];
export const ACTIVE_APP_STATUSES = ['new', 'screening', 'interviewing', 'offer', 'accepted', 'on_hold'];

// Manual moves. →offer / →accepted come only from the offer flow (sent / acceptance recorded); the C3
// closes (offer → declined | withdrawn | rejected, accepted → withdrawn) need the live offer closed first.
// accepted → no_show (J1) keeps the accepted offer; →joined comes only from Confirm joining.
// Mirrors APP_TRANSITIONS in the worker.
export const APP_TRANSITIONS = {
  new:          ['screening', 'rejected', 'withdrawn', 'on_hold'],
  screening:    ['interviewing', 'rejected', 'withdrawn', 'on_hold'],
  interviewing: ['rejected', 'withdrawn', 'on_hold'],
  on_hold:      ['new', 'screening', 'interviewing', 'rejected', 'withdrawn'],
  offer:        ['declined', 'withdrawn', 'rejected'],
  accepted:     ['withdrawn', 'no_show'],
};
export const REASON_REQUIRED = ['rejected', 'withdrawn', 'declined'];
// Reject / withdraw reasons are a category (shown to everyone who sees the application); any free text
// is a note the worker shows only to the opening's salary chain. Mirrors OUTCOME_REASON_CODES in the worker.
export const OUTCOME_REASONS = [
  { id: 'not_a_fit',          label: 'Not a fit' },
  { id: 'skills',             label: 'Skills' },
  { id: 'experience',         label: 'Experience' },
  { id: 'compensation',       label: 'Compensation' },
  { id: 'location',           label: 'Location' },
  { id: 'notice_period',      label: 'Notice period' },
  { id: 'candidate_withdrew', label: 'Candidate withdrew' },
  { id: 'no_response',        label: 'No response' },
  { id: 'duplicate',          label: 'Duplicate' },
  { id: 'other',              label: 'Other' },
];
export function allowedTransitions(status) { return APP_TRANSITIONS[status] || []; }

export const BUDGET_STATUSES = [
  { id: 'pending',    label: 'Pending approval', tone: 'warn' },
  { id: 'approved',   label: 'Approved',         tone: 'ok' },
  { id: 'rejected',   label: 'Rejected',         tone: 'bad' },
  { id: 'superseded', label: 'Superseded',       tone: 'neutral' },
  { id: 'cancelled',  label: 'Cancelled',        tone: 'neutral' },
  { id: 'none',       label: 'No band',          tone: 'neutral' },
];

export const SOURCES = [
  { id: 'referral',     label: 'Referral' },
  { id: 'linkedin',     label: 'LinkedIn' },
  { id: 'naukri',       label: 'Naukri' },
  { id: 'campus',       label: 'Campus' },
  { id: 'walk_in',      label: 'Walk-in' },
  { id: 'agency',       label: 'Agency' },
  { id: 'careers_page', label: 'Careers page' },
  { id: 'other',        label: 'Other' },
];

export const HIRING_EMPLOYMENT_TYPES = [
  { id: 'full_time', label: 'Full-time' },
  { id: 'intern',    label: 'Intern' },
];

// Candidate document types. `tier`: open = anyone who can see the opening; salary = the salary chain;
// hr = HR only. The worker filters the list and refuses the upload/URL; the tier here only decides
// which options the upload select offers.
export const CANDIDATE_DOC_TYPES = [
  { id: 'cv',                label: 'CV',                tier: 'open' },
  { id: 'education',         label: 'Education',         tier: 'open' },
  { id: 'experience_letter', label: 'Experience letter', tier: 'open' },
  { id: 'relieving_letter',  label: 'Relieving letter',  tier: 'hr' },   // worker fails it closed to HR (joining-stage doc)
  { id: 'photo',             label: 'Photo',             tier: 'open' },
  { id: 'other',             label: 'Other',             tier: 'open' },
  { id: 'payslip',           label: 'Payslip',           tier: 'salary' },
  { id: 'signed_offer',      label: 'Signed offer',      tier: 'salary' },
  { id: 'offer_evidence',    label: 'Offer as sent',     tier: 'salary' },
  { id: 'id_proof',          label: 'ID proof',          tier: 'hr' },
  { id: 'pan',               label: 'PAN',               tier: 'hr' },
  { id: 'address_proof',     label: 'Address proof',     tier: 'hr' },
  { id: 'bank',              label: 'Bank details',      tier: 'hr' },
];
export const CANDIDATE_DOC_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.webp';
export const JD_ACCEPT = '.pdf,.docx';
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const JD_REQUIRED_MSG = 'Add the JD to this opening first. Without a JD the opening stays a draft and no CVs can be added.';

// Worker error codes → what the user should read.
const ERROR_COPY = {
  jd_required: 'Add the JD to this opening first',
  resolve_applications_first: 'Close or move every active candidate before marking this opening filled or cancelled',
  no_self_approval: 'You requested this, so someone else has to approve it',
  already_active: 'This candidate already has an active application on that opening',
  opening_not_open: 'The opening is not open for candidates',
  reason_required: 'A reason is required',
  invalid_transition: 'That status move is not allowed',
  not_pending: 'That band request has already been decided',
  stale: 'This changed since you loaded it — refresh and try again',
  forbidden: 'You do not have access to do that',
  bad_reason: 'Pick a reason from the list',
  no_self_chain: 'You cannot put yourself on this opening — ask a founder',
  reporting_manager_not_in_team: 'The reporting manager must be you or someone in your team',
  band_from_role_requires_comp: "Only the salary allow-list can use the role's band — enter a band instead",
  // C3 offers
  application_not_ready: 'Offers start once the candidate is interviewing',
  band_not_approved: 'The opening has no approved band yet — get the band approved first',
  draft_exists: 'This application already has an offer in progress — edit that one',
  not_editable: 'Only a draft (or a rejected one) can be edited — revise instead',
  signatory_required: 'Pick who signs the letter',
  signatory_inactive: 'That signatory is not active',
  template_missing: 'No current template for this kind of offer',
  rule_set_missing: 'No statutory rule set covers that start date',
  special_negative: 'The deductions exceed the allowances — the special allowance would be negative',
  wage_rule: 'Basic would fall below 50% of fixed pay',
  pf_opt_out_not_eligible: 'PF opt-out is allowed only when Basic is above the PF wage ceiling',
  pf_opt_out_reason_required: 'Give a reason for not opting in to PF',
  offer_expired: "The acceptance date is after the offer's validity — send a fresh revision",
  close_offers_first: "Withdraw or close this application's live offer first",
  already_accepted: 'Another revision of this offer is already accepted',
  pdf_store_failed: 'The PDF could not be stored — try again',
  template_error: 'The template has an unknown merge field or an unclosed section',
  no_pdf: 'This revision has not been issued yet',
  not_latest: 'A newer revision has been sent — only the latest sent revision can be accepted',
  not_approved_for_terms: 'This offer is outside the band and not approved for these exact terms',
  doc_in_use: 'This document is the evidence for an offer and cannot be deleted',
  doc_already_recorded: 'That file is already recorded',
  pdf_path_in_use: 'That PDF is already recorded against another revision',
  conflict: 'This conflicts with an existing record — reload and retry',
  offer_check_failed: 'The offer failed a consistency check — reload and retry',
  bad_fixed_annual: 'Enter the fixed salary (annual, whole rupees)',
  bad_variable_annual: 'Enter the variable pay as whole rupees',
  bad_stipend_monthly: 'Enter the monthly stipend',
  bad_internship_months: 'Internship length must be 1–24 months',
  start_date_required: 'Pick a start date',
  designation_required: 'Designation is required',
  location_required: 'Location is required',
  bad_probation_months: 'Probation must be 0–12 months',
  bad_valid_days: 'Validity must be 1–60 days',
  bad_joining_bonus: 'Joining bonus must be whole rupees',
  bad_retention_bonus: 'Retention bonus must be whole rupees',
  // J1 work accounts + joining
  forbidden_google_admin: 'Only a Google admin (Afshaan, Vinay, Mohit) can do this',
  forbidden_podium_view: 'You do not have access to do that',
  not_accepted: 'The application must be at Accepted',
  offer_not_accepted: 'This application has no accepted offer',
  offer_not_latest: 'A newer offer revision is in progress or was sent — finish it first',
  rehire_not_supported_yet: 'This person was an employee before — rehires are not supported yet',
  account_exists: 'A work account already exists for this application',
  account_pending_other_email: 'An account for another address is still being created — retry that one',
  email_taken: 'That address is already taken — pick another',
  bad_org_unit: 'Pick an org unit from the list',
  bad_name: 'Given and family name are required (up to 60 characters each)',
  override_reason_required: 'Say why this account is created without hiring (at least 10 characters)',
  local_required: 'Enter the part before @',
  local_too_long: 'The address is too long',
  local_bad_chars: 'Use lowercase letters, digits and dots only',
  local_bad_dots: 'No dot at the start or end, and no two dots together',
  google_error: 'Google refused the request — try again, or check the address',
  google_write_not_configured: 'Google account creation is not configured on the worker',
  record_failed: 'Google created the account but Podium could not record it — create it again to finish',
  no_work_account: 'Create the work account first',
  employee_id_mismatch: 'This changed since you loaded it — refresh and try again',
  bad_start_date: 'Pick the actual start date',
  start_date_too_far: 'The start date can be at most 7 days ahead — confirm joining on the day',
  start_date_before_acceptance: 'The start date is before the offer was accepted',
  doc_copy_failed: 'The hiring documents could not be copied — try again',
  bad_document_path: 'A document path was outside the employee folder',
  not_suspendable: 'Only an account whose application is No show or Withdrawn can be suspended here',
  check_failed: 'The record failed a consistency check',
  in_progress: 'Someone else is creating this account right now — wait a moment and reload',
  not_resettable: 'Only a created account whose person has not joined can have its password reset here',
  offer_changed: 'The offer changed while joining was being confirmed — reload and retry',
  opening_closed: 'The opening is cancelled — reopen it before confirming joining',
  headcount_full: 'The opening already has its full headcount joined',
  created_by_podium_awaiting_joining: 'Podium created this address for a hire who has not joined — use Confirm joining on the candidate',
  // O2 interviews
  application_not_schedulable: 'Interviews can be scheduled only while the candidate is New, Screening or Interviewing',
  round_required: 'Pick a round from the plan',
  bad_round: 'That round is not on this opening, or is inactive',
  round_already_scheduled: 'This candidate already has a live interview for that round',
  panel_required: 'Add at least one interviewer',
  panel_too_large: 'At most 10 interviewers',
  bad_panel: 'Pick interviewers from the list',
  panelist_inactive: 'Interviewers must be active employees with a Podium login',
  panel_submitted: 'An interviewer who has submitted feedback cannot be removed',
  interview_closed: 'This interview is cancelled or marked as a no-show',
  not_scheduled: 'Only a scheduled interview can be changed',
  too_early: 'The interview time has not passed yet',
  verdict_exists: 'This interview already has a verdict',
  bad_verdict: 'Pick advance, hold or reject',
  already_submitted: 'Your feedback is already in. It cannot be edited',
  feedback_locked: 'Your feedback is already in. It cannot be edited',
  scores_incomplete: 'Score every criterion from 1 to 5',
  bad_rating: 'Pick an overall rating from 1 to 5',
  bad_recommendation: 'Pick a recommendation',
  bad_scores: "The scores do not match this interview's scorecard",
  notes_too_long: 'Notes can be at most 5,000 characters',
  note_too_long: 'The note can be at most 2,000 characters',
  remind_too_soon: 'A reminder went out in the last 12 hours',
  feedback_not_owed: 'This interviewer owes no feedback right now',
  no_work_mailbox: 'You need an active work mailbox to send reminders',
  panelist_no_email: 'That interviewer has no work email',
  mail_failed: 'The reminder could not be sent. Try again',
  mail_unknown: 'The reminder may not have gone out. Check your Sent folder before trying again',
  bad_time: 'Pick a time within the next year (or the last 30 days)',
  time_required: 'Pick the interview time',
  bad_mode: 'Pick in person, video or phone',
  bad_duration: 'Duration must be 10 to 480 minutes',
  location_too_long: 'Location can be at most 500 characters',
  cancel_reason_required: 'Say why the interview is cancelled',
  cancel_reason_too_long: 'The reason can be at most 500 characters',
  round_name_required: 'Name the round',
  round_name_too_long: 'Round names can be at most 80 characters',
  too_many_criteria: 'At most 10 scorecard criteria',
  duplicate_criteria: 'Two criteria have the same name',
  criterion_label_required: 'Each criterion needs a name',
  criterion_label_too_long: 'Criterion names can be at most 80 characters',
  bad_criterion_key: 'Each criterion needs a name',
  bad_order: 'The round list changed. Refresh and try again',
  no_patch: 'Nothing changed',
  panel_self: 'You cannot add or remove yourself from a panel; ask another member of the hiring team',
  reschedule_after_feedback: 'Feedback is in, so the time cannot move. Cancel this interview and schedule a new one',
  // O3 — Calendar (podiumops-worker/src/calendar.js CAL_COPY)
  calendar_off: 'Google Calendar is not switched on for Podium yet',
  calendar_not_scheduled: 'Only a scheduled interview can go on the calendar',
  calendar_past: 'This interview time has passed',
  calendar_linked: 'This interview is already on the calendar',
  calendar_busy: 'Someone is adding this interview to the calendar right now, refresh in a moment',
  calendar_no_mailbox: 'You need an active work mailbox to organise the calendar invite',
  calendar_no_candidate_email: 'The candidate has no email address for an invite',
  calendar_event_deleted: 'The calendar event was deleted in Google Calendar; schedule a new interview',
  calendar_failed: 'Google Calendar did not accept the invite, try again',
};
export function hiringError(e, fallback = 'Something went wrong') {
  const msg = (e && e.message) || '';
  const code = msg.split(/[:\s]/)[0];
  return ERROR_COPY[code] || msg || fallback;
}

export function labelFrom(list, id) { return list.find(x => x.id === id)?.label || (id ? String(id).replace(/_/g, ' ') : '—'); }
export function toneFrom(list, id) { return TONES[list.find(x => x.id === id)?.tone || 'neutral']; }

// Annual INR → "₹12,00,000" (or "₹12.0 L" with compact).
export function formatINR(n, { compact = false } = {}) {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (compact) {
    if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
    if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  }
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);
}
export function formatBand(min, max) {
  if (min == null && max == null) return '—';
  return `${formatINR(min, { compact: true })} – ${formatINR(max, { compact: true })}`;
}

export function fmtDateTime(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  } catch { return String(d); }
}

// A list response may arrive bare or wrapped ({ openings: [...] }) — accept either.
export function listOf(d, key) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d[key])) return d[key];
  return [];
}
// Write responses: the new row's id, wherever the worker put it.
export function idOf(d, key) {
  if (!d) return null;
  return d.id || d[key]?.id || d[`${key}_id`] || null;
}
// Empty strings → null; numeric strings → Number (for band/CTC inputs).
export function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ── Offers (C3) ──────────────────────────────────────────────────────────────
export const OFFER_STATUSES = [
  { id: 'draft',             label: 'Draft',             tone: 'neutral' },
  { id: 'pending_approval',  label: 'Pending approval',  tone: 'warn' },
  { id: 'approved',          label: 'Approved',          tone: 'info' },
  { id: 'approval_rejected', label: 'Approval rejected', tone: 'bad' },
  { id: 'ready',             label: 'Ready to send',     tone: 'accent' },
  { id: 'sent',              label: 'Sent',              tone: 'info' },
  { id: 'accepted',          label: 'Accepted',          tone: 'ok' },
  { id: 'declined',          label: 'Declined',          tone: 'bad' },
  { id: 'expired',           label: 'Expired',           tone: 'warn' },
  { id: 'withdrawn',         label: 'Withdrawn',         tone: 'neutral' },
  { id: 'superseded',        label: 'Superseded',        tone: 'neutral' },
];
export const OFFER_OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'approval_rejected'];
export const OFFER_WITHDRAWABLE = ['draft', 'pending_approval', 'approved', 'approval_rejected', 'ready', 'sent', 'accepted', 'expired'];
export const BAND_CHECKS = [
  { id: 'in_band',    label: 'In band',                         tone: 'ok' },
  { id: 'below_band', label: 'Below band',                      tone: 'warn' },
  { id: 'above_band', label: 'Above band — needs approval',     tone: 'bad' },
  { id: 'extras',     label: 'One-time extras — need approval', tone: 'warn' },
];
export const VARIABLE_LABELS = [
  { id: 'variable pay',  label: 'Variable pay' },
  { id: 'incentive pay', label: 'Incentive pay' },
];
// Only the two the payouts reader handles (mirrors VARIABLE_FREQUENCIES in the worker).
export const VARIABLE_FREQUENCIES = [
  { id: 'half-yearly', label: 'Half-yearly' },
  { id: 'monthly',     label: 'Monthly' },
];
export const OFFER_TEMPLATE_KEYS = [
  { id: 'employment', label: 'Offer of Employment' },
  { id: 'internship', label: 'Internship Offer' },
];
// Today in IST as YYYY-MM-DD (offers date and expire by India time).
export function istTodayIso() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }

// ── Work accounts (J1) ───────────────────────────────────────────────────────
export const WORK_ACCOUNT_STATUSES = [
  { id: 'pending',   label: 'Creating',  tone: 'warn' },
  { id: 'created',   label: 'Created',   tone: 'ok' },
  { id: 'failed',    label: 'Failed',    tone: 'bad' },
  { id: 'suspended', label: 'Suspended', tone: 'bad' },
];
