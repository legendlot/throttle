import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import {
  CV_SCHEMA, DRAFT_FIELDS, buildExtractRequest, parseExtractResponse, readUsage, validateExtraction,
  quoteFound, foldText, cleanText, docxXmlToText, costInr, estimateInr, importItemPath, checkImportItemPath,
  pickDraft, MAX_TEXT_CHARS, fileExtOf,
} from '../src/cvimport.js';
import { cvText } from '../src/cvtext.js';

const CV = `Riya Sample
Pune, Maharashtra · riya.sample@example.com · +91 98765 43210
linkedin.com/in/riya-sample
Experience
Acme Toys Pvt Ltd — Product Designer, Jan 2021 – Present
Beta Studio — Junior Designer, Jun 2018 – Dec 2020
Notice period: 30 days. Current CTC 9 LPA.
Skills: Figma, SolidWorks, Figma, KeyShot`;

test('strict schema: every property required, no extras', () => {
  assert.equal(CV_SCHEMA.additionalProperties, false);
  assert.deepEqual([...CV_SCHEMA.required].sort(), Object.keys(CV_SCHEMA.properties).sort());
});

test('request: text mode, store false, strict json_schema, low effort', () => {
  const b = buildExtractRequest({ model: 'gpt-6-luna', text: 'hello', today: '2026-11-12' });
  assert.equal(b.store, false);
  assert.equal(b.reasoning.effort, 'low');
  assert.equal(b.text.format.type, 'json_schema');
  assert.equal(b.text.format.strict, true);
  assert.match(b.input[1].content[0].text, /<cv>\nhello\n<\/cv>/);
  const f = buildExtractRequest({ model: 'm', text: null, file: { kind: 'pdf', name: 'a.pdf', b64: 'QQ==' }, today: 'x' });
  assert.equal(f.input[1].content[1].type, 'input_file');
  assert.match(f.input[1].content[1].file_data, /^data:application\/pdf;base64,QQ==$/);
  const i = buildExtractRequest({ model: 'm', text: null, file: { kind: 'image', mime: 'image/png', b64: 'QQ==' }, today: 'x' });
  assert.equal(i.input[1].content[1].image_url, 'data:image/png;base64,QQ==');
  assert.throws(() => buildExtractRequest({ model: 'm', text: null, today: 'x' }));
});

test('response parsing: ok, incomplete, refusal, junk', () => {
  const okJ = { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"full_name":"A"}' }] }],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 300 } } };
  assert.deepEqual(parseExtractResponse(okJ), { ok: true, raw: { full_name: 'A' } });
  assert.deepEqual(readUsage(okJ), { input_tokens: 1000, cached_tokens: 200, output_tokens: 500, reasoning_tokens: 300 });
  assert.equal(parseExtractResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }).reason, 'incomplete: max_output_tokens');
  assert.match(parseExtractResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }).reason, /^refused/);
  assert.equal(parseExtractResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'nope' }] }] }).reason, 'output was not JSON');
  assert.equal(parseExtractResponse(null).ok, false);
  assert.deepEqual(readUsage({}), { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
});

const GOOD = {
  full_name: 'Riya Sample', email: 'Riya.Sample@example.com', phone: '+91 98765 43210', location: 'Pune, Maharashtra',
  linkedin_url: 'https://linkedin.com/in/riya-sample/', current_employer: 'Acme Toys Pvt Ltd', current_title: 'Product Designer',
  total_experience_years: 8.43, experience_evidence: 'Jun 2018 – Dec 2020', skills: ['Figma', 'SolidWorks', 'figma', 'KeyShot', ''],
  education: null, notice_period_days: 30, notice_evidence: 'Notice period: 30 days', current_ctc_inr: 900000,
  current_ctc_evidence: 'Current CTC 9 LPA', expected_ctc_inr: null, expected_ctc_evidence: null,
};

test('validation: traceable values kept and normalised', () => {
  const v = validateExtraction(GOOD, CV);
  assert.deepEqual(Object.keys(v.fields).sort(), [...DRAFT_FIELDS].sort());
  assert.equal(v.fields.email, 'riya.sample@example.com');
  assert.equal(v.fields.phone, '+91 98765 43210');
  assert.equal(v.fields.linkedin_url, 'https://www.linkedin.com/in/riya-sample');
  assert.equal(v.fields.total_experience_years, 8.4);
  assert.equal(v.fields.notice_period_days, 30);
  assert.equal(v.fields.current_ctc, 900000);
  assert.equal(v.fields.expected_ctc, null);
  assert.deepEqual(v.fields.skills, ['Figma', 'SolidWorks', 'KeyShot']);
  assert.equal(v.evidence.notice, 'Notice period: 30 days');
  assert.deepEqual(v.warnings, []);
});

test('validation: injected / untraceable values dropped (D5)', () => {
  const v = validateExtraction({ ...GOOD, email: 'attacker@evil.com', phone: '+1 555 000 1111', linkedin_url: 'linkedin.com/in/someone-else',
    current_ctc_inr: 2500000, current_ctc_evidence: 'CTC 25 LPA', total_experience_years: 12, experience_evidence: null }, CV);
  assert.equal(v.fields.email, null);
  assert.equal(v.fields.phone, null);
  assert.equal(v.fields.linkedin_url, null);
  assert.equal(v.fields.current_ctc, null);
  assert.equal(v.fields.total_experience_years, null);
  assert.ok(v.warnings.some(x => /Email not found/.test(x)));
  assert.ok(v.warnings.some(x => /Current CTC couldn't be traced/.test(x)));
  assert.ok(v.warnings.some(x => /Experience couldn't be traced/.test(x)));
});

test('validation: insane numbers and bad formats dropped', () => {
  const v = validateExtraction({ ...GOOD, email: 'not an email', phone: '123', total_experience_years: 99, notice_period_days: -3, current_ctc_inr: 5 }, CV);
  assert.equal(v.fields.email, null);
  assert.equal(v.fields.phone, null);
  assert.equal(v.fields.total_experience_years, null);
  assert.equal(v.fields.notice_period_days, null);
  assert.equal(v.fields.current_ctc, null);
  assert.ok(v.warnings.includes('Email looked invalid — dropped'));
  assert.ok(v.warnings.includes('Experience looked wrong — dropped'));
});

test('validation: scan mode keeps values but flags everything; junk input is safe', () => {
  const v = validateExtraction(GOOD, null);
  assert.equal(v.fields.email, 'riya.sample@example.com');
  assert.equal(v.fields.current_ctc, 900000);
  assert.ok(v.warnings.includes('Read from a scan or image — check every field by hand'));
  const z = validateExtraction(null, CV);
  assert.equal(z.fields.full_name, null);
  assert.ok(z.warnings.includes('No name found — enter it'));
  const n = validateExtraction({ ...GOOD, full_name: 'Someone Else' }, CV);
  assert.ok(n.warnings.some(x => /Name not found/.test(x)));
});

test('quote matching folds dashes, quotes, case and spacing', () => {
  assert.ok(quoteFound('jun 2018 - dec 2020', CV));
  assert.ok(quoteFound('Notice   period: 30 days', CV));
  assert.ok(!quoteFound('abc', CV));
  assert.ok(!quoteFound('Notice period: 60 days', CV));
  assert.equal(foldText('A—B  “x”'), 'a-b "x"');
});

test('text cleaning: whitespace, NULs, truncation', () => {
  assert.deepEqual(cleanText('a\u0000b \t c\r\n\n\n\nd'), { text: 'ab c\n\nd', truncated: false });
  const big = cleanText('x'.repeat(MAX_TEXT_CHARS + 5));
  assert.equal(big.text.length, MAX_TEXT_CHARS);
  assert.equal(big.truncated, true);
});

test('docx xml → text keeps paragraphs, tabs, entities', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Riya &amp; Co</w:t></w:r><w:r><w:tab/><w:t>Pune</w:t></w:r></w:p><w:p><w:r><w:t>a</w:t><w:br/><w:t>b &#8211; c &#x2014;</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(docxXmlToText(xml), 'Riya & Co\tPune\na\nb – c —\n');
  assert.equal(docxXmlToText('&#0;&#99999999;'), '');
});

test('cost: cached tokens at cached price, ₹ conversion; estimate is a ceiling', () => {
  const luna = { in: 0.10, cached: 0.01, out: 0.50 };
  // 3000 in (1000 cached) + 1500 out → (2000*0.1 + 1000*0.01 + 1500*0.5)/1e6 $ = 0.00096 $ → ₹0.0864
  assert.equal(costInr({ input_tokens: 3000, cached_tokens: 1000, output_tokens: 1500 }, luna, 90), 0.0864);
  assert.ok(estimateInr(9000, luna, 90) >= costInr({ input_tokens: 4500, cached_tokens: 0, output_tokens: 8000 }, luna, 90));
  assert.ok(estimateInr(null, luna, 90) > 0.3);
  assert.equal(costInr({ input_tokens: 10 }, {}, 90), 0);
});

test('storage path: minted shape passes its own check, traversal fails', () => {
  const id = '1f16f945-0000-4000-8000-000000000001';
  const p = importItemPath(id, '../My CV (final).pdf', 1700000000000);
  assert.equal(p, `cv_imports/${id}/1700000000000_My_CV_final_.pdf`);
  assert.equal(checkImportItemPath(p, id), null);
  assert.equal(checkImportItemPath(`cv_imports/${id}/../x/1_a.pdf`, id), 'bad_storage_path');
  assert.equal(checkImportItemPath(`cv_imports/${id}/1_a%2e%2e.pdf`, id), 'bad_storage_path');
  assert.equal(checkImportItemPath(`cv_imports/other/1_a.pdf`, id), 'bad_storage_path');
  assert.equal(fileExtOf('A.DOCX'), 'docx');
});

test('pickDraft keeps only draft fields', () => {
  assert.deepEqual(pickDraft({ full_name: 'A', status: 'x', candidate_code: 'y', skills: [] }), { full_name: 'A', skills: [] });
});

test('cvText: real PDF text layer and real DOCX', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Riya Sample riya.sample@example.com', { x: 50, y: 700, size: 12, font });
  const pdf = await cvText(await doc.save(), 'pdf');
  assert.match(pdf.text, /riya\.sample@example\.com/);
  assert.equal(pdf.pages, 1);
  const docx = zipSync({ 'word/document.xml': strToU8('<w:document><w:p><w:t>Hello CV</w:t></w:p></w:document>'), '[Content_Types].xml': strToU8('<x/>') });
  assert.equal((await cvText(docx, 'docx')).text, 'Hello CV\n');
  assert.equal((await cvText(new Uint8Array([1, 2]), 'doc')).text, '');
});
