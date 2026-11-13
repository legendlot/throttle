import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsFor, findTool } from '../src/tools/index.js';
import { SALARY_KEY, parseCorrections, uploadLink, payText, clean, matchesFor, REMOVED } from '../src/tools/podium.js';
import { readFileSync } from 'node:fs';
import { refusalText } from '../src/checks.js';

const IMP = '11111111-1b2c-4d5e-8f90-123456789abc';
const ITEM = '22222222-1b2c-4d5e-8f90-123456789abc';
const OPEN = '33333333-1b2c-4d5e-8f90-123456789abc';
const CAND = '44444444-1b2c-4d5e-8f90-123456789abc';
const EMP = '55555555-1b2c-4d5e-8f90-123456789abc';
const AUTH = '66666666-1b2c-4d5e-8f90-123456789abc';

// Fake podiumops: GET ?action= / POST {action, data}; records every request.
function fake(routes) {
  const seen = [];
  return {
    seen,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const body = init.body ? JSON.parse(init.body) : null;
      const action = body ? body.action : u.searchParams.get('action');
      seen.push({ method: init.method || 'GET', action, query: Object.fromEntries(u.searchParams), body });
      const r = routes[action];
      const [status, j] = typeof r === 'function' ? r(body, u) : (r || [400, { ok: false, error: `unknown_action: ${action}` }]);
      return new Response(JSON.stringify(j), { status });
    },
  };
}
const SALARYISH = {
  current_ctc: 1800000, expected_ctc: 2400000, salary_band_min: 1, salary_band_max: 2, band: { band_min: 1, band_max: 2 },
  pending_band: { band_min: 3 }, can_see_salary: true, pan: 'ABCDE1234F', pan_number: 'X', bank: { ifsc: 'HDFC0001', account_number: '123' },
  bank_name: 'HDFC', aadhaar: '1234', compensation: { total: 1 }, increment_pct: 10, payslip: 'p', stipend: 1, created_by: AUTH, userId: AUTH,
};
const ITEM_ROW = {
  id: ITEM, import_id: IMP, file_name: 'asha.pdf', status: 'extracted', storage_path: 'imports/x/asha.pdf', sha256: 'abc',
  warnings: ['Current CTC couldn\'t be traced to the CV — dropped', 'Phone not found in the CV text — dropped'],
  extracted: { fields: { full_name: 'Asha Rao', email: 'asha@example.com', phone: '+91 98450 00000', skills: ['SQL'], total_experience_years: 4,
    current_ctc: 1800000, expected_ctc: 2400000, nested: { ...SALARYISH } }, evidence: { current_ctc: '18 LPA', experience: '4 years' } },
  final: null, candidate_id: null, application_id: null, ...SALARYISH,
};
const IMPORT = { ok: true, data: { import: { id: IMP, opening_id: OPEN, source: 'other', source_detail: 'AI connector', created_by: AUTH },
  opening: { id: OPEN, opening_code: 'OPN-007', designation: 'Analyst', status: 'open' }, can_see_salary: true,
  items: [ITEM_ROW], duplicates: [{ id: CAND, candidate_code: 'CAN-0042', full_name: 'Asha R', email_norm: 'asha@example.com', phone_norm: '9845000000' }],
  hidden_keys: [], spend: { inr: 12 }, ai_ready: true } };
const OPENINGS = { ok: true, data: { openings: [
  { id: OPEN, opening_code: 'OPN-007', designation: 'Analyst', status: 'open', department: { id: 'd', name: 'Growth' }, has_jd: true,
    hiring_owner: { id: EMP, full_name: 'Me' }, reporting_manager: { id: 'other', full_name: 'Boss' }, application_counts: { new: 3 },
    band: { band_min: 1, band_max: 2 }, pending_band: null, can_see_salary: true, budget_status: 'approved', ...SALARYISH },
  { id: 'not-mine', opening_code: 'OPN-008', designation: 'HR seen only', status: 'open', hiring_owner: { id: 'x' }, reporting_manager: { id: 'y' } },
] } };
const ME = { ok: true, data: { userId: AUTH, employee_id: EMP, permissions: { podium_hiring: false } } };
const routes = (over = {}) => ({ getOpenings: [200, OPENINGS], getMe: [200, ME], getCvImport: [200, IMPORT],
  createCvImport: [200, { ok: true, data: { id: IMP, opening_id: OPEN, source: 'other', created_by: AUTH, ...SALARYISH } }],
  cvImportAccept: [200, { ok: true, data: { id: ITEM, status: 'accepted', candidate_id: CAND, application_id: 'app-1', final: { current_ctc: 1800000 }, ...SALARYISH } }],
  ...over });
const BAD = /ctc|salary|band|1800000|2400000|ABCDE1234F|HDFC|account_number|aadhaar|ifsc|payslip|stipend|increment|compensation|pan_number|"pan"|"bank|66666666|18 LPA|storage_path|sha256/i;
const call = async (name, args, b = fake(routes())) => {
  const t = findTool(name);
  const p = t.parse(args);
  assert.equal(p.ok, true, p.error);
  return { r: await t.run({ env: { PODIUMOPS: b }, sbAccess: 'JWT', gate: { systems: ['podium'] }, input: p.value }), b };
};

test('salary + personal-finance keys never appear in any tool output', async () => {
  const outs = [
    await call('podium_hiring', { report: 'openings' }),
    await call('podium_hiring', { report: 'import', import_id: IMP }),
    await call('podium_start_resume_import', { opening_id: OPEN }),
    await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }),
  ];
  for (const { r } of outs) {
    assert.equal(r.ok, true);
    assert.doesNotMatch(JSON.stringify(r.data), BAD);
  }
  // Names, email and phone stay (needed for review).
  const imp = outs[1].r.data.result;
  assert.equal(imp.items[0].fields.full_name, 'Asha Rao');
  assert.equal(imp.items[0].fields.email, 'asha@example.com');
  assert.deepEqual(imp.items[0].warnings, ['Phone not found in the CV text — dropped']);
  assert.deepEqual(imp.items[0].matches, [{ candidate_id: CAND, code: 'CAN-0042', name: 'Asha R' }]);
});
test('dropMatch: drops salary keys, keeps harmless look-alikes', () => {
  for (const k of ['current_ctc', 'expected_ctc', 'ctc', 'salary_band_max', 'can_see_salary', 'band', 'pending_band', 'has_band', 'band_min', 'pan', 'pan_number',
    'bank', 'bank_name', 'ifsc', 'account_number', 'aadhaar', 'aadhar_no', 'increment_pct', 'compensation', 'pay', 'payslip', 'stipend', 'bonus', 'comp']) assert.match(k, SALARY_KEY, k);
  for (const k of ['company', 'current_employer', 'panel', 'expand', 'span', 'payload', 'competencies', 'opening_code', 'application_counts', 'candidate_id', 'full_name', 'email', 'phone', 'skills', 'education', 'notice_period_days', 'banner'])
    assert.doesNotMatch(k, SALARY_KEY, k);
});
test('openings: only the ones the caller can hire for, with their role; reads getMe alongside', async () => {
  const { r, b } = await call('podium_hiring', { report: 'openings' });
  assert.deepEqual(r.data.result.openings.map(o => [o.code, o.your_role, o.can_import_cvs, o.department]), [['OPN-007', ['hiring owner'], true, 'Growth']]);
  assert.deepEqual(r.data.result.openings[0].candidate_counts, { new: 3 });
  assert.deepEqual(b.seen.map(s => s.action).sort(), ['getMe', 'getOpenings']);
  assert.equal(b.seen.find(s => s.action === 'getOpenings').query.status, 'open');
  // podium_hiring permission → hiring team on every visible opening.
  const team = fake(routes({ getMe: [200, { ok: true, data: { employee_id: null, permissions: { podium_hiring: true } } }] }));
  const t = await call('podium_hiring', { report: 'openings', status: 'all' }, team);
  assert.equal(t.r.data.result.openings.length, 2);
  assert.deepEqual(t.r.data.result.openings[1].your_role, ['hiring team']);
});
test('corrections: only the non-salary draft fields, typed', () => {
  assert.deepEqual(parseCorrections({ full_name: ' Asha Rao ', notice_period_days: 30, skills: ['SQL'] }), { ok: true, value: { full_name: 'Asha Rao', notice_period_days: 30, skills: ['SQL'] } });
  for (const k of ['current_ctc', 'expected_ctc', 'salary', 'pan', 'bank_name']) assert.match(parseCorrections({ [k]: 1 }).error, /salary fields cannot be set/, k);
  assert.match(parseCorrections({ age: 30 }).error, /not a candidate field/);
  assert.match(parseCorrections({ notice_period_days: 12.5 }).error, /whole number/);
  assert.match(parseCorrections({ full_name: '' }).error, /full_name/);
  assert.match(parseCorrections({ email: 'nope' }).error, /email/);
  assert.equal(parseCorrections([1]).ok, false);
  const t = findTool('podium_accept_resume');
  assert.match(t.parse({ import_id: IMP, item_id: ITEM, corrections: { expected_ctc: 2500000 } }).error, /salary fields cannot be set/);
});
test('accept: posts the server-side draft WITH ctc preserved, corrections on top', async () => {
  const { r, b } = await call('podium_accept_resume', { import_id: IMP, item_id: ITEM, corrections: { full_name: 'Asha K Rao', notice_period_days: 30 } });
  const post = b.seen.find(s => s.method === 'POST');
  assert.equal(post.action, 'cvImportAccept');
  assert.deepEqual(post.body.data, { item_id: ITEM, draft: { full_name: 'Asha K Rao', email: 'asha@example.com', phone: '+91 98450 00000', skills: ['SQL'],
    total_experience_years: 4, current_ctc: 1800000, expected_ctc: 2400000, notice_period_days: 30 } });
  assert.equal(b.seen[0].action, 'getCvImport'); assert.equal(b.seen[0].query.id, IMP);
  assert.equal(r.data.done, 'podium_accept_resume');
  assert.deepEqual(r.data.result.candidate, { id: CAND, code: 'CAN-0042', name: 'Asha R', new: true });
  assert.equal(r.data.result.application_id, 'app-1');
});
test('accept: candidate_id attaches; an item not in the batch is refused before any write', async () => {
  const { b } = await call('podium_accept_resume', { import_id: IMP, item_id: ITEM, candidate_id: CAND });
  assert.equal(b.seen.find(s => s.method === 'POST').body.data.candidate_id, CAND);
  const other = '77777777-1b2c-4d5e-8f90-123456789abc';
  const n = await call('podium_accept_resume', { import_id: IMP, item_id: other });
  assert.match(n.r.userError, /not in this batch/);
  assert.equal(n.b.seen.some(s => s.method === 'POST'), false);
});
test('accept: duplicate guard and unknown outcome in plain words', async () => {
  const dup = fake(routes({ cvImportAccept: [409, { ok: false, error: 'duplicate', message: 'Already in Podium: Asha R (CAN-0042)' }] }));
  assert.match((await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, dup)).r.userError, /candidate_id/);
  const lost = fake(routes({ cvImportAccept: [500, { ok: false, error: 'server_error: boom' }] }));
  assert.deepEqual((await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, lost)).r, { ok: false, reason: 'podium write unconfirmed' });
  assert.match(refusalText('podium write unconfirmed').text, /podium_hiring report=import/);
  assert.equal(refusalText('podium write unconfirmed').fault, true);
});
test('worker 403 → podium denied refusal (reads and writes)', async () => {
  const no = fake(routes({ getOpenings: [403, { ok: false, error: 'forbidden' }], getCvImport: [403, { ok: false, error: 'forbidden' }], createCvImport: [403, { ok: false, error: 'forbidden' }] }));
  assert.deepEqual((await call('podium_hiring', { report: 'openings' }, no)).r, { ok: false, reason: 'podium denied' });
  assert.deepEqual((await call('podium_hiring', { report: 'import', import_id: IMP }, no)).r, { ok: false, reason: 'podium denied' });
  assert.deepEqual((await call('podium_start_resume_import', { opening_id: OPEN }, no)).r, { ok: false, reason: 'podium denied' });
  assert.deepEqual((await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, no)).r, { ok: false, reason: 'podium denied' });
  assert.equal(refusalText('podium denied').fault, false);
  assert.equal(refusalText('no podium grant').fault, false);
});
test('start import: source other + note, upload link, what_next; JD gate in plain words', async () => {
  const { r, b } = await call('podium_start_resume_import', { opening_id: OPEN, note: 'Naukri batch' });
  assert.deepEqual(b.seen[0].body, { action: 'createCvImport', data: { opening_id: OPEN, source: 'other', source_detail: 'AI connector: Naukri batch' } });
  assert.equal(r.data.result.upload_link, `https://podium.legendoftoys.com/hiring/import/batch/?id=${IMP}`);
  assert.equal(uploadLink(IMP), r.data.result.upload_link);
  assert.match(r.data.result.what_next, /drop the CV files/);
  const jd = fake(routes({ createCvImport: [409, { ok: false, error: 'jd_required', message: 'Add the JD to this opening first' }] }));
  assert.match((await call('podium_start_resume_import', { opening_id: OPEN }, jd)).r.userError, /no JD yet/);
});
test('parse validation', () => {
  const s = findTool('podium_start_resume_import'), a = findTool('podium_accept_resume'), h = findTool('podium_hiring');
  assert.match(s.parse({}).error, /opening_id/);
  assert.match(s.parse({ opening_id: 'nope' }).error, /uuid/);
  assert.match(s.parse({ opening_id: OPEN, source: 'mcp' }).error, /not a field/);
  assert.match(s.parse({ opening_id: OPEN, note: 'x'.repeat(151) }).error, /150/);
  assert.match(a.parse({ item_id: ITEM }).error, /import_id/);
  assert.match(a.parse({ import_id: IMP, item_id: 'x' }).error, /uuid/);
  assert.match(a.parse({ import_id: IMP, item_id: ITEM, candidate_id: 'x' }).error, /candidate_id/);
  assert.match(a.parse({ import_id: IMP, item_id: ITEM, draft: {} }).error, /not a field/);
  assert.equal(h.parse({ report: 'import' }).ok, false);
  assert.equal(h.parse({ report: 'import', import_id: 'x' }).ok, false);
  assert.equal(h.parse({ report: 'openings', status: 'weird' }).ok, false);
  assert.deepEqual(h.parse({ report: 'import', import_id: IMP }).value, { report: 'import', params: { id: IMP } });
});
test('podium tools hidden without the podium grant; writes say so', () => {
  const names = g => toolsFor(g).map(t => t.name).filter(n => n.startsWith('podium_'));
  assert.deepEqual(names({ systems: ['docket', 'odo'] }), []);
  assert.deepEqual(names({ systems: ['podium'] }).sort(), ['podium_accept_resume', 'podium_hiring', 'podium_start_resume_import']);
  assert.equal(findTool('podium_hiring').annotations.readOnlyHint, true);
  for (const n of ['podium_start_resume_import', 'podium_accept_resume']) {
    const t = findTool(n);
    assert.equal(t.annotations.readOnlyHint, false); assert.equal(t.annotations.destructiveHint, false); assert.equal(t.write, true);
  }
});

// ---- review fixes (hostile review + Codex, 2026-11-13)
const withItems = (items, extra = {}) => fake(routes({ getCvImport: [200, { ok: true, data: { ...IMPORT.data, items, ...extra } }] }));
const OTHER_CAND = '88888888-1b2c-4d5e-8f90-123456789abc';

test('1: per-item matches mirror the import page (normEmail / normPhone); candidate_id must be one of THIS CV\'s', async () => {
  const d = { duplicates: [{ id: CAND, candidate_code: 'CAN-0042', full_name: 'A', email_norm: 'asha@example.com', phone_norm: null },
    { id: OTHER_CAND, candidate_code: 'CAN-0050', full_name: 'B', email_norm: null, phone_norm: '9845000000' }], hidden_keys: ['9999999999'] };
  assert.deepEqual(matchesFor({ email: '  ASHA@Example.com ' }, d).matches.map(m => m.id), [CAND]);
  assert.deepEqual(matchesFor({ phone: '+91 98450-00000' }, d).matches.map(m => m.id), [OTHER_CAND]);
  assert.equal(matchesFor({ phone: '(0) 99999 99999' }, d).hidden, true);
  assert.deepEqual(matchesFor({ email: 'x@y.com' }, d), { matches: [], hidden: false });
  // Another CV's match is not this CV's: refused before any write.
  const b = withItems([{ ...ITEM_ROW, extracted: { fields: { full_name: 'Ravi', email: 'ravi@example.com' } } }]);
  const r = await call('podium_accept_resume', { import_id: IMP, item_id: ITEM, candidate_id: CAND }, b);
  assert.equal(r.r.byGateway, true); assert.match(r.r.userError, /not one of this CV's matches/);
  assert.equal(r.b.seen.some(s => s.method === 'POST'), false);
  const imp = (await call('podium_hiring', { report: 'import', import_id: IMP }, b)).r.data.result;
  assert.deepEqual(imp.items[0].matches, []); assert.equal(imp.duplicates, undefined);
});
test('2: with candidate_id only notice_period_days may be corrected', () => {
  const t = findTool('podium_accept_resume');
  assert.match(t.parse({ import_id: IMP, item_id: ITEM, candidate_id: CAND, corrections: { full_name: 'X' } }).error, /only notice_period_days/);
  assert.equal(t.parse({ import_id: IMP, item_id: ITEM, candidate_id: CAND, corrections: { notice_period_days: 30 } }).ok, true);
  assert.match(t.description, /only notice_period_days/);
});
test('3: pay details in free text: masked on output, refused on input; harmless strings survive', async () => {
  const probes = ['CTC 18 LPA', '18 LPA', 'Asha_CTC_18L.pdf', 'Example_18LPA.pdf', 'CTC 18 LPA; PAN ABCDE1234F', '₹24,00,000', 'expected 24 lacs',
    'Asha_18L.pdf', '12 l.p.a.', '50k/month', '6 lakhs', '1.2 cr', 'Rs. 50000', '12,00,000 per annum', 'salary negotiable', 'package of 18', 'HDFC0001234'];
  for (const p of probes) assert.equal(payText(p), true, p);
  const safe = ['B.Tech, IIT Bombay', 'Salesforce', 'Pancake', 'Panasonic', 'HDFC Bank', 'Packaging Engineer', 'Python packages', 'asha.pdf', '+91 98450 00000',
    'Bangalore, India', 'Lakshmi Rao', CAND, '2026-11-13T10:00:00Z', 'CAN-0042', 'Prince2'];
  for (const p of safe) assert.equal(payText(p), false, p);
  const b = withItems([{ ...ITEM_ROW, file_name: 'Asha_CTC_18L.pdf', extracted: { fields: { full_name: 'Asha Rao', education: 'CTC 18 LPA', skills: ['18 LPA', 'Salesforce'], location: 'expected 24 lacs' } } }]);
  const it = (await call('podium_hiring', { report: 'import', import_id: IMP }, b)).r.data.result.items[0];
  assert.equal(it.file_name, REMOVED); assert.equal(it.fields.education, REMOVED); assert.equal(it.fields.location, REMOVED);
  assert.deepEqual(it.fields.skills, [REMOVED, 'Salesforce']); assert.equal(it.fields.full_name, 'Asha Rao');
  assert.equal(clean({ f: 'Example_18LPA.pdf', n: { a: ['₹24,00,000'] } }).data.n.a[0], REMOVED);
  // Input: corrections and the note.
  assert.match(parseCorrections({ education: 'CTC 18 LPA' }).error, /pay details/);
  assert.match(parseCorrections({ skills: ['18 LPA'] }).error, /pay details/);
  assert.match(parseCorrections({ location: 'expected 24 lacs' }).error, /pay details/);
  assert.equal(parseCorrections({ education: 'B.Tech, IIT Bombay', skills: ['Salesforce'] }).ok, true);
  assert.match(findTool('podium_start_resume_import').parse({ opening_id: OPEN, note: 'CTC 18 LPA; PAN ABCDE1234F' }).error, /pay details/);
  assert.match(findTool('podium_start_resume_import').parse({ opening_id: OPEN, note: '₹24,00,000' }).error, /pay details/);
});
test('4: last_error never passes through', async () => {
  const b = withItems([{ ...ITEM_ROW, status: 'needs_manual', last_error: 'db_error: {"code":"23505","details":"Key (email_norm)=(asha@example.com)"}' }]);
  const it = (await call('podium_hiring', { report: 'import', import_id: IMP }, b)).r.data.result.items[0];
  assert.equal(it.problem, 'Podium could not read or save this CV; open the import page to see why');
  assert.equal(JSON.stringify(it).includes('23505'), false); assert.equal('last_error' in it, false);
});
test('5: no salary access → no draft sent (Podium keeps its stored CTC); corrections refused', async () => {
  const nosal = () => withItems([{ ...ITEM_ROW, extracted: { fields: { full_name: 'Asha Rao', email: 'asha@example.com' } } }], { can_see_salary: false });
  const r = await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, nosal());
  assert.equal(r.r.ok, true);
  assert.deepEqual(r.b.seen.find(s => s.method === 'POST').body.data, { item_id: ITEM });
  const c = await call('podium_accept_resume', { import_id: IMP, item_id: ITEM, corrections: { notice_period_days: 30 } }, nosal());
  assert.equal(c.r.byGateway, true); assert.match(c.r.userError, /import page/);
  assert.equal(c.b.seen.some(s => s.method === 'POST'), false);
  // A missing flag is treated as no salary access.
  const unk = withItems([ITEM_ROW], { can_see_salary: undefined });
  assert.equal((await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, unk)).b.seen.find(s => s.method === 'POST').body.data.draft, undefined);
});
test('6: linkedin_url follows cvimport.js (linkedin.com/in/<slug>), normalised; anything else refused', () => {
  assert.deepEqual(parseCorrections({ linkedin_url: 'linkedin.com/in/asha-rao/' }).value, { linkedin_url: 'https://www.linkedin.com/in/asha-rao' });
  assert.deepEqual(parseCorrections({ linkedin_url: 'https://in.linkedin.com/in/asha_rao?trk=x' }).value, { linkedin_url: 'https://www.linkedin.com/in/asha_rao' });
  for (const bad of ['javascript:alert(1)//linkedin.com/in/x', 'https://evil.com/?linkedin.com/in/x', 'https://linkedin.com/company/lot', 'https://linkedin.com.evil.com/in/x'])
    assert.equal(parseCorrections({ linkedin_url: bad }).ok, false, bad);
});
test('7: refusals in plain words: read errors, item status, attach 403', async () => {
  const nf = fake(routes({ getCvImport: [404, { ok: false, error: 'not_found' }] }));
  assert.match((await call('podium_hiring', { report: 'import', import_id: IMP }, nf)).r.userError, /no CV batch or CV with that id/);
  assert.match((await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, nf)).r.userError, /no CV batch or CV with that id/);
  for (const [st, re] of [['uploaded', /still being read/], ['extracting', /still being read/], ['accepted', /already done/], ['skipped', /already done/]]) {
    const r = await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, withItems([{ ...ITEM_ROW, status: st }]));
    assert.match(r.r.userError, re, st); assert.equal(r.r.byGateway, true); assert.equal(r.b.seen.some(s => s.method === 'POST'), false);
  }
  const att = fake(routes({ cvImportAccept: [403, { ok: false, error: 'forbidden' }] }));
  assert.match((await call('podium_accept_resume', { import_id: IMP, item_id: ITEM, candidate_id: CAND }, att)).r.userError, /won't let you add this CV to that person: ask HR or hiring/);
  assert.deepEqual((await call('podium_accept_resume', { import_id: IMP, item_id: ITEM }, att)).r, { ok: false, reason: 'podium denied' });
});
test('8: the call audit row keeps ids + correction KEYS only', () => {
  const t = findTool('podium_accept_resume');
  assert.deepEqual(JSON.parse(JSON.stringify(t.auditArgs({ import_id: IMP, item_id: ITEM, corrections: { email: 'asha@example.com', phone: '+91 98450 00000' } }))),
    { import_id: IMP, item_id: ITEM, corrections_keys: ['email', 'phone'] });
  assert.doesNotMatch(JSON.stringify(t.auditArgs({ import_id: IMP, item_id: ITEM, candidate_id: CAND, corrections: { email: 'asha@example.com' } })), /asha@/);
  assert.deepEqual(JSON.parse(JSON.stringify(t.auditArgs('junk'))), {});
  // src/index.js builds the `call` row from auditArgs when a tool has one.
  assert.match(readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'), /params: auditParams\(tool\.auditArgs \? tool\.auditArgs\(args\) : args\)/);
});
test('10: salary keys the projection does not know about are dropped (fails without dropMatch)', async () => {
  // `fields` is Podium's own draft passed through, not a fixed projection: only dropMatch stands between these and the output.
  const b = withItems([{ ...ITEM_ROW, final: { full_name: 'Asha Rao', current_ctc: 1800000, expected_ctc: 2400000, salary_expectation: 'x', ctc_breakup: { fixed: 1 },
    bank_details: { name: 'x' }, pan_number: 'y', new_compensation_field: 1, variable_pay: 2, company: 'Acme' } }]);
  const f = (await call('podium_hiring', { report: 'import', import_id: IMP }, b)).r.data.result.items[0].fields;
  assert.deepEqual(f, { full_name: 'Asha Rao', company: 'Acme' });
});

test('Codex re-check 2026-11-13: more pay phrasings masked, ordinary CV text kept, odd LinkedIn paths refused', async () => {
  const { payText } = await import('../src/tools/podium.js');
  for (const s of ['Expected: 18 L', '25k pm', '75,000 per month', 'PAN: abcde1234f', 'CTC 18,00,000', '12 p.a.', '₹ 2.4 Cr', '24 lakhs per annum'])
    assert.equal(payText(s), true, s);
  for (const s of ['P.A. to the director', 'Processed 1,200,000 records', 'Salesforce', 'Panasonic', 'HDFC Bank', 'B.Tech, IIT Bombay', 'Python 3 libraries', 'Level 2 lead'])
    assert.equal(payText(s), false, s);
  const t = findTool('podium_accept_resume');
  for (const bad of ['https://linkedin.com/in/..', 'https://linkedin.com/in/%2e%2e', 'linkedin.com/in/.hidden'])
    assert.equal(t.parse({ import_id: IMP, item_id: ITEM, corrections: { linkedin_url: bad } }).ok, false, bad);
  assert.equal(t.parse({ import_id: IMP, item_id: ITEM, corrections: { linkedin_url: 'linkedin.com/in/asha-k' } }).value.corrections.linkedin_url, 'https://www.linkedin.com/in/asha-k');
});
