// X1b — relieving + experience letters (src/exit-letters.js + issueExitLetter), against the template bodies AS SEEDED
// in migrations/0022_exit_letters.sql. Synthetic people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import {
  EXIT_LETTER_FIELDS, exitLetterRef, nextExitLetterRef, exitLetterPath, exitLetterFileName, exitLetterTitle,
  exitLetterBlock, exitLetterView, renderExitLetterPdf, validateExitLetterBody, EXIT_LETTER_DOC_TYPE, unsupportedCharField,
} from '../src/exit-letters.js';
import { sha256Hex } from '../src/offer-render.js';
import { issueExitLetter, getExitLetterUrl, cancelExit } from '../src/index.js';

const sql = readFileSync(new URL('../migrations/0022_exit_letters.sql', import.meta.url), 'utf8');
const seeded = [...sql.matchAll(/\('(relieving|experience)', '([^']+)', \$tpl\$([\s\S]*?)\$tpl\$\)/g)]
  .map(m => ({ template_key: m[1], title: m[2], body: m[3] }));
const LH = { entity_name: 'Example Entity Pvt Ltd', entity_address: ['1 Test Road,', 'Testville - 000000'] };
const REL = { id: 't-rel', version: 1, ...seeded.find(t => t.template_key === 'relieving'), ...LH };
const EXP = { id: 't-exp', version: 1, ...seeded.find(t => t.template_key === 'experience'), ...LH };
const EID = '11111111-1111-4111-8111-111111111111';
const XID = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';
const EMP = { id: EID, full_name: 'Test Person', employee_code: 'EMP-T01', job_title: 'Test Analyst', date_joined: '2024-06-03' };
const EXIT = { id: XID, employee_id: EID, status: 'closed', lwd: '2026-10-31' };
const SIG = { id: SID, display_name: 'Test Signatory', title: null, active: true, employee_id: null };
const args = (o = {}) => ({ exit: EXIT, employee: EMP, department: null, template: REL, signatory: SIG,
  issueDate: '2026-11-13', ref: 'REL-2026-001', revision: 1, ...o });
const text = (v) => v.paragraphs.map(p => p.join('\n')).join('\n\n');

test('both templates are seeded with the Fraternitas letterhead copied, and pass the merge-field check', () => {
  assert.equal(seeded.length, 2);
  for (const t of seeded) assert.equal(validateExitLetterBody(t.body), null, t.template_key);
  assert.match(sql, /from podium\.offer_templates\s+where template_key = 'employment' and is_current/);
  assert.deepEqual(seeded.map(t => t.title), ['RELIEVING LETTER', 'TO WHOM IT MAY CONCERN']);
});

test('relieving letter: the draft wording, department section, closing "For <entity>"', () => {
  const v = exitLetterView(args());
  assert.equal(v.title, 'RELIEVING LETTER');
  assert.equal(text(v), 'Date: 13th November 2026 · Ref: REL-2026-001\n\nDear Test Person,\n\n'
    + 'This is to confirm that you have been relieved of your duties with Example Entity Pvt Ltd with effect from the close of business on 31st October 2026. '
    + 'At the time of leaving you were working as Test Analyst (Employee Code EMP-T01).\n\n'
    + 'We thank you for your contribution and wish you the very best.');
  assert.deepEqual(v.closing, { salutation: 'For Example Entity Pvt Ltd', name: 'Test Signatory', title: null });
  assert.equal(v.letterhead.phone, null);
  assert.equal(v.footer, 'REL-2026-001 · 13th November 2026');
  const d = exitLetterView(args({ department: { name: 'Test Dept' }, signatory: { ...SIG, title: 'Director' }, revision: 2 }));
  assert.match(text(d), /working as Test Analyst in the Test Dept team \(Employee Code EMP-T01\)\./);
  assert.equal(d.closing.title, 'Director');
  assert.equal(d.footer, 'REL-2026-001 · r2 · 13th November 2026');
});

test('experience letter: joining → LWD, no dues / F&F claim', () => {
  const t = text(exitLetterView(args({ template: EXP, ref: 'EXP-2026-004' })));
  assert.match(t, /^Date: 13th November 2026 · Ref: EXP-2026-004\n\nThis is to certify that Test Person \(Employee Code EMP-T01\) was employed with Example Entity Pvt Ltd from 3rd June 2024 to 31st October 2026\./);
  assert.match(t, /the designation held was Test Analyst\./);
  assert.match(t, /We wish Test Person success in all future endeavours\.$/);
  assert.doesNotMatch(t, /dues|full (and|&) final|settle/i);
});

test('template check: unknown field, an OFFER field, unclosed section → refused', () => {
  assert.equal(validateExitLetterBody('Hi {{salary}}'), 'unknown_field:salary');
  assert.equal(validateExitLetterBody('Hi {{candidate_name}}'), 'unknown_field:candidate_name');
  assert.equal(validateExitLetterBody('{{#has_department}}x'), 'unclosed_section');
  assert.throws(() => exitLetterView(args({ template: { ...REL, body: '{{fixed_annual}}' } })), /unknown_field:fixed_annual/);
  assert.ok(EXIT_LETTER_FIELDS.includes('has_signatory_title'));
});

test('refusals, in the plan order', () => {
  const b = (o = {}) => exitLetterBlock({ kind: 'relieving', exit: EXIT, employee: EMP, signatory: SIG, today: '2026-11-13', ...o });
  assert.equal(b(), null);
  assert.equal(b({ kind: 'nope' }), 'bad_kind');
  assert.equal(b({ exit: null }), 'exit_not_found');
  assert.equal(b({ exit: { ...EXIT, status: 'cancelled' } }), 'exit_cancelled');
  assert.equal(b({ exit: { ...EXIT, status: 'open', lwd: '2026-11-14' } }), 'before_lwd');
  assert.equal(b({ exit: { ...EXIT, status: 'open', lwd: '2026-11-13' } }), null, 'on the LWD itself: allowed (open exit)');
  assert.equal(b({ kind: 'experience', employee: { ...EMP, date_joined: null } }), 'no_joining_date');
  assert.equal(b({ employee: { ...EMP, date_joined: null } }), null, 'a relieving letter needs no joining date');
  assert.equal(b({ employee: { ...EMP, job_title: '  ' } }), 'no_designation');
  assert.equal(b({ signatory: null }), 'bad_signatory');
  assert.equal(b({ signatory: { ...SIG, active: false } }), 'bad_signatory');
  assert.equal(b({ signatory: { ...SIG, employee_id: EID } }), 'bad_signatory', 'the leaver never signs their own');
});

test('refs, revisions, paths, titles', () => {
  assert.equal(exitLetterRef('relieving', 2026, 1), 'REL-2026-001');
  assert.equal(exitLetterRef('experience', 2026, 42), 'EXP-2026-042');
  assert.equal(exitLetterRef('relieving', 2026, 1234), 'REL-2026-1234');
  assert.deepEqual(nextExitLetterRef({ kind: 'relieving', prior: [], counterLastN: 6, year: 2026 }), { ref: 'REL-2026-007', revision: 1 });
  assert.deepEqual(nextExitLetterRef({ kind: 'relieving', prior: [{ kind: 'relieving', revision: 2, letter_ref: 'REL-2026-003' }], counterLastN: 9, year: 2026 }),
    { ref: 'REL-2026-003', revision: 3 }, 're-issue keeps the ref, bumps the revision');
  const sha = 'a'.repeat(64);
  assert.equal(exitLetterPath(EID, 'REL-2026-001', 1, sha, 'ab-12'), `${EID}/exit_letters/REL-2026-001_r1_aaaaaaaaaaaa_ab12.pdf`);
  assert.notEqual(exitLetterPath(EID, 'REL-2026-001', 1, sha, 'n1'), exitLetterPath(EID, 'REL-2026-001', 1, sha, 'n2'), 'one object per attempt');
  assert.throws(() => exitLetterPath(EID, 'REL-2026-001', 1, sha, ''), /nonce required/);
  assert.equal(exitLetterFileName('REL-2026-001', 1), 'REL-2026-001.pdf');
  assert.equal(exitLetterFileName('REL-2026-001', 2), 'REL-2026-001-r2.pdf');
  assert.equal(exitLetterTitle('relieving', 'REL-2026-001', 1), 'Relieving letter — REL-2026-001');
  assert.equal(exitLetterTitle('experience', 'EXP-2026-001', 2), 'Experience letter — EXP-2026-001 (r2)');
  assert.deepEqual(EXIT_LETTER_DOC_TYPE, { relieving: 'relieving_letter', experience: 'experience_letter' });
});

test('PDF: one A4 page, deterministic, dated the issue date, changes with the ref', async () => {
  const a = await renderExitLetterPdf(args());
  const b = await renderExitLetterPdf(structuredClone(args()));
  assert.equal(await sha256Hex(a), await sha256Hex(b), 'same inputs → same bytes');
  const doc = await PDFDocument.load(a, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getProducer(), 'Podium');
  assert.equal(doc.getCreationDate().toISOString(), '2026-11-12T18:30:00.000Z');
  const c = await renderExitLetterPdf(args({ ref: 'REL-2026-002' }));
  assert.notEqual(await sha256Hex(c), await sha256Hex(a));
});

test('unsupported characters: a merged value the PDF font would alter is named, never printed as "?"', async () => {
  assert.equal(await unsupportedCharField(args()), null);
  assert.equal(await unsupportedCharField(args({ employee: { ...EMP, full_name: 'Zoë Test' } })), null, 'Latin-1 prints');
  assert.equal(await unsupportedCharField(args({ employee: { ...EMP, full_name: 'Test ✓ Person' } })), 'employee_name');
  assert.equal(await unsupportedCharField(args({ employee: { ...EMP, job_title: 'Lead ₹ Ops' } })), 'designation', 'mapped (₹ → INR) counts as altered');
  assert.equal(await unsupportedCharField(args({ signatory: { ...SIG, title: 'Dírector ✓' } })), 'signatory_title');
  assert.equal(await unsupportedCharField(args({ template: { ...REL, entity_name: 'Entity → Ltd' } })), 'entity_name');
});

test('migration: doc_type widened, RLS + service_role only, security definer + search_path, grants, reload', () => {
  const check = sql.match(/add constraint documents_doc_type_check check \(doc_type in \(([\s\S]*?)\)\);/)[1];
  for (const t of ['resume', 'offer_letter', 'employment_agreement', 'nda', 'education_cert', 'id_proof', 'bank_details',
    'address_proof', 'appraisal_letter', 'increment_letter', 'relieving_letter', 'experience_letter', 'other'])
    assert.ok(check.includes(`'${t}'`), t);
  assert.match(sql, /array\['exit_letter_templates', 'exit_letter_counters', 'exit_letters'\]/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on podium\.%I from anon, authenticated/);
  assert.match(sql, /grant all on podium\.%I to service_role/);
  for (const f of ['exit_letter_issue', 'exit_letter_template_new_version']) {
    assert.match(sql, new RegExp(`function podium\\.${f}\\(p jsonb\\)\\s+returns jsonb language plpgsql security definer set search_path to 'podium', 'public'`), f);
    assert.ok(sql.includes(`'${f}'`), `${f} in the grant loop`);
  }
  assert.match(sql, /revoke all on function podium\.%I\(jsonb\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function podium\.%I\(jsonb\) to service_role/);
  assert.match(sql.trim(), /notify pgrst, 'reload schema';$/);
  // Race safety: the exit row lock + the counter row bump live in the RPC, and a mismatch refuses.
  assert.match(sql, /from podium\.employee_exits where id = \(p->>'exit_id'\)::uuid for update/);
  assert.match(sql, /update podium\.exit_letter_counters set last_n = last_n \+ 1/);
  assert.match(sql, /raise exception 'podium_ref_conflict'/);
  assert.match(sql, /nullif\(p->>'expected_revision', ''\) is null[^;]*raise exception 'podium_bad_expected'/, 'expected revision required');
  assert.match(sql, /create trigger employee_exits_no_cancel_with_letters before update of status on podium\.employee_exits/);
  assert.match(sql, /raise exception 'podium_letters_issued'/);
  assert.match(sql, /lpad\(v_n::text, greatest\(3, length\(v_n::text\)\), '0'\)/, 'SQL ref padding = exitLetterRef');
});

test('enum drift: every employee doc-type list knows the two letters', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const restricted = src.slice(src.indexOf('const RESTRICTED_DOC_TYPES'), src.indexOf('const SALARY_DOC_TYPES'));
  const salary = src.split('\n').find(l => l.startsWith('const SALARY_DOC_TYPES'));
  const app = readFileSync(new URL('../../apps/podium/src/lib/format.js', import.meta.url), 'utf8');
  for (const t of ['relieving_letter', 'experience_letter']) {
    assert.ok(restricted.includes(`'${t}'`), `${t}: self + HR only`);
    assert.ok(!salary.includes(`'${t}'`), `${t}: no pay on it, not the salary tier`);
    assert.ok(app.includes(`id: '${t}'`), `${t}: app DOC_TYPES label`);
  }
});

// ── issueExitLetter / getExitLetterUrl / cancelExit with a mocked Supabase ───
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const HR = { userId: '44444444-4444-4444-8444-444444444444', permissions: { podium_view: true, podium_hr: true } };
const resp = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });

// priorRows(n) = this exit's letters of the kind as seen by the n-th context read.
async function withSupabase({ rpc = () => ({ body: {} }), counter = 0, held = [], heldLetter = [], emp = {}, priorRows = () => [],
  edges = [], letters = [], docs = [] }, fn) {
  const calls = { uploads: [], deletes: [], rpcs: [], patches: [] };
  const real = globalThis.fetch;
  let lastN = counter, priorReads = 0;
  globalThis.fetch = async (u, o = {}) => {
    const url = String(u).replace(ENV.SUPABASE_URL, '');
    const method = o.method || 'GET';
    if (url.startsWith('/storage/v1/object/sign/')) return resp({ signedURL: '/object/sign/x?token=t' });
    if (url.startsWith('/storage/v1/object/podium-documents/')) {
      const path = decodeURIComponent(url.slice('/storage/v1/object/podium-documents/'.length));
      if (method === 'POST') { calls.uploads.push(path); return resp({ Key: path }); }
      if (method === 'DELETE') { calls.deletes.push(path); return resp({}); }
    }
    if (url.startsWith('/rest/v1/rpc/exit_letter_issue')) {
      const p = JSON.parse(o.body).p;
      calls.rpcs.push(p);
      const out = rpc(p, calls.rpcs.length);
      if (out.bump) lastN = out.bump;
      return resp(out.body, out.status || 200);
    }
    if (url.startsWith('/rest/v1/employees?select=id,manager_id')) return resp(edges);
    if (url.startsWith('/rest/v1/employee_exits?id=eq.')) {
      if (method === 'PATCH') { calls.patches.push(JSON.parse(o.body)); return resp([{ ...EXIT, status: 'cancelled' }]); }
      return resp([EXIT]);
    }
    if (url.startsWith('/rest/v1/employees?id=eq.')) return resp([{ ...EMP, auth_user_id: null, department: null, ...emp }]);
    if (url.startsWith('/rest/v1/exit_letter_templates?')) return resp([REL]);
    if (url.startsWith('/rest/v1/offer_signatories?')) return resp([SIG]);
    if (url.startsWith('/rest/v1/exit_letters?exit_id=') && url.includes('kind=eq.')) return resp(priorRows(++priorReads));
    if (url.startsWith('/rest/v1/exit_letters?exit_id=')) return resp(letters);
    if (url.startsWith('/rest/v1/exit_letters?document_id=')) return resp(heldLetter);
    if (url.startsWith('/rest/v1/exit_letters?id=eq.')) return resp(letters);
    if (url.startsWith('/rest/v1/exit_letter_counters?')) return resp([{ last_n: lastN }]);
    if (url.startsWith('/rest/v1/documents?storage_path=')) return resp(held);
    if (url.startsWith('/rest/v1/documents?id=eq.')) return resp(docs);
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  try { const r = await fn(); return { res: r, body: await r.json(), calls }; } finally { globalThis.fetch = real; }
}
const body = { exit_id: XID, kind: 'relieving', signatory_id: SID };
const Y = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 4);   // the issue year = today IST
const raise = (code) => ({ status: 400, body: { code: 'P0001', message: code } });

test('issue: upload under the employee (nonce path), then ONE RPC with the predicted ref + revision', async () => {
  const { body: out, calls } = await withSupabase({ counter: 4, rpc: (p) => ({ body: { letter: { id: 'L1', letter_ref: p.expected_ref }, document: { id: 'D1' } } }) },
    () => issueExitLetter(body, HR, ENV));
  assert.equal(out.ok, true);
  assert.equal(calls.uploads.length, 1);
  assert.match(calls.uploads[0], new RegExp(`^${EID}/exit_letters/REL-${Y}-005_r1_[0-9a-f]{12}_[0-9a-f]{32}\\.pdf$`));
  assert.equal(calls.deletes.length, 0);
  const p = calls.rpcs[0];
  assert.equal(p.expected_ref, `REL-${Y}-005`);
  assert.equal(p.expected_revision, 1);
  assert.equal(p.storage_path, calls.uploads[0], 'the documents row gets exactly the uploaded path');
  assert.match(p.sha256, /^[0-9a-f]{64}$/);
  assert.equal(p.title, `Relieving letter — REL-${Y}-005`);
});

test('issue: a definite podium_* refusal removes the uploaded file', async () => {
  const { res, calls } = await withSupabase({ rpc: () => raise('podium_exit_cancelled') }, () => issueExitLetter(body, HR, ENV));
  assert.equal(res.status, 409);
  assert.deepEqual(calls.deletes, calls.uploads, 'the file this call wrote is gone');
});

test('issue: a lost response whose row DID commit keeps the file and returns that letter', async () => {
  const { body: out, calls } = await withSupabase({ held: [{ id: 'D9' }], heldLetter: [{ id: 'L9', document_id: 'D9' }],
    rpc: () => ({ status: 504, body: { message: 'timeout' } }) }, () => issueExitLetter(body, HR, ENV));
  assert.equal(calls.deletes.length, 0);
  assert.equal(out.ok, true);
  assert.equal(out.data.letter.id, 'L9');
});

test('issue: an indefinite failure with no row keeps the file (never deletes on a maybe) and reports', async () => {
  const { body: out, calls } = await withSupabase({ rpc: () => ({ status: 503, body: { message: 'upstream' } }) }, () => issueExitLetter(body, HR, ENV));
  assert.equal(out.ok, false);
  assert.equal(calls.deletes.length, 0);
  assert.equal(calls.rpcs.length, 1, 'no retry on an indefinite failure');
});

test('issue: a COUNTER race removes the stale file and re-renders with the fresh ref', async () => {
  const { body: out, calls } = await withSupabase({ counter: 0,
    rpc: (p, n) => (n === 1 ? { bump: 1, ...raise('podium_ref_conflict') } : { body: { letter: { letter_ref: p.expected_ref }, document: { id: 'D2' } } }) },
    () => issueExitLetter(body, HR, ENV));
  assert.equal(out.ok, true);
  assert.deepEqual(calls.rpcs.map(p => p.expected_ref), [`REL-${Y}-001`, `REL-${Y}-002`]);
  assert.deepEqual(calls.deletes, [calls.uploads[0]]);
  assert.equal(calls.uploads.length, 2);
  assert.notEqual(calls.uploads[0], calls.uploads[1]);
});

test('issue: a conflict that is NOT the counter comes back as ref_conflict — no silent r2', async () => {
  // Someone else issued r1 for this exit meanwhile: the re-read sees a prior row → stop.
  const a = await withSupabase({ rpc: () => raise('podium_ref_conflict'),
    priorRows: (n) => (n === 1 ? [] : [{ kind: 'relieving', revision: 1, letter_ref: `REL-${Y}-001` }]) }, () => issueExitLetter(body, HR, ENV));
  assert.equal(a.body.error, 'ref_conflict');
  assert.equal(a.calls.rpcs.length, 1);
  // A revision race (prediction r2) never retries.
  const b = await withSupabase({ rpc: () => raise('podium_ref_conflict'), priorRows: () => [{ kind: 'relieving', revision: 1, letter_ref: `REL-${Y}-001` }] },
    () => issueExitLetter(body, HR, ENV));
  assert.equal(b.body.error, 'ref_conflict');
  assert.equal(b.calls.rpcs.length, 1);
  assert.deepEqual(b.calls.deletes, b.calls.uploads);
});

test('issue: refusals stop before any upload; non-HR forbidden; HR never issues their own', async () => {
  const { body: out, calls } = await withSupabase({}, () => issueExitLetter({ ...body, signatory_id: 'nope' }, HR, ENV));
  assert.equal(out.error, 'bad_signatory');
  assert.equal(calls.uploads.length, 0);
  const f = await withSupabase({}, () => issueExitLetter(body, { userId: HR.userId, permissions: { podium_view: true } }, ENV));
  assert.equal(f.res.status, 403);
  const self = await withSupabase({ emp: { auth_user_id: HR.userId } }, () => issueExitLetter(body, HR, ENV));
  assert.equal(self.body.error, 'no_self_letter');
  assert.equal(self.calls.uploads.length, 0);
  const ch = await withSupabase({ emp: { full_name: 'Test ✓ Person' } }, () => issueExitLetter(body, HR, ENV));
  assert.equal(ch.body.error, 'unsupported_characters');
  assert.equal(ch.body.detail, 'employee_name');
  assert.equal(ch.calls.uploads.length, 0);
});

test('getExitLetterUrl: the person themselves or HR; never anyone else', async () => {
  const L = [{ id: 'L1', employee_id: EID, document_id: 'D1' }];
  const D = [{ id: 'D1', employee_id: EID, storage_path: `${EID}/exit_letters/x.pdf`, file_name: 'x.pdf' }];
  const u = (id = '55555555-5555-4555-8555-555555555555') => new URL(`https://w.test/?action=getExitLetterUrl&letter_id=${id}`);
  const SELF = { userId: '66666666-6666-4666-8666-666666666666', permissions: {} };
  const me = await withSupabase({ letters: L, docs: D, edges: [{ id: EID, auth_user_id: SELF.userId }] }, () => getExitLetterUrl(u(), SELF, ENV));
  assert.equal(me.body.ok, true);
  const other = await withSupabase({ letters: L, docs: D, edges: [{ id: 'someone-else', auth_user_id: SELF.userId }] }, () => getExitLetterUrl(u(), SELF, ENV));
  assert.equal(other.res.status, 403);
  const hr = await withSupabase({ letters: L, docs: D }, () => getExitLetterUrl(u(), HR, ENV));
  assert.equal(hr.body.ok, true);
  const bad = await withSupabase({ letters: L, docs: [{ ...D[0], storage_path: 'candidates/x.pdf' }] }, () => getExitLetterUrl(u(), HR, ENV));
  assert.equal(bad.res.status, 403, 'path must sit under the letter\'s employee');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(src.slice(src.indexOf('const SELF_SERVE_GET'), src.indexOf('const SELF_SERVE_POST')).includes("'getExitLetterUrl'"));
});

test('cancelExit: refused once letters exist', async () => {
  const OPEN = { ...EXIT, status: 'open' };
  const withOpen = async (letters) => {
    const real = globalThis.fetch;
    const patches = [];
    globalThis.fetch = async (u, o = {}) => {
      const url = String(u).replace(ENV.SUPABASE_URL, '');
      if (url.startsWith('/rest/v1/employee_exits?id=eq.')) {
        if ((o.method || 'GET') === 'PATCH') { patches.push(1); return resp([{ ...OPEN, status: 'cancelled' }]); }
        return resp([OPEN]);
      }
      if (url.startsWith('/rest/v1/employees?id=eq.')) return resp([{ ...EMP, auth_user_id: null }]);
      if (url.startsWith('/rest/v1/exit_letters?exit_id=')) return resp(letters);
      throw new Error(`unexpected fetch ${url}`);
    };
    try { const r = await cancelExit({ exit_id: XID, reason: 'withdrawn by the person' }, HR, ENV); return { out: await r.json(), patches }; }
    finally { globalThis.fetch = real; }
  };
  const blocked = await withOpen([{ id: 'L1' }]);
  assert.equal(blocked.out.error, 'letters_issued');
  assert.match(blocked.out.message, /ask Afshaan/);
  assert.equal(blocked.patches.length, 0);
  const fine = await withOpen([]);
  assert.equal(fine.out.ok, true);
  assert.equal(fine.patches.length, 1);
});
