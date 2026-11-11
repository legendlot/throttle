// Hiring J1 — the pure work-account rules in src/workaccount.js (plan 2026-11-11-podium-j1-work-accounts.md).
// Synthetic names and figures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WORK_DOMAIN, toEmail, splitName, asciiLocal, proposeLocalParts, checkLocalPart,
  tempPassword, PW_ALPHABET, PW_UPPER, PW_LOWER, PW_DIGIT, PW_SYMBOL, PW_LENGTH,
  isOurPendingAccount, workAccountExternalIds, WA_EXTERNAL_ID_TYPE, candidateDocToEmployeeDocType, employeeDocPath, defaultOu,
  joiningOffer, JOINING_BLOCKING_STATUSES, openingAfterJoin, checkStartDate, SUSPENDABLE_APP_STATUSES, workAccountDbErrorCode,
  ATTEMPT_LEASE_MS, attemptClaimFilter, attemptGuard, canClaimAttempt, attemptGuardMatches, NOT_COPIED_ON_JOINING,
} from '../src/workaccount.js';
import { CANDIDATE_DOC_TYPES } from '../src/hiring.js';

const SQL = readFileSync(new URL('../migrations/0009_work_accounts.sql', import.meta.url), 'utf8');
const SRC = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const EID = '11111111-2222-4333-8444-555555555555';
const DID = '99999999-8888-4777-8666-555555555555';

// ── Names → addresses ────────────────────────────────────────────────────────
test('splitName: first / last token, honorifics stripped, spaces collapsed', () => {
  assert.deepEqual(splitName('  Testa   Middle  Personne '), { given: 'Testa', family: 'Personne' });
  assert.deepEqual(splitName('Dr. Testa Personne'), { given: 'Testa', family: 'Personne' });
  assert.deepEqual(splitName('mrs testa personne'), { given: 'testa', family: 'personne' });
  assert.deepEqual(splitName('Ms Testa'), { given: 'Testa', family: 'Testa' }, 'one token → family = given');
  assert.deepEqual(splitName('Mononym'), { given: 'Mononym', family: 'Mononym' });
  assert.deepEqual(splitName(''), { given: '', family: '' });
  assert.deepEqual(splitName(null), { given: '', family: '' });
  assert.deepEqual(splitName('Mr'), { given: '', family: '' }, 'only an honorific → nothing');
});

test('asciiLocal: diacritics folded, everything but [a-z0-9] dropped', () => {
  assert.equal(asciiLocal('Zoë'), 'zoe');
  assert.equal(asciiLocal('Ánña-Maríe'), 'annamarie');
  assert.equal(asciiLocal("O'Testa 2"), 'otesta2');
  assert.equal(asciiLocal('Ça'), 'ca');
  assert.equal(asciiLocal('名前'), '');
  assert.equal(asciiLocal(undefined), '');
});

test('proposeLocalParts: L1 — first name, then first.lastinitial; deduped, empties dropped', () => {
  assert.deepEqual(proposeLocalParts('Testa', 'Personne'), ['testa', 'testa.p']);
  assert.deepEqual(proposeLocalParts('Zoë', 'Ölund'), ['zoe', 'zoe.o']);
  assert.deepEqual(proposeLocalParts('Mononym', 'Mononym'), ['mononym', 'mononym.m'], 'one-token name');
  assert.deepEqual(proposeLocalParts('Testa', ''), ['testa']);
  assert.deepEqual(proposeLocalParts('', 'Personne'), []);
  assert.deepEqual(proposeLocalParts('名前', 'Personne'), []);
});

test('a taken first proposal leaves the second as the pick', () => {
  const [first, second] = proposeLocalParts('Testa', 'Personne');
  const taken = new Set([toEmail(first)]);
  const pick = [first, second].map(toEmail).find(e => !taken.has(e));
  assert.equal(pick, `testa.p@${WORK_DOMAIN}`);
});

test('checkLocalPart: 1–64 of [a-z0-9.], no leading / trailing / double dot', () => {
  for (const ok of ['testa', 'testa.p', 'a', 't3sta.p2', 'a'.repeat(64)]) assert.equal(checkLocalPart(ok), null, ok);
  assert.equal(checkLocalPart(''), 'local_required');
  assert.equal(checkLocalPart(null), 'local_required');
  assert.equal(checkLocalPart('a'.repeat(65)), 'local_too_long');
  for (const bad of ['Testa', 'te sta', 'testa_p', 'testa+x', 'testa@x', 'tésta']) assert.equal(checkLocalPart(bad), 'local_bad_chars', bad);
  for (const bad of ['.testa', 'testa.', 'te..sta']) assert.equal(checkLocalPart(bad), 'local_bad_dots', bad);
});

test('toEmail lowercases onto the work domain', () => {
  assert.equal(toEmail('Testa.P'), 'testa.p@legendoftoys.com');
});

// ── Temp password ────────────────────────────────────────────────────────────
const rng = (n) => crypto.getRandomValues(new Uint8Array(n));
const AMBIGUOUS = ['0', 'O', '1', 'l', 'I'];

test('tempPassword: 16 chars, every class present, no look-alikes — over 1,000 draws', () => {
  const counts = new Map();
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const p = tempPassword(rng);
    assert.equal(p.length, PW_LENGTH);
    for (const set of [PW_UPPER, PW_LOWER, PW_DIGIT, PW_SYMBOL]) assert.ok([...p].some(c => set.includes(c)), `class missing in a draw`);
    for (const c of p) {
      assert.ok(PW_ALPHABET.includes(c), 'only alphabet chars');
      assert.ok(!AMBIGUOUS.includes(c), 'no look-alikes');
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    seen.add(p);
  }
  assert.equal(seen.size, 1000, 'no repeats');
  // Every symbol of the alphabet shows up, and none dominates: 16,000 chars over 67 symbols ≈ 239 each.
  assert.equal(counts.size, PW_ALPHABET.length, 'every alphabet char is drawn');
  const expected = (1000 * PW_LENGTH) / PW_ALPHABET.length;
  for (const [c, n] of counts) assert.ok(n > expected * 0.5 && n < expected * 1.8, `${c} drawn ${n}× (expected ≈${Math.round(expected)})`);
});

test('tempPassword: deterministic for a fixed byte source; biased bytes are rejected, not wrapped', () => {
  let k = 0;
  const seq = (n) => Uint8Array.from({ length: n }, () => (k++ * 37 + 11) % 256);
  const a = tempPassword(seq);
  k = 0;
  assert.equal(tempPassword(seq), a);
  const limit = 256 - (256 % PW_ALPHABET.length);
  // Only bytes ≥ limit → never accepted; then a usable stream.
  let calls = 0;
  const highThenNormal = (n) => (calls++ === 0 ? new Uint8Array(n).fill(limit) : rng(n));
  assert.equal(tempPassword(highThenNormal).length, PW_LENGTH);
  assert.throws(() => tempPassword((n) => new Uint8Array(n)), /temp_password_failed/, 'a stuck source never yields a weak password');
});

// ── Retry linking ────────────────────────────────────────────────────────────
const WA = '33333333-4444-4555-8666-777777777777';
test('isOurPendingAccount (A): adopt ONLY a Google user stamped with this row\'s id — timing is irrelevant', () => {
  const row = { id: WA, status: 'pending', email: 'testa.p@legendoftoys.com', created_at: '2026-11-11T10:00:00.000Z' };
  const g = (ext, extra = {}) => ({ primaryEmail: 'Testa.P@legendoftoys.com', externalIds: ext, ...extra });
  assert.deepEqual(workAccountExternalIds(WA), [{ type: 'custom', customType: WA_EXTERNAL_ID_TYPE, value: WA }]);
  assert.equal(isOurPendingAccount(row, g(workAccountExternalIds(WA))), true, 'our own earlier insert');
  assert.equal(isOurPendingAccount({ ...row, status: 'failed' }, g(workAccountExternalIds(WA))), true);
  // A stranger created AFTER our failed attempt (inside any time window) is still refused.
  assert.equal(isOurPendingAccount({ ...row, status: 'failed' }, g(undefined, { creationTime: '2026-11-11T10:00:30.000Z' })), false, 'stranger after our failure');
  assert.equal(isOurPendingAccount(row, g([])), false, 'no externalIds');
  assert.equal(isOurPendingAccount(row, g(workAccountExternalIds('99999999-8888-4777-8666-555555555555'))), false, 'another row\'s stamp');
  assert.equal(isOurPendingAccount(row, g([{ type: 'organization', value: WA }])), false, 'wrong type');
  assert.equal(isOurPendingAccount(row, g([{ type: 'custom', customType: 'other', value: WA }])), false, 'wrong customType');
  assert.equal(isOurPendingAccount({ ...row, status: 'created' }, g(workAccountExternalIds(WA))), false);
  assert.equal(isOurPendingAccount(row, { ...g(workAccountExternalIds(WA)), primaryEmail: 'other@legendoftoys.com' }), false);
  assert.equal(isOurPendingAccount(null, g(workAccountExternalIds(WA))), false);
});

test('attempt claim (B): two claims race, exactly one wins; the loser\'s failure cannot downgrade', () => {
  const now = Date.parse('2026-11-11T10:00:00.000Z');
  // Simulate the DB: a claim is a conditional update (canClaimAttempt) that sets a fresh attempt_id.
  let row = { id: WA, status: 'failed', attempt_id: null, attempt_started_at: null };
  const claim = (id, t) => { if (!canClaimAttempt(row, t)) return false; row = { ...row, status: 'pending', attempt_id: id, attempt_started_at: new Date(t).toISOString() }; return true; };
  const guarded = (id, patch) => { if (!attemptGuardMatches(row, id)) return 0; row = { ...row, ...patch }; return 1; };
  assert.equal(claim('A', now), true, 'first claim wins');
  assert.equal(claim('B', now + 1000), false, 'second claim inside the lease → in_progress');
  assert.equal(guarded('A', { status: 'created' }), 1, 'winner records created');
  assert.equal(guarded('B', { status: 'failed' }), 0, 'loser cannot write');
  assert.equal(row.status, 'created');
  assert.equal(claim('C', now + 10 * ATTEMPT_LEASE_MS), false, 'a created row is never re-claimed');
  // A stale attempt (past the lease) can be taken over; the stale one's late write then matches nothing.
  row = { id: WA, status: 'pending', attempt_id: 'A', attempt_started_at: new Date(now).toISOString() };
  assert.equal(claim('B', now + ATTEMPT_LEASE_MS - 1), false, 'inside the lease');
  assert.equal(claim('B', now + ATTEMPT_LEASE_MS + 1), true, 'after the lease');
  assert.equal(guarded('A', { status: 'failed' }), 0, 'the timed-out attempt cannot fail the new one');
  assert.equal(guarded('B', { status: 'created' }), 1);
  assert.equal(guarded('B', { status: 'failed' }), 0, 'nothing downgrades created, even its own attempt');
  // The PostgREST filters say the same thing.
  assert.equal(attemptGuard('A'), 'attempt_id=eq.A&status=eq.pending');
  const f = attemptClaimFilter(now);
  assert.match(f, /^status=in\.\(pending,failed\)&or=\(attempt_started_at\.is\.null,attempt_started_at\.lt\./);
  assert.ok(decodeURIComponent(f).includes(new Date(now - ATTEMPT_LEASE_MS).toISOString()));
});

test('worker uses the claim + guard on every create-attempt write (B) and stamps externalIds (A)', () => {
  const body = SRC.slice(SRC.indexOf('async function createWorkAccount'), SRC.indexOf('async function resetWorkAccountPassword'));
  assert.match(body, /attemptClaimFilter\(\)/);
  assert.match(body, /externalIds: workAccountExternalIds\(row\.id\)/);
  assert.ok(!/waPatch\(/.test(SRC), 'no unguarded work_accounts patch helper remains');
  // Every PATCH of work_accounts inside the create flow is either the claim or goes through mine() (guarded).
  const patches = body.match(/work_accounts\?id=eq\.[^`]*`/g) || [];
  for (const p of patches) assert.match(p, /attemptClaimFilter/, p);
  assert.ok(!/creationTime/.test(SRC), 'no timing heuristic left');
});

// ── Joining ──────────────────────────────────────────────────────────────────
test('candidateDocToEmployeeDocType: the plan map; PAN is an ID (restricted), the rest → other', () => {
  assert.equal(candidateDocToEmployeeDocType('cv'), 'resume');
  assert.equal(candidateDocToEmployeeDocType('signed_offer'), 'offer_letter');
  assert.equal(candidateDocToEmployeeDocType('id_proof'), 'id_proof');
  assert.equal(candidateDocToEmployeeDocType('pan'), 'id_proof');
  assert.equal(candidateDocToEmployeeDocType('address_proof'), 'address_proof');
  assert.equal(candidateDocToEmployeeDocType('education'), 'education_cert');
  assert.equal(candidateDocToEmployeeDocType('bank'), 'bank_details');
  for (const t of ['payslip', 'experience_letter', 'relieving_letter', 'photo', 'other', 'nope'])
    assert.equal(candidateDocToEmployeeDocType(t), 'other', t);
  for (const t of ['payslip', 'relieving_letter', 'experience_letter']) assert.ok(NOT_COPIED_ON_JOINING.has(t), `${t} stays on the candidate`);
  // Every result is a podium.documents doc_type the CHECK accepts.
  const EMP_TYPES = ['resume', 'offer_letter', 'employment_agreement', 'nda', 'education_cert', 'id_proof', 'bank_details',
    'address_proof', 'appraisal_letter', 'increment_letter', 'other'];
  for (const t of CANDIDATE_DOC_TYPES) assert.ok(EMP_TYPES.includes(candidateDocToEmployeeDocType(t)), t);
});

test('employeeDocPath: under the employee, safe name', () => {
  assert.equal(employeeDocPath(EID, DID, 'my cv (final).pdf'), `${EID}/hiring/${DID}_my_cv_final_.pdf`);
  const p = employeeDocPath(EID, DID, '../../etc/passwd');
  assert.ok(p.startsWith(`${EID}/hiring/`) && !p.includes('..'), p);
});

test('defaultOu: the department\'s most common OU among active employees, else root', () => {
  const emps = [
    { department_id: 'd1', status: 'active', google_org_unit: '/Ops' },
    { department_id: 'd1', status: 'active', google_org_unit: '/Ops/Floor' },
    { department_id: 'd1', status: 'active', google_org_unit: '/Ops/Floor' },
    { department_id: 'd1', status: 'exited', google_org_unit: '/Ops' },
    { department_id: 'd1', status: 'exited', google_org_unit: '/Ops' },
    { department_id: 'd2', status: 'active', google_org_unit: '/Brand' },
    { department_id: 'd1', status: 'active', google_org_unit: null },
  ];
  assert.equal(defaultOu('d1', emps), '/Ops/Floor');
  assert.equal(defaultOu('d2', emps), '/Brand');
  assert.equal(defaultOu('d3', emps), '/');
  assert.equal(defaultOu(null, emps), '/');
  assert.equal(defaultOu('d1', [{ department_id: 'd1', status: 'active', google_org_unit: '/B' }, { department_id: 'd1', status: 'active', google_org_unit: '/A' }]), '/A', 'ties → stable');
});

test('joiningOffer (H): only a newer LIVE revision (in flight or accepted) blocks; newer history does not', () => {
  const acc = { id: 'o1', revision: 1, status: 'accepted', sent_at: 't' };
  assert.equal(joiningOffer([acc]).offer, acc);
  assert.equal(joiningOffer([]).error, 'offer_not_accepted');
  assert.equal(joiningOffer([{ ...acc, status: 'sent' }]).error, 'offer_not_accepted');
  for (const st of ['draft', 'pending_approval', 'approved', 'approval_rejected', 'ready', 'sent'])
    assert.equal(joiningOffer([acc, { id: 'o2', revision: 2, status: st, sent_at: st === 'sent' ? 't' : null }]).error, 'offer_not_latest', st);
  for (const st of ['declined', 'expired', 'withdrawn', 'superseded'])
    assert.equal(joiningOffer([acc, { id: 'o2', revision: 2, status: st, sent_at: 't' }]).offer.id, 'o1', `newer ${st} does not block`);
  assert.equal(joiningOffer([{ ...acc, revision: 2 }, { id: 'o0', revision: 1, status: 'superseded', sent_at: 't' }]).offer.id, 'o1', 'older history is fine');
  assert.deepEqual(JOINING_BLOCKING_STATUSES, ['draft', 'pending_approval', 'approved', 'approval_rejected', 'ready', 'sent', 'accepted']);
  // The SQL mirror lists the same statuses.
  const m = SQL.match(/x\.status in \(([^)]*)\)\) then\s+raise exception 'podium_offer_not_latest'/);
  assert.ok(m, 'SQL newer-revision check found');
  assert.deepEqual(m[1].split(',').map(x => x.trim().replace(/'/g, '')), JOINING_BLOCKING_STATUSES);
  assert.ok(!/sent_at is not null/.test(SQL), 'a newer revision that was merely sent once (now history) no longer blocks');
});

test('openingAfterJoin (G): fill only at headcount with nobody else active; else needs resolution', () => {
  assert.equal(openingAfterJoin(1, 1, 0), 'filled');
  assert.equal(openingAfterJoin(1, 1, 2), 'needs_resolution');
  assert.equal(openingAfterJoin(1, 2, 0), 'open');
  assert.equal(openingAfterJoin(3, 2, 0), 'filled');
});

test('0009 RPC (E, F, G): offer pinned under the lock, email + opening guards, fill rule', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function podium.hiring_confirm_joining'));
  const at = (re) => { const i = fn.search(re); assert.ok(i >= 0, String(re)); return i; };
  const lock = at(/from podium\.applications where id = \(p->>'application_id'\)::uuid for update/);
  // E: the worker's offer_id + terms_hash must still be the joining offer, checked after the lock, before writes.
  const changed = at(/raise exception 'podium_offer_changed'/);
  assert.match(fn, /v_off\.id is distinct from nullif\(p->>'offer_id', ''\)::uuid/);
  assert.match(fn, /v_off\.terms_hash is distinct from nullif\(p->>'terms_hash', ''\)/);
  const insert = at(/insert into podium\.employees/);
  assert.ok(lock < changed && changed < insert);
  // F: no employee may already hold the address.
  const taken = at(/raise exception 'podium_email_taken'/);
  assert.match(fn, /lower\(e\.work_email\) = lower\(v_wa\.email\)/);
  assert.ok(taken < insert);
  // G: cancelled / full refused under the opening lock, before the insert.
  const opLock = at(/from podium\.openings where id = v_app\.opening_id for update/);
  const closed = at(/raise exception 'podium_opening_closed'/);
  const full = at(/raise exception 'podium_headcount_full'/);
  assert.ok(opLock < closed && closed < full && full < insert);
  assert.match(fn, /v_joined >= v_op\.headcount and v_active > 0 then\s+v_resolve := true/);
  assert.match(fn, /'opening_needs_resolution', v_resolve/);
  assert.match(fn, /status in \('new', 'screening', 'interviewing', 'offer', 'accepted', 'on_hold'\)/);
  assert.match(SQL, /'reset_password'\)\)/, 'log CHECK widened (C)');
  assert.match(SQL, /attempt_id uuid,\s+attempt_started_at timestamptz/, 'attempt columns (B)');
});

test('worker (F, I, K, L, M, D): the review gates are in the code paths they guard', () => {
  const fnBody = (name) => {
    let i = SRC.indexOf(`async function ${name}(`); if (i < 0) i = SRC.indexOf(`\nfunction ${name}(`);
    assert.ok(i >= 0, name); return SRC.slice(i, SRC.indexOf('\n}\n', i));
  };
  // F: hand-made employees cannot take an awaiting-joining address.
  assert.match(fnBody('createEmployee'), /workEmailAwaitingJoining\(env, body\.work_email\)/);
  assert.match(fnBody('updateEmployee'), /workEmailAwaitingJoining\(env, patch\.work_email\)/);
  assert.match(fnBody('workEmailAwaitingJoining'), /db_error/, 'fails closed');
  // I: the sync fails closed when the work_accounts lookup fails.
  assert.match(fnBody('podiumMadeAccounts'), /return null/);
  assert.match(fnBody('getDirectorySyncPreview'), /if \(!podiumMade\) return err\('db_error/);
  assert.match(fnBody('importDirectoryCandidates'), /if \(!podiumMade\) return err\('db_error/);
  // K: HR or podium_hiring only.
  assert.match(SRC, /const canConfirmJoining = \(roles\) => !!\(roles\?\.hr \|\| roles\?\.hiring\);/);
  assert.match(fnBody('setApplicationStatus'), /if \(d\.status === 'no_show'\) return markNoShow\(/);
  assert.match(fnBody('markNoShow'), /canConfirmJoining\(x\.roles\)/);
  // Every J1 handler is routed (the harness caught an unregistered one once), and none is self-serve.
  const posts = SRC.slice(SRC.indexOf('const POST_ACTIONS = {'), SRC.indexOf('};', SRC.indexOf('const POST_ACTIONS = {')));
  for (const h of ['createWorkAccount', 'resetWorkAccountPassword', 'confirmJoining', 'markNoShow', 'suspendWorkAccount']) assert.ok(posts.includes(h), `${h} routed`);
  const gets = SRC.slice(SRC.indexOf('const GET_ACTIONS = {'), SRC.indexOf('};', SRC.indexOf('const GET_ACTIONS = {')));
  for (const h of ['getWorkAccount', 'checkWorkEmail']) assert.ok(gets.includes(h), `${h} routed`);
  const selfServe = SRC.slice(SRC.indexOf('const SELF_SERVE_GET'), SRC.indexOf('async function handleGet'));
  for (const h of ['WorkAccount', 'confirmJoining', 'markNoShow', 'checkWorkEmail']) assert.ok(!selfServe.includes(h), `${h} not self-serve`);
  // L: already suspended → no Google call.
  const sus = fnBody('suspendWorkAccount');
  assert.ok(sus.indexOf("wa.status === 'suspended'") < sus.indexOf('googleWriteToken'));
  // M: active employee required.
  assert.match(fnBody('isGoogleAdmin'), /status=eq\.active/);
  // E: the worker passes the revision it built from.
  assert.match(fnBody('confirmJoining'), /offer_id: off\.id, terms_hash: off\.terms_hash/);
  // D: salary letters = allow-list or self, before the HR shortcut; address_proof restricted.
  const da = fnBody('docAllowed');
  assert.ok(da.indexOf('SALARY_DOC_TYPES.has(docType)') < da.indexOf('isHr(auth)'));
  assert.match(da, /return isSelf \|\| canComp\(auth\)/);
  assert.match(fnBody('getDocuments'), /logCompAccess\(auth, 'getDocuments'/);
  assert.match(fnBody('getDocumentDownloadUrl'), /logCompAccess\(auth, 'getDocumentDownloadUrl'/);
});

test('checkStartDate: real date, not before acceptance, at most 7 days ahead (IST today)', () => {
  assert.equal(checkStartDate('2026-11-11', '2026-11-11', '2026-11-01'), null);
  assert.equal(checkStartDate('2026-11-18', '2026-11-11', null), null, 'exactly +7');
  assert.equal(checkStartDate('2026-11-19', '2026-11-11', null), 'start_date_too_far');
  assert.equal(checkStartDate('2026-10-31', '2026-11-11', '2026-11-01'), 'start_date_before_acceptance');
  assert.equal(checkStartDate('2026-11-01', '2026-11-11', '2026-11-01'), null, 'same day as acceptance');
  assert.equal(checkStartDate('2026-02-30', '2026-11-11', null), 'bad_start_date');
  assert.equal(checkStartDate('11/11/2026', '2026-11-11', null), 'bad_start_date');
  assert.equal(checkStartDate(undefined, '2026-11-11', null), 'bad_start_date');
});

test('suspension is only for people who never joined', () => {
  assert.deepEqual(SUSPENDABLE_APP_STATUSES, ['no_show', 'withdrawn']);
});

test('workAccountDbErrorCode: RPC raises and unique indexes map to codes, never a row', () => {
  assert.deepEqual(workAccountDbErrorCode({ message: 'podium_rehire_not_supported_yet' }), { code: 'rehire_not_supported_yet', status: 409 });
  assert.deepEqual(workAccountDbErrorCode({ message: 'podium_no_work_account' }), { code: 'no_work_account', status: 409 });
  const dup = (c) => ({ code: '23505', message: `duplicate key value violates unique constraint "${c}"`, details: 'Key (x)=(secret)' });
  assert.equal(workAccountDbErrorCode(dup('work_accounts_email_live')).code, 'email_taken');
  assert.equal(workAccountDbErrorCode(dup('work_accounts_application_id_key')).code, 'account_exists');
  assert.equal(workAccountDbErrorCode(dup('something_else')).code, 'conflict');
  assert.equal(workAccountDbErrorCode({ code: '23514', message: 'x' }).code, 'check_failed');
  assert.equal(workAccountDbErrorCode({ message: 'podium_Bad' }), null);
  assert.equal(workAccountDbErrorCode(null), null);
  for (const v of Object.values(workAccountDbErrorCode(dup('work_accounts_email_live')))) assert.ok(!String(v).includes('secret'));
});

// ── Migration + worker invariants (text checks) ──────────────────────────────
test('0009: service_role only, RLS on, append-only log, the allow-list seed', () => {
  assert.match(SQL, /revoke all on function podium\.hiring_confirm_joining\(jsonb\) from public, anon, authenticated/);
  assert.match(SQL, /grant execute on function podium\.hiring_confirm_joining\(jsonb\) to service_role/);
  assert.match(SQL, /security definer set search_path to 'podium', 'public'/);
  for (const t of ['google_admin_access', 'work_accounts', 'google_admin_log']) assert.ok(SQL.includes(`'${t}'`), t);
  assert.match(SQL, /enable row level security/);
  assert.match(SQL, /before update or delete on podium\.google_admin_log/);
  assert.match(SQL, /where status <> 'failed'/);
  assert.match(SQL, /rehire_not_supported_yet/);
  assert.match(SQL, /next_employee_seq\(\)/);
  assert.match(SQL, /case when v_vault then v_off\.total_ctc end/, 'vault off → no figure stored');
  // No column anywhere that could hold a password.
  // ('reset_password' is the log ACTION name, not a value.)
  assert.ok(!/password/i.test(SQL.replace(/--[^\n]*/g, '').replace(/'reset_password'/g, '')), 'no password column or value in the schema');
});

test('worker: the temp password never reaches a log, a row or the console', () => {
  // createWorkAccount + resetWorkAccountPassword — the only two places a temp password is minted.
  const body = SRC.slice(SRC.indexOf('async function createWorkAccount'), SRC.indexOf('// ── end J1 create'));
  assert.ok(body.length > 500 && body.includes('async function resetWorkAccountPassword'), 'both handlers found');
  assert.ok(!/console\./.test(body), 'no console in either');
  // The password goes to Google and to the response, nowhere else: every `password` mention is one of those.
  const lines = body.split('\n').filter(l => /password/i.test(l) && !/^\s*\/\//.test(l));
  for (const l of lines) assert.ok(/temp_password: pw|tempPassword\(|password: pw|changePasswordAtNextLogin|async function resetWorkAccountPassword|action: 'reset_password'/.test(l), `unexpected password use: ${l.trim()}`);
  assert.ok(!/googleAdminLog\([^)]*\bpw\b/.test(body), 'pw never passed to the log');
  assert.ok(!/(?:mine|waAttemptPatch)\([^)]*\bpw\b/.test(body), 'pw never written to the row');
  assert.ok(!/work_accounts`[^\n]*\bpw\b/.test(body), 'pw never in a work_accounts write');
});

test('joining: salary-bearing hiring docs never land as manager-visible types', async () => {
  const m = await import('../src/workaccount.js');
  assert.equal(m.candidateDocToEmployeeDocType('signed_offer'), 'offer_letter');
  assert.equal(m.candidateDocToEmployeeDocType('offer_evidence'), 'offer_letter');
  assert.ok(m.NOT_COPIED_ON_JOINING.has('payslip'));
  const src = (await import('node:fs')).readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const line = src.split('\n').find(l => l.startsWith('const RESTRICTED_DOC_TYPES'));
  for (const t of ['bank_details', 'id_proof', 'offer_letter', 'increment_letter', 'appraisal_letter']) assert.ok(line.includes(`'${t}'`), t);
});
