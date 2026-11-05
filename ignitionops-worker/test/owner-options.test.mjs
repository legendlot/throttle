import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerOptions } from '../src/index.js';

const users = [{ id: 'a', full_name: 'Himani' }, { id: 'b', full_name: 'Jarvis' }, { id: 'c', full_name: 'Piyush' }];

test('owner list is the Ignition users who are on the team', () => {
  assert.deepEqual(ownerOptions(users, ['a', 'z', null]).map(u => u.id), ['a']);
});
test('fails open, so a failed team read cannot stop deals being created', () => {
  assert.equal(ownerOptions(users, null).length, 3);
  assert.equal(ownerOptions(users, []).length, 3);
  assert.equal(ownerOptions(users, ['z']).length, 3);
});
