// Podium J1b — the pure Podium → Google field-sync rules in src/googlesync.js
// (plan docs/superpowers/plans/2026-11-12-podium-j1b-google-sync.md). Synthetic names and figures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SYNC_FIELDS, IN_SCOPE_STATUSES, DRAIN_CAP, SYNC_LEASE_MS, ORG_EXTERNAL_ID_TYPE, GOOGLE_CALL_TIMEOUT_MS, FOUNDER_CODES, COLUMN_FIELD,
  splitForGoogle, ouExcluded, desiredGoogleFields, googleFieldsOf, sameValue, mergeGoogleUser, bodyFields, scopeOf,
  classifyDiff, diffPerson, nextLastPushed, nextAttemptAt, syncClaimFilter, canClaimSync, cleanSyncFields,
  dirtiedFields, fieldsToPush, afterAttempt, leaseHeld, canonicalJson, previewHash, effectiveFields, needsOuCheck, identityChanged,
} from '../src/googlesync.js';
import { pushOneToGoogle, googleFetch, pushGoogleFields, bulkPushPaused } from '../src/index.js';
import { WA_EXTERNAL_ID_TYPE, workAccountExternalIds } from '../src/workaccount.js';

const SQL = readFileSync(new URL('../migrations/0015_google_field_sync.sql', import.meta.url), 'utf8');
const SQL19 = readFileSync(new URL('../migrations/0019_google_sync_no_phone_bulk_pause.sql', import.meta.url), 'utf8');
const SRC = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const WA_ID = '11111111-2222-4333-8444-555555555555';
const EMP_ID = '22222222-3333-4444-8555-666666666666';
const AUTH_ID = '33333333-4444-4555-8666-777777777777';

const emp = (over = {}) => ({
  id: EMP_ID, auth_user_id: AUTH_ID, status: 'active', work_email: 'testa@legendoftoys.com',
  full_name: 'Testa Middle Personne', job_title: 'Analyst', phone: '+91 90000 00001', employee_code: 'EMP-901',
  org_unit_path: '/Team A', ...over,
});
const gUser = (over = {}) => ({
  id: 'g-1', primaryEmail: 'testa@legendoftoys.com', isAdmin: false, suspended: false, orgUnitPath: '/Team A',
  name: { givenName: 'Testa Middle', familyName: 'Personne', fullName: 'Testa Middle Personne' },
  organizations: [{ primary: true, title: 'Analyst', department: 'Ops', costCenter: 'CC-1', customType: '' }],
  relations: [{ type: 'manager', value: 'boss@legendoftoys.com' }, { type: 'assistant', value: 'helper@legendoftoys.com' }],
  phones: [{ type: 'work', value: '080 1111 1111' }, { type: 'mobile', value: '+919000000001', primary: true }],
  externalIds: [...workAccountExternalIds(WA_ID), { type: 'organization', value: 'EMP-901' }],
  ...over,
});
const want = (e = emp(), o = { departmentName: 'Ops', managerEmail: 'boss@legendoftoys.com', hasManager: true }) => desiredGoogleFields(e, o);

// ── Name (D2: full_name only) ────────────────────────────────────────────────
test('splitForGoogle: all tokens but the last → givenName, the last → familyName', () => {
  assert.deepEqual(splitForGoogle('Testa Middle Personne'), { givenName: 'Testa Middle', familyName: 'Personne' });
  assert.deepEqual(splitForGoogle('  Testa   Personne  '), { givenName: 'Testa', familyName: 'Personne' });
  assert.deepEqual(splitForGoogle('Dr Testa Personne'), { givenName: 'Dr Testa', familyName: 'Personne' }, 'nothing dropped: Podium is the truth');
});
test('splitForGoogle: a one-word name fills both parts (Google needs both)', () => {
  assert.deepEqual(splitForGoogle('Mononym'), { givenName: 'Mononym', familyName: 'Mononym' });
});
test('splitForGoogle: blank → null (never pushed)', () => {
  for (const b of ['', '   ', null, undefined]) assert.equal(splitForGoogle(b), null);
});

// ── desired fields ───────────────────────────────────────────────────────────
test('desiredGoogleFields maps every D2 field; blanks become null', () => {
  const d = want();
  assert.deepEqual(d, { name: { givenName: 'Testa Middle', familyName: 'Personne' }, title: 'Analyst', department: 'Ops',
    manager: 'boss@legendoftoys.com', employee_code: 'EMP-901', org_unit: '/Team A' });
  assert.equal('phone' in d, false, 'phone stays in Podium (Afshaan 2026-11-13)');
  const b = desiredGoogleFields(emp({ job_title: '  ', phone: null, org_unit_path: '' }), { departmentName: null, hasManager: false });
  assert.equal(b.title, null); assert.equal(b.org_unit, null); assert.equal(b.department, null);
  assert.equal(b.manager, null, 'no manager in Podium = a value (remove), not blank');
});
test('desiredGoogleFields: a manager with no known work email is undefined (leave Google alone)', () => {
  assert.equal(desiredGoogleFields(emp(), { hasManager: true, managerEmail: null }).manager, undefined);
  assert.equal(desiredGoogleFields(emp(), { hasManager: true, managerEmail: ' Boss@LegendOfToys.com ' }).manager, 'boss@legendoftoys.com');
});

// ── merge: no-op ─────────────────────────────────────────────────────────────
test('mergeGoogleUser: Google already matches → null (no PUT)', () => {
  assert.equal(mergeGoogleUser(gUser(), want()), null);
});
test('mergeGoogleUser: manager compared case-insensitively', () => {
  const g = gUser({ relations: [{ type: 'manager', value: 'BOSS@legendoftoys.com' }] });
  assert.equal(mergeGoogleUser(g, want()), null);
});

// ── merge: preserve what Podium does not own ─────────────────────────────────
test('merge keeps the J1 podium_work_account externalId and replaces only the organization code', () => {
  const b = mergeGoogleUser(gUser(), want(emp({ employee_code: 'EMP-902' })));
  assert.deepEqual(Object.keys(b), ['externalIds']);
  assert.ok(b.externalIds.some(x => x.type === 'custom' && x.customType === WA_EXTERNAL_ID_TYPE && x.value === WA_ID), 'J1 stamp survives');
  const orgIds = b.externalIds.filter(x => x.type === ORG_EXTERNAL_ID_TYPE);
  assert.deepEqual(orgIds, [{ type: 'organization', value: 'EMP-902' }]);
});
test('merge replaces duplicate organization codes with exactly one', () => {
  const g = gUser({ externalIds: [{ type: 'organization', value: 'EMP-901' }, { type: 'organization', value: 'OLD' }, { type: 'account', value: 'x' }] });
  const b = mergeGoogleUser(g, want());
  assert.deepEqual(b.externalIds, [{ type: 'account', value: 'x' }, { type: 'organization', value: 'EMP-901' }]);
});
test('merge keeps other relations and sets the manager', () => {
  const b = mergeGoogleUser(gUser(), want(emp(), { departmentName: 'Ops', managerEmail: 'other@legendoftoys.com', hasManager: true }));
  assert.deepEqual(b.relations, [{ type: 'assistant', value: 'helper@legendoftoys.com' }, { type: 'manager', value: 'other@legendoftoys.com' }]);
});
test('phones are never sent: a different Podium phone, or none in Google, changes nothing', () => {
  assert.equal(SYNC_FIELDS.includes('phone'), false);
  assert.equal(mergeGoogleUser(gUser(), want(emp({ phone: '+91 90000 00009' }))), null);
  assert.equal(mergeGoogleUser(gUser({ phones: [] }), want()), null);
  const b = mergeGoogleUser(gUser(), want(emp({ phone: '+91 90000 00009', job_title: 'Lead' })));
  assert.deepEqual(Object.keys(b), ['organizations']);
  assert.equal(cleanSyncFields(['phone']).error, 'bad_fields');
  assert.deepEqual(dirtiedFields(emp(), emp({ phone: '+91 90000 00009' })), [], 'a phone edit dirties nothing');
});
test('merge keeps extra organization keys and the other organizations', () => {
  const g = gUser({ organizations: [{ name: 'Old Co', title: 'Intern' }, { primary: true, title: 'Analyst', department: 'Ops', costCenter: 'CC-1' }] });
  const b = mergeGoogleUser(g, want(emp({ job_title: 'Senior Analyst' })));
  assert.deepEqual(b.organizations, [{ name: 'Old Co', title: 'Intern' }, { primary: true, title: 'Senior Analyst', department: 'Ops', costCenter: 'CC-1' }]);
});
test('merge creates a primary organization when Google has none', () => {
  const b = mergeGoogleUser(gUser({ organizations: undefined }), want());
  assert.deepEqual(b.organizations, [{ primary: true, title: 'Analyst', department: 'Ops' }]);
});
test('primary org: a list with no primary=true entry is never overwritten; a new primary entry is APPENDED', () => {
  const g = gUser({ organizations: [{ name: 'Old Co', title: 'Intern', department: 'X' }] });
  const b = mergeGoogleUser(g, want());
  assert.deepEqual(b.organizations, [{ name: 'Old Co', title: 'Intern', department: 'X' }, { primary: true, title: 'Analyst', department: 'Ops' }]);
  assert.equal(googleFieldsOf(g).title, null, 'list[0] is not read as the primary either');
});
test('primary org: only the primary=true entry is touched, wherever it sits', () => {
  const g = gUser({ organizations: [{ title: 'A' }, { primary: true, title: 'Analyst', department: 'Ops', location: 'BLR' }, { title: 'C' }] });
  const b = mergeGoogleUser(g, want(emp({ job_title: 'Lead' })));
  assert.deepEqual(b.organizations, [{ title: 'A' }, { primary: true, title: 'Lead', department: 'Ops', location: 'BLR' }, { title: 'C' }]);
  assert.equal(mergeGoogleUser(gUser({ organizations: [{ primary: false, title: 'Analyst', department: 'Ops' }] }), want()).organizations.length, 2,
    'primary:false is not primary');
});
test('merge sets name and org unit only when they differ', () => {
  const b = mergeGoogleUser(gUser(), want(emp({ full_name: 'Testa Personne', org_unit_path: '/Team B' })));
  assert.deepEqual(b, { name: { givenName: 'Testa', familyName: 'Personne' }, orgUnitPath: '/Team B' });
  assert.deepEqual(bodyFields(b), ['name', 'org_unit']);
});
test('merge: a one-word Podium name is pushed as both parts', () => {
  const b = mergeGoogleUser(gUser(), want(emp({ full_name: 'Mononym' })));
  assert.deepEqual(b.name, { givenName: 'Mononym', familyName: 'Mononym' });
});

// ── merge: blank never wipes, except the manager ─────────────────────────────
test('a blank Podium value leaves Google alone (title, department, code, OU)', () => {
  const e = emp({ job_title: null, employee_code: null, org_unit_path: null });
  const b = mergeGoogleUser(gUser(), desiredGoogleFields(e, { departmentName: null, managerEmail: 'boss@legendoftoys.com', hasManager: true }));
  assert.equal(b, null);
});
test('Podium with no manager removes Google\'s manager relation (other relations kept)', () => {
  const b = mergeGoogleUser(gUser(), want(emp(), { departmentName: 'Ops', hasManager: false }));
  assert.deepEqual(b, { relations: [{ type: 'assistant', value: 'helper@legendoftoys.com' }] });
  const only = mergeGoogleUser(gUser({ relations: [{ type: 'manager', value: 'boss@legendoftoys.com' }] }), want(emp(), { departmentName: 'Ops', hasManager: false }));
  assert.deepEqual(only, { relations: [] }, 'the last relation removed → an empty list is sent');
  assert.equal(mergeGoogleUser(gUser({ relations: [] }), want(emp(), { departmentName: 'Ops', hasManager: false })), null);
});
test('a manager with an unknown email never touches Google relations', () => {
  const b = mergeGoogleUser(gUser({ relations: [] }), want(emp(), { departmentName: 'Ops', hasManager: true, managerEmail: null }));
  assert.equal(b, null);
});

// ── merge: field pick ────────────────────────────────────────────────────────
test('opts.fields limits the merge to those fields; an EMPTY list merges nothing', () => {
  const e = emp({ full_name: 'Other Person', job_title: 'Lead', org_unit_path: '/Team B' });
  assert.deepEqual(mergeGoogleUser(gUser(), want(e), { fields: ['org_unit'] }), { orgUnitPath: '/Team B' });
  assert.equal(mergeGoogleUser(gUser(), want(e), { fields: ['employee_code'] }), null);
  assert.equal(mergeGoogleUser(gUser(), want(e), { fields: [] }), null, '[] is not "all"');
  assert.deepEqual(Object.keys(mergeGoogleUser(gUser(), want(e))).sort(), ['name', 'orgUnitPath', 'organizations'], 'omitted = all');
});

// ── push only what changed ───────────────────────────────────────────────────
test('dirtiedFields: an update dirties only the fields whose columns changed', () => {
  const a = emp(), b = emp({ job_title: 'Lead' });
  assert.deepEqual(dirtiedFields(a, b), ['title']);
  assert.deepEqual(dirtiedFields(a, emp({ manager_id: 'm2', phone: '1' })), ['manager']);
  assert.deepEqual(dirtiedFields(a, emp({ preferred_name: 'x' })), [], 'unwatched column');
  assert.deepEqual(dirtiedFields(a, emp({ work_email: 'new@legendoftoys.com' })), [], 'work_email → nothing on the person');
  assert.deepEqual(dirtiedFields(a, emp({ status: 'on_leave' })), [], 'status → nothing');
  assert.deepEqual(dirtiedFields(null, emp({ department_id: 'd1', manager_id: 'm1' })), ['department', 'manager', 'employee_code', 'org_unit'],
    'insert → all but name + title');
  assert.deepEqual(Object.values(COLUMN_FIELD).sort(), [...SYNC_FIELDS].sort(), 'every field has its column');
});
test('R3: an INSERT dirties only fields that hold a value — a NULL OU or manager dirties neither', () => {
  assert.deepEqual(dirtiedFields(null, emp({ org_unit_path: null, manager_id: null, department_id: 'd1' })), ['department', 'employee_code']);
  assert.deepEqual(dirtiedFields(null, emp({ org_unit_path: '  ', manager_id: undefined })), ['employee_code'], 'blank = no value');
  assert.match(SQL, /if new\.manager_id is not null then v_f := array_append\(v_f, 'manager'\)/);
  assert.match(SQL, /if nullif\(btrim\(coalesce\(new\.org_unit_path, ''\)\), ''\) is not null then v_f := array_append\(v_f, 'org_unit'\)/);
});
test('R2: status / work_email change bumps rev and revives a row with dirty fields, adding none', () => {
  assert.match(SQL, /old\.status is distinct from new\.status or old\.work_email is distinct from new\.work_email\) then\s+update podium\.google_sync_state set rev = rev \+ 1,\s+status = case when cardinality\(dirty_fields\) > 0 then 'pending' else status end/);
  assert.equal(identityChanged({ status: 'active', work_email: 'a@x.com', google_user_id: 'g1' }, { status: 'active', work_email: 'A@x.com', google_user_id: 'g1' }), false);
  for (const fresh of [{ status: 'exited', work_email: 'a@x.com', google_user_id: 'g1' }, { status: 'active', work_email: 'b@x.com', google_user_id: 'g1' },
    { status: 'active', work_email: 'a@x.com', google_user_id: 'g2' }, null]) {
    assert.equal(identityChanged({ status: 'active', work_email: 'a@x.com', google_user_id: 'g1' }, fresh), true, JSON.stringify(fresh));
  }
});
test('fieldsToPush: dirty fields, narrowed to the claim scope when there is one', () => {
  assert.deepEqual(fieldsToPush(['title', 'org_unit']), ['title', 'org_unit']);
  assert.deepEqual(fieldsToPush(['org_unit', 'name']), ['name', 'org_unit'], 'SYNC_FIELDS order');
  assert.deepEqual(fieldsToPush(['title', 'org_unit'], ['org_unit', 'manager']), ['org_unit']);
  assert.deepEqual(fieldsToPush(['phone', 'title']), ['title'], 'a stale phone entry is never pushed');
  assert.deepEqual(fieldsToPush([], null), []);
  assert.deepEqual(fieldsToPush(null, ['name']), []);
});
test('dirty_fields → merge subset: a title change never pushes the (different) name or OU', () => {
  const e = emp({ job_title: 'Lead', full_name: 'Other Person', org_unit_path: '/Team B' });
  const b = mergeGoogleUser(gUser(), want(e), { fields: fieldsToPush(dirtiedFields(emp(), emp({ job_title: 'Lead' }))) });
  assert.deepEqual(Object.keys(b), ['organizations']);
  assert.equal(b.organizations[0].title, 'Lead');
});
test('afterAttempt: ok only when nothing is left AND rev is unchanged', () => {
  assert.deepEqual(afterAttempt({ outcome: 'ok', claimedRev: 3, currentRev: 3, dirty: ['title'], done: ['title'] }), { status: 'ok', dirty_fields: [] });
  assert.deepEqual(afterAttempt({ outcome: 'ok', claimedRev: 3, currentRev: 3, dirty: ['title', 'org_unit'], done: ['title'] }),
    { status: 'pending', dirty_fields: ['org_unit'] }, 'a subset push leaves the other real change pending');
  assert.deepEqual(afterAttempt({ outcome: 'ok', claimedRev: 3, currentRev: 4, dirty: ['title'], done: ['title'] }),
    { status: 'pending', dirty_fields: ['title'] }, 'changed mid-push: nothing is dropped');
  assert.deepEqual(afterAttempt({ outcome: 'ok', claimedRev: 3, currentRev: 3, dirty: ['title'], done: [] }), { status: 'pending', dirty_fields: ['title'] });
  assert.deepEqual(afterAttempt({ outcome: 'failed', claimedRev: 1, currentRev: 1, dirty: ['name'] }), { status: 'failed', dirty_fields: ['name'] });
  assert.deepEqual(afterAttempt({ outcome: 'failed', claimedRev: 1, currentRev: 2, dirty: ['name'] }), { status: 'pending', dirty_fields: ['name'] });
  assert.deepEqual(afterAttempt({ outcome: 'skipped', claimedRev: '5', currentRev: 5, dirty: ['name'] }), { status: 'skipped', dirty_fields: ['name'] }, 'bigint as string');
});
test('a no-op push (merge → null) counts its fields as done', () => {
  const fs = ['title'];
  assert.equal(mergeGoogleUser(gUser(), want(), { fields: fs }), null);
  assert.equal(afterAttempt({ outcome: 'ok', claimedRev: 1, currentRev: 1, dirty: fs, done: fs }).status, 'ok');
});
test('leaseHeld: the owner with enough lease left; anyone else, or too little time, is not', () => {
  const now = Date.parse('2026-11-12T10:00:00.000Z');
  const row = (ageMs) => ({ attempt_id: 'a1', attempt_started_at: new Date(now - ageMs).toISOString() });
  assert.equal(leaseHeld(row(1000), 'a1', now), true);
  assert.equal(leaseHeld(row(1000), 'a2', now), false, 'another attempt');
  assert.equal(leaseHeld(row(SYNC_LEASE_MS - GOOGLE_CALL_TIMEOUT_MS + 1), 'a1', now), false, 'not enough lease for the PUT');
  assert.equal(leaseHeld(null, 'a1', now), false);
  assert.ok(2 * GOOGLE_CALL_TIMEOUT_MS + 5000 < SYNC_LEASE_MS, 'GET + PUT fit inside the lease');
});
test('preview hash: order-free, sensitive to any value, null = "nothing to send"', async () => {
  assert.equal(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] }), '{"a":[{"x":1,"y":2}],"b":1}');
  const h1 = await previewHash({ name: { givenName: 'A', familyName: 'B' }, orgUnitPath: '/T' });
  const h2 = await previewHash({ orgUnitPath: '/T', name: { familyName: 'B', givenName: 'A' } });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(h1, await previewHash({ orgUnitPath: '/T2', name: { givenName: 'A', familyName: 'B' } }));
  assert.equal(await previewHash(null), await previewHash(undefined));
  assert.notEqual(await previewHash(null), h1);
});
test('cleanSyncFields: null = all, unknown refused', () => {
  assert.deepEqual(cleanSyncFields(undefined), { fields: null });
  assert.deepEqual(cleanSyncFields(['name', 'name', 'org_unit']), { fields: ['name', 'org_unit'] });
  assert.deepEqual(cleanSyncFields(['password']), { error: 'bad_fields' });
  assert.deepEqual(cleanSyncFields([]), { error: 'bad_fields' });
  assert.deepEqual(cleanSyncFields('name'), { error: 'bad_fields' });
});
test('the merge never emits primaryEmail, password, suspended or groups', () => {
  const b = mergeGoogleUser({}, want());
  for (const k of ['primaryEmail', 'password', 'suspended', 'changePasswordAtNextLogin', 'groups']) assert.equal(k in b, false, k);
});

// ── scope (D4) ───────────────────────────────────────────────────────────────
const ctx = (over = {}) => ({ superAdminAuthIds: new Set(), ignored: new Set(), excludedOus: ['/Admin and general'],
  liveOus: new Set(['/', '/Team A', '/Team B', '/Admin and general']), impersonateEmail: 'admin@legendoftoys.com', ...over });

test('scopeOf: an active person with a matching Google account is in scope', () => {
  for (const s of IN_SCOPE_STATUSES) assert.deepEqual(scopeOf(emp({ status: s }), gUser(), ctx()), { ok: true });
});
test('scopeOf: exited / no work email / not our domain are skipped', () => {
  assert.equal(scopeOf(emp({ status: 'exited' }), gUser(), ctx()).reason, 'exited');
  assert.equal(scopeOf(emp({ work_email: null }), gUser(), ctx()).reason, 'no_work_email');
  assert.equal(scopeOf(emp({ work_email: 'testa@example.com' }), gUser(), ctx()).reason, 'no_work_email');
});
test('scopeOf: founders and super-admins excluded entirely, every way they are recognised', () => {
  assert.equal(scopeOf(emp(), gUser(), ctx({ superAdminAuthIds: new Set([AUTH_ID]) })).reason, 'founder_or_super_admin');
  for (const code of FOUNDER_CODES) {
    assert.equal(scopeOf(emp({ employee_code: code, auth_user_id: null }), gUser(), ctx()).reason, 'founder_or_super_admin', `deny-list ${code}`);
  }
  assert.equal(scopeOf(emp({ employee_code: ' emp-001 ' }), gUser(), ctx()).reason, 'founder_or_super_admin');
  assert.equal(scopeOf(emp(), gUser({ isAdmin: true }), ctx()).reason, 'founder_or_super_admin');
  assert.equal(scopeOf(emp({ work_email: 'admin@legendoftoys.com' }), gUser({ primaryEmail: 'admin@legendoftoys.com' }), ctx()).reason,
    'founder_or_super_admin', 'the impersonated admin');
  // checked before Google is even consulted
  assert.equal(scopeOf(emp(), null, ctx({ superAdminAuthIds: new Set([AUTH_ID]) })).reason, 'founder_or_super_admin');
});
test('scopeOf: ignore list, missing account, alias mismatch, suspended', () => {
  assert.equal(scopeOf(emp(), gUser(), ctx({ ignored: new Set(['testa@legendoftoys.com']) })).reason, 'directory_ignored');
  assert.equal(scopeOf(emp(), null, ctx()).reason, 'no_google_account');
  assert.equal(scopeOf(emp(), gUser({ primaryEmail: 'someone.else@legendoftoys.com' }), ctx()).reason, 'alias_mismatch');
  assert.equal(scopeOf(emp({ work_email: 'Testa@LegendOfToys.com' }), gUser(), ctx()).ok, true, 'case-insensitive');
  assert.equal(scopeOf(emp(), gUser({ suspended: true }), ctx()).reason, 'suspended');
});
test('scopeOf: the CURRENT Google OU is excluded unconditionally; a bad TARGET OU never skips the person', () => {
  assert.equal(scopeOf(emp(), gUser({ orgUnitPath: '/Admin and general' }), ctx()).reason, 'excluded_ou');
  assert.equal(scopeOf(emp(), gUser({ orgUnitPath: '/Admin and general/Shared' }), ctx()).reason, 'excluded_ou', 'sub-OU too');
  assert.equal(scopeOf(emp({ org_unit_path: '/Admin and general' }), gUser(), ctx()).ok, true);
  assert.equal(scopeOf(emp({ org_unit_path: '/Nowhere' }), gUser(), ctx()).ok, true);
  assert.equal(ouExcluded('/Admin and generalx', ['/Admin and general']), false, 'prefix is not a sub-OU');
});
test('R6: a bad target OU is a skip for the org_unit FIELD only', () => {
  const e = emp({ org_unit_path: '/Nowhere' });
  assert.deepEqual(effectiveFields(e, gUser(), ['title', 'org_unit'], ctx()), { fields: ['title'], fieldSkips: { org_unit: 'target_ou_unknown' } });
  assert.deepEqual(effectiveFields(emp({ org_unit_path: '/Admin and general' }), gUser(), undefined, ctx()).fieldSkips, { org_unit: 'target_ou_excluded' });
  assert.deepEqual(effectiveFields(e, gUser(), ['title'], ctx()), { fields: ['title'], fieldSkips: {} }, 'not pushing org_unit → no OU check');
  assert.equal(needsOuCheck(e, gUser(), ['title']), false);
  assert.equal(needsOuCheck(e, gUser(), ['org_unit']), true);
  assert.equal(needsOuCheck(emp({ org_unit_path: '/Team A' }), gUser(), ['org_unit']), false, 'no move → no check');
  assert.deepEqual(effectiveFields(emp({ org_unit_path: '/Team B' }), gUser(), ['org_unit'], ctx()).fields, ['org_unit']);
});

// ── diff states (D11) ────────────────────────────────────────────────────────
test('classifyDiff: equal / differs / podium_blank / changed_in_google', () => {
  assert.equal(classifyDiff('title', 'Analyst', 'Analyst', null), 'equal');
  assert.equal(classifyDiff('title', 'Analyst', 'Lead', null), 'differs', 'never pushed');
  assert.equal(classifyDiff('title', null, 'Lead', null), 'podium_blank');
  assert.equal(classifyDiff('title', 'Analyst', 'Lead', { title: 'Analyst' }), 'changed_in_google', 'we pushed Analyst, Google now says Lead');
  assert.equal(classifyDiff('title', 'Senior', 'Analyst', { title: 'Analyst' }), 'differs', 'Podium changed since the push');
});
test('classifyDiff: no manager is a value, an unknown manager email is blank', () => {
  assert.equal(classifyDiff('manager', null, null, null), 'equal');
  assert.equal(classifyDiff('manager', null, 'boss@legendoftoys.com', null), 'differs');
  assert.equal(classifyDiff('manager', undefined, 'boss@legendoftoys.com', null), 'podium_blank');
  assert.equal(classifyDiff('manager', 'a@legendoftoys.com', 'A@legendoftoys.com', null), 'equal');
});
test('diffPerson covers every field', () => {
  const d = diffPerson(want(emp({ job_title: 'Lead' })), googleFieldsOf(gUser()), null);
  assert.deepEqual(Object.keys(d), SYNC_FIELDS);
  assert.equal(d.title.state, 'differs');
  assert.equal(d.name.state, 'equal');
  assert.equal(d.employee_code.state, 'equal');
});
test('googleFieldsOf reads the primary organization and the organization code (never phones)', () => {
  const g = googleFieldsOf(gUser());
  assert.equal('phone' in g, false);
  assert.equal(g.employee_code, 'EMP-901');
  assert.equal(g.manager, 'boss@legendoftoys.com');
  assert.equal(g.department, 'Ops');
  assert.ok(sameValue('name', g.name, splitForGoogle('Testa Middle Personne')));
});
test('nextLastPushed records what GOOGLE holds after the push, for the considered fields only', () => {
  const prev = { title: 'Old', org_unit: '/Team A' };
  const after = googleFieldsOf(gUser({ organizations: [{ primary: true, title: 'Analyst (as Google stored it)' }] }));
  const n = nextLastPushed(prev, want(emp({ employee_code: null })), ['title', 'employee_code', 'manager'], after);
  assert.deepEqual(n, { title: 'Analyst (as Google stored it)', org_unit: '/Team A', manager: 'boss@legendoftoys.com' }, 'blank code not recorded');
  assert.deepEqual(nextLastPushed(null, want(emp(), { hasManager: false }), ['manager'], googleFieldsOf(gUser({ relations: [] }))), { manager: null });
  assert.deepEqual(nextLastPushed(null, want(), [], after), {}, 'nothing considered → nothing recorded');
});

// ── backoff + lease ──────────────────────────────────────────────────────────
test('nextAttemptAt: 1 / 5 / 30 minutes, capped at 30', () => {
  const t0 = Date.parse('2026-11-12T00:00:00.000Z');
  const mins = (n) => (Date.parse(nextAttemptAt(n, t0)) - t0) / 60000;
  assert.deepEqual([1, 2, 3, 4, 10].map(mins), [1, 5, 30, 30, 30]);
  assert.equal(mins(0), 1, 'nonsense counts as the first failure');
});
test('canClaimSync mirrors the claim filter: pending/failed, due, outside the lease', () => {
  const now = Date.parse('2026-11-12T10:00:00.000Z');
  assert.equal(canClaimSync({ status: 'pending' }, now), true);
  assert.equal(canClaimSync({ status: 'failed', next_attempt_at: '2026-11-12T09:59:00.000Z' }, now), true);
  assert.equal(canClaimSync({ status: 'failed', next_attempt_at: '2026-11-12T10:05:00.000Z' }, now), false, 'backing off');
  assert.equal(canClaimSync({ status: 'pending', attempt_started_at: new Date(now - 30000).toISOString() }, now), false, 'inside the lease');
  assert.equal(canClaimSync({ status: 'pending', attempt_started_at: new Date(now - SYNC_LEASE_MS - 1).toISOString() }, now), true);
  for (const s of ['ok', 'skipped']) assert.equal(canClaimSync({ status: s }, now), false);
  const f = syncClaimFilter(now);
  assert.match(f, /^status=in\.\(pending,failed\)&and=\(or\(next_attempt_at\.is\.null,next_attempt_at\.lte\./);
  assert.ok(f.includes(encodeURIComponent(new Date(now - SYNC_LEASE_MS).toISOString())));
  assert.equal(DRAIN_CAP, 8);
});

// ── migration + worker wiring (source checks) ────────────────────────────────
test('0015: org_unit_path starts NULL (no seed from the stale baseline); the live backfill dirties nobody', () => {
  assert.match(SQL, /add column org_unit_path text/);
  assert.equal(/set org_unit_path = google_org_unit/.test(SQL), false, 'no seed UPDATE');
  assert.match(SQL, /set_config\('podium\.gsync_backfill', 'on', true\)/);
  assert.match(SQL, /if coalesce\(current_setting\('podium\.gsync_backfill', true\), ''\) = 'on' then return null; end if;/);
  assert.match(SQL, /e\.org_unit_path is null and e\.status <> 'exited'/);
});
test('0015: dirty_fields — the trigger maps columns to fields, the record removes done fields, ok only when empty', () => {
  for (const [col, f] of Object.entries(COLUMN_FIELD)) {
    assert.match(SQL, new RegExp(`old\\.${col} is distinct from new\\.${col} then v_f := array_append\\(v_f, '${f}'\\)`), col);
  }
  assert.match(SQL, /array\['manager'\], v_actor/, 'manager e-mail fan-out');
  assert.match(SQL, /array\['department'\], podium\.gsync_actor\(\)/, 'rename fan-out');
  assert.match(SQL, /status = case when v_same and cardinality\(v_left\) = 0 then 'ok' else 'pending' end/);
  // R4: sorted; per person the employees row is locked, then the state row WHERE the attempt is ours; baselines after
  const rec = SQL.slice(SQL.indexOf('function podium.google_sync_record'));
  assert.match(rec, /order by \(x->>'employee_id'\)::uuid loop/);
  const lockEmp = rec.indexOf('perform 1 from podium.employees where id = v_id for update');
  const lockState = rec.indexOf('from podium.google_sync_state where employee_id = v_id and attempt_id = v_attempt for update');
  assert.ok(lockEmp > 0 && lockEmp < lockState, 'employees row locked first');
  assert.ok(lockState < rec.indexOf('if not found then continue'), 'not ours → skip');
  assert.ok(rec.indexOf('if not found then continue') < rec.indexOf('update podium.employees e set'), 'baselines only after ownership');
  assert.match(SQL, /from \(select distinct x from unnest\(p_ids\) x where x is not null\) d order by x/, 'mark inserts sorted');
  assert.equal(/set_config\('podium\.gsync_backfill', 'on', false\)/.test(SQL), false, 'never session-wide');
});
test('0019: the live trigger no longer watches phone; the state CHECKs refuse it; bulk push paused by default', () => {
  const fn = SQL19.slice(SQL19.indexOf('create or replace function podium.employees_google_sync_dirty'), SQL19.indexOf('-- ── 2.'));
  assert.ok(fn.length > 500);
  assert.equal(/phone/.test(fn), false, 'no phone in the function or the trigger');
  for (const c of ['full_name', 'job_title', 'department_id', 'manager_id', 'employee_code', 'org_unit_path', 'work_email', 'status']) {
    assert.match(fn, new RegExp(`old\\.${c} is distinct from new\\.${c}`), c);
  }
  assert.match(SQL19, /dirty_fields <@ array\['name', 'title', 'department', 'manager', 'employee_code', 'org_unit'\]/);
  assert.match(SQL19, /google_bulk_push_paused boolean not null default true/);
  assert.match(SRC, /if \(await bulkPushPaused\(env\)\) return j1bErr\('bulk_push_paused', 423\)/);
  assert.ok(SRC.indexOf("bulkPushPaused(env)) return") > SRC.indexOf('if (d.dry_run) {'), 'preview stays allowed');
  assert.match(SRC, /google_bulk_push_paused === false\)/, 'only an explicit false unpauses');
});
test('0015: the trigger watches exactly the D6 columns, IS DISTINCT FROM', () => {
  for (const c of ['full_name', 'job_title', 'department_id', 'manager_id', 'phone', 'employee_code', 'org_unit_path', 'work_email', 'status']) {
    assert.match(SQL, new RegExp(`old\\.${c} is distinct from new\\.${c}`), c);
  }
  assert.match(SQL, /create trigger departments_google_sync after update of name on podium\.departments/);
  assert.match(SQL, /'sync_fields', 'sync_fields_failed'/);
  assert.match(SQL, /alter table podium\.google_sync_state enable row level security/);
});
test('index.js: ctx is threaded, the import refuses update/dismiss/baseline, the move tiers are gone', () => {
  assert.match(SRC, /async fetch\(request, env, ctx\)/);
  assert.match(SRC, /handler\(body, auth, env, ctx\)/);
  assert.match(SRC, /handler\(url, auth, env, ctx\)/);
  assert.match(SRC, /podium_owns_these_fields/);
  assert.equal(/tier: ouMoved/.test(SRC), false, 'the moved / differs tiers are gone from the preview');
});

// ── R1 / R2 / R5 / R6 through the worker's push path (mocked fetch; nothing real is called) ───────────────────────
const NOW_ISO = () => new Date().toISOString();
const ATT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ENVW = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const wEmp = (over = {}) => emp({ google_user_id: 'g-1', department: { name: 'Ops' }, manager_id: 'm-1', manager: { work_email: 'boss@legendoftoys.com' }, ...over });
const sctxW = (over = {}) => ({ ...ctx(), loadLiveOus: async () => {}, ...over });
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });

async function withFetch({ user = gUser(), fresh = { status: 'active', work_email: 'testa@legendoftoys.com', google_user_id: 'g-1' }, owner = true } = {}, fn) {
  const calls = { put: [], get: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => {
    const url = String(u);
    if (url.includes('/rest/v1/google_sync_state')) return json(owner ? [{ attempt_id: ATT, attempt_started_at: NOW_ISO() }] : [{ attempt_id: 'other', attempt_started_at: NOW_ISO() }]);
    if (url.includes('/rest/v1/employees?id=eq.')) return json(fresh ? [fresh] : []);
    if (url.startsWith('https://admin.googleapis.com/admin/directory/v1/users/')) {
      if ((o.method || 'GET') === 'PUT') { calls.put.push(JSON.parse(o.body)); return json({ ...user, ...JSON.parse(o.body) }); }
      calls.get++; return json(user);
    }
    throw new Error('unexpected fetch ' + url);
  };
  try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
}

test('R1: the final body must hash to the preview — a mismatch never PUTs', async () => {
  const e = wEmp({ job_title: 'Lead' });
  const { out, calls } = await withFetch({}, () => pushOneToGoogle(ENVW, 't', e, sctxW(), { fields: ['title'], attemptId: ATT, expectHash: 'f'.repeat(64) }));
  assert.equal(out.outcome, 'stale_preview');
  assert.equal(calls.put.length, 0);
  // control: the right hash PUTs exactly the previewed body
  const want = mergeGoogleUser(gUser(), desiredGoogleFields(e, { departmentName: 'Ops', managerEmail: 'boss@legendoftoys.com', hasManager: true }), { fields: ['title'] });
  const ok2 = await withFetch({}, () => pushOneToGoogle(ENVW, 't', e, sctxW(), { fields: ['title'], attemptId: ATT, expectHash: null }));
  assert.equal(ok2.out.outcome, 'ok');
  assert.deepEqual(ok2.calls.put, [want]);
  const h = await previewHash(want);
  const ok3 = await withFetch({}, () => pushOneToGoogle(ENVW, 't', e, sctxW(), { fields: ['title'], attemptId: ATT, expectHash: h }));
  assert.equal(ok3.out.outcome, 'ok');
  assert.equal(ok3.calls.put.length, 1);
});

test('R2: identity changed between load and PUT (work email / status / Google id) → no PUT', async () => {
  const e = wEmp({ job_title: 'Lead' });
  for (const fresh of [{ status: 'active', work_email: 'moved@legendoftoys.com', google_user_id: 'g-1' },
    { status: 'exited', work_email: 'testa@legendoftoys.com', google_user_id: 'g-1' },
    { status: 'active', work_email: 'testa@legendoftoys.com', google_user_id: 'g-2' }]) {
    const { out, calls } = await withFetch({ fresh }, () => pushOneToGoogle(ENVW, 't', e, sctxW(), { fields: ['title'], attemptId: ATT }));
    assert.equal(out.outcome, 'failed', JSON.stringify(fresh));
    assert.equal(out.error, 'identity_changed');
    assert.equal(calls.put.length, 0);
  }
  const lost = await withFetch({ owner: false }, () => pushOneToGoogle(ENVW, 't', e, sctxW(), { fields: ['title'], attemptId: ATT }));
  assert.equal(lost.out.outcome, 'lost_claim');
  assert.equal(lost.calls.get, 0, 'a lost claim stops before the GET too');
});

test('R6: bad target OU + title → the title is pushed, the OU is not; phones are never sent', async () => {
  const e = wEmp({ job_title: 'Lead', phone: '+91 90000 00009', org_unit_path: '/Nowhere' });
  const { out, calls } = await withFetch({}, () => pushOneToGoogle(ENVW, 't', e, sctxW(), { fields: ['title', 'org_unit'], attemptId: ATT }));
  assert.equal(out.outcome, 'ok');
  assert.deepEqual(out.fieldSkips, { org_unit: 'target_ou_unknown' });
  assert.equal(calls.put.length, 1);
  assert.ok(calls.put[0].organizations && !('orgUnitPath' in calls.put[0]) && !('phones' in calls.put[0]));
});

test('R5: a response whose BODY stalls is aborted by the same deadline', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => ({ ok: true, status: 200,
    text: () => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  try {
    const t0 = Date.now();
    await assert.rejects(googleFetch('https://admin.googleapis.com/x', {}, 40), (x) => x.name === 'AbortError');
    assert.ok(Date.now() - t0 < 1000);
  } finally { globalThis.fetch = real; }
  // …and the push path turns it into a retryable failure, never a throw
  const block = SRC.slice(SRC.indexOf('// J1b — PODIUM → GOOGLE FIELD SYNC'), SRC.indexOf('// ── end J1b'));
  assert.equal(/\br\.json\(\)/.test(block), false, 'J1b callers never read the body themselves');
  assert.match(block, /x\?\.name === 'AbortError' \? 'google_timeout'/);
});

test('R1: an admin push is one-shot — never queued, nothing added to dirty_fields, released on anything but ok', () => {
  const push = SRC.slice(SRC.indexOf('async function adminPushGoogle'), SRC.indexOf('// GET getGoogleDiff'));
  assert.equal(/google_sync_queue/.test(push), false);
  assert.match(push, /google_sync_claim/);
  assert.match(push, /\{ oneShot: true \}/);
  assert.match(push, /preview_required/);
  assert.match(SQL, /raise exception 'podium_fields_not_queueable'/);
  assert.match(SQL, /claimed_hash = null/);
});

test('bulk-push pause (0019): anything but an explicit false refuses a real push with 423; preview is never refused', async () => {
  const ENVP = { ...ENVW, GOOGLE_SA_JSON: '{}', GOOGLE_ADMIN_SA_JSON: '{}', GOOGLE_ADMIN_IMPERSONATE_EMAIL: 'admin@legendoftoys.com' };
  const AUTHP = { userId: AUTH_ID };
  const body = { data: { employee_ids: [EMP_ID], dry_run: false, preview_hashes: { [EMP_ID]: 'a'.repeat(64) } } };
  const run = async (settings, b = body) => {
    const seen = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => {
      const url = String(u); seen.push(url);
      if (url.includes('/rest/v1/google_admin_access')) return json([{ auth_user_id: AUTH_ID }]);
      if (url.includes('/rest/v1/employees?auth_user_id=')) return json([{ id: EMP_ID }]);
      if (url.includes('/rest/v1/settings')) return typeof settings === 'function' ? settings() : json(settings.body, settings.status || 200);
      return json({ message: 'stop here' }, 500);
    };
    try { const r = await pushGoogleFields(b, AUTHP, ENVP, null); return { status: r.status, body: await r.json(), seen }; }
    finally { globalThis.fetch = real; }
  };
  for (const s of [{ body: [{ google_bulk_push_paused: true }] }, { body: [] }, { body: [{ google_bulk_push_paused: null }] },
    { body: [{ google_bulk_push_paused: 'false' }] }, { body: { code: '42703' }, status: 400 }]) {
    const r = await run(s);
    assert.equal(r.status, 423, JSON.stringify(s));
    assert.equal(r.body.error, 'bulk_push_paused');
    assert.equal(r.seen.some(u => /google_sync_claim|googleapis/.test(u)), false, 'nothing claimed or sent');
  }
  const thrown = await run(() => { throw new Error('network'); }).catch(e => ({ thrown: e }));
  assert.ok(thrown.thrown || thrown.status === 423, 'a thrown read never pushes');
  const open = await run({ body: [{ google_bulk_push_paused: false }] });
  assert.notEqual(open.status, 423, 'exactly false → the push goes on');
  assert.ok(open.seen.length > 3, 'went past the pause');
  const pv = await run({ body: [{ google_bulk_push_paused: true }] }, { data: { employee_ids: [EMP_ID], dry_run: true } });
  assert.notEqual(pv.status, 423, 'preview is not paused');
  assert.equal(pv.seen.some(u => u.includes('google_bulk_push_paused')), false, 'preview never reads the pause');
  assert.equal(typeof bulkPushPaused, 'function');
});
