import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLink } from '../src/lib/myLink.mjs';

const P = (employeeId, perfError = false) => ({ state: 'panels', employeeId, perfError });
const NO = { state: 'noProfile', employeeId: null, perfError: false };
const LOADING = { state: 'loading', employeeId: null, perfError: false };
const ERROR = { state: 'error', employeeId: null, perfError: true };

// contextId · perfStatus · perfId → expected
const TABLE = [
  ['e1', 'loading', undefined, P('e1')],    // optimistic: context id mounts the panels at once
  [null, 'loading', undefined, LOADING],    // nothing known → neutral shell, never "no profile"
  ['e1', 'ok', 'e1', P('e1')],              // confirmed
  ['e1', 'ok', 'e2', P('e2')],              // the page's own answer wins when it differs
  [null, 'ok', 'e9', P('e9')],              // linked since the context was written
  ['e1', 'ok', null, NO],                   // context said linked, getMyPerformance says not → no profile
  [null, 'ok', null, NO],                   // the only way to "no profile": a successful answer saying so
  ['e1', 'error', undefined, P('e1', true)],// keep the panels, compact error + Retry for the perf bits
  [null, 'error', undefined, ERROR],        // error + Retry — never "no profile"
  [undefined, 'error', undefined, ERROR],
];

test('link decision truth table', () => {
  for (const [contextId, perfStatus, perfId, want] of TABLE) {
    assert.deepEqual(decideLink({ contextId, perfStatus, perfId }), want, `${contextId}/${perfStatus}/${perfId}`);
  }
});

test('"no profile" never comes from the context alone', () => {
  for (const perfStatus of ['loading', 'error']) {
    for (const contextId of [null, undefined, '']) {
      assert.notEqual(decideLink({ contextId, perfStatus }).state, 'noProfile');
    }
  }
});
