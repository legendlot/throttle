import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directoryRows, filterOnServer, DIRECTORY_ALL_LIMIT } from '../src/lib/directory.mjs';

// Rows as getEmployees(status=all) sends them, already ordered full_name.asc. Expected outputs are written
// out by hand from the worker's filter rules: status=<tab> (active / on_leave / exited), status=notice →
// open exit (on_notice), status=all → everyone, department_id → equals it.
const asha = { id: 'asha', full_name: 'Asha', status: 'active', department_id: 'ops', on_notice: false };
const bilal = { id: 'bilal', full_name: 'Bilal', status: 'active', department_id: 'tech', on_notice: true };   // serving notice
const chen = { id: 'chen', full_name: 'Chen', status: 'on_leave', department_id: 'ops', on_notice: false };
const dev = { id: 'dev', full_name: 'Dev', status: 'exited', department_id: 'ops', on_notice: false };        // exited
const esha = { id: 'esha', full_name: 'Esha', status: 'active', department_id: null, on_notice: false, _restricted: true };
const all = [asha, bilal, chen, dev, esha];

const ids = (rows) => rows.map(r => r.id);

test('tabs', () => {
  assert.deepEqual(ids(directoryRows(all, { tab: 'active' })), ['asha', 'bilal', 'esha']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'on_leave' })), ['chen']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'notice' })), ['bilal']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'exited' })), ['dev']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'all' })), ['asha', 'bilal', 'chen', 'dev', 'esha']);
});

test('department filter, alone and with a tab', () => {
  assert.deepEqual(ids(directoryRows(all, { tab: 'all', dept: 'ops' })), ['asha', 'chen', 'dev']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'active', dept: 'ops' })), ['asha']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'exited', dept: 'ops' })), ['dev']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'notice', dept: 'ops' })), []);
  assert.deepEqual(ids(directoryRows(all, { tab: 'notice', dept: 'tech' })), ['bilal']);
  assert.deepEqual(ids(directoryRows(all, { tab: 'active', dept: 'nowhere' })), []);
});

test('rows are passed through as the worker sent them (no re-projection) and nothing else is touched', () => {
  const got = directoryRows(all, { tab: 'active' });
  assert.equal(got[2], esha);
  assert.equal(got[2]._restricted, true);
  assert.deepEqual(directoryRows(null, { tab: 'active' }), []);
});

test('filterOnServer: local only while the full list is provably complete and there is no text', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
  assert.equal(DIRECTORY_ALL_LIMIT, 2000);
  assert.equal(filterOnServer({ query: '', all: rows(83) }), false);
  assert.equal(filterOnServer({ query: '   ', all: rows(83) }), false);     // whitespace is no search
  assert.equal(filterOnServer({ query: 'asha', all: rows(83) }), true);
  assert.equal(filterOnServer({ query: '', all: rows(1999) }), false);
  assert.equal(filterOnServer({ query: '', all: rows(2000) }), true);      // filled the limit → may be cut off
  assert.equal(filterOnServer({ query: '', all: rows(2500) }), true);
  assert.equal(filterOnServer({ query: '', all: null }), false);           // not loaded yet → wait for it
  assert.equal(filterOnServer({ query: '', all: rows(5), limit: 5 }), true);
});
