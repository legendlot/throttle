// Run: node --test docketops-worker/test/*.test.mjs
// Request hardening, the pure core (src/request-core.mjs, 2026-11-14): uuid canonicalisation (podiumops-worker's
// canonicalIds / canonicalizeUrlUuids, mirrored) and the size caps. The router-level checks are hardening-gate.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIds, canonicalizeUrlUuids, LIMITS, taskFieldsError, customFieldsError, docError, commentError,
  bulkIdsError, scratchBodyError } from '../src/request-core.mjs';

const ME = '00000000-0000-4000-8000-0000000000ab';
const UP = ME.toUpperCase();
const MIXED = ME.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');

test('canonicalIds: only id-bearing keys (id / ids / *_id / *_ids) are lowercased — in arrays and arrays of objects', () => {
  const b = { id: UP, parent_task_id: MIXED, ids: [UP, MIXED], items: [{ id: UP, title: UP }], Other_ID: UP,
    title: UP, body: UP, url: `https://x/${UP}`, note: UP, data: { employee_id: UP, description: UP },
    deep: { list: [[{ space_id: UP }]] }, n: 3, nil: null };
  assert.equal(canonicalIds(b), true);
  assert.deepEqual(b, { id: ME, parent_task_id: ME, ids: [ME, ME], items: [{ id: ME, title: UP }], Other_ID: ME,
    title: UP, body: UP, url: `https://x/${UP}`, note: UP, data: { employee_id: ME, description: UP },
    deep: { list: [[{ space_id: ME }]] }, n: 3, nil: null });
  const notWhole = { id: `x${UP}` };
  assert.equal(canonicalIds(notWhole), true);
  assert.equal(notWhole.id, `x${UP}`);   // only a whole-string uuid is touched
});
test('canonicalIds: over the depth / node caps → false, never a throw; a realistic bulk body passes', () => {
  let deep = {}; const root = deep;
  for (let i = 0; i < 12000; i++) { deep.x = {}; deep = deep.x; }
  assert.equal(canonicalIds(root), false);
  assert.equal(canonicalIds({ ids: Array.from({ length: 500001 }, () => 'x') }), false);
  assert.equal(canonicalIds({ ids: Array.from({ length: LIMITS.bulkIds }, () => UP) }), true);
  assert.equal(canonicalIds(null), true);
  assert.equal(canonicalIds('x'), true);
  assert.equal(canonicalIds([UP]), true);
});
test('canonicalizeUrlUuids: id-keyed query values lowercased (repeats kept); q and other keys untouched', () => {
  const u = new URL(`https://w/?action=getTask&id=${UP}&q=${UP}&space_id=${MIXED}&employee_ids=${UP}&employee_ids=${MIXED}`);
  canonicalizeUrlUuids(u);
  assert.equal(u.searchParams.get('id'), ME);
  assert.equal(u.searchParams.get('space_id'), ME);
  assert.equal(u.searchParams.get('q'), UP);
  assert.deepEqual(u.searchParams.getAll('employee_ids'), [ME, ME]);
  assert.equal(u.searchParams.get('action'), 'getTask');
});

const s = (n) => 'a'.repeat(n);
test('caps: a value AT each limit passes; one over is refused with its own error', () => {
  assert.equal(taskFieldsError({ title: s(LIMITS.title) }), null);
  assert.equal(taskFieldsError({ title: s(LIMITS.title + 1) }), 'title_too_long');
  assert.equal(taskFieldsError({ title: `  ${s(LIMITS.title)}  ` }), null);   // measured as stored (trimmed)
  assert.equal(taskFieldsError({ description: s(LIMITS.description) }), null);
  assert.equal(taskFieldsError({ description: s(LIMITS.description + 1) }), 'description_too_long');
  assert.equal(taskFieldsError({ documents: Array.from({ length: LIMITS.documents }, () => ({ url: 'https://x' })) }), null);
  assert.equal(taskFieldsError({ documents: Array.from({ length: LIMITS.documents + 1 }, () => ({ url: 'https://x' })) }), 'too_many_documents');
  assert.equal(taskFieldsError({ documents: [{ url: 'https://x', title: s(LIMITS.docTitle + 1) }] }), 'document_title_too_long');
  assert.equal(taskFieldsError({ collaborators: Array.from({ length: LIMITS.collaborators }, () => ME) }), null);
  assert.equal(taskFieldsError({ collaborators: Array.from({ length: LIMITS.collaborators + 1 }, () => ME) }), 'too_many_collaborators');
  assert.equal(docError({ url: 'https://' + s(LIMITS.docUrl - 8) }), null);
  assert.equal(docError({ url: 'https://' + s(LIMITS.docUrl - 7) }), 'document_url_too_long');
  assert.equal(commentError(s(LIMITS.comment)), null);
  assert.equal(commentError(s(LIMITS.comment + 1)), 'comment_too_long');
  assert.equal(bulkIdsError(Array.from({ length: LIMITS.bulkIds }, () => ME)), null);
  assert.equal(bulkIdsError(Array.from({ length: LIMITS.bulkIds + 1 }, () => ME)), 'too_many_ids');
  assert.equal(bulkIdsError(undefined), null);   // the handler's own 'ids required' answers that
  assert.equal(scratchBodyError(s(LIMITS.scratchBody)), null);
  assert.equal(scratchBodyError(s(LIMITS.scratchBody + 1)), 'body_too_long');
  assert.equal(taskFieldsError({}), null);
  assert.equal(taskFieldsError({ title: null, description: null, custom_fields: null }), null);
});
test('custom_fields: absent / null fine; must be a plain object; its JSON at most 32 KB', () => {
  assert.equal(customFieldsError(undefined), null);
  assert.equal(customFieldsError(null), null);
  assert.equal(customFieldsError({}), null);
  assert.equal(customFieldsError({ a: 1, b: { c: [1, 2] } }), null);
  for (const bad of [[], 'x', 3, true]) assert.equal(customFieldsError(bad), 'custom_fields_not_object', JSON.stringify(bad));
  const at = { k: s(LIMITS.customFieldsBytes - '{"k":""}'.length) };
  assert.equal(customFieldsError(at), null);
  assert.equal(customFieldsError({ k: s(LIMITS.customFieldsBytes) }), 'custom_fields_too_large');
  assert.equal(customFieldsError({ k: 'é'.repeat(LIMITS.customFieldsBytes / 2) }), 'custom_fields_too_large');   // bytes, not chars
  assert.equal(taskFieldsError({ custom_fields: [] }), 'custom_fields_not_object');
});
