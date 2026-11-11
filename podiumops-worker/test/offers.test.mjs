// Hiring C3 — the pure offer rules in src/hiring.js (who may act, terms validation, paths, redaction).
// Synthetic figures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canManageOffers, offerRoles, canSeeSalary, canSeeOpening, cleanOfferTerms, offerPdfPath, offerDocPath, checkOfferDocPath,
  offerView, istToday, addDaysIso, isIsoDate, OFFER_LIVE_STATUSES, OFFER_WITHDRAWABLE, OFFER_OPEN_STATUSES,
  docTier, canSeeDocRow, CANDIDATE_DOC_TYPES,
  offerTermsCanonical, SUPERSEDE_ON_SEND, isLatestSent, canSendOffer, needsNoLiveOffer, canMoveFrom, offerDbErrorCode,
  APP_TRANSITIONS, ACTIVE_APP_STATUSES,
} from '../src/hiring.js';
import { readFileSync } from 'node:fs';
const SQL = readFileSync(new URL('../migrations/0008_hiring_offers.sql', import.meta.url), 'utf8');

const CID = '11111111-2222-4333-8444-555555555555';
const AID = '99999999-8888-4777-8666-555555555555';
const R = (o) => ({ hiring: false, owner: false, manager: false, approver: false, hr: false, comp: false, ...o });

test('offers are made by the hiring owner or reporting manager only', () => {
  assert.equal(canManageOffers(R({ owner: true })), true);
  assert.equal(canManageOffers(R({ manager: true })), true);
  assert.equal(canManageOffers(R({ hiring: true })), false, 'podium_hiring alone: status only');
  assert.equal(canManageOffers(R({ hr: true, comp: true })), false, 'HR / allow-list off the chain');
  assert.equal(canManageOffers(R({ approver: true })), false);
  assert.equal(canManageOffers(null), false);
});

test('the snapshotted offer approver sees the opening and that offer\'s figures', () => {
  const base = R({});
  const r = offerRoles(base, { approver_employee_id: 'e1' }, 'e1');
  assert.equal(canSeeOpening(r) && canSeeSalary(r), true);
  assert.equal(base.approver, false, 'input roles untouched');
  const other = offerRoles(base, { approver_employee_id: 'e1' }, 'e2');
  assert.equal(canSeeOpening(other), false);
  assert.equal(offerRoles(base, { approver_employee_id: null }, null).approver, false);
});

test('cleanOfferTerms: salary mode', () => {
  const ok = cleanOfferTerms({ fixed_annual: '4,50,000', variable_annual: '50000', designation: ' Analyst ', start_date: '2026-12-01',
    location: 'Bangalore', probation_months: '3', variable_label: 'Incentive pay' }, 'salary');
  assert.deepEqual(ok.terms, {
    designation: 'Analyst', department_name: null, location: 'Bangalore', start_date: '2026-12-01', probation_months: 3,
    signatory_id: null, valid_days: 7, joining_bonus: 0, retention_bonus: 0, fixed_annual: 450000, variable_annual: 50000,
    variable_label: 'incentive pay', variable_frequency: 'half-yearly', pf_opt_out: false, pf_opt_out_reason: null,
    stipend_monthly: null, internship_months: null,
  });
  const base = { designation: 'A', start_date: '2026-12-01', location: 'B', fixed_annual: 450000 };
  assert.equal(cleanOfferTerms({ ...base, fixed_annual: 0 }, 'salary').error, 'bad_fixed_annual');
  assert.equal(cleanOfferTerms({ ...base, fixed_annual: -5 }, 'salary').error, 'bad_fixed_annual');
  assert.equal(cleanOfferTerms({ ...base, variable_annual: 'abc' }, 'salary').error, 'bad_variable_annual');
  assert.equal(cleanOfferTerms({ ...base, joining_bonus: -1 }, 'salary').error, 'bad_joining_bonus');
  assert.equal(cleanOfferTerms({ ...base, pf_opt_out: true }, 'salary').error, 'pf_opt_out_reason_required');
  assert.equal(cleanOfferTerms({ ...base, pf_opt_out: true, pf_opt_out_reason: 'existing member elsewhere' }, 'salary').terms.pf_opt_out, true);
  assert.equal(cleanOfferTerms({ ...base, start_date: '2026-02-30' }, 'salary').error, 'start_date_required');
  assert.equal(cleanOfferTerms({ ...base, probation_months: 13 }, 'salary').error, 'bad_probation_months');
  assert.equal(cleanOfferTerms({ ...base, variable_label: 'bonus' }, 'salary').error, 'bad_variable_label');
  assert.equal(cleanOfferTerms({ ...base, variable_frequency: 'weekly' }, 'salary').error, 'bad_variable_frequency');
  assert.equal(cleanOfferTerms({ ...base, signatory_id: 'x' }, 'salary').error, 'bad_signatory_id');
  assert.equal(cleanOfferTerms({ ...base, valid_days: 0 }, 'salary').error, 'bad_valid_days');
  assert.equal(cleanOfferTerms({ ...base, designation: '' }, 'salary').error, 'designation_required');
  // Error codes never carry the figure.
  for (const bad of [{ fixed_annual: 123456.5e9 * -1 }, { variable_annual: '98765x' }]) {
    const e = cleanOfferTerms({ ...base, ...bad }, 'salary').error;
    assert.ok(e && !/\d/.test(e), e);
  }
});

test('cleanOfferTerms: request over defaults; stipend mode zeroes the salary fields', () => {
  const t = cleanOfferTerms({ fixed_annual: 450000 }, 'salary', { designation: 'From opening', location: 'Bangalore', start_date: '2026-12-01' }).terms;
  assert.equal(t.designation, 'From opening');
  const s = cleanOfferTerms({ stipend_monthly: '15000', internship_months: 6, fixed_annual: 999999, pf_opt_out: true },
    'stipend', { designation: 'Design', location: 'Bangalore', start_date: '2026-12-01' }).terms;
  assert.equal(s.stipend_monthly, 15000);
  assert.equal(s.fixed_annual, null);
  assert.equal(s.variable_annual, 0);
  assert.equal(s.pf_opt_out, false);
  assert.equal(cleanOfferTerms({ stipend_monthly: 15000, internship_months: 30 }, 'stipend', { designation: 'D', location: 'B', start_date: '2026-12-01' }).error, 'bad_internship_months');
});

test('offer storage paths: minted shape passes its own check, anything else fails', () => {
  assert.equal(offerPdfPath(AID, 'OFR-2026-001', 2, 'abcdef0123456789'), `offers/${AID}/OFR-2026-001-r2-abcdef01.pdf`, 'hash-suffixed: a stale render never overwrites');
  assert.doesNotMatch(SQL + readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'), /x-upsert/, 'no upsert anywhere');
  const p = offerDocPath(CID, 'OFR-2026-001', 2, 'signed', 1700000000000);
  assert.equal(p, `candidates/${CID}/offers/OFR-2026-001-r2-signed-1700000000000.pdf`);
  assert.equal(checkOfferDocPath(p, CID, 'OFR-2026-001', 2, 'signed'), null);
  assert.equal(checkOfferDocPath(p, CID, 'OFR-2026-001', 3, 'signed'), 'bad_storage_path', 'another revision');
  assert.equal(checkOfferDocPath(p, CID, 'OFR-2026-001', 2, 'sent_evidence'), 'bad_storage_path', 'another kind');
  assert.equal(checkOfferDocPath(p.replace(CID, AID), CID, 'OFR-2026-001', 2, 'signed'), 'bad_storage_path', 'another candidate');
  assert.equal(checkOfferDocPath(`candidates/${CID}/offers/../x/OFR-2026-001-r2-signed-1.pdf`, CID, 'OFR-2026-001', 2, 'signed'), 'bad_storage_path');
  assert.equal(checkOfferDocPath(p, CID, 'OFR-2026-001', 2, 'other'), 'bad_storage_path');
  assert.equal(checkOfferDocPath(p, CID, 'OFR.*', 2, 'signed'), 'bad_storage_path', 'ref is a pattern, not a regex hole');
});

test('offerView: no figures, annexure or notes without salary on the opening', () => {
  const o = { id: 'o1', offer_ref: 'OFR-2026-001', revision: 1, status: 'sent', fixed_annual: '450000', total_ctc: '500000',
    annexure: { lines: [] }, inputs: {}, decision_note: 'ok at 5L', outcome_note: 'x', designation: 'Analyst' };
  const meta = offerView(o, false);
  for (const k of ['fixed_annual', 'total_ctc', 'annexure', 'inputs', 'decision_note', 'outcome_note', 'variable_annual', 'pdf_sha256']) {
    assert.equal(k in meta, false, k);
  }
  assert.equal(meta.status, 'sent');
  const full = offerView(o, true);
  assert.equal(full.total_ctc, 500000, 'numerics → Number');
  assert.equal(full.decision_note, 'ok at 5L');
});

test('offer evidence is a salary-tier document', () => {
  assert.ok(CANDIDATE_DOC_TYPES.includes('offer_evidence'));
  assert.equal(docTier('offer_evidence'), 'salary');
  const ctx = { rolesByOpening: { op1: R({ hiring: true }), op2: R({ owner: true }) }, appOpening: { a1: 'op1', a2: 'op2' }, hr: true };
  assert.equal(canSeeDocRow('offer_evidence', 'a1', ctx), false, 'podium_hiring / HR off the chain');
  assert.equal(canSeeDocRow('offer_evidence', 'a2', ctx), true);
});

test('status sets', () => {
  assert.deepEqual(OFFER_OPEN_STATUSES, ['draft', 'pending_approval', 'approved', 'approval_rejected']);
  assert.ok(OFFER_LIVE_STATUSES.includes('accepted') && !OFFER_LIVE_STATUSES.includes('expired'));
  assert.ok(OFFER_WITHDRAWABLE.includes('expired') && !OFFER_WITHDRAWABLE.includes('superseded') && !OFFER_WITHDRAWABLE.includes('declined'));
});

test('IST dates', () => {
  assert.equal(istToday(Date.UTC(2026, 10, 11, 18, 29)), '2026-11-11');
  assert.equal(istToday(Date.UTC(2026, 10, 11, 18, 30)), '2026-11-12', 'midnight IST');
  assert.equal(addDaysIso('2026-12-28', 7), '2027-01-04');
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isIsoDate('2028-02-29'), true);
});

// ── Review fixes ─────────────────────────────────────────────────────────────
const ROW = { template_id: 't1', rule_set_id: 'r1', mode: 'salary', fixed_annual: 450000, variable_annual: 50000,
  variable_label: 'variable pay', variable_frequency: 'half-yearly', joining_bonus: 0, retention_bonus: 0, stipend_monthly: null,
  internship_months: null, total_ctc: 500000, pf_opt_out: false, pf_opt_out_reason: null, designation: 'A', department_name: null,
  location: 'B', start_date: '2026-12-01', probation_months: 3, signatory_id: 's1', annexure: { lines: [{ key: 'basic', annual: 1 }], totals: { b: 1, a: 2 } } };

test('terms canonical: PostgREST strings = worker numbers; any term change changes it; non-terms do not', () => {
  const db = { ...ROW, fixed_annual: '450000', variable_annual: '50000', total_ctc: '500000', joining_bonus: '0', retention_bonus: '0',
    annexure: { totals: { a: 2, b: 1 }, lines: [{ annual: 1, key: 'basic' }] }, status: 'ready', updated_at: 'x', pdf_path: 'p', band_check: 'in_band' };
  assert.equal(offerTermsCanonical(db), offerTermsCanonical(ROW), 'key order / numeric strings / status fields ignored');
  for (const [k, v] of [['fixed_annual', 450001], ['joining_bonus', 1], ['signatory_id', 's2'], ['start_date', '2026-12-02'],
    ['template_id', 't2'], ['pf_opt_out', true], ['annexure', { lines: [] }], ['designation', 'B']]) {
    assert.notEqual(offerTermsCanonical({ ...ROW, [k]: v }), offerTermsCanonical(ROW), k);
  }
});

test('the transition RPC guards freeze / approve / issue / send / accept on the terms hash and the latest sent', () => {
  const fn = SQL.slice(SQL.indexOf('function podium.hiring_offer_transition'), SQL.indexOf('function podium.hiring_expire_offers'));
  assert.match(fn, /v_to in \('pending_approval', 'approved', 'ready', 'sent', 'accepted'\)\s+and v_o\.terms_hash is distinct from nullif\(p->>'expected_terms_hash', ''\) then\s+raise exception 'stale'/);
  assert.match(fn, /raise exception 'not_latest'/);
  assert.match(fn, /sent_at = case when v_to = 'sent' then coalesce\(v_s\.sent_at, now\(\)\)/, 'the DB stamps sent_at, so not_latest cannot be dodged');
  assert.match(fn, /approved_terms_hash = case when v_to = 'approved' then v_o\.terms_hash/, 'approval binds to the row\'s hash, set by the DB');
  assert.match(SQL, /coalesce\(band_check in \('in_band', 'below_band'\), false\)\s+or coalesce\(approved_terms_hash = terms_hash, false\)\)/, 'table check: nothing above band issued unapproved (NULL-safe)');
});

test('send supersedes ready / sent / expired siblings (worker constant = 0008)', () => {
  assert.deepEqual(SUPERSEDE_ON_SEND, ['ready', 'sent', 'expired']);
  const m = SQL.match(/if v_to = 'sent' then[\s\S]*?status in \(([^)]*)\)/);
  assert.deepEqual(m[1].split(',').map(x => x.trim().replace(/'/g, '')), SUPERSEDE_ON_SEND);
});

test('only the latest sent revision can be accepted', () => {
  const offers = [{ id: 'r1', revision: 1, sent_at: 't' }, { id: 'r2', revision: 2, sent_at: 't' }, { id: 'r3', revision: 3, sent_at: null }];
  assert.equal(isLatestSent(offers, 'r2'), true);
  assert.equal(isLatestSent(offers, 'r1'), false, 'an expired older revision after a newer send');
  assert.equal(isLatestSent(offers, 'r3'), false, 'never sent');
  assert.equal(isLatestSent([{ id: 'a', revision: '10', sent_at: 't' }, { id: 'b', revision: '9', sent_at: 't' }], 'a'), true, 'numeric strings');
});

test('canSendOffer: in / below band, or approved for exactly these terms', () => {
  assert.equal(canSendOffer({ status: 'ready', band_check: 'in_band' }), true);
  assert.equal(canSendOffer({ status: 'ready', band_check: 'below_band' }), true);
  assert.equal(canSendOffer({ status: 'ready', band_check: 'above_band', terms_hash: 'h', approved_terms_hash: 'h' }), true);
  assert.equal(canSendOffer({ status: 'ready', band_check: 'above_band', terms_hash: 'h2', approved_terms_hash: 'h' }), false);
  assert.equal(canSendOffer({ status: 'ready', band_check: 'extras', terms_hash: 'h', approved_terms_hash: null }), false);
  assert.equal(canSendOffer({ status: 'ready', band_check: 'extras', terms_hash: null, approved_terms_hash: null }), false);
  assert.equal(canSendOffer({ status: 'approved', band_check: 'in_band' }), false);
});

test('every manual close / hold checks for a live offer; nothing at offer / accepted moves', () => {
  for (const to of ['rejected', 'withdrawn', 'on_hold', 'declined', 'no_show', 'joined']) assert.equal(needsNoLiveOffer(to), true, to);
  for (const to of ['screening', 'interviewing', 'new']) assert.equal(needsNoLiveOffer(to), false, to);
  for (const targets of Object.values(APP_TRANSITIONS)) for (const t of targets) {
    if (!ACTIVE_APP_STATUSES.includes(t) || t === 'on_hold') assert.equal(needsNoLiveOffer(t), true, `manual →${t} is checked`);
  }
  assert.equal(canMoveFrom('offer'), false);
  assert.equal(canMoveFrom('accepted'), false);
  assert.equal(canMoveFrom('interviewing'), true);
});

test('offer DB errors map by constraint name and never echo a row', () => {
  const dup = (c) => ({ code: '23505', message: `duplicate key value violates unique constraint "${c}"`, details: 'Key (x)=(450000)' });
  assert.deepEqual(offerDbErrorCode(dup('offers_one_accepted')), { code: 'already_accepted', status: 409 });
  assert.deepEqual(offerDbErrorCode(dup('offers_one_open_draft')), { code: 'draft_exists', status: 409 });
  assert.deepEqual(offerDbErrorCode(dup('candidate_documents_storage_path_key')), { code: 'doc_already_recorded', status: 409 });
  assert.deepEqual(offerDbErrorCode(dup('offers_pdf_path_key')), { code: 'pdf_path_in_use', status: 409 });
  assert.deepEqual(offerDbErrorCode(dup('something_else')), { code: 'conflict', status: 409 });
  assert.deepEqual(offerDbErrorCode({ message: 'stale' }), { code: 'stale', status: 409 });
  assert.deepEqual(offerDbErrorCode({ message: 'not_latest' }), { code: 'not_latest', status: 409 });
  assert.deepEqual(offerDbErrorCode({ code: '23514', message: 'violates check constraint "offers_check6"' }), { code: 'offer_check_failed', status: 409 });
  assert.equal(offerDbErrorCode({ code: '42P01', message: 'x' }), null);
  // The index names the mapping keys on exist in 0008 / 0006.
  assert.match(SQL, /create unique index offers_one_accepted /);
  assert.match(SQL, /create unique index offers_one_open_draft /);
  assert.match(SQL, /pdf_path text unique/);
});

test('signatories are seeded without a title (letters sign with the name only)', () => {
  assert.match(SQL, /select e\.id, e\.full_name, nullif\(btrim\(e\.phone\), ''\), null\s+from podium\.employees/);
});
