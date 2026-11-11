// Hiring C3 — template merge + PDF render (src/offer-render.js), against the template bodies AS SEEDED in
// migrations/0008_hiring_offers.sql. Synthetic people and figures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { computeAnnexure } from '../src/offer-calc.js';
import {
  fmtINR, fmtLetterDate, mergeBody, offerFields, renderOfferText, renderOfferPdf, validateTemplateBody, sha256Hex,
  OFFER_FIELDS,
} from '../src/offer-render.js';

const sql = readFileSync(new URL('../migrations/0008_hiring_offers.sql', import.meta.url), 'utf8');
const bodies = [...sql.matchAll(/\('(employment|internship)', 1, '([^']+)', \$tpl\$([\s\S]*?)\$tpl\$/g)]
  .map(m => ({ template_key: m[1], title: m[2], body: m[3] }));
const R26 = JSON.parse(sql.match(/\('IN-2026-09',[^$]*\$rules\$([\s\S]*?)\$rules\$/)[1]);
const EMP = { ...bodies.find(b => b.template_key === 'employment'), entity_name: 'Example Entity Pvt Ltd',
  entity_address: ['1 Test Road,', 'Testville - 000000'], footer_note: 'Medical insurance premium will be over and above your CTC.' };
const INT = { ...bodies.find(b => b.template_key === 'internship'), entity_name: 'Example Entity Pvt Ltd', entity_address: ['1 Test Road,'] };
const SIG = { display_name: 'Test Signatory', phone: '+91 00000 11111', title: null };
const CAND = { full_name: 'Test Candidate' };
const OFFER = {
  offer_ref: 'OFR-2026-001', revision: 2, issue_date: '2026-11-03', valid_until: '2026-11-10',
  mode: 'salary', fixed_annual: 450000, variable_annual: 50000, variable_label: 'variable pay', variable_frequency: 'half-yearly',
  joining_bonus: 0, retention_bonus: 0, designation: 'Test Analyst', department_name: '', location: 'Bangalore',
  start_date: '2026-12-01', probation_months: 3,
};
const annex = (o = OFFER) => computeAnnexure({ ...o, work_state: 'Karnataka' }, R26);
const text = (v) => v.paragraphs.map(p => p.join('\n')).join('\n\n');

test('both templates are seeded and pass the merge-field check', () => {
  assert.equal(bodies.length, 2);
  for (const b of bodies) assert.equal(validateTemplateBody(b.body), null, b.template_key);
});

test('fmtINR uses Indian grouping; fmtLetterDate is "3rd November 2026"', () => {
  assert.equal(fmtINR(540000), '5,40,000');
  assert.equal(fmtINR(12345678), '1,23,45,678');
  assert.equal(fmtINR(999), '999');
  assert.equal(fmtINR(1000), '1,000');
  assert.equal(fmtINR('250000'), '2,50,000');
  assert.equal(fmtINR(-1500), '-1,500');
  assert.equal(fmtINR(null), '');
  assert.equal(fmtLetterDate('2026-11-03'), '3rd November 2026');
  assert.equal(fmtLetterDate('2026-07-29'), '29th July 2026');
  assert.equal(fmtLetterDate('2026-06-11'), '11th June 2026');
  assert.equal(fmtLetterDate('2026-06-22'), '22nd June 2026');
  assert.equal(fmtLetterDate('2026-06-01'), '1st June 2026');
  assert.equal(fmtLetterDate(null), '');
});

test('merge: fields, truthy sections, paragraphs on blank lines', () => {
  const f = { candidate_name: 'A', has_variable: true, variable_annual: '10', has_department: false, department: 'X' };
  const all = Object.fromEntries(OFFER_FIELDS.map(k => [k, '']));
  const p = mergeBody('Dear {{candidate_name}},\n\nPay{{#has_variable}} + {{variable_annual}}{{/has_variable}}.{{#has_department}} in {{department}}{{/has_department}}\nline two', { ...all, ...f });
  assert.deepEqual(p, [['Dear A,'], ['Pay + 10.', 'line two']]);
});

test('merge refuses unknown fields, unknown sections, unclosed sections and stray braces', () => {
  const all = Object.fromEntries(OFFER_FIELDS.map(k => [k, 'x']));
  assert.throws(() => mergeBody('Hi {{salary}}', all), /unknown_field:salary/);
  assert.throws(() => mergeBody('{{#nope}}x{{/nope}}', all), /unknown_field:nope/);
  assert.throws(() => mergeBody('{{#has_variable}}x', all), /unclosed_section/);
  assert.throws(() => mergeBody('a {{ b', all), /bad_tag/);
  assert.equal(validateTemplateBody('Hi {{ctc}}'), 'unknown_field:ctc');
});

test('employment letter: today\'s wording with the optional sections', () => {
  const v = renderOfferText({ template: EMP, offer: OFFER, annexure: annex(), signatory: SIG, candidate: CAND });
  const t = text(v);
  assert.equal(v.title, 'Offer of Employment');
  assert.match(t, /^Dated: 3rd November 2026\n\nDear Test Candidate,/);
  assert.match(t, /extend an offer to join Example Entity Pvt Ltd \(Legend of Toys\)\./);
  assert.match(t, /your fixed salary will be INR 4,50,000 per annum \(before all customary payroll deductions\)/);
  assert.match(t, /you will be given a variable pay of up to INR 50,000 per annum paid half-yearly\./);
  assert.match(t, /on or before 1st December 2026 and you are designated as Test Analyst\. The location of work will be Bangalore\./);
  assert.match(t, /confidentiality, non-compete and similar obligations/);
  assert.match(t, /includes a 3-month probationary period\./);
  assert.match(t, /Please confirm by sending a signed copy of this letter over email\./);
  assert.doesNotMatch(t, /joining bonus|retention bonus| department/);
  assert.equal(v.footer, 'OFR-2026-001 · r2 · 3rd November 2026');
  assert.equal(v.letterhead.phone, '+91 00000 11111');
  assert.equal(v.closing.name, 'Test Signatory');
  assert.equal(v.annexure.heading, 'Annexure I: CTC Break Up');
  assert.deepEqual(v.annexure.rows[0].cells, ['Basic Salary', '2,25,000', '18,750']);
  assert.ok(v.annexure.notes.includes('Medical insurance premium will be over and above your CTC.'));
  assert.equal(v.annexure.in_hand.value, fmtINR(annex().in_hand_monthly));
});

test('employment letter: incentive article, department, bonuses, no probation, no variable', () => {
  const o = { ...OFFER, variable_label: 'incentive pay', department_name: 'Test Dept', joining_bonus: 25000, probation_months: 0 };
  const t = text(renderOfferText({ template: EMP, offer: o, annexure: annex(o), signatory: SIG, candidate: CAND }));
  assert.match(t, /given an incentive pay of up to INR 50,000/);
  assert.match(t, /designated as Test Analyst in Test Dept department\./);
  assert.match(t, /one-time joining bonus of INR 25,000/);
  assert.doesNotMatch(t, /probationary/);
  const nv = { ...OFFER, variable_annual: 0 };
  assert.doesNotMatch(text(renderOfferText({ template: EMP, offer: nv, annexure: annex(nv), signatory: SIG, candidate: CAND })), /In addition/);
});

test('internship letter: stipend × months, Intern — designation, no non-compete', () => {
  const o = { ...OFFER, mode: 'stipend', fixed_annual: null, variable_annual: 0, stipend_monthly: 15000, internship_months: 6 };
  const a = computeAnnexure(o, R26);
  const v = renderOfferText({ template: INT, offer: o, annexure: a, signatory: SIG, candidate: CAND });
  const t = text(v);
  assert.equal(v.title, 'Internship Offer');
  assert.match(t, /stipend of INR 15,000 per month for 6 months/);
  assert.match(t, /designated as Intern — Test Analyst/);
  assert.match(t, /certificate of internship/);
  assert.doesNotMatch(t, /non-compete/);
  assert.equal(v.annexure.heading, 'Annexure I: Stipend');
  assert.deepEqual(v.annexure.rows[0].cells, ['Stipend', '15,000', '90,000']);
});

test('PDF: two A4 pages, deterministic bytes, changes with the inputs', async () => {
  const args = { template: EMP, offer: OFFER, annexure: annex(), signatory: SIG, candidate: CAND };
  const a = await renderOfferPdf(args);
  const b = await renderOfferPdf(structuredClone(args));
  assert.ok(a instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(a.slice(0, 5)), '%PDF-');
  assert.equal(await sha256Hex(a), await sha256Hex(b), 'same inputs → same bytes');
  const doc = await PDFDocument.load(a, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 2);
  const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
  assert.ok(Math.abs(w - 595.28) < 0.01 && Math.abs(h - 841.89) < 0.01, 'A4');
  assert.equal(doc.getProducer(), 'Podium');
  assert.equal(doc.getCreationDate().toISOString(), '2026-11-02T18:30:00.000Z', 'creation date = issue date (IST midnight)');
  const c = await renderOfferPdf({ ...args, offer: { ...OFFER, revision: 3 } });
  assert.notEqual(await sha256Hex(c), await sha256Hex(a));
  assert.match(await sha256Hex(a), /^[0-9a-f]{64}$/);
});

test('PDF: characters Helvetica cannot draw are mapped, not fatal', async () => {
  const t = { ...EMP, body: 'Dated: {{issue_date}}\n\nDear {{candidate_name}}, ₹ 5 — ok ✓ ​' };
  const bytes = await renderOfferPdf({ template: t, offer: OFFER, annexure: null, signatory: SIG, candidate: { full_name: 'Zoë Test' } });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('offerFields never carries a figure the offer does not', () => {
  const f = offerFields({ offer: { ...OFFER, variable_annual: 0, joining_bonus: 0 }, signatory: SIG, candidate: CAND, entityName: 'E' });
  assert.equal(f.has_variable, false);
  assert.equal(f.has_joining_bonus, false);
  assert.equal(f.has_probation, true);
  assert.equal(f.revision, '2');
});
