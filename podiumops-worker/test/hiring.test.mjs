// Hiring C1/C2 — the pure rules in src/hiring.js (plan 2026-11-11-podium-hiring-c1-c2.md §A).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_TRANSITIONS, checkTransition, ACTIVE_APP_STATUSES, TERMINAL_APP_STATUSES,
  resolveApprover, checkBandDecider, openingRoles,
  canSeeOpening, canEditOpening, canManageApps, canSeeSalary, canChangeChain,
  canSeeCandidateDoc, docTier, CANDIDATE_DOC_TYPES, jdGate, fileOk, retainUntil,
  normPhoneKey, normEmailKey, openingCode, candidateCode, parseBand,
  canSeeDocRow, OUTCOME_REASON_CODES, isSafeReason, redactReason, redactEvent, candidateEventsFor, checkFileSize,
  safeFileName, candidateDocPath, jdPath, checkCandidateDocPath, checkJdPath, cleanSearch,
} from '../src/hiring.js';

// ── Transitions ──────────────────────────────────────────────────────────────
test('APP_TRANSITIONS: the manual moves, exactly (C3 adds the offer / accepted closes; J1 adds accepted → no_show)', () => {
  assert.deepEqual(APP_TRANSITIONS, {
    new:          ['screening', 'rejected', 'withdrawn', 'on_hold'],
    screening:    ['interviewing', 'rejected', 'withdrawn', 'on_hold'],
    interviewing: ['rejected', 'withdrawn', 'on_hold'],
    on_hold:      ['new', 'screening', 'interviewing', 'rejected', 'withdrawn'],
    offer:        ['declined', 'withdrawn', 'rejected'],
    accepted:     ['withdrawn', 'no_show'],
  });
});

test('offer / accepted / joined are never set by hand; no_show only from accepted; declined only closes an offer', () => {
  for (const from of Object.keys(APP_TRANSITIONS)) {
    for (const to of ['offer', 'accepted', 'joined']) {
      assert.equal(checkTransition(from, to, 'x'), 'invalid_transition', `${from}→${to}`);
    }
    if (from !== 'accepted') assert.equal(checkTransition(from, 'no_show', ''), 'invalid_transition', `${from}→no_show`);
    if (from !== 'offer') assert.equal(checkTransition(from, 'declined', 'compensation'), 'invalid_transition', `${from}→declined`);
  }
  assert.equal(checkTransition('interviewing', 'offer', 'x'), 'invalid_transition', '→offer is the offer flow');
  assert.equal(checkTransition('offer', 'declined', 'compensation'), null);
  assert.equal(checkTransition('offer', 'declined', ''), 'reason_required');
  assert.equal(checkTransition('accepted', 'withdrawn', 'other'), null);
  assert.equal(checkTransition('accepted', 'rejected', 'other'), 'invalid_transition');
  assert.equal(checkTransition('accepted', 'no_show', ''), null, 'J1: no reason needed for a no-show');
  for (const from of ['offer', 'accepted', ...TERMINAL_APP_STATUSES]) {
    assert.equal(checkTransition(from, 'screening', 'x'), 'invalid_transition', `nothing leaves ${from} manually`);
  }
});

test('rejected / withdrawn require a reason CODE; others do not', () => {
  assert.equal(checkTransition('new', 'rejected', ''), 'reason_required');
  assert.equal(checkTransition('new', 'rejected', '   '), 'reason_required');
  assert.equal(checkTransition('screening', 'withdrawn', null), 'reason_required');
  assert.equal(checkTransition('new', 'rejected', 'not_a_fit'), null);
  assert.equal(checkTransition('new', 'rejected', 'not a fit — asked 12L'), 'bad_reason', 'free text is a note, never the reason');
  assert.equal(checkTransition('new', 'on_hold', 'whatever'), 'bad_reason', 'an optional reason must still be a code');
  assert.equal(checkTransition('new', 'screening', ''), null);
  assert.equal(checkTransition('on_hold', 'interviewing', undefined), null);
});

test('active and terminal statuses partition the schema list', () => {
  const all = [...ACTIVE_APP_STATUSES, ...TERMINAL_APP_STATUSES].sort();
  assert.deepEqual(all, ['accepted', 'declined', 'interviewing', 'joined', 'new', 'no_show', 'offer', 'on_hold', 'rejected', 'screening', 'withdrawn']);
});

// ── Approver ─────────────────────────────────────────────────────────────────
const F1 = 'emp-001', F2 = 'emp-002', M = 'mgr', RM = 'rm', REQ = 'req';
const edges = [
  { id: F1, manager_id: null }, { id: F2, manager_id: null },
  { id: M, manager_id: F1 }, { id: RM, manager_id: M }, { id: REQ, manager_id: RM },
  { id: 'rm2', manager_id: F1 },
];
const founders = [F1, F2];

test('resolveApprover: normal case = the reporting manager\'s manager', () => {
  assert.equal(resolveApprover(edges, founders, RM, REQ), M);
  assert.equal(resolveApprover(edges, founders, RM, RM), M, 'RM raising their own opening');
});

test('resolveApprover: RM is a founder → the OTHER founder', () => {
  assert.equal(resolveApprover(edges, founders, F1, REQ), F2);
  assert.equal(resolveApprover(edges, founders, F2, REQ), F1);
});

test('resolveApprover: approver would be the requester → a founder, never the requester', () => {
  // M requests for RM (whose manager is M) → not M.
  const a = resolveApprover(edges, founders, RM, M);
  assert.notEqual(a, M);
  assert.ok(founders.includes(a));
  // rm2 reports to F1; F1 requests → F2.
  assert.equal(resolveApprover(edges, founders, 'rm2', F1), F2);
});

test('resolveApprover: requester is a founder and the RM is the other founder', () => {
  // RM=F1 (no manager) → first pick F2 = requester → falls to a founder ≠ requester = F1.
  assert.equal(resolveApprover(edges, founders, F1, F2), F1);
  // Founder requests for themselves as RM → the other founder.
  assert.equal(resolveApprover(edges, founders, F1, F1), F2);
});

test('resolveApprover: nobody resolvable → null', () => {
  assert.equal(resolveApprover(edges, [], F1, REQ), null);
  assert.equal(resolveApprover(edges, [F1], F1, F1), null, 'the only founder is the requester');
  // Sole founder is the RM, someone else requests: RM is skipped, no other founder → falls to the
  // founder who is not the requester (requester is the one hard rule; the DB check enforces it).
  assert.equal(resolveApprover(edges, [F1], F1, REQ), F1);
});

test('resolveApprover: the hiring owner is skipped too', () => {
  // podium_hiring (REQ) files for owner M; RM's manager is M → the owner would approve → a founder.
  assert.equal(resolveApprover(edges, founders, RM, REQ, M), F1);
  // Owner is a founder AND the RM's manager (rm2 → F1): skip F1 → F2.
  assert.equal(resolveApprover(edges, founders, 'rm2', REQ, F1), F2);
  // Owner unrelated to the approver → normal case unchanged.
  assert.equal(resolveApprover(edges, founders, RM, REQ, 'someone'), M);
  // Never the requester, the owner or the RM while any other founder exists.
  for (const [rm, req, own] of [[RM, M, F1], [F1, REQ, M], ['rm2', F2, REQ], [M, REQ, F1]]) {
    const a = resolveApprover(edges, founders, rm, req, own);
    assert.ok(a && ![rm, req, own].includes(a), `${rm}/${req}/${own} → ${a}`);
  }
});

test('resolveApprover: chain-change re-resolution records the CALLER as requester', () => {
  // podium_hiring user M changes the chain of an opening whose RM is RM (manager M): the caller is the
  // requester now, so M can never be its approver.
  assert.notEqual(resolveApprover(edges, founders, RM, M, 'own'), M);
});

test('checkBandDecider: approver or founder, never the requester', () => {
  const b = { approver_employee_id: M, requested_by_employee_id: REQ };
  assert.equal(checkBandDecider(M, false, b), null);
  assert.equal(checkBandDecider(F2, true, b), null, 'founder override');
  assert.equal(checkBandDecider(RM, false, b), 'forbidden');
  assert.equal(checkBandDecider(REQ, false, b), 'no_self_approval');
  assert.equal(checkBandDecider(F1, true, { approver_employee_id: F1, requested_by_employee_id: F1 }), 'no_self_approval');
  assert.equal(checkBandDecider(null, true, b), 'forbidden');
});

// ── Roles ────────────────────────────────────────────────────────────────────
const opening = { id: 'op1', hiring_owner_employee_id: 'own', reporting_manager_employee_id: RM, current_budget_id: 'b1' };
const budgets = [
  { id: 'b1', opening_id: 'op1', status: 'approved', approver_employee_id: 'appr' },
  { id: 'b2', opening_id: 'op1', status: 'pending', approver_employee_id: 'appr2' },
  { id: 'b0', opening_id: 'op1', status: 'superseded', approver_employee_id: 'old' },
];
const A = (perms = {}, compAccess = false) => ({ permissions: perms, compAccess });
const roles = (auth, meId) => openingRoles(auth, meId ? { id: meId } : null, opening, budgets);

test('openingRoles: owner / manager / approver (current OR pending, not superseded)', () => {
  assert.equal(roles(A(), 'own').owner, true);
  assert.equal(roles(A(), RM).manager, true);
  assert.equal(roles(A(), 'appr').approver, true);
  assert.equal(roles(A(), 'appr2').approver, true);
  assert.equal(roles(A(), 'old').approver, false);
  assert.equal(roles(A(), null).owner, false);
});

test('visibility gates', () => {
  const stranger = roles(A(), 'x');
  assert.equal(canSeeOpening(stranger), false);
  assert.equal(canSeeOpening(roles(A({ podium_hr: true }), 'x')), true);
  assert.equal(canSeeOpening(roles(A(), 'appr')), true);
  assert.equal(canEditOpening(roles(A(), RM)), false, 'RM manages apps, does not edit the opening');
  assert.equal(canEditOpening(roles(A(), 'own')), true);
  assert.equal(canManageApps(roles(A(), RM)), true);
  assert.equal(canManageApps(roles(A(), 'appr')), false);
  assert.equal(canChangeChain(roles(A(), 'own')), false);
  assert.equal(canChangeChain(roles(A({ podium_hiring: true }), 'x')), true);
});

test('canSeeSalary: podium_hiring alone is NOT enough; HR alone is NOT enough', () => {
  assert.equal(canSeeSalary(roles(A({ podium_hiring: true, podium_view: true }), 'x')), false);
  assert.equal(canSeeSalary(roles(A({ podium_admin: true }), 'x')), false);
  assert.equal(canSeeSalary(roles(A({}, true), 'x')), true, 'allow-list');
  assert.equal(canSeeSalary(roles(A(), 'own')), true);
  assert.equal(canSeeSalary(roles(A(), RM)), true);
  assert.equal(canSeeSalary(roles(A(), 'appr2')), true);
  assert.equal(canSeeSalary(roles(A({ podium_hiring: true }), 'own')), true, 'hiring + owner');
});

// ── Documents ────────────────────────────────────────────────────────────────
test('doc visibility table', () => {
  const hiringOnly = [roles(A({ podium_hiring: true }), 'x')];
  const owner = [roles(A(), 'own')];
  const none = [];
  const rows = [
    // type,              hiringOnly, owner, hr-without-openings, nobody
    ['cv',                 true,  true,  true,  false],
    ['education',          true,  true,  true,  false],
    ['experience_letter',  true,  true,  true,  false],
    ['photo',              true,  true,  true,  false],
    ['other',              true,  true,  true,  false],
    ['payslip',            false, true,  false, false],
    ['signed_offer',       false, true,  false, false],
    ['id_proof',           false, false, true,  false],
    ['pan',                false, false, true,  false],
    ['address_proof',      false, false, true,  false],
    ['bank',               false, false, true,  false],
    ['relieving_letter',   false, false, true,  false], // not in the plan's table → fails closed to HR
    ['made_up_type',       false, false, true,  false], // unknown → HR only
  ];
  for (const [t, h, o, hr, n] of rows) {
    assert.equal(canSeeCandidateDoc(t, hiringOnly, false), h, `${t} podium_hiring`);
    assert.equal(canSeeCandidateDoc(t, owner, false), o, `${t} owner`);
    assert.equal(canSeeCandidateDoc(t, none, true), hr, `${t} HR`);
    assert.equal(canSeeCandidateDoc(t, none, false), n, `${t} nobody`);
  }
  // Allow-list member on one of the candidate's openings sees payslips.
  assert.equal(canSeeCandidateDoc('payslip', [roles(A({ podium_hiring: true }, true), 'x')], false), true);
  for (const t of CANDIDATE_DOC_TYPES) assert.ok(['opening', 'salary', 'hr'].includes(docTier(t)), t);
});

// ── Gates + helpers ──────────────────────────────────────────────────────────
test('jdGate', () => {
  assert.equal(jdGate({ current_jd_id: null }), 'jd_required');
  assert.equal(jdGate({}), 'jd_required');
  assert.equal(jdGate({ current_jd_id: 'j1' }), null);
});

test('fileOk: types and the 15 MB cap', () => {
  assert.equal(fileOk('jd.pdf', ['pdf', 'docx'], 1000), null);
  assert.equal(fileOk('JD.DOCX', ['pdf', 'docx']), null);
  assert.equal(fileOk('jd.doc', ['pdf', 'docx'], 1000), 'bad_file_type');
  assert.equal(fileOk('cv.pdf', ['pdf'], 15 * 1024 * 1024 + 1), 'file_too_large');
  assert.equal(fileOk('cv.pdf', ['pdf'], '15728640'), null, 'string size from the client');
});

test('retainUntil, normalisers, codes, parseBand', () => {
  assert.equal(retainUntil('2026-11-11'), '2027-11-11');
  assert.equal(retainUntil('2026-11-11T10:00:00Z'), '2027-11-11');
  assert.equal(normPhoneKey('+91 77099-91011'), '7709991011');
  assert.equal(normPhoneKey(''), null);
  assert.equal(normEmailKey('  A@B.com '), 'a@b.com');
  assert.equal(openingCode(7), 'OPN-007');
  assert.equal(candidateCode(42), 'CAN-0042');
  assert.deepEqual(parseBand('600000', '900000'), { band_min: 600000, band_max: 900000 }, 'PostgREST strings');
  assert.equal(parseBand(9, 1).error, 'band_max_below_min');
  assert.equal(parseBand(null, 1).error, 'band_required');
  assert.equal(parseBand(-1, 1).error, 'bad_band');
});

// ── Storage paths (path traversal) ───────────────────────────────────────────
const CID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', CID2 = '11111111-2222-4333-8444-555555555555';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('safeFileName: only [A-Za-z0-9._-], no .. run, no leading dot, never empty', () => {
  assert.equal(safeFileName('My CV (final).pdf'), 'My_CV_final_.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\boot.ini'), 'boot.ini');
  assert.equal(safeFileName('a..b...pdf'), 'a.b.pdf');
  assert.equal(safeFileName('%2e%2e%2fx.pdf'), '2e_2e_2fx.pdf');
  assert.equal(safeFileName('.hidden.pdf'), 'hidden.pdf');
  assert.equal(safeFileName(''), 'file');
  assert.match(safeFileName('рез.pdf'), /^[A-Za-z0-9._-]+$/);
});

test('minted paths always pass their own check', () => {
  for (const n of ['cv.pdf', 'My CV (final).pdf', '../../x.pdf', '..', 'a..b.pdf', '%2e%2e.pdf', 'résumé.docx']) {
    assert.equal(checkCandidateDocPath(candidateDocPath(CID, 'cv', n, 1731300000000), CID, 'cv'), null, n);
    assert.equal(checkJdPath(jdPath(OID, n, 1731300000000), OID), null, n);
  }
  assert.equal(candidateDocPath(CID, 'payslip', 'p.pdf', 5), `candidates/${CID}/payslip/5_p.pdf`);
  assert.equal(jdPath(OID, 'jd.pdf', 5), `openings/${OID}/jd/5_jd.pdf`);
});

test('checkCandidateDocPath: exact shape for THIS candidate + doc type, nothing else', () => {
  const ok = `candidates/${CID}/cv/1731300000000_cv.pdf`;
  assert.equal(checkCandidateDocPath(ok, CID, 'cv'), null);
  const bad = [
    `candidates/${CID}/../${CID2}/cv/1_cv.pdf`,           // traversal to another candidate
    `candidates/${CID}/cv/../../${CID2}/cv/1_cv.pdf`,
    `candidates/${CID}/cv/1_..`,                          // '..' inside the name segment
    `candidates/${CID}/cv/1_a..pdf`,
    `candidates/${CID}/cv/%2e%2e/1_cv.pdf`,
    `candidates/${CID}/cv/1_%2E%2Ecv.pdf`,
    `candidates/${CID}/payslip/1_cv.pdf`,                 // doc_type segment ≠ the doc_type recorded
    `candidates/${CID2}/cv/1_cv.pdf`,                     // another candidate
    `candidates/${CID}/cv/cv.pdf`,                        // no <ts>_
    `candidates/${CID}/cv/x1_cv.pdf`,
    `candidates/${CID}/cv/1_cv pdf`,                      // space
    `candidates/${CID}/cv/sub/1_cv.pdf`,                  // extra segment
    `candidates/${CID}//cv/1_cv.pdf`,
    `/candidates/${CID}/cv/1_cv.pdf`,
    `candidates/${CID}/cv/1_cv.pdf/`,
    `openings/${OID}/jd/1_jd.pdf`,
    '', null, undefined, 42,
  ];
  for (const p of bad) assert.equal(checkCandidateDocPath(p, CID, 'cv'), 'bad_storage_path', String(p));
  assert.equal(checkCandidateDocPath(ok, 'not-a-uuid', 'cv'), 'bad_storage_path');
  assert.equal(checkCandidateDocPath(ok, CID, 'made_up'), 'bad_storage_path');
});

test('checkJdPath: exact shape for THIS opening', () => {
  assert.equal(checkJdPath(`openings/${OID}/jd/1731300000000_JD-v2.pdf`, OID), null);
  for (const p of [
    `openings/${OID}/jd/../../${CID2}/jd/1_x.pdf`, `openings/${OID}/../x/jd/1_x.pdf`, `openings/${OID}/jd/1_..`,
    `openings/${OID}/jd/%2e%2e/1_x.pdf`, `openings/${OID}/cv/1_x.pdf`, `openings/${CID}/jd/1_x.pdf`,
    `openings/${OID}/jd/x.pdf`, `candidates/${CID}/cv/1_cv.pdf`, '',
  ]) assert.equal(checkJdPath(p, OID), 'bad_storage_path', p);
});

test('checkFileSize: positive integer ≤ 15 MB, required', () => {
  assert.equal(checkFileSize(1), null);
  assert.equal(checkFileSize(15728640), null);
  assert.equal(checkFileSize('2048'), null, 'numeric string from JSON is fine');
  for (const v of [0, -1, 15728641, 1.5, '1.5', 'abc', '', ' ', null, undefined, NaN, Infinity, '1e3', [], {}]) {
    assert.equal(checkFileSize(v), 'bad_file_size', JSON.stringify(v));
  }
});

// ── Search + band input ──────────────────────────────────────────────────────
test('cleanSearch strips PostgREST filter grammar incl. quotes and backslashes', () => {
  assert.equal(cleanSearch('a,b(c)*d"e\\f'), encodeURIComponent('a b c  d e f'));
  assert.equal(cleanSearch('  OPN-001 '), 'OPN-001');
  assert.equal(cleanSearch(null), '');
});

test('parseBand: blank / whitespace is "required", not 0', () => {
  assert.equal(parseBand('', '900000').error, 'band_required');
  assert.equal(parseBand('   ', '900000').error, 'band_required');
  assert.equal(parseBand('600000', ' ').error, 'band_required');
  assert.equal(parseBand(undefined, 1).error, 'band_required');
  assert.deepEqual(parseBand(0, 0), { band_min: 0, band_max: 0 }, 'an explicit 0 is a number');
  assert.equal(parseBand('abc', 1).error, 'bad_band');
});

// ── Per-application doc visibility ───────────────────────────────────────────
// Two openings: the caller owns op1 (salary) and is HR-free podium_hiring on op2 (no salary).
const op2 = { id: 'op2', hiring_owner_employee_id: 'other', reporting_manager_employee_id: 'other2' };
const ctxFor = (auth, meId) => ({
  rolesByOpening: {
    op1: openingRoles(auth, { id: meId }, opening, budgets),
    op2: openingRoles(auth, { id: meId }, op2, []),
  },
  appOpening: { app1: 'op1', app2: 'op2' },
  hr: false,
});

test('canSeeDocRow: a payslip tied to an application follows THAT opening only', () => {
  const ctx = ctxFor(A({ podium_hiring: true }), 'own');   // owner of op1, hiring-only on op2
  assert.equal(canSeeDocRow('payslip', 'app1', ctx), true, 'own opening');
  assert.equal(canSeeDocRow('payslip', 'app2', ctx), false, 'salary on op1 does not open op2\'s payslip');
  assert.equal(canSeeDocRow('signed_offer', 'app2', ctx), false);
  assert.equal(canSeeDocRow('payslip', null, ctx), true, 'untied → salary on any');
  assert.equal(canSeeDocRow('payslip', 'unknown-app', ctx), false);
  assert.equal(canSeeDocRow('cv', 'app2', ctx), true, 'opening tier unchanged');
  assert.equal(canSeeDocRow('pan', null, ctx), false, 'HR tier unchanged');
  assert.equal(canSeeDocRow('pan', null, { ...ctx, hr: true }), true);
  const hiringOnly = ctxFor(A({ podium_hiring: true }), 'x');
  assert.equal(canSeeDocRow('payslip', null, hiringOnly), false);
  assert.equal(canSeeDocRow('payslip', 'app1', hiringOnly), false);
});

// ── Reasons, notes, timeline ─────────────────────────────────────────────────
test('reason codes: the picklist, exactly', () => {
  assert.deepEqual(OUTCOME_REASON_CODES, ['not_a_fit', 'skills', 'experience', 'compensation', 'location', 'notice_period',
    'candidate_withdrew', 'no_response', 'duplicate', 'other']);
  assert.equal(isSafeReason('compensation'), true);
  assert.equal(isSafeReason('moved to OPN-012'), true);
  assert.equal(isSafeReason('JD added'), true);
  assert.equal(isSafeReason('asked for 14L'), false);
  assert.equal(redactReason('asked for 14L', false), null);
  assert.equal(redactReason('asked for 14L', true), 'asked for 14L');
  assert.equal(redactReason('skills', false), 'skills');
});

test('redactEvent strips detail.note and free-text reason for non-salary viewers only', () => {
  const ev = { id: 1, reason: 'too expensive at 14L', detail: { note: 'wants 14L', version: 2 } };
  assert.deepEqual(redactEvent(ev, false), { id: 1, reason: null, detail: { version: 2 } });
  assert.deepEqual(redactEvent(ev, true), ev);
  assert.deepEqual(redactEvent({ id: 2, reason: 'compensation', detail: null }, false), { id: 2, reason: 'compensation', detail: null });
  assert.equal(ev.detail.note, 'wants 14L', 'input not mutated');
});

test('candidateEventsFor: no cross-opening rows, no hidden doc types, notes only with salary', () => {
  const ctx = ctxFor(A({ podium_hiring: true }), 'own');
  const evs = [
    { id: 1, opening_id: 'op1', application_id: 'app1', event_type: 'status_changed', reason: 'compensation', detail: { note: 'asked 14L' } },
    { id: 2, opening_id: 'op2', application_id: 'app2', event_type: 'status_changed', reason: 'skills', detail: { note: 'weak' } },
    { id: 3, opening_id: 'op9', event_type: 'status_changed' },                                   // opening caller can't see
    { id: 4, application_id: 'app2', event_type: 'document_added', detail: { doc_type: 'payslip' } }, // payslip on op2
    { id: 5, application_id: 'app1', event_type: 'document_added', detail: { doc_type: 'payslip' } },
    { id: 6, event_type: 'document_deleted', detail: { doc_type: 'pan' } },                        // HR-only type
    { id: 7, event_type: 'document_added', detail: { doc_type: 'cv' } },
    { id: 8, event_type: 'candidate_created' },
    { id: 9, application_id: 'app9', event_type: 'x' },                                           // unknown application
  ];
  const out = candidateEventsFor(evs, ctx);
  assert.deepEqual(out.map(e => e.id), [1, 2, 5, 7, 8]);
  assert.equal(out[0].detail.note, 'asked 14L', 'salary on op1 → note kept');
  assert.equal(out[1].detail.note, undefined, 'no salary on op2 → note stripped');
  assert.equal(out[1].reason, 'skills', 'the code stays');
  // HR without any opening seat: sees the HR doc row, never a payslip row.
  const hr = { rolesByOpening: {}, appOpening: { app1: 'op1', app2: 'op2' }, hr: true };
  assert.deepEqual(candidateEventsFor(evs, hr).map(e => e.id), [6, 7, 8]);
});
