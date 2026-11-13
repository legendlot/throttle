// X1 — exits + no-dues: vocabularies + error copy for the Exit panel, /exits and /admin/exit-checklist.
// Every gate is the worker's (podiumops-worker src/exits.js); these are labels only.

export const EXIT_REASONS = [
  { id: 'resignation',       label: 'Resignation' },
  { id: 'termination',       label: 'Termination' },
  { id: 'absconding',        label: 'Absconding' },
  { id: 'end_of_internship', label: 'End of internship' },
  { id: 'end_of_contract',   label: 'End of contract' },
  { id: 'other',             label: 'Other' },
];
export const CHECKLIST_OWNERS = [
  { id: 'hr',      label: 'HR' },
  { id: 'manager', label: 'Manager' },
  { id: 'it',      label: 'IT' },
  { id: 'admin',   label: 'Admin' },
  { id: 'finance', label: 'Finance' },
  { id: 'store',   label: 'Store' },
];
export const AUTO_SOURCE_LABELS = {
  snorkel_assets: 'Live from Snorkel assets',
  open_work: 'Live from Docket',
  payment_requests: 'Live from Snorkel payment requests',
  lot_access: 'Done by the close',
  leave_ledger: 'Live from the leave ledger',
};
export const GOOGLE_ITEM_STATUSES = [
  { id: 'open', label: 'Open', tone: 'bad' },
  { id: 'kept', label: 'Kept active', tone: 'warn' },
  { id: 'transfer_pending', label: 'Suspended · Drive transfer running', tone: 'warn' },
  { id: 'suspended', label: 'Suspended', tone: 'neutral' },
  { id: 'transferred_suspended', label: 'Drive transferred + suspended', tone: 'neutral' },
  { id: 'gone', label: 'No Google account', tone: 'neutral' },
];
export const ACCESS_LABEL = { login: 'LOT login active', podium_role: 'Podium role', comp_access: 'Salary access', google_admin: 'Google admin', assets: 'Snorkel assets held' };
export const BLOCKER_LABEL = {
  before_lwd: (b) => `Last working day is ${b.lwd}`,
  item_open: (b) => `Open: ${b.title}`,
  assets_outstanding: (b) => `${b.count} asset${b.count === 1 ? '' : 's'} still assigned in Snorkel`,
  open_work: (b) => `${b.count} open Docket task${b.count === 1 ? '' : 's'}`,
  live_check_failed: () => 'Could not check Snorkel / Docket / leave — reload',
  leave_changed: () => 'Leave changed since the balance was confirmed — re-open the leave line and confirm it again',
  exit_not_open: () => 'This exit is not open',
};
export function blockerText(b) { return (BLOCKER_LABEL[b?.code] || (() => b?.code || ''))(b || {}); }

const COPY = {
  use_exit_flow: 'Exits are recorded through the Exit panel on the person’s page',
  exits_are_recorded_in_podium: 'The sync no longer exits anyone — start the exit on the person’s page',
  forbidden: 'You cannot act on this exit',
  forbidden_item: 'Only HR — or the manager, for manager lines — can set this line',
  set_by_close: 'LOT app access is revoked by closing the exit',
  bad_reason_code: 'Pick a reason',
  reason_note_required: 'Say what the reason is',
  bad_notice_date: 'Pick the date notice was given',
  notice_date_in_future: 'The notice date cannot be in the future',
  bad_lwd: 'Pick a real last working day (not in the future)',
  lwd_before_joining: 'The last working day is before the person joined',
  notice_before_joining: 'The notice date is before the person joined',
  notice_date_too_old: 'The notice date can be at most 7 days back — HR can record an older one',
  lwd_closed_month_hr_only: 'A last working day in an earlier month changes a closed SG&A month — only HR can set it, with a reason',
  bad_rehire: 'Rehire must be yes, no or not recorded',
  assets_unverifiable: 'Snorkel cannot verify these assets automatically — HR marks the line Done with a note',
  org_check_failed: 'Could not check the reporting line right now — try again',
  transfer_in_progress: 'The Drive transfer is under way — use Check transfer',
  no_transfer_to_check: 'There is no transfer to check',
  in_progress: 'Someone else is acting on this account right now — wait a moment and reload',
  no_work_email: 'This person has no work email',
  google_item_exists: 'This person already has an open Google item',
  lwd_before_notice: 'The last working day is before the notice date',
  lwd_override_hr_only: 'Only HR can change the last working day',
  lwd_override_reason_required: 'Say why the last working day differs from the notice period (at least 5 characters)',
  already_exited: 'This person has already exited',
  exit_already_open: 'An exit is already open for this person',
  exit_not_open: 'This exit is not open',
  before_lwd: 'The exit can close on or after the last working day',
  checklist_incomplete: 'Required checklist lines are still open',
  assets_outstanding: 'Assets are still assigned to this person in Snorkel',
  open_work: 'This person still has open Docket tasks',
  exit_blocked: 'The exit cannot close yet — clear the blockers listed',
  live_check_failed: 'Could not check Snorkel / Docket right now — try again',
  na_not_allowed: 'This line cannot be marked N/A',
  na_note_required: 'Say why this line does not apply',
  bad_document: 'That document is not on this person’s record',
  cancel_reason_required: 'Say why (at least 5 characters)',
  not_exited: 'Only an exited person can be handled here',
  already_backfilled: 'This exit already has a record',
  keep_until_future: 'Pick a future date',
  keep_reason_required: 'Say why the account stays active (at least 5 characters)',
  google_item_closed: 'This account has already been actioned',
  google_account_mismatch: 'The Google account no longer matches this address — not touched',
  manager_has_no_google_account: 'The manager has no Google account to receive the Drive — use Suspend, or fix the manager',
  drive_app_not_found: 'Google did not list the Drive transfer app',
  google_error: 'Google refused the request',
  google_write_not_configured: 'Google write access is not configured on the worker',
  forbidden_google_admin: 'Only a Google admin (Afshaan, Vinay, Mohit) can do this',
  bad_line: 'Key (lowercase_with_underscores), title and owner are required',
  bad_tool: 'A tool needs a name',
  // Leave R2 E2 (the leave line)
  leave_after_lwd: 'This person has leave pending or approved after the last working day — cancel it first',
  leave_pending: 'This person has a leave request still pending — decide or withdraw it first',
  leave_changed: 'Leave changed since the balance was confirmed — confirm it again',
};
export function exitError(e, fallback = 'Something went wrong') {
  const msg = (e && e.message) || '';
  const code = msg.split(/[:\s]/)[0];
  return COPY[code] || msg || fallback;
}

export function addDaysIso(iso, n) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
export function labelOfList(list, id) { return list.find(x => x.id === id)?.label || (id ? String(id).replace(/_/g, ' ') : '—'); }
