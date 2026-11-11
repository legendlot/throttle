// Podium J2 — the pure onboarding / profile rules in src/onboarding.js + text checks on 0011, the worker and the
// app (plan 2026-11-12-podium-j2-onboarding.md). Synthetic names and figures only — no real person, PAN, bank
// number or salary appears here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_PROFILE_FIELDS, PROTECTED_FIELDS, PROFILE_EMPLOYEE_FIELDS, PROFILE_PRIVATE_FIELDS, SALARY_PRIVATE_FIELDS,
  profileMissing, completionPct, validateProfileInput, routeProfileField, normPhone, normPan, normIfsc, normAmount,
  maskAccount, projectPrivate, projectChangeRequest, onboardingRole, canSeeOnboarding, canManageOnboarding,
  canTickOnboardingItem, autoStatus, itemState, onboardingBlockers, onboardingProgress, checkOnboardingItemUpdate,
  dueDate, itemOverdue, fyLabelFor, joinersWithoutOnboarding, snapshotOnboardingItems, policyApplies, checkAcknowledge,
  selfDocTypes, selfDocPath, isSelfDocPath, policyPath, XPAYROLL_HEADERS, ddmmyyyy, xpGender, xpPf, csvCell, xpayrollRow,
  xpayrollCsv, currentCtc, onboardingDbErrorCode,
} from '../src/onboarding.js';
import { istToday } from '../src/hiring.js';

const SQL = readFileSync(new URL('../migrations/0011_onboarding.sql', import.meta.url), 'utf8');
const SRC = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const fnBody = (name) => {
  let i = SRC.indexOf(`async function ${name}(`); if (i < 0) i = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(i >= 0, name); return SRC.slice(i, SRC.indexOf('\n}\n', i));
};
const TODAY = '2026-11-12';

// Synthetic, format-valid values (not anyone's real data).
const PAN = 'ABCDE1234F';
const IFSC = 'TEST0A1B2C3';
const ACCT = '000111222333';
const FULL_EMP = { date_of_birth: '1995-01-01', gender: 'f', personal_email: 'test.person@example.com', phone: '9000000001',
  emergency_contact_name: 'Test Contact', emergency_contact_phone: '9000000002', pan_number: PAN };
const FULL_PRIV = { current_address: '1 Test Street, Test City', bank_account_number: ACCT, bank_ifsc: IFSC };
const ALL_DOCS = ['id_proof', 'address_proof', 'bank_details'];

// ── The completion rule ──────────────────────────────────────────────────────
test('profileMissing: complete profile + every required doc → nothing missing', () => {
  assert.deepEqual(profileMissing(FULL_EMP, FULL_PRIV, ALL_DOCS), []);
  assert.equal(completionPct([], ALL_DOCS), 100);
});

test('profileMissing: each required field is reported on its own, with a human label', () => {
  for (const f of REQUIRED_PROFILE_FIELDS) {
    const emp = { ...FULL_EMP }, priv = { ...FULL_PRIV };
    if (f in emp) emp[f] = '  '; else priv[f] = null;
    const m = profileMissing(emp, priv, ALL_DOCS);
    assert.equal(m.length, 1, f);
    assert.equal(m[0].key, f);
    assert.ok(m[0].label && !m[0].label.includes('_'), `${f} has a human label`);
  }
});

test('profileMissing: each required doc type, and the settings list decides which', () => {
  const m = profileMissing(FULL_EMP, FULL_PRIV, ['id_proof']);
  assert.deepEqual(m.map(x => x.key), ['doc:address_proof', 'doc:bank_details']);
  assert.deepEqual(profileMissing(FULL_EMP, FULL_PRIV, [], ['id_proof']).map(x => x.key), ['doc:id_proof']);
  assert.deepEqual(profileMissing(FULL_EMP, FULL_PRIV, [], []), []);
  assert.equal(completionPct(m, ALL_DOCS), Math.round(100 * 11 / 13));
});

test('profileMissing: optional fields (UAN, ESIC, past salary, blood group, permanent address) never count', () => {
  const m = profileMissing({ ...FULL_EMP, blood_group: null, preferred_name: null },
    { ...FULL_PRIV, pf_uan: null, esic_number: null, past_taxable_salary: null, past_tds: null, permanent_address: null }, ALL_DOCS);
  assert.deepEqual(m, []);
  const all = profileMissing({}, null, []);
  assert.deepEqual(all.map(x => x.key), [...REQUIRED_PROFILE_FIELDS, 'doc:id_proof', 'doc:address_proof', 'doc:bank_details']);
  assert.equal(completionPct(all, ALL_DOCS), 0);
});

test('0011 profile_missing lists the SAME fields in the SAME order as the JS rule', () => {
  const body = SQL.slice(SQL.indexOf('function podium.profile_missing'), SQL.indexOf('function podium.onboarding_auto_status'));
  const keys = [...body.matchAll(/\(\d+,\s+'([a-z_]+)',/g)].map(m => m[1]);
  assert.deepEqual(keys, REQUIRED_PROFILE_FIELDS);
  assert.match(body, /profile_required_doc_types/);
});

// ── Validators: trim / uppercase / strip at the source form ──────────────────
test('validateProfileInput: PAN, IFSC, bank account, UAN, ESIC, phones are normalised then checked', () => {
  const v = validateProfileInput({ pan_number: ' abcde 1234f ', bank_ifsc: 'test0a1b2c3', bank_account_number: '0001 1122 2333',
    pf_uan: '1001-0010-0100', esic_number: '12345 67890', phone: '+91 90000 00001', emergency_contact_phone: '09000000002',
    personal_email: ' Test.Person@Example.COM ' }, TODAY);
  assert.deepEqual(v.errors, []);
  // Phones: validated as 10 digits, STORED as +91 + digits (the live form); either form is accepted back.
  assert.deepEqual(v.employee, { personal_email: 'test.person@example.com', phone: '+919000000001', emergency_contact_phone: '+919000000002', pan_number: PAN });
  assert.equal(validateProfileInput({ phone: '+919000000001' }, TODAY).employee.phone, '+919000000001', 'the stored form round-trips');
  assert.equal(validateProfileInput({ phone: '9000000001' }, TODAY).employee.phone, '+919000000001');
  assert.equal(validateProfileInput({ phone: '+91900000000' }, TODAY).errors[0].field, 'phone', '9 digits after +91');
  assert.deepEqual(v.private, { pf_uan: '100100100100', esic_number: '1234567890', bank_account_number: ACCT, bank_ifsc: IFSC });
});

test('validateProfileInput: bad formats come back with friendly messages, field by field', () => {
  const v = validateProfileInput({ pan_number: 'ABCD1234F', bank_ifsc: 'TEST1A1B2C3', bank_account_number: '12345678',
    pf_uan: '12345', esic_number: '123', phone: '12345', personal_email: 'nope', date_of_birth: '2030-01-01',
    gender: 'x', blood_group: 'C+', fy_label: '2026', past_tds: '-5' }, TODAY);
  const fields = v.errors.map(e => e.field).sort();
  assert.deepEqual(fields, ['bank_account_number', 'bank_ifsc', 'blood_group', 'date_of_birth', 'esic_number', 'fy_label', 'gender',
    'pan_number', 'past_tds', 'personal_email', 'pf_uan', 'phone'].sort());
  for (const e of v.errors) assert.ok(e.message.length > 10 && !/undefined/.test(e.message), e.field);
  assert.match(v.errors.find(e => e.field === 'pan_number').message, /ABCDE1234F/);
});

test('validateProfileInput: whitelist only; blank = clear; dates, gender, amounts normalised', () => {
  const v = validateProfileInput({ full_name: 'Not Allowed', status: 'exited', manager_id: 'x', salary: 1,
    preferred_name: '', date_of_birth: '2000-02-29', gender: 'Female', blood_group: 'ab+', past_taxable_salary: '1,20,000',
    cur_fy_tds: ' 0 ', current_address: '  Flat 1,\n  Test Road  ' }, TODAY);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.employee, { preferred_name: null, date_of_birth: '2000-02-29', gender: 'f', blood_group: 'AB+' });
  assert.deepEqual(v.private, { current_address: 'Flat 1, Test Road', cur_fy_tds: 0, past_taxable_salary: 120000 });
  assert.equal(validateProfileInput({ date_of_birth: '2001-02-29' }, TODAY).errors[0].field, 'date_of_birth', 'not a real date');
  assert.equal(validateProfileInput({ date_of_birth: TODAY }, TODAY).errors.length, 1, 'not today');
  for (const k of [...PROFILE_EMPLOYEE_FIELDS, ...PROFILE_PRIVATE_FIELDS]) assert.ok(!['full_name', 'status', 'manager_id', 'auth_user_id', 'work_email'].includes(k));
  assert.equal(normPhone('91 9000000001'), '9000000001');
  assert.equal(normPan('abcde1234f'), PAN);
  assert.equal(normIfsc(' test 0a1b2c3 '), IFSC);
  assert.equal(normAmount('12.5'), 12.5);
  assert.equal(normAmount('abc'), null);
});

// ── First fill vs change request (decision 4) ───────────────────────────────
test('routeProfileField: protected fields — first fill writes, a change requests, clearing is refused', () => {
  for (const f of PROTECTED_FIELDS) {
    assert.equal(routeProfileField(f, null, 'X'), 'write', `${f} first fill`);
    assert.equal(routeProfileField(f, '', 'X'), 'write', `${f} blank counts as unfilled`);
    assert.equal(routeProfileField(f, 'A', 'B'), 'request', `${f} change`);
    assert.equal(routeProfileField(f, 'A', ' A '), 'unchanged');
    assert.equal(routeProfileField(f, 'A', ''), 'cannot_clear');
  }
  assert.equal(routeProfileField('phone', '9000000001', '9000000003'), 'write', 'every other field stays self-editable');
  assert.equal(routeProfileField('current_address', 'A', null), 'write');
  assert.deepEqual(PROTECTED_FIELDS, ['pan_number', 'bank_account_number', 'bank_ifsc', 'bank_account_name']);
});

test('0011 profile_save_self mirrors the routing: protected list, first fill skipped, change → request, clear refused', () => {
  const body = SQL.slice(SQL.indexOf('function podium.profile_save_self'), SQL.indexOf('function podium.profile_change_decide'));
  assert.match(body, /array\['pan_number', 'bank_account_number', 'bank_ifsc', 'bank_account_name'\]/);
  assert.match(body, /if v_cur is null then continue; end if;\s+-- first fill/);
  assert.match(body, /raise exception 'podium_cannot_clear_protected'/);
  assert.match(body, /insert into podium\.profile_change_requests/);
  assert.match(body, /from podium\.employees where id = \(p->>'employee_id'\)::uuid for update/);
  // Every whitelisted field is written by the RPC, nothing else.
  for (const f of [...PROFILE_EMPLOYEE_FIELDS, ...PROFILE_PRIVATE_FIELDS]) assert.match(body, new RegExp(`v_(emp|priv) \\? '${f}'`), f);
  const upd = body.slice(body.indexOf('update podium.employees set'), body.indexOf('where id = v_e.id;'));
  assert.ok(upd.length > 100);
  const cols = [...upd.matchAll(/^\s+([a-z_]+)\s+= /gm)].map(m => m[1]);
  assert.deepEqual(cols.sort(), [...PROFILE_EMPLOYEE_FIELDS, 'updated_at'].sort(), 'the employees write touches the whitelist only');
});

// ── Masking + tiers (decision 2) ─────────────────────────────────────────────
test('maskAccount + projectPrivate: HR sees the bank account masked, comp adds salary fields, self sees all', () => {
  const row = { employee_id: 'e1', ...FULL_PRIV, pf_uan: '100100100100', esic_number: '1234567890', bank_account_name: 'Test Person',
    past_taxable_salary: '100000', past_tds: '1000', cur_fy_tds: '0', fy_label: '2026-27' };
  assert.equal(maskAccount(ACCT), '••••2333');
  assert.equal(maskAccount(null), null);
  const hr = projectPrivate(row, { hr: true });
  assert.equal(hr.bank_account_number, '••••2333');
  assert.equal(hr.bank_ifsc, IFSC);
  assert.equal(hr.pf_uan, '100100100100');
  for (const k of SALARY_PRIVATE_FIELDS) assert.ok(!(k in hr), `HR alone does not see ${k}`);
  const comp = projectPrivate(row, { comp: true });
  assert.equal(comp.past_taxable_salary, '100000');
  assert.ok(!('bank_account_number' in comp) && !('current_address' in comp), 'comp alone sees salary fields only');
  const both = projectPrivate(row, { hr: true, comp: true });
  assert.equal(both.bank_account_number, '••••2333', 'full account only to self and the export');
  assert.equal(both.past_tds, '1000');
  assert.equal(projectPrivate(row, { self: true }).bank_account_number, ACCT);
  assert.equal(projectPrivate(row, {}), null);
  assert.equal(projectChangeRequest({ field: 'bank_account_number', new_value: ACCT }).new_value, '••••2333');
  assert.equal(projectChangeRequest({ field: 'bank_ifsc', new_value: IFSC }).new_value, IFSC);
});

// ── Who may set which line ───────────────────────────────────────────────────
test('onboardingRole + canTickOnboardingItem: HR any line, manager only manual manager lines, the employee none', () => {
  assert.equal(onboardingRole({ self: true, hr: true }), 'employee', 'nobody runs their own onboarding');
  assert.equal(onboardingRole({ hr: true, chain: true }), 'hr');
  assert.equal(onboardingRole({ chain: true }), 'manager');
  assert.equal(onboardingRole(), null);
  for (const r of ['hr', 'manager', 'employee']) assert.ok(canSeeOnboarding(r));
  assert.ok(!canSeeOnboarding(null));
  assert.ok(canManageOnboarding('hr'));
  for (const r of ['manager', 'employee', null]) assert.ok(!canManageOnboarding(r));
  const mgr = { owner: 'manager', auto_source: null }, it = { owner: 'it', auto_source: null }, auto = { owner: 'employee', auto_source: 'profile' };
  assert.equal(canTickOnboardingItem('hr', it), null);
  assert.equal(canTickOnboardingItem('hr', auto), null, 'HR reaches auto lines (the unverifiable rule decides)');
  assert.equal(canTickOnboardingItem('manager', mgr), null);
  assert.equal(canTickOnboardingItem('manager', it), 'forbidden_item');
  assert.equal(canTickOnboardingItem('manager', { owner: 'manager', auto_source: 'it_kit' }), 'forbidden_item');
  assert.equal(canTickOnboardingItem('employee', auto), 'forbidden_item');
  assert.equal(canTickOnboardingItem(null, mgr), 'forbidden_item');
  assert.equal(canTickOnboardingItem('hr', null), 'not_found');
});

// ── Auto lines (decision 6) ──────────────────────────────────────────────────
test('autoStatus: each source resolves live; no login → IT kit / policies unverifiable', () => {
  assert.equal(autoStatus('profile', { missing: [] }), 'done');
  assert.equal(autoStatus('profile', { missing: [{ key: 'phone' }] }), 'open');
  assert.equal(autoStatus('documents', { docs_missing: ['id_proof'] }), 'open');
  assert.equal(autoStatus('documents', { docs_missing: [] }), 'done');
  assert.equal(autoStatus('policies', { policies_applicable: 0, auth_linked: false }), 'done', 'policies ship empty (L4)');
  assert.equal(autoStatus('policies', { policies_applicable: 2, auth_linked: false }), 'unverifiable');
  assert.equal(autoStatus('policies', { policies_applicable: 2, policies_pending: 1, auth_linked: true }), 'open');
  assert.equal(autoStatus('policies', { policies_applicable: '2', policies_pending: '0', auth_linked: true }), 'done');
  assert.equal(autoStatus('login', { auth_linked: true }), 'done');
  assert.equal(autoStatus('login', {}), 'open');
  assert.equal(autoStatus('it_kit', { auth_linked: false, assets: 3 }), 'unverifiable');
  assert.equal(autoStatus('it_kit', { auth_linked: true, assets: '0' }), 'open');
  assert.equal(autoStatus('it_kit', { auth_linked: true, assets: 1 }), 'done');
  assert.equal(autoStatus('probation_date', { probation_set: true }), 'done');
  assert.equal(autoStatus('probation_date', {}), 'open');
  assert.equal(autoStatus('nonsense', {}), 'open');
});

test('0011 onboarding_auto_status mirrors autoStatus (sources, unverifiable cases, retired assets excluded)', () => {
  const body = SQL.slice(SQL.indexOf('function podium.onboarding_auto_status'), SQL.indexOf('function podium.onboarding_start'));
  for (const s of ['profile', 'documents', 'policies', 'login', 'it_kit', 'probation_date']) assert.match(body, new RegExp(`p_source = '${s}'`), s);
  assert.equal((body.match(/return 'unverifiable'/g) || []).length, 2, 'only policies + it_kit');
  assert.match(body, /if v_apply = 0 then return 'done'/);
  assert.match(body, /status <> 'retired'/);
  assert.match(body, /a\.version = pl\.version/, 'an ack counts for the current version only');
});

test('itemState: stored done/na win; an open auto line shows its live status; not-required lines never block', () => {
  const f = { missing: [], auth_linked: false };
  assert.deepEqual(itemState({ auto_source: 'profile', status: 'open', required: true }, f), { state: 'done', live: 'done', resolved: true });
  assert.deepEqual(itemState({ auto_source: 'it_kit', status: 'open', required: true }, f), { state: 'unverifiable', live: 'unverifiable', resolved: false });
  assert.equal(itemState({ auto_source: 'it_kit', status: 'done', required: true }, f).resolved, true, 'HR marked it with a note');
  assert.equal(itemState({ auto_source: null, status: 'na', allow_na: true, required: true }, f).resolved, true);
  assert.equal(itemState({ auto_source: null, status: 'open', required: false }, f).resolved, true);
  const items = [
    { line_key: 'b', title: 'B', owner: 'hr', required: true, status: 'open', sort: 20 },
    { line_key: 'a', title: 'A', owner: 'employee', required: true, auto_source: 'profile', status: 'open', sort: 10 },
    { line_key: 'c', title: 'C', owner: 'hr', required: false, status: 'open', sort: 30 },
  ];
  assert.deepEqual(onboardingBlockers(items, { missing: [{ key: 'phone' }] }).map(b => b.line_key), ['a', 'b']);
  assert.deepEqual(onboardingBlockers(items, { missing: [] }).map(b => b.line_key), ['b']);
  assert.deepEqual(onboardingProgress(items, { missing: [] }), { required: 2, done: 1 });
});

test('checkOnboardingItemUpdate: auto lines only while unverifiable, by HR, with a note; N/A rules', () => {
  const auto = { owner: 'it', auto_source: 'it_kit', allow_na: true };
  assert.equal(checkOnboardingItemUpdate(auto, { status: 'done', note: 'Laptop handed over in person' }, 'unverifiable', 'hr'), null);
  assert.equal(checkOnboardingItemUpdate(auto, { status: 'done', note: '' }, 'unverifiable', 'hr'), 'unverifiable_note_required');
  assert.equal(checkOnboardingItemUpdate(auto, { status: 'done', note: 'x' }, 'open', 'hr'), 'auto_line_open');
  assert.equal(checkOnboardingItemUpdate(auto, { status: 'done', note: 'x' }, 'done', 'hr'), 'set_automatically');
  assert.equal(checkOnboardingItemUpdate(auto, { status: 'na', note: 'No laptop for this role' }, 'open', 'hr'), null);
  assert.equal(checkOnboardingItemUpdate(auto, { status: 'done', note: 'x' }, 'unverifiable', 'manager'), 'forbidden_item');
  const manual = { owner: 'manager', auto_source: null, allow_na: false };
  assert.equal(checkOnboardingItemUpdate(manual, { status: 'done' }, null, 'manager'), null);
  assert.equal(checkOnboardingItemUpdate(manual, { status: 'na', note: 'x' }, null, 'hr'), 'na_not_allowed');
  assert.equal(checkOnboardingItemUpdate({ ...manual, allow_na: true }, { status: 'na', note: ' ' }, null, 'hr'), 'na_note_required');
  assert.equal(checkOnboardingItemUpdate(manual, { status: 'maybe' }, null, 'hr'), 'bad_item_status');
  assert.equal(checkOnboardingItemUpdate(manual, { status: 'done' }, null, 'employee'), 'forbidden_item');
});

test('0011 onboarding_update_item re-checks under the lock: employee → onboarding → item, live auto check, roles', () => {
  const body = SQL.slice(SQL.indexOf('function podium.onboarding_update_item'), SQL.indexOf('function podium.onboarding_complete'));
  const iE = body.indexOf('from podium.employees where id = v_emp_id for update');
  const iO = body.indexOf('from podium.employee_onboardings where id = v_ob_id for update');
  const iI = body.indexOf('from podium.onboarding_items where id = (p->>\'item_id\')::uuid for update');
  assert.ok(iE > 0 && iO > iE && iI > iO, 'lock order employee → onboarding → item');
  for (const c of ['onboarding_not_open', 'bad_item_status', 'forbidden_item', 'na_not_allowed', 'na_note_required',
    'set_automatically', 'auto_line_open', 'unverifiable_note_required']) assert.match(body, new RegExp(`'podium_${c}'`), c);
  assert.match(body, /podium\.onboarding_auto_status\(v_e\.id, v_it\.auto_source\)/);
  const cb = SQL.slice(SQL.indexOf('function podium.onboarding_complete'), SQL.indexOf('function podium.profile_save_self'));
  assert.match(cb, /podium_onboarding_incomplete' using detail = v_open/);
  assert.match(cb, /onboarding_auto_status\(v_e\.id, i\.auto_source\) = 'done'/, 'auto lines re-checked live inside the RPC');
});

// ── Dates (IST) ──────────────────────────────────────────────────────────────
test('dueDate / itemOverdue: date_joined + offset; overdue = unresolved and due before IST today', () => {
  assert.equal(dueDate('2026-11-30', 3), '2026-12-03');
  assert.equal(dueDate('2026-11-02', -3), '2026-10-30', 'negative = before day one');
  assert.equal(dueDate(null, 3), null);
  const open = { status: 'open', required: true, due_date: '2026-11-11' };
  assert.equal(itemOverdue(open, {}, TODAY), true);
  assert.equal(itemOverdue({ ...open, due_date: TODAY }, {}, TODAY), false, 'due today is not overdue');
  assert.equal(itemOverdue({ ...open, status: 'done', done_at: 'x' }, {}, TODAY), false);
  assert.equal(itemOverdue({ ...open, auto_source: 'login' }, { auth_linked: true }, TODAY), false, 'live-done auto line');
  assert.equal(itemOverdue({ ...open, due_date: null }, {}, TODAY), false);
  // 20:00 UTC on the 11th is already the 12th in India.
  assert.equal(istToday(Date.parse('2026-11-11T20:00:00Z')), '2026-11-12');
  assert.equal(itemOverdue(open, {}, istToday(Date.parse('2026-11-11T20:00:00Z'))), true);
  assert.equal(itemOverdue(open, {}, istToday(Date.parse('2026-11-11T18:00:00Z'))), false, 'still the 11th in IST');
});

test('fyLabelFor + joinersWithoutOnboarding (90-day window, open/complete onboarding covers, cancelled does not)', () => {
  assert.equal(fyLabelFor('2026-11-12'), '2026-27');
  assert.equal(fyLabelFor('2027-03-31'), '2026-27');
  assert.equal(fyLabelFor('2027-04-01'), '2027-28');
  assert.equal(fyLabelFor('1999-12-31'), '1999-00');
  const emps = [
    { id: 'a', status: 'active', date_joined: '2026-11-01' },
    { id: 'b', status: 'active', date_joined: '2026-11-01' },
    { id: 'c', status: 'active', date_joined: '2026-11-01' },
    { id: 'd', status: 'active', date_joined: '2026-01-01' },
    { id: 'e', status: 'exited', date_joined: '2026-11-01' },
    { id: 'f', status: 'active', date_joined: null },
  ];
  const obs = [{ employee_id: 'a', status: 'open' }, { employee_id: 'b', status: 'complete' }, { employee_id: 'c', status: 'cancelled' }];
  assert.deepEqual(joinersWithoutOnboarding(emps, obs, TODAY).map(e => e.id), ['c']);
});

// ── Snapshot ─────────────────────────────────────────────────────────────────
test('snapshotOnboardingItems: active lines, filtered by applies_to (interns skip PF/ESI), sorted, offsets kept', () => {
  const lines = [
    { key: 'pf_esi_registration', title: 'PF', owner: 'hr', required: true, allow_na: true, applies_to: ['full_time', 'part_time'], due_offset_days: 30, sort: 110 },
    { key: 'profile_complete', title: 'Profile', owner: 'employee', required: true, auto_source: 'profile', applies_to: [], due_offset_days: '3', sort: 10 },
    { key: 'old_line', title: 'Old', owner: 'hr', required: true, applies_to: [], sort: 5, active: false },
  ];
  const intern = snapshotOnboardingItems(lines, 'intern');
  assert.deepEqual(intern.map(i => i.line_key), ['profile_complete']);
  assert.equal(intern[0].due_offset_days, 3);
  assert.equal(intern[0].auto_source, 'profile');
  assert.deepEqual(snapshotOnboardingItems(lines, 'full_time').map(i => i.line_key), ['profile_complete', 'pf_esi_registration']);
  assert.deepEqual(snapshotOnboardingItems(lines, null).map(i => i.line_key), ['profile_complete', 'pf_esi_registration'], 'no type → every line');
});

test('0011 seed: the plan\'s lines, owners, auto sources and offsets; interns excluded from PF / ESI', () => {
  const seed = SQL.slice(SQL.indexOf('insert into podium.onboarding_lines'), SQL.indexOf('create table podium.employee_onboardings'));
  const rows = [...seed.matchAll(/\('([a-z_]+)',\s+'[^']+',\s+'([a-z]+)',\s+(true|false),\s+(true|false),\s+'(\{[^}]*\})',\s+(null|'[a-z_]+'),\s+(-?\d+),/g)]
    .map(m => ({ key: m[1], owner: m[2], required: m[3] === 'true', allow_na: m[4] === 'true', applies: m[5], auto: m[6].replace(/'/g, ''), off: Number(m[7]) }));
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.equal(rows.length, 13);
  assert.deepEqual(['profile_complete', 'documents_uploaded', 'policies_acknowledged'].map(k => [by[k].owner, by[k].auto, by[k].off]),
    [['employee', 'profile', 3], ['employee', 'documents', 7], ['employee', 'policies', 7]]);
  assert.deepEqual([by.login_linked.auto, by.it_kit_issued.auto, by.app_access.auto], ['login', 'it_kit', 'null']);
  assert.deepEqual(['first_week_plan', 'probation_goals', 'buddy_assigned'].map(k => [by[k].owner, by[k].off]), [['manager', 0], ['manager', 14], ['manager', 0]]);
  assert.equal(by.pf_esi_registration.allow_na, true);
  assert.ok(!by.pf_esi_registration.applies.includes('intern'));
  assert.equal(by.probation_date_set.auto, 'probation_date');
  assert.equal(by.welcome_email.required, false);
});

// ── Policies + self documents ────────────────────────────────────────────────
test('policyApplies / checkAcknowledge: current active version that applies; old versions are stale', () => {
  const p = { id: 'p', version: 2, applies_to: ['full_time'], active: true };
  assert.equal(checkAcknowledge(p, 2, 'full_time'), null);
  assert.equal(checkAcknowledge(p, '2', null), null, 'no employment type → applies');
  assert.equal(checkAcknowledge(p, 1, 'full_time'), 'policy_version_stale');
  assert.equal(checkAcknowledge(p, 2, 'intern'), 'policy_not_applicable');
  assert.equal(checkAcknowledge({ ...p, active: false }, 2, 'full_time'), 'policy_version_stale', 'a superseded row is stale, not "not applicable"');
  assert.equal(checkAcknowledge({ ...p, active: false }, 2, 'intern'), 'policy_version_stale');
  assert.equal(checkAcknowledge(null, 1, null), 'policy_not_found');
  assert.ok(policyApplies({ applies_to: [], active: true }, 'intern'));
  assert.match(policyPath('Leave Policy v2.pdf', 1), /^policies\/1_Leave_Policy_v2\.pdf$/);
});

test('self documents: required types + education / other only; path under <employee>/self/, never ..', () => {
  assert.deepEqual(selfDocTypes(), ['id_proof', 'address_proof', 'bank_details', 'education_cert', 'other']);
  assert.ok(!selfDocTypes().includes('offer_letter') && !selfDocTypes().includes('photo'));
  const path = selfDocPath('emp-1', 'id_proof', 'my id (1).pdf', 42);
  assert.equal(path, 'emp-1/self/id_proof/42_my_id_1_.pdf');
  assert.ok(isSelfDocPath('emp-1', path));
  assert.ok(!isSelfDocPath('emp-1', 'emp-1/id_proof/42_x.pdf'), 'an HR upload path is not a self path');
  assert.ok(!isSelfDocPath('emp-1', 'emp-1/self/../emp-2/x.pdf'));
  assert.ok(!isSelfDocPath('emp-1', 'emp-2/self/id_proof/x.pdf'));
});

// ── XPayroll export ──────────────────────────────────────────────────────────
test('XPayroll headers are the sheet\'s, verbatim and in order', () => {
  assert.equal(XPAYROLL_HEADERS.length, 22);
  assert.deepEqual(XPAYROLL_HEADERS.slice(0, 5), ['Employee ID', 'Name *', 'Email *', 'Date of Hiring * (DD/MM/YYYY format only)', 'Professional Tax Location *\n(State)']);
  assert.equal(XPAYROLL_HEADERS[9], 'Provident Fund?\n(Y/N) *');
  assert.equal(XPAYROLL_HEADERS[12], 'Taxable salary paid in current F.Y. till now by curent employer outside XPayroll *');
  assert.deepEqual(XPAYROLL_HEADERS.slice(-5), ['Phone Number', 'Gender\n(M/F/Other)', 'Date of Birth\n(dd/mm/yyyy)', 'Bank Account Number', 'Bank IFSC Code']);
});

test('xpayrollRow / xpayrollCsv: DD/MM/YYYY, M/F/Other, PF Y/N from the offer, CSV escaping, numbers not strings', () => {
  assert.equal(ddmmyyyy('2026-11-03'), '03/11/2026');
  assert.equal(ddmmyyyy(null), '');
  assert.deepEqual(['m', 'F', 'other', 'Female', null, 'x'].map(xpGender), ['M', 'F', 'Other', 'F', '', '']);
  assert.deepEqual([true, false, null, undefined].map(xpPf), ['N', 'Y', '', '']);
  assert.equal(csvCell('Plain'), 'Plain');
  assert.equal(csvCell('Doe, Test'), '"Doe, Test"');
  assert.equal(csvCell('Say "hi"'), '"Say ""hi"""');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell(null), '');
  const row = xpayrollRow({ emp: { employee_code: 'EMP-900', full_name: 'Test, Person', work_email: 'test@example.com',
    date_joined: '2026-11-03', job_title: 'Tester', pan_number: PAN, phone: '9000000001', gender: 'f', date_of_birth: '1995-01-31' },
    priv: { pf_uan: '100100100100', esic_number: '', cur_fy_taxable_outside: '1000.50', cur_fy_exemptions: null, cur_fy_tds: '0',
      past_taxable_salary: '2000', past_tds: null, bank_account_number: ACCT, bank_ifsc: IFSC },
    department: 'QA', ctc: '600000', pf_opt_out: false, pt_state: 'Karnataka' });
  assert.equal(row.length, XPAYROLL_HEADERS.length);
  // Amounts are numbers; the five FY / past figures are 0 when null (nothing paid = 0); CTC stays a number.
  assert.deepEqual(row, ['EMP-900', 'Test, Person', 'test@example.com', '03/11/2026', 'Karnataka', 'Tester', 'QA', 600000, PAN, 'Y',
    '100100100100', '', 1000.5, 0, 0, 2000, 0, '9000000001', 'F', '31/01/1995', ACCT, IFSC]);
  assert.equal(xpayrollRow({ emp: { phone: '+919000000001' } })[17], '9000000001', 'stored +91 form exports as 10 digits');
  assert.equal(xpayrollRow({})[7], '', 'unknown CTC stays blank (vault off)');
  assert.deepEqual(xpayrollRow({}).slice(12, 17), [0, 0, 0, 0, 0]);
  const csv = xpayrollCsv([row]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], XPAYROLL_HEADERS.map(csvCell).join(','));
  assert.ok(lines[1].startsWith('EMP-900,"Test, Person",test@example.com,03/11/2026,'));
  assert.equal(lines[2], '');
  assert.equal(currentCtc([{ event_type: 'one_time_bonus', new_ctc: '50000' }, { event_type: 'increment', new_ctc: '700000' }, { event_type: 'initial', new_ctc: '600000' }]), 700000);
  assert.equal(currentCtc([{ event_type: 'increment', new_ctc: null }]), null, 'vault off → no CTC, blank cell');
});

test('exportXPayroll is comp-gated, audited per employee in ONE insert, and reads no row per employee', () => {
  const b = fnBody('exportXPayroll');
  assert.match(b, /const gate = requireComp\(auth\); if \(gate\) return gate;/);
  assert.match(b, /comp_access_log`, env, \{ method: 'POST'/);
  assert.match(b, /er\.data\.map\(e => \(\{\s*viewer_user_id/);
  assert.match(b, /employee_id=in\.\(/);
  assert.ok(!/for \(const [^)]+\) \{[^}]*await/.test(b), 'no await per row');
  assert.match(fnBody('getEmployeePrivate'), /if \(comp && !self\) await logCompAccess\(auth, 'getEmployeePrivate'/);
  assert.match(fnBody('getEmployeePrivate'), /projectPrivate\(row, \{ self, hr, comp \}\)/);
});

// ── Worker wiring ────────────────────────────────────────────────────────────
test('worker: self actions are self-serve (a no-role joiner reaches them); HR actions are requireHr-gated', () => {
  const sg = SRC.slice(SRC.indexOf('const SELF_SERVE_GET'), SRC.indexOf('const SELF_SERVE_POST'));
  const sp = SRC.slice(SRC.indexOf('const SELF_SERVE_POST'), SRC.indexOf('async function handleGet'));
  for (const a of ['getMyProfile', 'getPolicyFile', 'getOnboarding', 'getEmployeePrivate', 'exportXPayroll']) assert.match(sg, new RegExp(`'${a}'`), a);
  for (const a of ['saveMyProfile', 'createMyDocumentUploadUrl', 'recordMyDocument', 'acknowledgePolicy', 'updateOnboardingItem']) assert.match(sp, new RegExp(`'${a}'`), a);
  const hrOnly = ['getOnboardingBoard', 'getProfileCompletion', 'getProfileChangeRequests', 'getOnboardingTemplate', 'getPolicies',
    'startOnboarding', 'completeOnboarding', 'cancelOnboarding', 'launchProfileCampaign', 'decideProfileChange', 'saveOnboardingLine',
    'createPolicyUploadUrl', 'savePolicy', 'setPolicyActive'];
  for (const h of hrOnly) {
    assert.match(fnBody(h), /requireHr\(auth\)/, h);
    assert.ok(!new RegExp(`'${h}'`).test(sg + sp), `${h} is not self-serve`);
  }
  for (const h of ['getMyProfile', 'saveMyProfile', 'createMyDocumentUploadUrl', 'recordMyDocument', 'acknowledgePolicy'])
    assert.match(fnBody(h), /myOnboardingEmployee\(auth, env\)/, `${h} self-scopes on auth_user_id`);
  assert.match(fnBody('myOnboardingEmployee'), /employees\?auth_user_id=eq\.\$\{auth\.userId\}/);
  for (const h of ['getOnboarding', 'updateOnboardingItem']) assert.match(fnBody(h), /onboardingCtx\(auth, env,/, h);
  assert.match(fnBody('updateOnboardingItem'), /canTickOnboardingItem\(c\.role, item\)/);
  assert.match(fnBody('decideProfileChange'), /own_change_request/);
  assert.match(fnBody('saveMyProfile'), /validateProfileInput\(d\.fields, istToday\(\)\)/);
  assert.match(fnBody('recordMyDocument'), /isSelfDocPath\(m\.emp\.id, d\.storage_path\)/);
});

test('J1 hook: confirmJoining starts the onboarding best-effort and never fails the joining', () => {
  const cj = fnBody('confirmJoining');
  assert.equal((cj.match(/onboardingAfterJoining\(env, /g) || []).length, 2, 'both success paths (first run + re-run)');
  const h = fnBody('onboardingAfterJoining');
  assert.match(h, /startOnboardingFor\(env, employeeId, actorUserId, 'joining'\)/);
  assert.match(h, /catch \(e\) \{\s*return \{ onboarding_started: false/);
  assert.ok(!/return err\(|return j1Err\(|return j2Err\(/.test(h), 'the hook never returns an error response');
});

test('loadProfileFacts batches with in.() filters — one request per source, not per employee', () => {
  const b = fnBody('loadProfileFacts');
  for (const t of ['employee_private', 'documents', 'policy_acknowledgements']) assert.match(b, new RegExp(`${t}\\?employee_id=in\\.\\(`), t);
  assert.match(b, /assets\?custodian_user_id=in\.\(/);
  assert.ok(!/for \(const [^)]+\) \{[^}]*await/.test(b));
});

// ── SQL shape (copy of 0010's) ───────────────────────────────────────────────
test('0011: RLS on + service_role only for every new table; every function definer + pinned path + service_role execute', () => {
  const tables = ['employee_private', 'profile_change_requests', 'policies', 'policy_acknowledgements', 'onboarding_lines',
    'employee_onboardings', 'onboarding_items'];
  const loop = SQL.slice(SQL.indexOf('foreach t in array'), SQL.indexOf('end loop'));
  for (const t of tables) { assert.match(SQL, new RegExp(`create table podium\\.${t} \\(`), t); assert.match(loop, new RegExp(`'${t}'`), t); }
  assert.match(loop, /enable row level security/);
  assert.match(loop, /revoke all on podium\.%I from anon, authenticated/);
  assert.match(loop, /grant all on podium\.%I to service_role/);
  const fns = [...SQL.matchAll(/create or replace function (podium\.[a-z_]+)\(([^)]*)\)\s*returns [^\n]+\n?[^$]*?as \$\$/g)];
  assert.equal(fns.length, 8);
  for (const m of fns) {
    const name = m[1];
    assert.match(m[0], /security definer set search_path to 'podium', 'public'/, name);
    assert.match(SQL, new RegExp(`revoke all on function ${name.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(SQL, new RegExp(`grant execute on function ${name.replace('.', '\\.')}\\([^)]*\\) to service_role;`), name);
    assert.ok(!new RegExp(`grant execute on function ${name.replace('.', '\\.')}\\([^)]*\\) to (anon|authenticated|public)`).test(SQL), name);
  }
  assert.match(SQL.trim(), /notify pgrst, 'reload schema';$/);
});

test('0011: partial uniques (one open onboarding, one pending change per field, one active version), append-only acks', () => {
  assert.match(SQL, /create unique index employee_onboardings_one_open on podium\.employee_onboardings \(employee_id\) where status = 'open';/);
  assert.match(SQL, /create unique index profile_change_requests_one_pending on podium\.profile_change_requests \(employee_id, field\) where status = 'pending';/);
  assert.match(SQL, /create unique index policies_one_active_per_title on podium\.policies \(title\) where active;/);
  assert.match(SQL, /unique \(employee_id, policy_id, version\)/);
  assert.match(SQL, /policy_acknowledgements_no_update before update or delete on podium\.policy_acknowledgements\s+for each row execute function podium\.refuse_event_mutation\(\);/);
  assert.match(SQL, /unique \(onboarding_id, line_key\)/);
  assert.match(SQL, /bank_ifsc text check \(bank_ifsc ~ '\^\[A-Z\]\{4\}0\[A-Z0-9\]\{6\}\$'\)/);
  assert.match(SQL, /pf_uan text check \(pf_uan ~ '\^\[0-9\]\{12\}\$'\)/);
  assert.match(SQL, /profile_required_doc_types text\[\] not null default '\{id_proof,address_proof,bank_details\}'/);
  assert.match(SQL, /pt_state text not null default 'Karnataka'/);
  // Bank / statutory columns are NOT added to employees (decision 1).
  assert.ok(!/alter table podium\.employees/.test(SQL));
});

test('onboardingDbErrorCode maps raises and the partial-unique violations', () => {
  assert.deepEqual(onboardingDbErrorCode({ message: 'podium_onboarding_incomplete', details: 'a,b' }), { code: 'onboarding_incomplete', status: 409, detail: 'a,b' });
  assert.equal(onboardingDbErrorCode({ code: '23505', message: 'duplicate key value violates unique constraint "employee_onboardings_one_open"' }).code, 'onboarding_already_open');
  assert.equal(onboardingDbErrorCode({ code: '23505', message: 'x "profile_change_requests_one_pending"' }).code, 'change_already_pending');
  assert.equal(onboardingDbErrorCode({ code: '23514', message: 'check' }).code, 'check_failed');
  assert.equal(onboardingDbErrorCode({ code: '42P01', message: 'x' }), null);
});

// ── The app: no `action` key in a podiumopsPost body (X1 shipped that bug) ───
// podiumopsPost(action, body) sends {action, ...body} and the worker routes POSTs by body.action, so a body field
// named `action` silently re-routes the call. Scans every Podium app source file.
function appFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...appFiles(p));
    else if (/\.(js|jsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
// The argument text of every podiumopsPost( call, paren-balanced (strings skipped).
function postCalls(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('podiumopsPost(', i)) >= 0) {
    let j = i + 'podiumopsPost('.length, depth = 1, q = null;
    for (; j < src.length && depth > 0; j++) {
      const ch = src[j];
      if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') q = ch;
      else if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
    }
    out.push(src.slice(i, j));
    i = j;
  }
  return out;
}
const bodyHasActionKey = (call) => {
  const afterName = call.replace(/^podiumopsPost\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[A-Za-z_$][\w$]*)\s*,?/, '');
  return /[{,]\s*action\s*[:,}]/.test(afterName) || /[{,]\s*['"]action['"]\s*:/.test(afterName);
};
test('app: no podiumopsPost body carries a field named `action`', () => {
  const root = fileURLToPath(new URL('../../apps/podium/src/', import.meta.url));
  const files = appFiles(root);
  assert.ok(files.some(f => f.includes('welcome')), 'the J2 pages are scanned');
  const hits = [];
  for (const f of files) for (const c of postCalls(readFileSync(f, 'utf8'))) if (bodyHasActionKey(c)) hits.push(`${f.slice(root.length)}: ${c.slice(0, 120)}`);
  assert.deepEqual(hits, []);
  // The detector itself catches the X1 shape and leaves legitimate bodies alone.
  assert.ok(bodyHasActionKey("podiumopsPost('actGoogleExitItem', { id: x.id, action: 'keep' }, session)"));
  assert.ok(bodyHasActionKey("podiumopsPost('x', { action }, session)"));
  assert.ok(!bodyHasActionKey("podiumopsPost('actGoogleExitItem', { id: x.id, op: 'keep' }, session)"));
  assert.ok(!bodyHasActionKey("podiumopsPost(action, body, session)"));
  assert.ok(!bodyHasActionKey("podiumopsPost('decideProfileChange', { id, decision: 'approved', note: 'action: fine' }, session)"));
});

// ── Review fixes (2026-11-12) ────────────────────────────────────────────────
import {
  XPAYROLL_TEXT_COLUMNS, safeName, checkStoredObject, CHANGE_GROUPS, changeGroupOf, groupChangeRequests, cleanChangeDecision,
  selfViewItem, selfViewOnboarding, cleanOnboardingLine,
} from '../src/onboarding.js';

test('XPayroll: leading-zero 18-digit account (and UAN / ESIC / phone) survive as text — xlsx text columns + CSV ="…"', () => {
  const acct = '000000123456789012';   // synthetic, 18 digits, leading zeros
  assert.deepEqual(XPAYROLL_TEXT_COLUMNS.map(i => XPAYROLL_HEADERS[i]), ['PF UAN', 'ESIC Number', 'Phone Number', 'Bank Account Number']);
  const row = xpayrollRow({ emp: { phone: '9000000001' }, priv: { bank_account_number: acct, pf_uan: '010010010010', esic_number: '0012345678' } });
  assert.equal(row[20], acct, 'kept as a string with its zeros');
  assert.equal(typeof row[20], 'string');
  const line = xpayrollCsv([row]).split('\r\n')[1].split(',');
  assert.equal(line[20], '"=""000000123456789012"""', 'CSV: formula text, so Excel/Sheets keep it verbatim');
  assert.equal(line[10], '"=""010010010010"""');
  assert.equal(line[17], '"=""9000000001"""');
  assert.equal(xpayrollCsv([xpayrollRow({})]).split('\r\n')[1].split(',')[20], '', 'a blank stays blank, not =""');
  const b = fnBody('exportXPayroll');
  assert.match(b, /text_columns: XPAYROLL_TEXT_COLUMNS/);
  assert.match(b, /pf_blank: pfBlank/);
  assert.match(b, /if \(!ar\?\.ok\) return j2Err\('audit_failed', 500\);/, 'the audit insert must succeed or the export fails closed');
  assert.ok(b.indexOf("j2Err('audit_failed'") < b.indexOf('return ok('), 'checked before anything is returned');
});

test('safeName collapses dot runs (no orphaned upload), for self docs and policy paths', () => {
  assert.equal(safeName('scan..final.pdf'), 'scan.final.pdf');
  assert.equal(safeName('a....b...pdf'), 'a.b.pdf');
  const p = selfDocPath('emp-1', 'id_proof', 'scan..final.pdf', 7);
  assert.equal(p, 'emp-1/self/id_proof/7_scan.final.pdf');
  assert.ok(isSelfDocPath('emp-1', p), 'the path the upload got is the path recordMyDocument accepts');
  assert.equal(policyPath('leave..v2.pdf', 7), 'policies/7_leave.v2.pdf');
  assert.ok(!policyPath('../../x.pdf', 7).includes('..'));
});

test('checkStoredObject: storage decides — missing object, bad size, bad mime are refused; size/mime come from the HEAD', () => {
  assert.deepEqual(checkStoredObject({ ok: false, status: 404 }), { error: 'upload_not_found' });
  assert.deepEqual(checkStoredObject({ ok: false, status: 400 }), { error: 'upload_not_found' });
  assert.deepEqual(checkStoredObject(null), { error: 'upload_not_found' });
  assert.deepEqual(checkStoredObject({ ok: false, status: 503 }), { error: 'storage_check_failed' });
  assert.deepEqual(checkStoredObject({ ok: true, size: '0', mime: 'application/pdf' }), { error: 'bad_file_size' });
  assert.deepEqual(checkStoredObject({ ok: true, size: String(16 * 1024 * 1024), mime: 'application/pdf' }), { error: 'bad_file_size' });
  assert.deepEqual(checkStoredObject({ ok: true, size: '1200', mime: 'text/html' }), { error: 'bad_file_type' });
  assert.deepEqual(checkStoredObject({ ok: true, size: '1200', mime: 'image/PNG; charset=binary' }), { size: 1200, mime: 'image/png' });
  const b = fnBody('recordMyDocument');
  assert.match(b, /checkStoredObject\(await storageHead\(env, d\.storage_path\)\)/);
  assert.match(b, /mime_type: so\.mime, file_size: so\.size/, 'never the client\'s size / mime');
  assert.ok(!/d\.file_size|d\.mime_type/.test(b));
  assert.ok(b.indexOf('isSelfDocPath(m.emp.id') < b.indexOf('storageHead('), 'own path checked before storage is asked');
});

test('docAllowed: a self upload (/self/) is self + HR only — never the manager chain, whatever its type', () => {
  const b = fnBody('docAllowed');
  assert.match(b, /if \(isSelfUploadPath\(storagePath\)\) return false;/);
  assert.ok(b.indexOf('isSelfUploadPath') > b.indexOf('if (isSelf) return true;'), 'self still sees their own');
  assert.ok(b.indexOf('if (isHr(auth)) return true;') < b.indexOf('isSelfUploadPath'), 'HR still sees them');
  assert.match(fnBody('getDocuments'), /docAllowed\(auth, edges, employee_id, d\.doc_type, d\.storage_path\)/);
  assert.match(fnBody('getDocumentDownloadUrl'), /docAllowed\(auth, edges, doc\.employee_id, doc\.doc_type, doc\.storage_path\)/);
  const calls = SRC.match(/(?<!function )docAllowed\(auth[^)]*\)/g) || [];
  assert.equal(calls.length, 2, 'two callers');
  for (const c of calls) assert.match(c, /storage_path\)$/, `${c} passes the path`);
});

test('change requests: rev bumped on replace; bank fields decided as ONE group; PAN alone; stale revs refused', () => {
  assert.deepEqual(CHANGE_GROUPS, { pan: ['pan_number'], bank: ['bank_account_number', 'bank_ifsc', 'bank_account_name'] });
  assert.equal(changeGroupOf('bank_ifsc'), 'bank');
  assert.equal(changeGroupOf('pan_number'), 'pan');
  assert.equal(changeGroupOf('phone'), null);
  const g = groupChangeRequests([
    { id: 'r1', employee_id: 'e1', field: 'bank_ifsc', rev: 2, requested_at: '2026-11-12T10:00:00Z' },
    { id: 'r2', employee_id: 'e1', field: 'bank_account_number', rev: 1, requested_at: '2026-11-12T09:00:00Z' },
    { id: 'r3', employee_id: 'e1', field: 'pan_number', rev: 1, requested_at: '2026-11-12T08:00:00Z' },
    { id: 'r4', employee_id: 'e2', field: 'bank_ifsc', rev: 1, requested_at: '2026-11-12T08:00:00Z' },
  ]);
  assert.equal(g.length, 3);
  const bank = g.find(x => x.employee_id === 'e1' && x.group === 'bank');
  assert.equal(bank.label, 'Bank details');
  assert.deepEqual(bank.items.map(i => i.field), ['bank_account_number', 'bank_ifsc'], 'one change, fields in order');
  assert.equal(bank.requested_at, '2026-11-12T10:00:00Z');
  const U = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(cleanChangeDecision({ employee_id: 'e', group: 'bank', items: [{ id: U, rev: 2 }], decision: 'approved' }),
    { employee_id: 'e', group: 'bank', expected: [{ id: U, rev: 2 }], decision: 'approved', note: null });
  assert.deepEqual(cleanChangeDecision({ group: 'bank', items: [], decision: 'approved' }), { error: 'change_request_changed' }, 'no revs = cannot prove what HR saw');
  assert.deepEqual(cleanChangeDecision({ group: 'bank', items: [{ id: U }], decision: 'approved' }), { error: 'change_request_changed' });
  assert.deepEqual(cleanChangeDecision({ group: 'phone', items: [{ id: U, rev: 1 }], decision: 'approved' }), { error: 'bad_group' });
  assert.deepEqual(cleanChangeDecision({ group: 'pan', items: [{ id: U, rev: 1 }], decision: 'rejected' }), { error: 'decision_note_required' });
  // SQL: rev bumped on every replace; decide compares the exact (id, rev) set under the lock.
  const save = SQL.slice(SQL.indexOf('function podium.profile_save_self'), SQL.indexOf('function podium.profile_change_decide'));
  assert.match(save, /set new_value = v_new, rev = rev \+ 1,/);
  const dec = SQL.slice(SQL.indexOf('function podium.profile_change_decide'), SQL.indexOf('function podium.policy_publish'));
  assert.match(dec, /raise exception 'podium_change_request_changed'/);
  assert.match(dec, /if v_want is distinct from v_have then/);
  assert.match(dec, /array\['bank_account_number', 'bank_ifsc', 'bank_account_name'\]/);
  assert.ok(dec.indexOf('from podium.employees where id = v_emp_id for update') < dec.indexOf('select string_agg'), 'locked before comparing');
  assert.match(SQL, /rev int not null default 1 check \(rev >= 1\)/);
  assert.match(SQL, /status in \('pending', 'approved', 'rejected', 'withdrawn'\)/);
  assert.match(fnBody('decideProfileChange'), /cleanChangeDecision\(d\)/);
  assert.match(fnBody('getProfileChangeRequests'), /groupChangeRequests\(rows\)/);
});

test('withdrawMyChangeRequest: self-serve, scoped to the caller, guarded on pending', () => {
  const sp = SRC.slice(SRC.indexOf('const SELF_SERVE_POST'), SRC.indexOf('async function handleGet'));
  assert.match(sp, /'withdrawMyChangeRequest'/);
  const b = fnBody('withdrawMyChangeRequest');
  assert.match(b, /myOnboardingEmployee\(auth, env\)/);
  assert.match(b, /employee_id=eq\.\$\{m\.emp\.id\}&status=eq\.pending&field=in\./);
  assert.match(b, /status: 'withdrawn'/);
});

test('self view: only employee-owned lines keep their note; no cancel reason', () => {
  assert.equal(selfViewItem({ owner: 'manager', note: 'private manager note', title: 'x' }).note, undefined);
  assert.equal(selfViewItem({ owner: 'hr', note: 'hr note' }).note, undefined);
  assert.equal(selfViewItem({ owner: 'employee', note: 'mine' }).note, 'mine');
  const o = selfViewOnboarding({ id: 'o', status: 'cancelled', cancel_reason: 'wrong person', cancelled_by: 'u', started_by: 'u' });
  assert.deepEqual(o, { id: 'o', status: 'cancelled' });
  assert.match(fnBody('getMyProfile'), /\.map\(selfViewItem\)/);
  assert.match(fnBody('getMyProfile'), /selfViewOnboarding\(ob\)/);
  assert.match(fnBody('getOnboarding'), /self \? selfViewItem\(i\) : i/);
  assert.match(fnBody('getOnboarding'), /self \? selfViewOnboarding\(ob\) : ob/);
});

test('cleanOnboardingLine: sort 0 kept, due offset required integer, applies_to ⊆ employment types', () => {
  const base = { key: 'buddy_assigned', title: 'Buddy', owner: 'manager', due_offset_days: 0, sort: 0 };
  assert.equal(cleanOnboardingLine(base).sort, 0, '?? not ||');
  assert.equal(cleanOnboardingLine(base).due_offset_days, 0);
  assert.equal(cleanOnboardingLine({ ...base, sort: undefined }).sort, 100);
  for (const off of ['', null, undefined, '1.5', 'x', 366, -61, true]) assert.deepEqual(cleanOnboardingLine({ ...base, due_offset_days: off }), { error: 'bad_line' }, String(off));
  assert.equal(cleanOnboardingLine({ ...base, due_offset_days: '-3' }).due_offset_days, -3);
  assert.deepEqual(cleanOnboardingLine({ ...base, applies_to: ['full_time', 'intern'] }).applies_to, ['full_time', 'intern']);
  assert.deepEqual(cleanOnboardingLine({ ...base, applies_to: ['full_time', 'freelancer'] }), { error: 'bad_line' });
  assert.deepEqual(cleanOnboardingLine({ ...base, applies_to: 'full_time' }), { error: 'bad_line' });
  assert.ok(!('auto_source' in cleanOnboardingLine({ ...base, auto_source: 'profile' })), 'auto_source never written');
  assert.match(fnBody('saveOnboardingLine'), /cleanOnboardingLine\(body\.data \|\| body\)/);
});

test('J1 hook never auto-starts when ANY onboarding row exists (a cancelled one included)', () => {
  const h = fnBody('onboardingAfterJoining');
  assert.match(h, /employee_onboardings\?employee_id=eq\.\$\{employeeId\}&select=status/);
  assert.ok(!/status=(eq|in)\./.test(h.split('startOnboardingFor')[0]), 'no status filter: open, complete AND cancelled all count');
  assert.match(h, /if \(er\.data\.length\) return \{ onboarding_existing: er\.data\[0\]\.status \};/);
  assert.ok(h.indexOf('onboarding_existing') < h.indexOf('startOnboardingFor('));
});

test('HR edit paths validate PAN with the same rule (trim / uppercase first)', () => {
  const c = fnBody('cleanPanField');
  assert.match(c, /normPan\(raw\)/);
  assert.match(c, /PAN_RE\.test\(v\)/);
  assert.match(fnBody('updateEmployee'), /cleanPanField\(patch\)/);
  assert.match(fnBody('createEmployee'), /cleanPanField\(row\)/);
});

test('it_kit_issued allows N/A on purpose (floor / production staff get no laptop)', () => {
  const seed = SQL.slice(SQL.indexOf('insert into podium.onboarding_lines'), SQL.indexOf('create table podium.employee_onboardings'));
  assert.match(seed, /-- allow_na on it_kit is deliberate: floor \/ production staff get no laptop/);
  assert.match(seed, /\('it_kit_issued',\s+'[^']+',\s+'it',\s+true,\s+true,/);
});
