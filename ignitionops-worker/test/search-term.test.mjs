import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTerm, infSearchOr, engSearchOwnOr, engSearchInfOr } from '../src/index.js';

test('or-group breakers become the LIKE single-char wildcard, so the group cannot be ended early', () => {
  assert.equal(searchTerm('a,b)'), 'a_b_');
  assert.equal(searchTerm('x)*'), 'x_');
  assert.equal(searchTerm('Chanda(kid'), 'Chanda_kid');       // still matches "Chanda(kid inf)"
  assert.equal(searchTerm('say "hi"'), 'say _hi_');
  assert.equal(searchTerm('a\\b'), 'a_b');
});

test('pasted links, emails and phones survive untouched (`:` is not special inside a value)', () => {
  assert.equal(searchTerm('https://www.instagram.com/x/'), 'https://www.instagram.com/x/');
  assert.equal(searchTerm('a.b+c@d.com'), 'a.b+c@d.com');
  assert.equal(searchTerm('+91 98765'), '+91 98765');
});

test('* is dropped; whitespace collapses', () => {
  assert.equal(searchTerm('  pe*tro   l  '), 'pe tro l');
});

test('nothing searchable left → empty (callers treat it as no search)', () => {
  for (const q of [')))', '***', '  ', '', null, undefined, ',(),']) assert.equal(searchTerm(q), '');
});

test('non-strings are coerced', () => {
  assert.equal(searchTerm(12345), '12345');
});

test('cap is 64 code points and never splits a surrogate pair', () => {
  assert.equal(searchTerm('a'.repeat(100)).length, 64);
  const t = searchTerm('a'.repeat(63) + '💥💥');
  assert.equal(Array.from(t).length, 64);
  assert.doesNotThrow(() => encodeURIComponent(t));
});

test('one definition of each search group (shared by list reads and searchAll)', () => {
  const s = encodeURIComponent(searchTerm('a,b)'));
  for (const g of [infSearchOr(s), engSearchOwnOr(s), engSearchInfOr(s)]) {
    assert.equal((g.match(/\(/g) || []).length, 1);            // the term adds no paren
    assert.equal((g.match(/\)/g) || []).length, 1);
    assert.ok(g.endsWith(')'));
  }
  assert.match(infSearchOr('x'), /channel_link\.ilike\.\*x\*/);
  assert.match(engSearchOwnOr('x'), /video_link\.ilike\.\*x\*/);
});
