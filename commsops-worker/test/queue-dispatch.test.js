// Queue routing contract (frozen-roster spec §9.11). Run: node test/queue-dispatch.test.js
//
// THE POINT: the consumer's dispatch used to default unknown kinds into the campaign fan-out,
// which early-returns on them and ACKS — the message is silently destroyed with no DLQ row, no
// alert, no error. Found 2026-08-15 while speccing the roster build: a `build_roster` message
// consumed by a stale isolate mid-deploy would be eaten and the campaign stuck in
// `building_roster` forever. These tests pin the replacement contract: a kind must opt in, and
// everything else THROWS so it retries onto a current isolate and eventually dead-letters VISIBLY.
const assert = require('assert');
const { queueRoute, KNOWN_KINDS } = require('../src/queue-route.js');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
  catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

t('every known kind routes to itself', () => {
  for (const k of KNOWN_KINDS) assert.equal(queueRoute({ kind: k, anything: 'else' }), k);
});

t('a bare campaign body routes to campaign — both the old and the sharded shape', () => {
  // pre-sharding shape (still in flight across any deploy) and today's sharded shape
  assert.equal(queueRoute({ campaignId: 'C', after: null }), 'campaign');
  assert.equal(queueRoute({ campaignId: 'C', after: 'uuid', shard: 3, shardCount: 5 }), 'campaign');
});

t('the deploy-race case: a FUTURE kind on this consumer THROWS, never acks', () => {
  // The §9.11 scenario: a new producer enqueues a kind this consumer predates. build_roster WAS
  // the example until Task 4 registered it (it now routes); any future kind takes its place here.
  assert.throws(() => queueRoute({ kind: 'roster_topup', campaignId: 'C', after: null }),
    /unknown_queue_kind:roster_topup/);
});

t('garbage kinds throw, naming the kind for the DLQ row', () => {
  assert.throws(() => queueRoute({ kind: 'garbage' }), /unknown_queue_kind:garbage/);
});

t('a body with neither kind nor campaignId throws — junk never defaults into the fan-out', () => {
  for (const b of [{}, null, undefined, { after: 'x' }, { journeyId: 'J' }]) {
    assert.throws(() => queueRoute(b), /unknown_queue/, JSON.stringify(b));
  }
});

t('an empty/null kind falls through to the campaignId check, not the kind check', () => {
  // `kind: ''` or `kind: null` on a campaign body must not be read as an (unknown) kind.
  assert.equal(queueRoute({ kind: null, campaignId: 'C' }), 'campaign');
  assert.equal(queueRoute({ kind: '', campaignId: 'C' }), 'campaign');
});

t('KNOWN_KINDS canary — adding a kind is a CONSCIOUS act in both files', () => {
  // When a new kind (e.g. build_roster, Task 4) is added, update this list in the same commit as
  // its consumer branch in index.js — the spec's §9.11 note explains the deploy-order rule.
  assert.deepEqual([...KNOWN_KINDS].sort(),
    ['build_roster', 'enrol', 'last_order_backfill', 'shopify_backfill']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
