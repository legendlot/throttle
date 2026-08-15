// Classify a commsops-broadcast queue message into its handler route. Pure: no DB, no network —
// extracted from the index.js queue consumer so the routing CONTRACT is unit-testable
// (test/queue-dispatch.test.js), the same reasoning as segmentAst.js and ab-stats.js.
//
// ⚠️ WHY THIS EXISTS (frozen-roster spec §9.11, found 2026-08-15). The consumer's dispatch used to
// be an if/else chain whose ELSE was the campaign fan-out — so ANY message with an unrecognised
// `kind` fell through to processQueueMessage, which reads `b.campaignId` (undefined), loads no
// campaign, returns early, and the message is ACKED. Silently destroyed, in the precise sense that
// nothing anywhere records it existed.
//
// That is a loaded gun for every kind added later: a `{kind:'build_roster'}` message consumed by a
// stale isolate mid-deploy (old code, no build_roster branch) would be eaten, and the campaign it
// belonged to would sit in `building_roster` forever with no DLQ row, no alert, no error.
//
// The contract now: a kind must OPT IN by being listed here. Anything else THROWS, so the consumer
// calls msg.retry() → Queues redelivers (a mid-deploy retry lands on a current isolate, which is
// the fix for the deploy race) → after max_retries it dead-letters, where the DLQ consumer writes
// comms.queue_failures + alerts. Unknown messages become VISIBLE instead of vanishing. Same idiom
// as gate.js's session-message modes: "a new mode must opt IN", never default into a live path.
//
// ⚠️ When adding a kind: add it to KNOWN_KINDS *and* its branch in index.js's consumer in the SAME
// commit, and deploy the consumer BEFORE any producer starts enqueueing the new kind — the whole
// point of the throw is that the old consumer retries the new kind instead of eating it, but that
// only converges if the new consumer ships first.
const KNOWN_KINDS = ['enrol', 'shopify_backfill', 'last_order_backfill', 'build_roster'];

// → 'enrol' | 'shopify_backfill' | 'last_order_backfill' | 'campaign', or THROWS.
// A campaign fan-out message has no `kind` (back-compat with every message shape since M6) and is
// recognised POSITIVELY by campaignId — `!kind` alone would accept {} and junk into the fan-out.
function queueRoute(b) {
  const kind = b && b.kind;
  if (kind != null && kind !== '') {
    if (KNOWN_KINDS.includes(kind)) return kind;
    throw new Error(`unknown_queue_kind:${kind}`);
  }
  if (b && b.campaignId) return 'campaign';
  throw new Error('unknown_queue_message:no_kind_no_campaignId');
}

module.exports = { queueRoute, KNOWN_KINDS };
