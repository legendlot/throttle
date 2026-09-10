import test from 'node:test';
import assert from 'node:assert/strict';
import { mgrDisagrees, normEmail } from '../src/index.js';

// S369 — "Dismiss" on a MANAGER-ONLY disagreement used to silence it for exactly zero syncs:
// the only baseline written was google_org_unit, and a manager-only row has no OU change to
// bank. Found by the S306 hostile review, not by a user.
const ALICE = 'a-id', BOB = 'b-id', CARE = 'c-id';

test('no Google manager, or one that matches, is never a disagreement', () => {
  assert.equal(mgrDisagrees(null, BOB, ALICE, null, null), false);
  assert.equal(mgrDisagrees(undefined, BOB, ALICE, 'bob@x.com', null), false);
  assert.equal(mgrDisagrees(BOB, BOB, ALICE, 'bob@x.com', null), false, 'we already agree');
});

test('nobody is ever proposed as their own manager', () => {
  assert.equal(mgrDisagrees(ALICE, BOB, ALICE, 'alice@x.com', null), false);
});

test('a fresh disagreement with no baseline is reported', () => {
  assert.equal(mgrDisagrees(BOB, CARE, ALICE, 'bob@x.com', null), true);
});

test('THE BUG: after a dismissal the same disagreement stays silent', () => {
  assert.equal(mgrDisagrees(BOB, CARE, ALICE, 'bob@x.com', 'bob@x.com'), false);
});

test('Google naming someone ELSE is new information and re-raises the row', () => {
  assert.equal(mgrDisagrees(BOB, CARE, ALICE, 'dave@x.com', 'bob@x.com'), true);
});

test('the baseline is matched case- and whitespace-insensitively', () => {
  assert.equal(mgrDisagrees(BOB, CARE, ALICE, '  BOB@X.com ', 'bob@x.com'), false);
  assert.equal(mgrDisagrees(BOB, CARE, ALICE, 'bob@x.com', '  Bob@X.COM'), false);
});

// The falsy-empty-string class that CORE.md and normOu both warn about: '' and NULL must mean
// the same thing, or a blank baseline reads as "dismissed" against a blank Google value.
test('a blank baseline never counts as a dismissal', () => {
  for (const blank of [null, undefined, '', '   ']) {
    assert.equal(mgrDisagrees(BOB, CARE, ALICE, 'bob@x.com', blank), true, `baseline ${JSON.stringify(blank)}`);
  }
});

test('a blank Google email never matches a real baseline', () => {
  for (const blank of [null, undefined, '', '   ']) {
    assert.equal(mgrDisagrees(BOB, CARE, ALICE, blank, 'bob@x.com'), true, `google ${JSON.stringify(blank)}`);
  }
});

// Documented trade-off — see the comment on mgrDisagrees. Pinned so a future reader does not
// "fix" it by accident.
test('DELIBERATE: changing PODIUM\'s manager after a dismissal does not re-raise it', () => {
  assert.equal(mgrDisagrees(BOB, 'someone-new', ALICE, 'bob@x.com', 'bob@x.com'), false);
});

test('normEmail folds blanks to null and never throws on odd input', () => {
  assert.equal(normEmail('  A@B.com '), 'a@b.com');
  for (const blank of [null, undefined, '', '   ']) assert.equal(normEmail(blank), null);
  assert.equal(normEmail(42), '42');
});
