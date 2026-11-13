// Hiring C5 — candidate sources + the referral rule (plan 2026-11-13-podium-c5-add-candidate-cv-first.md D1, D2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_SOURCES, referralError, REFERRER_REQUIRED_MSG } from '../src/hiring.js';

const EMP = '11111111-1111-4111-8111-111111111111';

test('APP_SOURCES: the ten sources, incl. C5 direct_email + job_portal', () => {
  assert.deepEqual([...APP_SOURCES].sort(), ['agency', 'campus', 'careers_page', 'direct_email', 'job_portal', 'linkedin',
    'naukri', 'other', 'referral', 'walk_in']);
});

test('APP_SOURCES matches the 0023 CHECK exactly', () => {
  const sql = readFileSync(new URL('../migrations/0023_candidate_sources.sql', import.meta.url), 'utf8');
  const m = sql.match(/applications_source_check check \(source in \(([^)]*)\)\)/);
  assert.ok(m, '0023 re-adds applications_source_check');
  const inCheck = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(inCheck.sort(), [...APP_SOURCES].sort());
});

test('APP_SOURCES matches the app SOURCES list', () => {
  const js = readFileSync(new URL('../../apps/podium/src/lib/hiring.js', import.meta.url), 'utf8');
  const block = js.slice(js.indexOf('export const SOURCES'), js.indexOf('];', js.indexOf('export const SOURCES')));
  const ids = [...block.matchAll(/id: '([a-z_]+)'/g)].map(x => x[1]);
  assert.deepEqual(ids.sort(), [...APP_SOURCES].sort());
});

test('referralError: non-referral sources never need a referrer', () => {
  for (const s of APP_SOURCES.filter(s => s !== 'referral')) assert.equal(referralError(s, null, null), null, s);
  assert.equal(referralError(undefined, null, null), null, 'no source → column default other');
});

test('referralError: a referral needs an employee or an outside name', () => {
  assert.equal(referralError('referral', EMP, null), null);
  assert.equal(referralError('referral', null, 'Ravi (ex-colleague)'), null);
  assert.equal(referralError('referral', EMP, 'also a note'), null);
  assert.equal(referralError('referral', null, null), 'referrer_required');
  assert.equal(referralError('referral', '', ''), 'referrer_required');
  assert.equal(referralError('referral', undefined, undefined), 'referrer_required');
  assert.equal(referralError('referral', null, '   \t '), 'referrer_required', 'whitespace is not a name');
});

test('REFERRER_REQUIRED_MSG is the plan copy', () => {
  assert.equal(REFERRER_REQUIRED_MSG, "Pick who referred them, or type the referrer's name");
});

// D2 wiring (source text): the rule is called at every write site, and updateApplication checks the MERGED row.
const INDEX = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const fnBody = (name) => {
  const i = INDEX.indexOf(`async function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  const j = INDEX.indexOf('\nasync function ', i + 1);
  return INDEX.slice(i, j < 0 ? undefined : j);
};

test('index.js: referralError at createCandidate, addApplication, updateApplication, createCvImport', () => {
  assert.ok((INDEX.match(/referralError\(/g) || []).length >= 4, 'at least 4 call sites');
  for (const f of ['createCandidate', 'addApplication', 'updateApplication', 'createCvImport']) {
    assert.match(fnBody(f), /referralError\(/, `${f} calls referralError`);
  }
});

test('index.js: updateApplication merges the patch over the row BEFORE the referral check', () => {
  const b = fnBody('updateApplication');
  const merged = b.search(/const fin = \{ \.\.\.app, \.\.\.ca\.patch \}/);
  const call = b.search(/referralError\(fin\.source, fin\.referrer_employee_id, fin\.source_detail\)/);
  assert.ok(merged > 0, 'merged object built');
  assert.ok(call > merged, 'referralError reads the merged object, after it is built');
});

test('index.js: createCvImport checks the referrer is a current employee and omits a null referrer key', () => {
  const b = fnBody('createCvImport');
  assert.match(b, /employees\?id=eq\.\$\{referrer\}&status=neq\.exited/);
  assert.match(b, /\.\.\.\(referrer \? \{ referrer_employee_id: referrer \} : \{\}\)/);
});
