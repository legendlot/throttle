// Podium X1 — exits + no-dues. The PURE rules (no I/O): who may start / tick / close, the default LWD and its
// override rule, the checklist snapshot, item resolution, close blockers, the Google prompt's due logic and the
// DB error map. index.js does the I/O; migrations/0010_exits.sql is the transactional half.
// Plan: docs/superpowers/plans/2026-11-11-podium-x1-exits.md · tests: test/exits.test.mjs
import { addDaysIso, isIsoDate } from './hiring.js';

export const EXIT_REASON_CODES = ['resignation', 'termination', 'absconding', 'end_of_internship', 'end_of_contract', 'other'];
export const EXIT_STATUSES = ['open', 'closed', 'cancelled'];
export const ITEM_STATUSES = ['open', 'done', 'na'];
export const CHECKLIST_OWNERS = ['hr', 'manager', 'it', 'admin', 'finance', 'store'];
export const AUTO_SOURCES = ['snorkel_assets', 'open_work', 'payment_requests', 'lot_access'];
export const GOOGLE_ACTIONS = ['transfer_and_suspend', 'suspend', 'keep', 'check_transfer'];
// transfer_pending = the Drive transfer started and the account is suspended; it stays in the queue until a
// "Check transfer" (transfers.get) sees it completed. gone = Google has no such account any more (terminal).
export const GOOGLE_ITEM_STATUSES = ['open', 'kept', 'transfer_pending', 'transferred_suspended', 'suspended', 'gone'];
export const GOOGLE_LIVE_STATUSES = ['open', 'kept', 'transfer_pending'];

// Live source values (checked against the DB 2026-11-11; 0010's exit_close mirrors the first two).
export const ASSET_CLOSED_STATUSES = ['retired'];                        // store.assets: anything else is still held
export const DOCKET_CLOSED_STATUSES = ['done', 'abandoned'];             // docket.tasks
export const DOCKET_OPEN_STATUSES = ['not_started', 'in_progress', 'blocked'];
export const PR_OPEN_STATUSES = ['submitted', 'pending_approval', 'approved', 'held'];   // store.payment_requests

export const TOOL_KEY_PREFIX = 'tool:';
export const NOTE_MAX = 2000;
export const NOTICE_BACKDATE_DAYS = 7;   // a non-HR starter's notice date is at most this many days back

// Who is the caller, for THIS employee's exit? Self wins over HR: nobody runs their own exit (an HR person who
// resigns is an employee here; another HR person closes it). → 'employee' | 'manager' | 'hr' | null
export function exitRole({ hr = false, self = false, chain = false } = {}) {
  if (self) return 'employee';
  if (hr) return 'hr';
  if (chain) return 'manager';
  return null;
}
export const canSeeExit = (role) => role === 'hr' || role === 'manager' || role === 'employee';
export const canStartExit = canSeeExit;
export const canManageExit = (role) => role === 'hr';   // close · cancel · update · backfill

// May this role set this line? (null = yes, else an error code.) lot_access is completed by the close only.
export function canTickItem(role, item) {
  if (!item) return 'not_found';
  if (item.auto_source === 'lot_access') return 'set_by_close';
  if (role === 'hr') return null;
  if (role === 'manager' && item.owner === 'manager') return null;
  return 'forbidden_item';
}

export const defaultLwd = (noticeDate, noticeDays) => addDaysIso(noticeDate, Math.max(0, Math.round(Number(noticeDays) || 0)));

export const monthStart = (iso) => String(iso).slice(0, 8) + '01';

// The LWD rule: default = notice date + exit_notice_days. Only HR may pick another date, and only with a reason.
// ⚠️ An LWD before the first day of the CURRENT IST month lands date_exited in a month SG&A has already run, so
// it is HR-only and needs a reason even when it IS the default (`today` omitted → that check is skipped).
// → { lwd, lwd_override_reason } | { error }
export function resolveLwd({ notice_date, lwd, lwd_override_reason }, noticeDays, role, today = null) {
  if (!isIsoDate(notice_date)) return { error: 'bad_notice_date' };
  const def = defaultLwd(notice_date, noticeDays);
  const want = lwd === undefined || lwd === null || lwd === '' ? def : lwd;
  if (!isIsoDate(want)) return { error: 'bad_lwd' };
  if (want < notice_date) return { error: 'lwd_before_notice' };
  const closedMonth = !!today && isIsoDate(today) && want < monthStart(today);
  if (want === def && !closedMonth) return { lwd: def, lwd_override_reason: null };
  if (role !== 'hr') return { error: closedMonth ? 'lwd_closed_month_hr_only' : 'lwd_override_hr_only' };
  const why = String(lwd_override_reason || '').trim();
  if (why.length < 5) return { error: 'lwd_override_reason_required' };
  return { lwd: want, lwd_override_reason: why.slice(0, 500) };
}

// startExit input → the exit_start payload (minus employee + items), or { error }.
// self → resignation, notice today, default LWD, no override, no rehire flag. manager → any reason, default LWD,
// no rehire flag, notice at most NOTICE_BACKDATE_DAYS back. hr → everything. notice_date is never in the future
// (it is the day notice was given) and never before the person joined.
export function buildStartExit(d, role, noticeDays, today, dateJoined = null) {
  if (!canStartExit(role)) return { error: 'forbidden' };
  const initiated_by = role === 'hr' ? 'hr' : role === 'manager' ? 'manager' : 'employee';
  const self = role === 'employee';
  const reason_code = self ? 'resignation' : d.reason_code;
  if (!EXIT_REASON_CODES.includes(reason_code)) return { error: 'bad_reason_code' };
  const reason_note = String(d.reason_note || '').trim().slice(0, NOTE_MAX) || null;
  if (reason_code === 'other' && !reason_note) return { error: 'reason_note_required' };
  const notice_date = self ? today : d.notice_date;
  if (!isIsoDate(notice_date)) return { error: 'bad_notice_date' };
  if (notice_date > today) return { error: 'notice_date_in_future' };
  if (isIsoDate(dateJoined) && notice_date < dateJoined) return { error: 'notice_before_joining' };
  if (role !== 'hr' && notice_date < addDaysIso(today, -NOTICE_BACKDATE_DAYS)) return { error: 'notice_date_too_old' };
  const l = resolveLwd({ notice_date, lwd: self ? null : d.lwd, lwd_override_reason: self ? null : d.lwd_override_reason }, noticeDays, role, today);
  if (l.error) return l;
  let rehire_eligible = null;
  if (role === 'hr' && (d.rehire_eligible === true || d.rehire_eligible === false)) rehire_eligible = d.rehire_eligible;
  return { initiated_by, reason_code, reason_note, notice_date, lwd: l.lwd, lwd_override_reason: l.lwd_override_reason, rehire_eligible };
}

// The snapshot: active template lines that apply to this employment type (empty applies_to = all; an employee
// with no employment type gets every line — more checks, never fewer), then one line per active tool.
export function snapshotItems(lines, tools, employmentType) {
  const out = (lines || [])
    .filter(l => l && l.active !== false)
    .filter(l => !Array.isArray(l.applies_to) || !l.applies_to.length || !employmentType || l.applies_to.includes(employmentType))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.key).localeCompare(String(b.key)))
    .map(l => ({ line_key: l.key, title: l.title, owner: l.owner, required: !!l.required, allow_na: !!l.allow_na,
      auto_source: l.auto_source || null, sort: Number(l.sort) || 0 }));
  const ts = (tools || []).filter(t => t && t.active !== false)
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name).localeCompare(String(b.name)));
  ts.forEach((t, i) => out.push({ line_key: TOOL_KEY_PREFIX + t.id, title: `Access removed: ${t.name}`, owner: 'it',
    required: true, allow_na: true, auto_source: null, sort: 1000 + i }));
  return out;
}

// Is a line out of the way of the close? Not-required lines never block; lot_access is done BY the close.
export function itemResolved(item) {
  if (!item.required) return true;
  if (item.auto_source === 'lot_access') return true;
  return item.status === 'done' || (item.status === 'na' && !!item.allow_na);
}

// A requested item change → null when allowed, else an error code. `live` = { assets, tasks, assets_verifiable }.
// (exit_update_item re-applies every rule under the exit lock; this is the pre-check + the testable copy.)
// Assets that cannot be verified automatically (no auth link, or unlinked assets in the person's name) → only
// HR can mark the line Done, and only with a note saying how it was checked.
export function checkItemUpdate(item, { status, note }, live = {}, role = null) {
  if (!ITEM_STATUSES.includes(status)) return 'bad_item_status';
  if (item.auto_source === 'lot_access') return 'set_by_close';
  const hasNote = !!String(note || '').trim();
  if (status === 'na') {
    if (!item.allow_na) return 'na_not_allowed';
    if (!hasNote) return 'na_note_required';
  }
  if (status === 'done') {
    if (item.auto_source === 'snorkel_assets' && Number(live.assets) > 0) return 'assets_outstanding';
    if (item.auto_source === 'snorkel_assets' && live.assets_verifiable === false && (role !== 'hr' || !hasNote)) return 'assets_unverifiable';
    if (item.auto_source === 'open_work' && Number(live.tasks) > 0) return 'open_work';
  }
  return null;
}
// Can Snorkel answer "does this person still hold assets"? Not without an auth link, and not while assets sit
// under their NAME with no custodian user (the custodian link was never made).
export function assetsVerifiable(authUserId, unlinkedByName) { return !!authUserId && !(Number(unlinkedByName) > 0); }

// updateExit → { patch, openOnly } | { error }. Only CHANGED fields count (the UI sends only those); the LWD is
// re-resolved only when the date or its reason actually changes. A closed / cancelled exit takes only the
// exit interview and the rehire flag.
const same = (a, b) => (a === undefined || a === null || a === '' ? null : a) === (b === undefined || b === null || b === '' ? null : b);
export function buildExitPatch(x, d, noticeDays, today) {
  const patch = {};
  const lwdChanged = 'lwd' in d && !same(d.lwd, x.lwd);
  const whyChanged = 'lwd_override_reason' in d && !same(String(d.lwd_override_reason ?? '').trim(), x.lwd_override_reason);
  const reasonChanged = 'reason_code' in d && !same(d.reason_code, x.reason_code);
  const noteChanged = 'reason_note' in d && !same(String(d.reason_note ?? '').trim(), x.reason_note);
  const openOnly = lwdChanged || whyChanged || reasonChanged || noteChanged;
  if (openOnly && x.status !== 'open') return { error: 'exit_not_open' };
  if (reasonChanged) {
    if (!EXIT_REASON_CODES.includes(d.reason_code)) return { error: 'bad_reason_code' };
    patch.reason_code = d.reason_code;
  }
  if (noteChanged) patch.reason_note = String(d.reason_note || '').trim().slice(0, NOTE_MAX) || null;
  if ((reasonChanged || noteChanged) && (patch.reason_code || x.reason_code) === 'other'
      && !('reason_note' in patch ? patch.reason_note : x.reason_note)) return { error: 'reason_note_required' };
  if (lwdChanged || whyChanged) {
    const l = resolveLwd({ notice_date: x.notice_date, lwd: lwdChanged ? d.lwd : x.lwd,
      lwd_override_reason: whyChanged ? d.lwd_override_reason : x.lwd_override_reason }, noticeDays, 'hr', today);
    if (l.error) return l;
    patch.lwd = l.lwd; patch.lwd_override_reason = l.lwd_override_reason;
  }
  if ('rehire_eligible' in d && !same(d.rehire_eligible, x.rehire_eligible)) {
    if (d.rehire_eligible !== true && d.rehire_eligible !== false && d.rehire_eligible !== null) return { error: 'bad_rehire' };
    patch.rehire_eligible = d.rehire_eligible;
  }
  if ('exit_interview' in d && !same(String(d.exit_interview ?? '').trim(), x.exit_interview)) {
    patch.exit_interview = String(d.exit_interview || '').trim().slice(0, 8000) || null;
  }
  return { patch, openOnly };
}

// Everything between this exit and Close, in the order HR should clear it. `live` = { assets, tasks }.
export function closeBlockers(exit, items, live = {}, today) {
  const out = [];
  if (!exit || exit.status !== 'open') return [{ code: 'exit_not_open' }];
  if (today && exit.lwd && today < exit.lwd) out.push({ code: 'before_lwd', lwd: exit.lwd });
  for (const it of (items || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0))) {
    if (!itemResolved(it)) out.push({ code: 'item_open', line_key: it.line_key, title: it.title, owner: it.owner });
  }
  if (Number(live.assets) > 0) out.push({ code: 'assets_outstanding', count: Number(live.assets) });
  if (Number(live.tasks) > 0) out.push({ code: 'open_work', count: Number(live.tasks) });
  return out;
}

export function itemProgress(items) {
  const req = (items || []).filter(i => i.required && i.auto_source !== 'lot_access');
  return { required: req.length, done: req.filter(itemResolved).length };
}

// Whole days from today to the LWD (negative once it has passed).
export function daysLeft(lwd, today) {
  if (!isIsoDate(lwd) || !isIsoDate(today)) return null;
  return Math.round((Date.parse(lwd + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}

// The Google prompt: open, kept until a date that has arrived, or a transfer still to be checked.
// (No cron — this is computed on read.)
export function googleItemDue(item, today) {
  if (!item) return false;
  if (item.status === 'open' || item.status === 'transfer_pending') return true;
  if (item.status === 'kept') return !item.keep_until || item.keep_until <= today;
  return false;
}
// A timestamp's calendar date in IST (a row created at 20:00 UTC is already tomorrow in India).
export function istDateOf(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t + 330 * 60000).toISOString().slice(0, 10) : null;
}
export function googleItemDaysOpen(item, today) {
  const since = istDateOf(item?.created_at);
  return since ? daysLeft(today, since) : null;   // today − created, both IST
}
// → null | error code. keep needs a FUTURE date and a reason. A pending transfer can only be checked; a transfer
// already started is never started again.
export function checkGoogleAction(item, { action, keep_until, keep_reason }, today) {
  if (!GOOGLE_ACTIONS.includes(action)) return 'bad_google_action';
  if (!item || !GOOGLE_LIVE_STATUSES.includes(item.status)) return 'google_item_closed';
  if (item.status === 'transfer_pending' && action !== 'check_transfer') return 'transfer_in_progress';
  if (action === 'check_transfer' && (item.status !== 'transfer_pending' || !item.transfer_id)) return 'no_transfer_to_check';
  if (action === 'keep') {
    if (!isIsoDate(keep_until) || keep_until <= today) return 'keep_until_future';
    if (String(keep_reason || '').trim().length < 5) return 'keep_reason_required';
  }
  return null;
}
// One actor at a time on a Google item (J1's attempt-claim pattern): the claim PATCH sets acting_id +
// acting_until only when no unexpired claim exists; every later write is guarded on acting_id.
export const GOOGLE_LEASE_MS = 2 * 60 * 1000;
export function googleClaimFilter(nowMs = Date.now()) {
  return `status=in.(${GOOGLE_LIVE_STATUSES.join(',')})&or=(acting_until.is.null,acting_until.lt.${encodeURIComponent(new Date(nowMs).toISOString())})`;
}
export const googleClaimGuard = (actingId) => `acting_id=eq.${actingId}`;
export function canClaimGoogleItem(row, nowMs = Date.now()) {
  if (!row || !GOOGLE_LIVE_STATUSES.includes(row.status)) return false;
  return !row.acting_until || Date.parse(row.acting_until) < nowMs;
}
// transfers.get → 'completed' | 'failed' | 'pending'
export function transferOutcome(t) {
  const s = String(t?.overallTransferStatusCode || '').toLowerCase();
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  return 'pending';
}
// Never act on a mismatched id: the Google user must BE the address Podium recorded.
export function googleUserMatches(guser, workEmail) {
  return !!guser && !!guser.primaryEmail && String(guser.primaryEmail).toLowerCase() === String(workEmail || '').toLowerCase();
}
export const DRIVE_APP_NAME = 'Drive and Docs';
export function driveTransferBody(oldId, newId, applications) {
  const app = (applications || []).find(a => a && a.name === DRIVE_APP_NAME);
  if (!app) return null;
  return { oldOwnerUserId: String(oldId), newOwnerUserId: String(newId),
    applicationDataTransfers: [{ applicationId: String(app.id),
      applicationTransferParams: [{ key: 'PRIVACY_LEVEL', value: ['PRIVATE', 'SHARED'] }] }] };
}

// What each caller may see of an exit. rehire_eligible + F&F: HR only. The exit interview: HR and the person.
export function projectExit(exit, role) {
  if (!exit) return exit;
  const o = { ...exit };
  if (role !== 'hr') { delete o.rehire_eligible; delete o.fnf_amount; delete o.fnf_paid_on; delete o.fnf_document_id; }
  if (role !== 'hr' && role !== 'employee') delete o.exit_interview;
  return o;
}
// Open payment requests: amounts are HR-only.
export function projectPaymentRequest(r, role) {
  const o = { id: r.id, request_no: r.request_no, purpose: r.purpose, status: r.status };
  if (role === 'hr') o.amount = r.amount_to_pay ?? r.invoice_total ?? null;
  return o;
}

// createEmployee / updateEmployee may never write an exit (X1: the exit flow is the only path).
// `cur` = the stored row (null on create). → null | 'use_exit_flow'
const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v));
export function employeeWriteTouchesExit(patch, cur) {
  const p = patch || {};
  const c = cur || {};
  if ('status' in p && (p.status === 'exited' || p.status === 'notice') && norm(p.status) !== norm(c.status)) return 'use_exit_flow';
  // Un-exiting is an exit change too: a rehire is a new employment (X1-later), never a status edit.
  if ('status' in p && c.status === 'exited' && norm(p.status) !== 'exited') return 'use_exit_flow';
  if ('date_exited' in p && norm(p.date_exited) !== norm(c.date_exited)) return 'use_exit_flow';
  if ('exit_reason' in p && norm(p.exit_reason) !== norm(c.exit_reason)) return 'use_exit_flow';
  return null;
}

// Backfill: what an exited person can still reach. → the list of what is left ([] = nothing).
export function accessLeft(a) {
  const out = [];
  if (a?.login_active) out.push('login');
  if (Number(a?.podium_roles) > 0) out.push('podium_role');
  if (a?.comp_access) out.push('comp_access');
  if (a?.google_admin) out.push('google_admin');
  if (Number(a?.assets) > 0) out.push('assets');
  return out;
}

// An RPC's `raise exception 'podium_<code>'` (PostgREST { message, details }) → { code, status, detail } | null.
export function exitDbErrorCode(data) {
  const d = data && typeof data === 'object' ? data : {};
  const m = String(d.message || '').match(/^podium_([a-z_]+)$/);
  if (m) return { code: m[1], status: 409, detail: d.details || null };
  if (d.code === '23505') {
    if (/employee_exits_one_open/.test(String(d.message || ''))) return { code: 'exit_already_open', status: 409, detail: null };
    if (/google_exit_items_one_live/.test(String(d.message || ''))) return { code: 'google_item_exists', status: 409, detail: null };
    return { code: 'conflict', status: 409, detail: null };
  }
  if (d.code === '23514') return { code: 'check_failed', status: 409, detail: null };
  return null;
}
