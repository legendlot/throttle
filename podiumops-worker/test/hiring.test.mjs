// Hiring C1/C2 — the pure rules in src/hiring.js (plan 2026-11-11-podium-hiring-c1-c2.md §A).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_TRANSITIONS, checkTransition, ACTIVE_APP_STATUSES, TERMINAL_APP_STATUSES,
  resolveApprover, checkBandDecider, openingRoles,
  canSeeOpening, canEditOpening, canManageApps, canSeeSalary, canChangeChain,
  canSeeCandidateDoc, docTier, CANDIDATE_DOC_TYPES, jdGate, fileOk, retainUntil,
  normPhoneKey, normEmailKey, openingCode, candidateCode, parseBand,
} from '../src/hiring.js';

// ── Transitions ──────────────────────────────────────────────────────────────
test('APP_TRANSITIONS: the manual moves of this slice, exactly', () => {
  assert.deepEqual(APP_TRANSITIONS, {
    new:          ['screening', 'rejected', 'withdrawn', 'on_hold'],
    screening:    ['interviewing', 'rejected', 'withdrawn', 'on_hold'],
    interviewing: ['rejected', 'withdrawn', 'on_hold'],
    on_hold:      ['new', 'screening', 'interviewing', 'rejected', 'withdrawn'],
  });
});

test('offer / accepted / joined / declined / no_show are never set by hand', () => {
  for (const from of Object.keys(APP_TRANSITIONS)) {
    for (const to of ['offer', 'accepted', 'joined', 'declined', 'no_show']) {
      assert.equal(checkTransition(from, to, 'x'), 'invalid_transition', `${from}→${to}`);
    }
  }
  assert.equal(checkTransition('interviewing', 'offer', 'x'), 'invalid_transition', '→offer is C3');
  for (const from of ['offer', 'accepted', ...TERMINAL_APP_STATUSES]) {
    assert.equal(checkTransition(from, 'screening', 'x'), 'invalid_transition', `nothing leaves ${from} manually`);
  }
});

test('rejected / withdrawn require a non-empty reason; others do not', () => {
  assert.equal(checkTransition('new', 'rejected', ''), 'reason_required');
  assert.equal(checkTransition('new', 'rejected', '   '), 'reason_required');
  assert.equal(checkTransition('screening', 'withdrawn', null), 'reason_required');
  assert.equal(checkTransition('new', 'rejected', 'not a fit'), null);
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
  assert.equal(resolveApprover(edges, [F1], F1, REQ), null);
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
