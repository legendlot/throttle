// The "Note for Finance" validation behind createPaymentRequest is a pure function lifted into
// apps/snorkel/src/lib/requesterNote.js precisely so it can be tested here, outside React/Next.
// snorkelops-worker holds an INLINE copy (search `REQUESTER NOTE — VERBATIM PORT`) — the worker
// is a zero-import single file — so these tests are the spec both sides must satisfy, and every
// case below runs against BOTH copies: the app module, and the worker's source lifted straight
// out of index.js (the way prior-tds.test.mjs / party-balances.test.mjs do). Drift fails a test.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as app from '../../apps/snorkel/src/lib/requesterNote.js';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const worker = new Function([
  lift('const REQUESTER_NOTE_MAX =', '\n// ⚠️⚠️ delivery_address_id'),
  'return { parseRequesterNote, REQUESTER_NOTE_MAX };',
].join('\n'))();

for (const [side, { parseRequesterNote, REQUESTER_NOTE_MAX }] of [['app', app], ['worker', worker]]) {
  test(`${side}: absent, null, empty and whitespace-only all mean NO note — stored as NULL, never ""`, () => {
    for (const raw of [undefined, null, '', '   ', '\n\t  \n']) {
      const { note, error } = parseRequesterNote(raw);
      assert.equal(error, null, `${JSON.stringify(raw)} must not error`);
      assert.equal(note, null, `${JSON.stringify(raw)} must store NULL`);
    }
  });

  test(`${side}: a note is trimmed at the ends and keeps its inner line breaks`, () => {
    const raw = '  A/c name: SHIVAM ENTERPRISES\nA/c 1234567890\nIFSC HDFC0001234  \n';
    const { note, error } = parseRequesterNote(raw);
    assert.equal(error, null);
    assert.equal(note, 'A/c name: SHIVAM ENTERPRISES\nA/c 1234567890\nIFSC HDFC0001234');
  });

  test(`${side}: plain text, NOT masked — an account number comes back exactly as typed`, () => {
    const { note } = parseRequesterNote('1234567890123456');
    assert.equal(note, '1234567890123456');
  });

  test(`${side}: exactly the cap is accepted; one over is refused with a message that says the limit`, () => {
    assert.equal(REQUESTER_NOTE_MAX, 2000);
    const atCap = parseRequesterNote('x'.repeat(2000));
    assert.equal(atCap.error, null);
    assert.equal(atCap.note.length, 2000);
    const over = parseRequesterNote('x'.repeat(2001));
    assert.equal(over.note, null);
    assert.match(over.error, /2001 characters/);
    assert.match(over.error, /2000/);
  });

  test(`${side}: the cap is measured AFTER trimming — padding cannot push a valid note over`, () => {
    const { note, error } = parseRequesterNote(`   ${'x'.repeat(2000)}   `);
    assert.equal(error, null);
    assert.equal(note.length, 2000);
  });

  test(`${side}: non-string payloads are refused on type, never coerced into stored text`, () => {
    for (const raw of [42, true, false, [], ['a'], {}, { note: 'x' }]) {
      const { note, error } = parseRequesterNote(raw);
      assert.equal(note, null, `${JSON.stringify(raw)} must not be stored`);
      assert.ok(error, `${JSON.stringify(raw)} must be refused`);
    }
  });
}
