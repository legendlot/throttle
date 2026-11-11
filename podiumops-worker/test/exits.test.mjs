// Podium X1 — the pure exit rules in src/exits.js + text checks on 0010 and the worker
// (plan 2026-11-11-podium-x1-exits.md). Synthetic names and figures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXIT_REASON_CODES, ASSET_CLOSED_STATUSES, DOCKET_CLOSED_STATUSES, DOCKET_OPEN_STATUSES, PR_OPEN_STATUSES,
  exitRole, canSeeExit, canStartExit, canManageExit, canTickItem, defaultLwd, resolveLwd, buildStartExit,
  snapshotItems, itemResolved, checkItemUpdate, closeBlockers, itemProgress, daysLeft, googleItemDue, googleItemDaysOpen,
  checkGoogleAction, googleUserMatches, driveTransferBody, projectExit, projectPaymentRequest, employeeWriteTouchesExit,
  exitDbErrorCode, TOOL_KEY_PREFIX, monthStart, assetsVerifiable, buildExitPatch, istDateOf, googleClaimFilter, googleClaimGuard,
  canClaimGoogleItem, GOOGLE_LEASE_MS, transferOutcome, accessLeft, GOOGLE_LIVE_STATUSES, GOOGLE_ITEM_STATUSES,
} from '../src/exits.js';

const SQL = readFileSync(new URL('../migrations/0010_exits.sql', import.meta.url), 'utf8');
const SRC = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const TODAY = '2026-11-11';
const fnBody = (name) => {
  let i = SRC.indexOf(`async function ${name}(`); if (i < 0) i = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(i >= 0, name); return SRC.slice(i, SRC.indexOf('\n}\n', i));
};

// ── Who ──────────────────────────────────────────────────────────────────────
test('exitRole: self wins over HR (nobody runs their own exit), then HR, then the manager chain', () => {
  assert.equal(exitRole({ self: true, hr: true }), 'employee');
  assert.equal(exitRole({ hr: true, chain: true }), 'hr');
  assert.equal(exitRole({ chain: true }), 'manager');
  assert.equal(exitRole({}), null);
  assert.equal(exitRole(), null);
  for (const r of ['hr', 'manager', 'employee']) { assert.ok(canSeeExit(r)); assert.ok(canStartExit(r)); }
  assert.ok(!canSeeExit(null));
  assert.ok(canManageExit('hr'));
  for (const r of ['manager', 'employee', null]) assert.ok(!canManageExit(r), `${r} cannot close / cancel / update / backfill`);
});

test('canTickItem: HR any line, manager only manager lines, nobody sets lot_access by hand', () => {
  const mgrLine = { owner: 'manager', auto_source: 'open_work' };
  const itLine = { owner: 'it', auto_source: null };
  const access = { owner: 'hr', auto_source: 'lot_access' };
  assert.equal(canTickItem('hr', itLine), null);
  assert.equal(canTickItem('hr', mgrLine), null);
  assert.equal(canTickItem('manager', mgrLine), null);
  assert.equal(canTickItem('manager', itLine), 'forbidden_item');
  assert.equal(canTickItem('employee', mgrLine), 'forbidden_item');
  assert.equal(canTickItem(null, itLine), 'forbidden_item');
  assert.equal(canTickItem('hr', access), 'set_by_close');
  assert.equal(canTickItem('hr', null), 'not_found');
});

// ── LWD ──────────────────────────────────────────────────────────────────────
test('defaultLwd = notice date + exit_notice_days (month and year roll)', () => {
  assert.equal(defaultLwd('2026-11-11', 30), '2026-12-11');
  assert.equal(defaultLwd('2026-12-15', 30), '2027-01-14');
  assert.equal(defaultLwd('2028-02-01', 28), '2028-02-29', 'leap year');
  assert.equal(defaultLwd('2026-11-11', 0), '2026-11-11');
  assert.equal(defaultLwd('2026-11-11', -5), '2026-11-11', 'never before the notice date');
});

test('resolveLwd: default needs no reason; another date is HR-only and needs a reason', () => {
  const n = '2026-11-01';
  assert.deepEqual(resolveLwd({ notice_date: n }, 30, 'manager'), { lwd: '2026-12-01', lwd_override_reason: null });
  assert.deepEqual(resolveLwd({ notice_date: n, lwd: '2026-12-01', lwd_override_reason: 'ignored' }, 30, 'hr'),
    { lwd: '2026-12-01', lwd_override_reason: null }, 'the default date drops a stray reason');
  assert.deepEqual(resolveLwd({ notice_date: n, lwd: '2026-11-20' }, 30, 'manager'), { error: 'lwd_override_hr_only' });
  assert.deepEqual(resolveLwd({ notice_date: n, lwd: '2026-11-20' }, 30, 'hr'), { error: 'lwd_override_reason_required' });
  assert.deepEqual(resolveLwd({ notice_date: n, lwd: '2026-11-20', lwd_override_reason: 'buy' }, 30, 'hr'), { error: 'lwd_override_reason_required' });
  assert.deepEqual(resolveLwd({ notice_date: n, lwd: '2026-11-20', lwd_override_reason: '  notice bought out  ' }, 30, 'hr'),
    { lwd: '2026-11-20', lwd_override_reason: 'notice bought out' });
  assert.deepEqual(resolveLwd({ notice_date: n, lwd: '2026-10-31', lwd_override_reason: 'long enough' }, 30, 'hr'), { error: 'lwd_before_notice' });
  assert.deepEqual(resolveLwd({ notice_date: n, lwd: '2026-02-30' }, 30, 'hr'), { error: 'bad_lwd' });
  assert.deepEqual(resolveLwd({ notice_date: 'soon' }, 30, 'hr'), { error: 'bad_notice_date' });
});

test('buildStartExit: self = resignation, notice today, default LWD, no override, no rehire flag', () => {
  const s = buildStartExit({ reason_code: 'termination', notice_date: '2026-10-01', lwd: '2026-11-12',
    lwd_override_reason: 'trying it on', rehire_eligible: true }, 'employee', 30, TODAY);
  assert.deepEqual(s, { initiated_by: 'employee', reason_code: 'resignation', reason_note: null, notice_date: TODAY,
    lwd: '2026-12-11', lwd_override_reason: null, rehire_eligible: null });
});

test('buildStartExit: manager = any reason, default LWD only, no rehire flag; HR = override + rehire', () => {
  const m = buildStartExit({ reason_code: 'end_of_internship', notice_date: '2026-11-05', rehire_eligible: false }, 'manager', 30, TODAY);
  assert.equal(m.initiated_by, 'manager'); assert.equal(m.reason_code, 'end_of_internship');
  assert.equal(m.lwd, '2026-12-05'); assert.equal(m.rehire_eligible, null);
  assert.deepEqual(buildStartExit({ reason_code: 'termination', notice_date: '2026-11-05', lwd: '2026-11-11' }, 'manager', 30, TODAY),
    { error: 'lwd_override_hr_only' });
  const h = buildStartExit({ reason_code: 'absconding', notice_date: '2026-11-05', lwd: '2026-11-05',
    lwd_override_reason: 'not seen since', rehire_eligible: false }, 'hr', 30, TODAY);
  assert.equal(h.initiated_by, 'hr'); assert.equal(h.lwd, '2026-11-05'); assert.equal(h.rehire_eligible, false);
  assert.equal(buildStartExit({ reason_code: 'resignation', notice_date: '2026-11-05', rehire_eligible: 'yes' }, 'hr', 30, TODAY).rehire_eligible, null);
});

test('buildStartExit: refusals', () => {
  assert.deepEqual(buildStartExit({ reason_code: 'resignation', notice_date: TODAY }, null, 30, TODAY), { error: 'forbidden' });
  assert.deepEqual(buildStartExit({ reason_code: 'fired', notice_date: TODAY }, 'hr', 30, TODAY), { error: 'bad_reason_code' });
  assert.deepEqual(buildStartExit({ reason_code: 'other', notice_date: TODAY }, 'hr', 30, TODAY), { error: 'reason_note_required' });
  assert.equal(buildStartExit({ reason_code: 'other', reason_note: 'moving city', notice_date: TODAY }, 'hr', 30, TODAY).reason_note, 'moving city');
  assert.deepEqual(buildStartExit({ reason_code: 'resignation', notice_date: '2026-11-12' }, 'hr', 30, TODAY), { error: 'notice_date_in_future' });
  assert.deepEqual(buildStartExit({ reason_code: 'resignation' }, 'manager', 30, TODAY), { error: 'bad_notice_date' });
  assert.deepEqual(EXIT_REASON_CODES, ['resignation', 'termination', 'absconding', 'end_of_internship', 'end_of_contract', 'other']);
});

// ── Snapshot ─────────────────────────────────────────────────────────────────
const LINES = [
  { key: 'b_line', title: 'B', owner: 'hr', required: true, allow_na: false, applies_to: [], sort: 20, active: true },
  { key: 'a_line', title: 'A', owner: 'store', required: true, allow_na: false, applies_to: [], sort: 10, active: true, auto_source: 'snorkel_assets' },
  { key: 'intern_only', title: 'Intern', owner: 'hr', required: true, allow_na: false, applies_to: ['intern'], sort: 15, active: true },
  { key: 'off_line', title: 'Off', owner: 'hr', required: true, allow_na: false, applies_to: [], sort: 5, active: false },
];
const TOOLS = [
  { id: 't2', name: 'Tool Two', sort: 20, active: true },
  { id: 't1', name: 'Tool One', sort: 10, active: true },
  { id: 't3', name: 'Tool Off', sort: 5, active: false },
];

test('snapshotItems: active lines by sort, applies_to filter, then one IT line per active tool', () => {
  const ft = snapshotItems(LINES, TOOLS, 'full_time');
  assert.deepEqual(ft.map(i => i.line_key), ['a_line', 'b_line', `${TOOL_KEY_PREFIX}t1`, `${TOOL_KEY_PREFIX}t2`]);
  assert.equal(ft[0].auto_source, 'snorkel_assets');
  const tool = ft[2];
  assert.deepEqual({ owner: tool.owner, required: tool.required, allow_na: tool.allow_na, auto_source: tool.auto_source },
    { owner: 'it', required: true, allow_na: true, auto_source: null });
  assert.ok(tool.title.includes('Tool One'));
  assert.deepEqual(snapshotItems(LINES, [], 'intern').map(i => i.line_key), ['a_line', 'intern_only', 'b_line']);
  assert.ok(snapshotItems(LINES, [], null).some(i => i.line_key === 'intern_only'), 'unknown employment type → every line');
  assert.deepEqual(snapshotItems(null, null, 'intern'), []);
  // A snapshot is a copy: editing the template afterwards cannot reach it.
  const snap = snapshotItems(LINES, TOOLS, 'full_time');
  LINES[1].title = 'Changed';
  assert.equal(snap[0].title, 'A');
});

// ── Items + blockers ─────────────────────────────────────────────────────────
test('itemResolved: done; n/a only where allowed; optional lines and lot_access never block', () => {
  assert.ok(itemResolved({ required: true, status: 'done', allow_na: false }));
  assert.ok(itemResolved({ required: true, status: 'na', allow_na: true }));
  assert.ok(!itemResolved({ required: true, status: 'na', allow_na: false }));
  assert.ok(!itemResolved({ required: true, status: 'open', allow_na: true }));
  assert.ok(itemResolved({ required: false, status: 'open' }));
  assert.ok(itemResolved({ required: true, status: 'open', auto_source: 'lot_access' }));
});

test('checkItemUpdate: n/a needs allow_na + a note; Done blocked while the live source has rows', () => {
  const assets = { auto_source: 'snorkel_assets', allow_na: false };
  const work = { auto_source: 'open_work', allow_na: false };
  const sim = { auto_source: null, allow_na: true };
  assert.equal(checkItemUpdate(sim, { status: 'na', note: '' }), 'na_note_required');
  assert.equal(checkItemUpdate(sim, { status: 'na', note: 'never issued' }), null);
  assert.equal(checkItemUpdate(assets, { status: 'na', note: 'x' }), 'na_not_allowed');
  assert.equal(checkItemUpdate(assets, { status: 'done' }, { assets: 2 }), 'assets_outstanding');
  assert.equal(checkItemUpdate(assets, { status: 'done' }, { assets: 0 }), null);
  assert.equal(checkItemUpdate(work, { status: 'done' }, { tasks: 1 }), 'open_work');
  assert.equal(checkItemUpdate(work, { status: 'done' }, { tasks: 0, assets: 5 }), null);
  assert.equal(checkItemUpdate(work, { status: 'open' }, { tasks: 9 }), null, 'reopening is always allowed');
  assert.equal(checkItemUpdate(sim, { status: 'closed' }), 'bad_item_status');
});

test('closeBlockers: before LWD, open required lines in order, live assets / tasks', () => {
  const exit = { status: 'open', lwd: '2026-11-20' };
  const items = [
    { line_key: 'z', title: 'Z', required: true, status: 'open', sort: 30, owner: 'hr' },
    { line_key: 'a', title: 'A', required: true, status: 'open', sort: 10, owner: 'it' },
    { line_key: 'opt', required: false, status: 'open', sort: 5 },
    { line_key: 'access', required: true, status: 'open', auto_source: 'lot_access', sort: 1 },
    { line_key: 'done', required: true, status: 'done', sort: 2 },
  ];
  const b = closeBlockers(exit, items, { assets: 1, tasks: 3 }, TODAY);
  assert.deepEqual(b.map(x => x.code), ['before_lwd', 'item_open', 'item_open', 'assets_outstanding', 'open_work']);
  assert.deepEqual(b.filter(x => x.code === 'item_open').map(x => x.line_key), ['a', 'z']);
  assert.equal(b.find(x => x.code === 'open_work').count, 3);
  const clear = items.map(i => ({ ...i, status: i.required && !i.auto_source ? 'done' : i.status }));
  assert.deepEqual(closeBlockers({ ...exit, lwd: TODAY }, clear, { assets: 0, tasks: 0 }, TODAY), [], 'on the LWD itself it can close');
  assert.deepEqual(closeBlockers({ status: 'closed' }, [], {}, TODAY), [{ code: 'exit_not_open' }]);
  assert.deepEqual(itemProgress(items), { required: 3, done: 1 }, 'lot_access is not counted');
});

test('daysLeft', () => {
  assert.equal(daysLeft('2026-11-21', TODAY), 10);
  assert.equal(daysLeft(TODAY, TODAY), 0);
  assert.equal(daysLeft('2026-11-01', TODAY), -10);
  assert.equal(daysLeft(null, TODAY), null);
});

// ── Google prompt ────────────────────────────────────────────────────────────
test('googleItemDue: open is due; kept is due again once keep_until arrives; actioned never', () => {
  assert.ok(googleItemDue({ status: 'open' }, TODAY));
  assert.ok(!googleItemDue({ status: 'kept', keep_until: '2026-11-12' }, TODAY));
  assert.ok(googleItemDue({ status: 'kept', keep_until: TODAY }, TODAY), 'reopens ON the date');
  assert.ok(googleItemDue({ status: 'kept', keep_until: '2026-11-01' }, TODAY));
  assert.ok(!googleItemDue({ status: 'suspended' }, TODAY));
  assert.ok(!googleItemDue({ status: 'transferred_suspended' }, TODAY));
  assert.ok(!googleItemDue(null, TODAY));
  assert.equal(googleItemDaysOpen({ created_at: '2026-11-01T10:00:00Z' }, TODAY), 10);
});

test('checkGoogleAction: keep needs a future date + a reason; closed items refuse', () => {
  const open = { status: 'open' };
  assert.equal(checkGoogleAction(open, { action: 'suspend' }, TODAY), null);
  assert.equal(checkGoogleAction(open, { action: 'transfer_and_suspend' }, TODAY), null);
  assert.equal(checkGoogleAction(open, { action: 'delete' }, TODAY), 'bad_google_action');
  assert.equal(checkGoogleAction(open, { action: 'keep', keep_until: TODAY, keep_reason: 'mailbox handover' }, TODAY), 'keep_until_future');
  assert.equal(checkGoogleAction(open, { action: 'keep', keep_until: '2026-12-01', keep_reason: 'no' }, TODAY), 'keep_reason_required');
  assert.equal(checkGoogleAction(open, { action: 'keep', keep_until: '2026-12-01', keep_reason: 'mailbox handover' }, TODAY), null);
  assert.equal(checkGoogleAction({ status: 'kept' }, { action: 'suspend' }, TODAY), null, 'a kept item can still be acted on');
  assert.equal(checkGoogleAction({ status: 'suspended' }, { action: 'suspend' }, TODAY), 'google_item_closed');
  assert.equal(checkGoogleAction({ status: 'gone' }, { action: 'suspend' }, TODAY), 'google_item_closed');
});

test('googleUserMatches + driveTransferBody: never act on a mismatched id; Drive and Docs only', () => {
  assert.ok(googleUserMatches({ primaryEmail: 'Testa@legendoftoys.com' }, 'testa@legendoftoys.com'));
  assert.ok(!googleUserMatches({ primaryEmail: 'other@legendoftoys.com' }, 'testa@legendoftoys.com'));
  assert.ok(!googleUserMatches({}, 'testa@legendoftoys.com'));
  assert.ok(!googleUserMatches(null, 'testa@legendoftoys.com'));
  const apps = [{ id: 1, name: 'Calendar' }, { id: 55656082996, name: 'Drive and Docs' }];
  assert.deepEqual(driveTransferBody('111', '222', apps), {
    oldOwnerUserId: '111', newOwnerUserId: '222',
    applicationDataTransfers: [{ applicationId: '55656082996', applicationTransferParams: [{ key: 'PRIVACY_LEVEL', value: ['PRIVATE', 'SHARED'] }] }],
  });
  assert.equal(driveTransferBody('111', '222', [{ id: 1, name: 'Calendar' }]), null);
});

// ── Visibility ───────────────────────────────────────────────────────────────
test('projectExit / projectPaymentRequest: rehire + F&F + amounts are HR-only; the interview HR + self', () => {
  const x = { id: 'x', rehire_eligible: false, fnf_amount: 1000, fnf_paid_on: null, fnf_document_id: null, exit_interview: 'notes', lwd: TODAY };
  assert.equal(projectExit(x, 'hr').rehire_eligible, false);
  assert.equal(projectExit(x, 'hr').fnf_amount, 1000);
  for (const r of ['manager', 'employee']) {
    const p = projectExit(x, r);
    assert.ok(!('rehire_eligible' in p) && !('fnf_amount' in p), `${r} never sees rehire / F&F`);
  }
  assert.equal(projectExit(x, 'employee').exit_interview, 'notes');
  assert.ok(!('exit_interview' in projectExit(x, 'manager')));
  assert.equal(x.rehire_eligible, false, 'input not mutated');
  const pr = { id: 1, request_no: 'PR-0001', purpose: 'Travel', status: 'approved', amount_to_pay: 500, invoice_total: 590 };
  assert.equal(projectPaymentRequest(pr, 'hr').amount, 500);
  for (const r of ['manager', 'employee']) assert.ok(!('amount' in projectPaymentRequest(pr, r)), `${r} sees no amount`);
});

// ── The other exit paths are closed ──────────────────────────────────────────
test('employeeWriteTouchesExit: no hand-made exit, notice, LWD or reason; unchanged values pass', () => {
  assert.equal(employeeWriteTouchesExit({ status: 'exited' }, { status: 'active' }), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ status: 'notice' }, { status: 'active' }), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ status: 'exited' }, null), 'use_exit_flow', 'create');
  assert.equal(employeeWriteTouchesExit({ date_exited: '2026-11-01' }, null), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ date_exited: '2026-11-01' }, { status: 'exited', date_exited: '2026-10-01' }), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ date_exited: null }, { status: 'exited', date_exited: '2026-10-01' }), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ exit_reason: 'resignation' }, { exit_reason: null }), 'use_exit_flow');
  // EmployeeForm sends every field on every save — unchanged lifecycle values are not a change.
  assert.equal(employeeWriteTouchesExit({ status: 'exited', date_exited: '2026-10-01', exit_reason: 'resignation', phone: '1' },
    { status: 'exited', date_exited: '2026-10-01', exit_reason: 'resignation' }), null);
  assert.equal(employeeWriteTouchesExit({ status: 'active', date_exited: null, exit_reason: '' }, { status: 'active' }), null, "'' = null");
  assert.equal(employeeWriteTouchesExit({ status: 'on_leave' }, { status: 'active' }), null);
  assert.equal(employeeWriteTouchesExit({ phone: '1' }, null), null);
});

test('worker: create / update / the Directory sync cannot exit anyone', () => {
  assert.match(fnBody('createEmployee'), /employeeWriteTouchesExit\(body, null\)\) return x1Err\('use_exit_flow'/);
  const up = fnBody('updateEmployee');
  assert.match(up, /employeeWriteTouchesExit\(patch, cr\.data\[0\] \|\| \{\}\)\) return x1Err\('use_exit_flow'/);
  assert.ok(up.indexOf('use_exit_flow') < up.indexOf("method: 'PATCH'"), 'guard before the write');
  assert.ok(!/reassignReportsOnExit/.test(up), 'no exit side-effects left in updateEmployee');
  const imp = fnBody('importDirectoryCandidates');
  assert.match(imp, /d\.exit\.length\) return x1Err\('exits_are_recorded_in_podium'/);
  assert.ok(!/status: 'exited'/.test(imp), 'the sync writes no exited status');
  assert.match(fnBody('getDirectorySyncPreview'), /alert: 'exit_started_outside_podium'/);
  // The only writer of status 'exited' left in the worker is the RPC — no literal PATCH anywhere.
  assert.ok(!/status: 'exited'/.test(SRC.replace(/\/\/[^\n]*/g, '')), "no status: 'exited' write in the worker");
  assert.match(SQL, /update podium\.employees set status = 'exited', date_exited = v_x\.lwd, exit_reason = v_x\.reason_code/);
});

test('worker: X1 actions routed; getExit / getMyTeamExits / startExit / updateExitItem self-serve; gates in place', () => {
  const posts = SRC.slice(SRC.indexOf('const POST_ACTIONS = {'), SRC.indexOf('};', SRC.indexOf('const POST_ACTIONS = {')));
  for (const h of ['startExit', 'updateExitItem', 'updateExit', 'cancelExit', 'closeExit', 'backfillExit', 'actGoogleExitItem',
    'saveExitChecklistLine', 'saveExitTool', 'revokeExitedAccess', 'openGoogleExitItem']) assert.ok(posts.includes(h), `${h} routed`);
  const gets = SRC.slice(SRC.indexOf('const GET_ACTIONS = {'), SRC.indexOf('};', SRC.indexOf('const GET_ACTIONS = {')));
  for (const h of ['getExit', 'getExits', 'getExitChecklist', 'getMyTeamExits']) assert.ok(gets.includes(h), `${h} routed`);
  const sg = SRC.slice(SRC.indexOf('const SELF_SERVE_GET'), SRC.indexOf('const SELF_SERVE_POST'));
  const sp = SRC.slice(SRC.indexOf('const SELF_SERVE_POST'), SRC.indexOf('async function handleGet'));
  assert.ok(sg.includes("'getExit'") && sg.includes("'getMyTeamExits'") && !sg.includes("'getExits'") && !sg.includes('getExitChecklist'));
  // Fix 2: managers without podium_view tick their manager lines — updateExitItem is self-serve.
  assert.ok(sp.includes("'startExit'") && sp.includes("'updateExitItem'"));
  for (const h of ["'updateExit'", 'cancelExit', 'closeExit', 'backfillExit', 'actGoogleExitItem', 'saveExit', 'revokeExitedAccess', 'openGoogleExitItem']) assert.ok(!sp.includes(h), `${h} not self-serve`);
  for (const h of ['getExit', 'startExit']) assert.match(fnBody(h), /exitCtx\(auth, env,/);
  assert.match(fnBody('getMyTeamExits'), /descendantsOf\(edges, me\.id\)/);
  for (const h of ['updateExit', 'cancelExit', 'closeExit']) assert.match(fnBody(h), /canManageExit\(c\.role\)/);
  for (const h of ['getExits', 'backfillExit', 'getExitChecklist', 'saveExitChecklistLine', 'saveExitTool', 'revokeExitedAccess',
    'openGoogleExitItem']) assert.match(fnBody(h), /requireHr\(auth\)/);
  assert.match(fnBody('updateExitItem'), /canTickItem\(c\.role, item\)/);
  // closeExit: blockers returned verbatim, then the RPC, then reports reassigned.
  const ce = fnBody('closeExit');
  assert.ok(ce.indexOf("x1Err('exit_blocked', 409, { blockers })") < ce.indexOf("'exit_close'"));
  assert.ok(ce.indexOf("'exit_close'") < ce.indexOf('reassignReportsOnExit(c.emp.id'));
  // Google: admin-gated, verified before any write, every write logged.
  const g = fnBody('actGoogleExitItem');
  assert.match(g, /requireGoogleAdmin\(auth, env\)/);
  assert.ok(g.indexOf('verifiedGoogleUser(token') < g.indexOf("method: 'PUT'"), 'verify before suspend');
  assert.ok(g.indexOf('verifiedGoogleUser(token') < g.indexOf("datatransfer/v1/transfers', { method: 'POST'"), 'verify before transfer');
  assert.match(g, /action: 'drive_transfer'/); assert.match(g, /action: 'suspend_exited'/); assert.match(g, /action: 'keep_active'/);
  assert.match(fnBody('verifiedGoogleUser'), /googleUserMatches\(gu, workEmail\)/);
  // Salary: payment-request amounts + rehire only through the projections.
  const ge = fnBody('getExit');
  assert.match(ge, /projectPaymentRequest\(p, c\.role\)/); assert.match(ge, /projectExit\(exit, c\.role\)/);
  assert.ok(!/amount_to_pay/.test(fnBody('getExits')), 'the board carries no amounts');
});

// ── 0010 ─────────────────────────────────────────────────────────────────────
test('0010: service_role only, RLS on, one open exit, one live Google item', () => {
  for (const t of ['exit_checklist_lines', 'exit_tools', 'employee_exits', 'exit_checklist_items', 'google_exit_items', 'exit_events']) assert.ok(SQL.includes(`'${t}'`), t);
  assert.match(SQL, /enable row level security/);
  assert.match(SQL, /revoke all on podium\.%I from anon, authenticated/);
  for (const f of ['exit_start', 'exit_close', 'exit_backfill', 'exit_update_item', 'exit_revoke_access', 'exit_open_google_item']) {
    assert.match(SQL, new RegExp(`revoke all on function podium\\.${f}\\(jsonb\\) from public, anon, authenticated`), f);
    assert.match(SQL, new RegExp(`grant execute on function podium\\.${f}\\(jsonb\\) to service_role`), f);
  }
  assert.equal((SQL.match(/security definer set search_path to 'podium', 'public'/g) || []).length, 6);
  assert.match(SQL, /create unique index employee_exits_one_open on podium\.employee_exits \(employee_id\) where status = 'open'/);
  assert.match(SQL, /create unique index google_exit_items_one_live on podium\.google_exit_items \(employee_id\)\s+where status in \('open', 'kept', 'transfer_pending'\)/);
  assert.match(SQL, /unique \(exit_id, line_key\)/);
  assert.match(SQL, /exit_notice_days int not null default 30/);
  assert.match(SQL, /'suspend_exited', 'drive_transfer'/);
  assert.ok(!/add column[^;]*\bnotice\b[^;]*status/i.test(SQL) && !/status = 'notice'/.test(SQL), 'no notice status written (deviation 1)');
});

test('0010: the CHECK lists match src/exits.js', () => {
  const reasons = SQL.match(/reason_code text not null check \(reason_code in \(([^)]+)\)\)/s)[1].match(/'([a-z_]+)'/g).map(s => s.slice(1, -1));
  assert.deepEqual(reasons, EXIT_REASON_CODES);
  const seededKeys = [...SQL.matchAll(/^\s+\('([a-z_]+)',\s*'/gm)].map(m => m[1]);
  assert.deepEqual(seededKeys, ['notice_served', 'assets_returned', 'id_card_keys', 'company_sim', 'lot_access', 'open_work_handed_over',
    'advances_reimbursements', 'leave_balance', 'fnf', 'relieving_letters', 'exit_interview'], 'L8 draft, in order');
  assert.match(SQL, /\('fnf',\s+'Full & final — later phase',\s+'finance',\s+false/);
  assert.match(SQL, /\('assets_returned',[^\n]*'store',\s+true,\s+false, 'snorkel_assets'/);
  assert.match(SQL, /\('company_sim',[^\n]*'it',\s+true,\s+true,/);
  assert.match(SQL, /\('exit_interview',[^\n]*'hr',\s+false,/);
});

test('0010 exit_close: refuses in the right order and does everything the plan lists', () => {
  const body = SQL.slice(SQL.indexOf('create or replace function podium.exit_close'), SQL.indexOf('create or replace function podium.exit_backfill'));
  const order = ['podium_exit_not_found', 'podium_exit_not_open', 'podium_already_exited', 'podium_before_lwd',
    'podium_checklist_incomplete', 'podium_assets_outstanding', 'podium_open_work', "set status = 'exited'"];
  let last = -1;
  for (const k of order) { const i = body.indexOf(k); assert.ok(i > last, `${k} in order`); last = i; }
  assert.match(body, /for update/);
  assert.match(body, /status <> 'retired'/, 'asset statuses as live: retired is the only closed one');
  assert.deepEqual(ASSET_CLOSED_STATUSES, ['retired']);
  assert.match(body, /status not in \('done', 'abandoned'\) and archived_at is null/);
  assert.deepEqual(DOCKET_CLOSED_STATUSES, ['done', 'abandoned']);
  assert.ok(!DOCKET_OPEN_STATUSES.some(s => DOCKET_CLOSED_STATUSES.includes(s)));
  assert.deepEqual(PR_OPEN_STATUSES, ['submitted', 'pending_approval', 'approved', 'held']);
  assert.match(body, /\(now\(\) at time zone 'Asia\/Kolkata'\)::date/, "today is the DB's IST date");
  for (const k of ['update store.users_profile set active = false', 'delete from store.podium_user_roles',
    'delete from podium.comp_access', 'delete from podium.google_admin_access', 'insert into podium.google_exit_items',
    "auto_source = 'lot_access'"]) assert.ok(body.includes(k), k);
  assert.ok(!/suspend/i.test(body.replace(/--[^\n]*/g, '')), 'the close never suspends Google (L5)');
});

test('0010 exit_start + exit_backfill guards', () => {
  const s = SQL.slice(SQL.indexOf('create or replace function podium.exit_start'), SQL.indexOf('create or replace function podium.exit_close'));
  for (const k of ['podium_employee_not_found', 'podium_already_exited', 'podium_exit_already_open']) assert.ok(s.includes(k), k);
  const b = SQL.slice(SQL.indexOf('create or replace function podium.exit_backfill'), SQL.indexOf('create or replace function podium.exit_update_item'));
  for (const k of ['podium_not_exited', 'podium_already_backfilled', 'podium_bad_lwd', "'backfill'", 'v_e.exit_reason']) assert.ok(b.includes(k), k);
  assert.ok(!/exit_checklist_items/.test(b), 'backfill writes no checklist');
});

test('exitDbErrorCode maps raises, the unique indexes and checks', () => {
  assert.deepEqual(exitDbErrorCode({ message: 'podium_assets_outstanding', details: '2' }), { code: 'assets_outstanding', status: 409, detail: '2' });
  assert.deepEqual(exitDbErrorCode({ code: '23505', message: 'duplicate key value violates unique constraint "employee_exits_one_open"' }),
    { code: 'exit_already_open', status: 409, detail: null });
  assert.equal(exitDbErrorCode({ code: '23505', message: 'x google_exit_items_one_live' }).code, 'google_item_exists');
  assert.equal(exitDbErrorCode({ code: '23514', message: 'x' }).code, 'check_failed');
  assert.equal(exitDbErrorCode({ message: 'something else' }), null);
  assert.equal(exitDbErrorCode(null), null);
});

// ── Review round 1 (hostile + Codex) ─────────────────────────────────────────
test('fix 3: self comes from the loaded row, the chain fails closed', () => {
  const ctx = fnBody('exitCtx');
  assert.match(ctx, /const self = !!emp\.auth_user_id && emp\.auth_user_id === auth\.userId;/);
  assert.ok(!/loadOrgEdges\(env\)/.test(ctx), 'never the lenient edges loader');
  assert.match(ctx, /if \(!self && !hr\) \{/);
  assert.match(ctx, /if \(!edges\) return \{ res: x1Err\('org_check_failed', 503\) \};/);
  assert.match(fnBody('loadOrgEdgesStrict'), /return r\.ok && Array\.isArray\(r\.data\) \? r\.data : null;/);
  assert.match(fnBody('getMyTeamExits'), /if \(!edges\) return x1Err\('org_check_failed'/);
  assert.equal(exitRole({ self: true, hr: true }), 'employee');
});

test('fix 4: nobody is un-exited by an edit; Google acts only on someone still exited', () => {
  assert.equal(employeeWriteTouchesExit({ status: 'active' }, { status: 'exited' }), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ status: 'on_leave' }, { status: 'exited' }), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ status: null }, { status: 'exited' }), 'use_exit_flow');
  assert.equal(employeeWriteTouchesExit({ status: 'exited' }, { status: 'exited' }), null);
  assert.equal(employeeWriteTouchesExit({ phone: '1' }, { status: 'exited' }), null, 'other fields on an exited person are fine');
  const g = fnBody('actGoogleExitItem');
  assert.ok(g.indexOf("item.employee?.status !== 'exited') return x1Err('not_exited')") < g.indexOf('googleClaimFilter()'));
});

test('fix 5: notice ≥ joining; non-HR notice ≤ 7 days back; an LWD in a closed month is HR + reason', () => {
  assert.equal(monthStart('2026-11-12'), '2026-11-01');
  assert.deepEqual(buildStartExit({ reason_code: 'resignation', notice_date: '2026-11-01' }, 'hr', 30, TODAY, '2026-11-05'), { error: 'notice_before_joining' });
  assert.equal(buildStartExit({ reason_code: 'resignation', notice_date: '2026-11-05' }, 'hr', 30, TODAY, '2026-11-05').notice_date, '2026-11-05');
  assert.deepEqual(buildStartExit({ reason_code: 'termination', notice_date: '2026-11-03' }, 'manager', 30, TODAY), { error: 'notice_date_too_old' });
  assert.equal(buildStartExit({ reason_code: 'termination', notice_date: '2026-11-04' }, 'manager', 30, TODAY).lwd, '2026-12-04', 'exactly 7 days back is fine');
  assert.equal(buildStartExit({ reason_code: 'termination', notice_date: '2026-09-01', lwd: '2026-11-02', lwd_override_reason: 'served notice off the record' }, 'hr', 30, TODAY).lwd, '2026-11-02');
  // An LWD before 1 Nov (today 11 Nov) — even the DEFAULT one — needs HR and a reason.
  assert.deepEqual(resolveLwd({ notice_date: '2026-09-15' }, 30, 'hr', TODAY), { error: 'lwd_override_reason_required' });
  assert.deepEqual(resolveLwd({ notice_date: '2026-09-15', lwd_override_reason: 'notice served in September' }, 30, 'hr', TODAY),
    { lwd: '2026-10-15', lwd_override_reason: 'notice served in September' });
  assert.deepEqual(resolveLwd({ notice_date: '2026-09-15' }, 30, 'manager', TODAY), { error: 'lwd_closed_month_hr_only' });
  assert.deepEqual(resolveLwd({ notice_date: '2026-10-05' }, 30, 'manager', TODAY), { lwd: '2026-11-04', lwd_override_reason: null }, 'this month is open');
  assert.deepEqual(resolveLwd({ notice_date: '2026-09-15' }, 30, 'manager'), { lwd: '2026-10-15', lwd_override_reason: null }, 'no today → no month rule');
  assert.match(fnBody('startExit'), /buildStartExit\(d, c\.role, days, istToday\(\), c\.emp\.date_joined\)/);
  const st = SQL.slice(SQL.indexOf('create or replace function podium.exit_start'), SQL.indexOf('create or replace function podium.exit_close'));
  assert.match(st, /\(p->>'notice_date'\)::date < v_e\.date_joined then\s+raise exception 'podium_notice_before_joining'/);
  const bf = SQL.slice(SQL.indexOf('create or replace function podium.exit_backfill'), SQL.indexOf('create or replace function podium.exit_update_item'));
  assert.match(bf, /v_lwd < v_e\.date_joined then raise exception 'podium_lwd_before_joining'/);
});

test('fix 6: updateExit — only changed fields; LWD re-resolved only when it changes; closed exit = interview + rehire', () => {
  const x = { status: 'open', notice_date: '2026-11-05', lwd: '2026-12-05', lwd_override_reason: null, reason_code: 'resignation',
    reason_note: null, rehire_eligible: null, exit_interview: null };
  assert.deepEqual(buildExitPatch(x, { lwd: '2026-12-05', reason_code: 'resignation' }, 30, TODAY), { patch: {}, openOnly: false }, 'unchanged = nothing');
  assert.deepEqual(buildExitPatch(x, { lwd: '2026-11-30', lwd_override_reason: 'early release agreed' }, 30, TODAY),
    { patch: { lwd: '2026-11-30', lwd_override_reason: 'early release agreed' }, openOnly: true });
  assert.deepEqual(buildExitPatch(x, { lwd: '2026-11-30' }, 30, TODAY), { error: 'lwd_override_reason_required' });
  // A stored override whose default moved (notice days changed) is NOT re-judged when the date is untouched.
  const ov = { ...x, lwd: '2026-11-20', lwd_override_reason: 'agreed' };
  assert.deepEqual(buildExitPatch(ov, { lwd: '2026-11-20', exit_interview: 'ok' }, 45, TODAY), { patch: { exit_interview: 'ok' }, openOnly: false });
  const closed = { ...x, status: 'closed' };
  assert.deepEqual(buildExitPatch(closed, { exit_interview: 'notes', rehire_eligible: true }, 30, TODAY),
    { patch: { exit_interview: 'notes', rehire_eligible: true }, openOnly: false });
  assert.deepEqual(buildExitPatch(closed, { lwd: '2026-11-30', lwd_override_reason: 'too late now' }, 30, TODAY), { error: 'exit_not_open' });
  assert.deepEqual(buildExitPatch(closed, { lwd: '2026-12-05' }, 30, TODAY), { patch: {}, openOnly: false }, 'an unchanged LWD on a closed exit is not a change');
  assert.deepEqual(buildExitPatch(x, { rehire_eligible: 'yes' }, 30, TODAY), { error: 'bad_rehire' });
  assert.deepEqual(buildExitPatch(x, { reason_code: 'other' }, 30, TODAY), { error: 'reason_note_required' });
  const ue = fnBody('updateExit');
  assert.match(ue, /const guard = b\.openOnly \? '&status=eq\.open' : '';/);
  assert.match(ue, /if \(!r\.data\?\.length\) return x1Err\('exit_not_open'\);/);
});

test('fix 7: Google item age is counted in IST days', () => {
  assert.equal(istDateOf('2026-11-10T20:00:00Z'), '2026-11-11', '20:00 UTC is already the 11th in India');
  assert.equal(googleItemDaysOpen({ created_at: '2026-11-10T20:00:00Z' }, TODAY), 0);
  assert.equal(googleItemDaysOpen({ created_at: '2026-11-10T10:00:00Z' }, TODAY), 1);
  assert.equal(istDateOf('nope'), null);
  assert.equal(googleItemDaysOpen({}, TODAY), null);
});

test('fix 8: item writes go through exit_update_item under the exit lock, with the rules re-run inside', () => {
  const u = fnBody('updateExitItem');
  assert.match(u, /hiringRpc\(env, 'exit_update_item', p\)/);
  assert.ok(!/exit_checklist_items\?id=eq\.\$\{item\.id\}`, env, \{ method: 'PATCH'/.test(u), 'no direct PATCH left');
  const f = SQL.slice(SQL.indexOf('create or replace function podium.exit_update_item'), SQL.indexOf('create or replace function podium.exit_revoke_access'));
  // Lock order employee → exit (as exit_start / exit_close), then the open check, then the rules.
  const order = ['from podium.employees where id = v_emp_id for update', 'from podium.employee_exits where id = v_exit_id for update',
    'podium_exit_not_open', 'podium_set_by_close', 'podium_forbidden_item', 'podium_na_not_allowed', 'podium_na_note_required',
    'podium_assets_outstanding', 'podium_assets_unverifiable', 'podium_open_work', 'podium_bad_document', 'update podium.exit_checklist_items'];
  let last = -1;
  for (const k of order) { const i = f.indexOf(k); assert.ok(i > last, `${k} in order`); last = i; }
  assert.match(f, /v_role = 'manager' and v_it\.owner <> 'manager'/);
  const close = SQL.slice(SQL.indexOf('create or replace function podium.exit_close'), SQL.indexOf('create or replace function podium.exit_backfill'));
  assert.match(close, /from podium\.employees where id = v_emp_id for update;\s+select \* into v_x from podium\.employee_exits where id = \(p->>'exit_id'\)::uuid for update;/);
});

test('fix 9: assets that cannot be verified → HR with a note only', () => {
  assert.equal(assetsVerifiable('u1', 0), true);
  assert.equal(assetsVerifiable(null, 0), false, 'no auth link');
  assert.equal(assetsVerifiable('u1', 2), false, 'assets in their name with no custodian user');
  const item = { auto_source: 'snorkel_assets', allow_na: false };
  const unv = { assets: 0, assets_verifiable: false };
  assert.equal(checkItemUpdate(item, { status: 'done', note: 'checked the cupboard' }, unv, 'hr'), null);
  assert.equal(checkItemUpdate(item, { status: 'done', note: '' }, unv, 'hr'), 'assets_unverifiable');
  assert.equal(checkItemUpdate(item, { status: 'done', note: 'x' }, unv, 'manager'), 'assets_unverifiable');
  assert.equal(checkItemUpdate(item, { status: 'done' }, { assets: 0, assets_verifiable: true }, 'manager'), null);
  assert.equal(checkItemUpdate(item, { status: 'done', note: 'x' }, { assets: 1, assets_verifiable: false }, 'hr'), 'assets_outstanding', 'linked assets still block');
  assert.equal(checkItemUpdate({ auto_source: 'lot_access' }, { status: 'done' }, {}, 'hr'), 'set_by_close');
  const live = fnBody('exitLive');
  assert.match(live, /custodian_user_id=is\.null&custodian_name=ilike\./);
  assert.match(live, /payment_requests_verifiable: !!authId/);
  const f = SQL.slice(SQL.indexOf('create or replace function podium.exit_update_item'), SQL.indexOf('create or replace function podium.exit_revoke_access'));
  assert.match(f, /custodian_user_id is null and status <> 'retired'/);
  assert.match(f, /\(v_e\.auth_user_id is null or v_n > 0\) and \(v_role <> 'hr' or v_note is null\)/);
});

test('fix 10: the Google item is claimed before any Google call; every write is guarded', () => {
  assert.equal(GOOGLE_LEASE_MS, 120000);
  const f = googleClaimFilter(Date.parse('2026-11-11T10:00:00Z'));
  assert.ok(f.startsWith('status=in.(open,kept,transfer_pending)&or=(acting_until.is.null,acting_until.lt.'));
  assert.equal(googleClaimGuard('abc'), 'acting_id=eq.abc');
  const now = Date.parse('2026-11-11T10:00:00Z');
  assert.ok(canClaimGoogleItem({ status: 'open' }, now));
  assert.ok(!canClaimGoogleItem({ status: 'open', acting_until: '2026-11-11T10:01:00Z' }, now), 'live claim blocks');
  assert.ok(canClaimGoogleItem({ status: 'kept', acting_until: '2026-11-11T09:59:00Z' }, now), 'expired claim is free');
  assert.ok(!canClaimGoogleItem({ status: 'suspended' }, now));
  const g = fnBody('actGoogleExitItem');
  const claim = g.indexOf('googleClaimFilter()');
  for (const call of ['googleWriteToken(env', 'verifiedGoogleUser(token', 'GDIR_USERS', 'datatransfer/v1/']) assert.ok(claim < g.indexOf(call), `claim before ${call}`);
  assert.match(g, /if \(!cr\.data\?\.length\) return x1Err\('in_progress'\);/);
  // No unguarded item write: every google_exit_items PATCH after the claim uses `mine` (id + acting_id).
  const after = g.slice(claim + 30);
  assert.ok(!/google_exit_items\?id=eq\.\$\{item\.id\}`/.test(after), 'no write by id alone after the claim');
  assert.match(g, /return r\.ok && r\.data\?\.length \? r\.data\[0\] : null;/, 'writes are checked');
  assert.match(g, /if \(!saved\) return x1Err\('conflict', 500\);/);
});

test('fix 11: transfer_pending until checked; never a second transfer', () => {
  assert.ok(GOOGLE_ITEM_STATUSES.includes('transfer_pending') && GOOGLE_LIVE_STATUSES.includes('transfer_pending'));
  assert.ok(googleItemDue({ status: 'transfer_pending' }, TODAY), 'stays in the queue');
  const pend = { status: 'transfer_pending', transfer_id: 't1' };
  assert.equal(checkGoogleAction(pend, { action: 'check_transfer' }, TODAY), null);
  for (const a of ['transfer_and_suspend', 'suspend', 'keep']) assert.equal(checkGoogleAction(pend, { action: a, keep_until: '2026-12-01', keep_reason: 'long enough' }, TODAY), 'transfer_in_progress');
  assert.equal(checkGoogleAction({ status: 'open' }, { action: 'check_transfer' }, TODAY), 'no_transfer_to_check');
  assert.equal(transferOutcome({ overallTransferStatusCode: 'completed' }), 'completed');
  assert.equal(transferOutcome({ overallTransferStatusCode: 'failed' }), 'failed');
  assert.equal(transferOutcome({ overallTransferStatusCode: 'inProgress' }), 'pending');
  assert.equal(transferOutcome({}), 'pending');
  const g = fnBody('actGoogleExitItem');
  assert.match(g, /op === 'transfer_and_suspend' && !item\.transfer_id/);
  assert.match(g, /status: item\.transfer_id \? 'transfer_pending' : 'suspended'/);
  assert.match(g, /if \(outcome === 'completed'\) return await finish\(\{ status: 'transferred_suspended'/);
  assert.match(g, /status: 'open', transfer_id: null/);
  assert.match(SQL, /check \(status not in \('transfer_pending', 'transferred_suspended'\) or transfer_id is not null\)/);
});

test('fix 12: a 404 by id retries by address; gone is terminal + logged; already-suspended still logged', () => {
  const v = fnBody('verifiedGoogleUser');
  assert.match(v, /if \(!r \|\| r\.status === 404\) r = await get\(workEmail\);/);
  assert.match(v, /if \(r\.status === 404\) return \{ gone: true \};/);
  const g = fnBody('actGoogleExitItem');
  assert.match(g, /action: 'account_gone'/);
  assert.match(g, /finish\(\{ status: 'gone'/);
  assert.match(g, /\.\.\.request, already: true \}/);
  assert.match(SQL, /'open', 'kept', 'transfer_pending', 'transferred_suspended', 'suspended', 'gone'/);
  assert.match(SQL, /'keep_active', 'transfer_checked', 'account_gone'/);
});

test('fix 13: backfill shows what exited people can still reach; revoke is a separate, logged HR action', () => {
  assert.deepEqual(accessLeft({ login_active: true, podium_roles: 1, comp_access: false, google_admin: true, assets: 2 }),
    ['login', 'podium_role', 'google_admin', 'assets']);
  assert.deepEqual(accessLeft({ login_active: false, podium_roles: 0, comp_access: false, google_admin: false, assets: 0 }), []);
  assert.deepEqual(accessLeft(null), []);
  const ge = fnBody('getExits');
  for (const k of ['users_profile?id=in.', 'podium_user_roles?user_id=in.', 'comp_access?auth_user_id=in.', 'google_admin_access?auth_user_id=in.']) assert.ok(ge.includes(k), k);
  assert.ok(!/exit_revoke_access/.test(ge) && !/backfillExit/.test(fnBody('backfillExit').replace('async function backfillExit', '')), 'nothing revokes on read or on backfill');
  assert.ok(!/users_profile|podium_user_roles/.test(SQL.slice(SQL.indexOf('create or replace function podium.exit_backfill'), SQL.indexOf('create or replace function podium.exit_update_item'))), 'backfill never revokes');
  assert.match(fnBody('revokeExitedAccess'), /hiringRpc\(env, 'exit_revoke_access'/);
  const rv = SQL.slice(SQL.indexOf('create or replace function podium.exit_revoke_access'), SQL.indexOf('create or replace function podium.exit_open_google_item'));
  for (const k of ["if v_e.status <> 'exited' then raise exception 'podium_not_exited'", 'update store.users_profile set active = false',
    'delete from store.podium_user_roles', 'delete from podium.comp_access', 'delete from podium.google_admin_access',
    "'access_revoked'"]) assert.ok(rv.includes(k), k);
  const og = SQL.slice(SQL.indexOf('create or replace function podium.exit_open_google_item'), SQL.indexOf('revoke all on function podium.exit_start'));
  for (const k of ['podium_not_exited', 'podium_no_work_email', 'podium_google_item_exists', "'google_item_opened'"]) assert.ok(og.includes(k), k);
  assert.match(og, /if exists \(select 1 from podium\.google_exit_items where employee_id = v_e\.id\) then/, 'never re-opens an actioned account');
  assert.match(ge, /can_open_google_item: !!e\.work_email && gir\.ok && !hasItem\.has\(e\.id\)/);
  assert.match(SQL, /before update or delete on podium\.exit_events/);
});

test('actGoogleExitItem reads the Google op from `op` — body.action is always the route name (prod smoke 2026-11-12)', () => {
  const g = fnBody('actGoogleExitItem');
  assert.ok(g.includes('const op = d.op'), 'op read from d.op');
  assert.ok(!g.includes('d.action'), 'never d.action');
});
