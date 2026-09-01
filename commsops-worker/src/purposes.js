// The purpose vocabulary, in ONE place — and, more importantly, the purpose *classes* the
// send path branches on. Added S327 with `influencer_outreach`.
//
// WHY THIS FILE EXISTS. Before it, every consumer spelled its own `purpose === 'marketing'`
// test, and each one silently meant something different: "needs consent", "route off the
// marketing number", "render an unsubscribe footer", "UTM-tag the links". Adding a purpose
// therefore meant finding every literal and deciding which of those four it belonged to —
// and that has already been got wrong once: `service` (S274) was never added to the test-send
// allow-list in index.js, so a `service` test send is coerced to `transactional` to this day.
// (PATTERN-218 — "when adding an enum value, grep EVERY gate on that column".)
//
// So the classes below are NOT synonyms for each other. Read the one you actually mean.

// Every purpose the send path accepts. Order is documentation, not behaviour.
const PURPOSES = ['marketing', 'influencer_outreach', 'service', 'utility', 'transactional'];

// ── The four classes, each answering ONE question ────────────────────────────────

// ① Does this send need positive `opted_in` marketing consent?
//    ONLY marketing. influencer_outreach deliberately does NOT — that is the whole point of
//    the class: a cold business contact has never opted in, and recording one so the send can
//    proceed would be a fiction (design §4 option (a), rejected by Afshaan 2026-08-26).
const needsOptIn = (p) => p === 'marketing';

// ② Must this send be REFUSED to someone who has explicitly opted out?
//    marketing (via ①, which already demands opted_in) AND influencer_outreach.
//    ⚠️ THIS IS THE HALF THAT MAKES `influencer_outreach` HONEST RATHER THAN A LOOPHOLE.
//    Bypassing consent must not mean ignoring a withdrawal: optout.js writes a *consent* row
//    (purpose 'marketing'), NOT a suppression — deliberately, so a STOP does not also kill the
//    customer's order updates. So an influencer who replied STOP or clicked unsubscribe is
//    invisible to the suppression list and visible ONLY here. Skip this and cold outreach keeps
//    reaching people who told us to stop.
const honoursOptOut = (p) => p === 'marketing' || p === 'influencer_outreach';

// ③ Is this send "marketing-side" for SENDER routing?
//    The pickSender carve-out refuses a send that crosses the marketing boundary in either
//    direction. influencer_outreach is marketing-side: cold outreach must not leave the number
//    people opted into for ORDER UPDATES, or it reads as marketing to the recipient and drags
//    down that number's WhatsApp quality rating — exactly the harm the carve-out exists for.
const isMarketingSide = (p) => p === 'marketing' || p === 'influencer_outreach';

// ④ Does this send carry an email unsubscribe footer?
//    marketing AND influencer_outreach. Non-negotiable for outreach: bulk cold email without a
//    working unsubscribe is both an ESP-policy breach and — because of ② — the ONLY way the
//    recipient can ever generate the opt-out that ② then enforces. Withhold the footer and the
//    consent rule above has no input.
const needsUnsubscribe = (p) => p === 'marketing' || p === 'influencer_outreach';

// ── Deliberately NOT a class ─────────────────────────────────────────────────────
// UTM tagging stays `purpose === 'marketing'` at its call sites, unchanged. Outreach traffic
// is not campaign traffic, and folding it into the marketing UTM buckets would quietly corrupt
// Odo's by-source attribution. It is a separate question from all four above, which is the
// entire reason they are named separately rather than sharing one isMarketing boolean.
//
// RCS also stays marketing-only (send.js) — the one provisioned bot is registered
// `promotional`, so an outreach RCS message cannot exist on this account.

// Purposes whose marketing-pressure counters are shared. An influencer who is ALSO a customer
// must not receive frequency_cap_per_day marketing messages AND another full allowance of
// outreach on the same day; the cap is about how much we contact a person, not about which
// internal label the send carried.
// ⚠️ Asymmetric ON PURPOSE: a marketing send still counts only marketing (see gate.js). This
// change must not alter the behaviour of any purpose that already exists.
const PRESSURE_PURPOSES = ['marketing', 'influencer_outreach'];

module.exports = {
  PURPOSES, PRESSURE_PURPOSES,
  needsOptIn, honoursOptOut, isMarketingSide, needsUnsubscribe,
};
