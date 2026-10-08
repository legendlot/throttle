import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingPatch } from '../src/index.js';

// B1 (S412): a rating click sends no notes and used to null `rating_notes` every time.
const NOW = '2026-10-08T06:00:00.000Z';

test('ratingPatch: no rating_notes key leaves the notes untouched', () => {
  const p = ratingPatch({ influencer_id: 'x', rating: 'green' }, NOW);
  assert.deepEqual(p, { quality_rating: 'green', updated_at: NOW });
  assert.equal('rating_notes' in p, false);
});

test('ratingPatch: notes sent are written, trimmed', () => {
  assert.equal(ratingPatch({ rating: 'red', rating_notes: '  ghosted twice ' }, NOW).rating_notes, 'ghosted twice');
});

test('ratingPatch: an explicit empty or null clears the notes', () => {
  assert.equal(ratingPatch({ rating: 'yellow', rating_notes: '' }, NOW).rating_notes, null);
  assert.equal(ratingPatch({ rating: 'yellow', rating_notes: '   ' }, NOW).rating_notes, null);
  assert.equal(ratingPatch({ rating: 'yellow', rating_notes: null }, NOW).rating_notes, null);
});
