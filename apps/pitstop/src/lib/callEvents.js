/**
 * A one-line bus between the softphone and the screen-pop.
 *
 * Why this exists (S311, 2026-08-26). CallPop learned about calls by polling
 * `getCallContext?mine=true`, which finds the agent's IN-FLIGHT call ROW. That row is
 * created by Exotel's flow-side agent webhook — and measured over the 7 days to
 * 2026-08-26, that webhook does not fire on ~30% of answered calls:
 *
 *   · answered + warmed    238 calls · row created ~7s after the call started
 *   · answered + NOT warmed 104 calls · row created ~9 MINUTES after (median)
 *
 * A ~9-minute median means those rows were written by the 2-minute poller, not the
 * webhook, and they arrive carrying a final status rather than `in_progress`. So during
 * the call there was no row for `mine=true` to find, and the agent got no pop at all —
 * not a late one. 104 answered calls in a week, picked up blind.
 *
 * We cannot make Exotel's webhook fire. But the SDK rings the agent's own browser, and
 * that event carries the caller's number — which is all the context assembler needs
 * (`getCallContext?phone=…` assembles live and touches no call row). So the pop stops
 * depending on a row existing at all.
 *
 * ⚠️ The poll is deliberately KEPT, not retired as the backlog item proposed. It is the
 * only path that covers an agent who is not on the browser phone, and outgoing
 * click-to-call. Replacing one gap with another is not a fix.
 *
 * Module-level rather than React context on purpose: CallBar and CallPop are siblings in
 * the (auth) layout, and threading a provider between them to move one string would be
 * more moving parts than the problem deserves.
 */
const subscribers = new Set();

/** Called by CallBar from the SDK's own event handler. */
export function publishCallEvent(event) {
  for (const fn of subscribers) {
    // One bad subscriber must never take down the softphone's event handler.
    try { fn(event); } catch { /* ignore */ }
  }
}

/** Returns an unsubscribe function. */
export function subscribeCallEvents(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
