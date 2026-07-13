const assert = require('assert');
const { pickSignals } = require('../src/ingest.js');

// One row per instance → one signal each, payload carries kind/outcome.
{
  const rows = [
    { instance_id: 'A', kind: 'response' },
    { instance_id: 'B', kind: 'exit', outcome: 'cancelled' },
  ];
  const out = pickSignals(rows, 'order_placed', 'evt-1');
  assert.equal(out.length, 2);
  assert.deepEqual(out.find((s) => s.instanceId === 'A').payload, { kind: 'response', event: 'order_placed', event_id: 'evt-1' });
  assert.deepEqual(out.find((s) => s.instanceId === 'B').payload, { kind: 'exit', outcome: 'cancelled', event: 'order_placed', event_id: 'evt-1' });
}
// Same instance matched by BOTH a response row and an exit row → ONE signal, exit wins.
{
  const rows = [
    { instance_id: 'A', kind: 'response' },
    { instance_id: 'A', kind: 'exit', outcome: 'cancelled' },
  ];
  const out = pickSignals(rows, 'order_placed', 'evt-2');
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.kind, 'exit');
}
console.log('pickSignals ok');
