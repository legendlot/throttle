import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshStep } from '../src/hooks/useAutoRefresh.js';

// useAutoRefresh routes every tick / visibilitychange / pageshow through refreshStep and
// carries `missed` between calls exactly as run() does below — this drives that function.
function run(events) {
  let missed = false, runs = 0;
  for (const [event, hidden] of events) {
    const r = refreshStep(missed, event, hidden);
    missed = r.missed;
    if (r.run) runs++;
  }
  return runs;
}

test('an interval tick runs only while the page is visible', () => {
  assert.deepEqual(refreshStep(false, 'tick', false), { run: true, missed: false });
  assert.deepEqual(refreshStep(false, 'tick', true), { run: false, missed: true });
});

test('becoming visible runs once only if a tick was missed while hidden', () => {
  assert.equal(refreshStep(true, 'visible', false).run, true);
  assert.equal(refreshStep(false, 'visible', false).run, false); // quick tab-away
  assert.equal(refreshStep(true, 'visible', true).run, false);   // the going-hidden event
});

test('a long hidden stretch costs no calls, then exactly one on return', () => {
  const hiddenTicks = Array.from({ length: 20 }, () => ['tick', true]);
  assert.equal(run([['tick', false], ['visible', true], ...hiddenTicks, ['visible', false]]), 2);
});

test('a hide-and-return inside one interval costs nothing extra', () => {
  assert.equal(run([['tick', false], ['visible', true], ['visible', false], ['tick', false]]), 2);
});

test('a back/forward-cache restore catches up once when visible', () => {
  assert.equal(run([['tick', false], ['pageshow', false]]), 2);
  // restored into a hidden tab: wait, then catch up when it is shown
  assert.equal(run([['pageshow', true], ['visible', false]]), 1);
});
