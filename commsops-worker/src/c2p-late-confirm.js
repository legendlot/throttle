// C2P late confirm — repair a "no response" that the customer actually answered.
//
// THE BUG THIS EXISTS FOR (found 2026-08-18, S297, from Pruthvi's LOT47217 report).
// The C2P `ask` step gives the customer 60 minutes to tap a button. On timeout the
// interpreter deletes the response wait, runs `noresp_tag` (adds `relay-c2p-no-response`
// to the Shopify order) and exits `no_response`. A tap that lands after that window is
// still ingested as a `whatsapp_reply` event — but there is no wait left to match it and
// no live enrolment to wake, so it is silently discarded. The order keeps a tag saying the
// customer never answered, and CS cancels on the strength of it.
//
// Measured before the fix, over 829 C2P enrolments / 313 `no_response`:
//   105 customers tapped a confirm button AFTER their window closed
//    32 of those orders were cancelled anyway  — ₹75,216
//    70 were live and mis-tagged at the time   — ₹1,51,448
//
// ⚠️ A LONGER `within` DOES NOT FIX THIS and must not be proposed as one. Lateness spread
// of those 105: 10 within 1h of timeout · 17 at 1–3h · 15 at 3–6h · 26 at 6–12h · **37 beyond
// 12h**. Even a 12-hour window misses a third of them. The only correct shape is to accept
// the confirm whenever it arrives, which is what this module does.
//
// ⚠️ THIS IS NOT A RE-LITIGATION OF THE TWO SETTLED C2P CALLS in reference/decisions.md
// ("quiet hours do NOT apply to utility" and "C2P cancellations are an ACCEPTED TRADE").
// Both concern customers who did NOT answer; an early cancellation being cheaper than a
// failed COD delivery is still true and is untouched here. This path only ever fires when
// a customer DID answer. Do not widen it into a cancellation-suppressor.
//
// DELIBERATELY NOT DONE HERE: sending the customer a "thanks for confirming" message. That
// needs the send gate, the 24h window and message logging, and commsops sends are under an
// explicit go-live gate — so the acknowledgment is a follow-up for the relay lane, tracked
// in BACKLOG. The tag is the load-bearing half: it is what CS reads before cancelling.

const A = require('./auth.js');
const SH = require('./shopify.js');
const AL = require('./alerts.js');

// Buttons that mean "keep my COD order". Both C2P send steps route these to `confirm_tag`:
// `Confirm COD Order` on the initial ask, `no_confirm` on the cancel double-check.
const CONFIRM_BUTTON_IDS = new Set(['confirm cod order', 'no_confirm']);

const NO_RESPONSE_TAG = 'relay-c2p-no-response';
const CONFIRMED_TAG   = 'relay-cod-confirmed';
const REPAIRED_TAG    = 'relay-c2p-late-confirm';            // audit marker + idempotency key
const AFTER_CANCEL_TAG = 'relay-c2p-late-confirm-after-cancel';

// How far back to look for the enrolment this tap belongs to. 7 days is well past the
// observed tail (the latest real late confirm was ~3 days) without turning an unrelated tap
// months later into a resurrection of a long-dead order.
const LOOKBACK_DAYS = 7;
const MAX_ENROLMENTS = 5;   // newest-first; a profile can have several C2P orders in a week

const ORDER_TAGS_Q = `query($id:ID!){ order(id:$id){ id name tags cancelledAt displayFulfillmentStatus } }`;
const TAGS_ADD_M    = `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ field message } } }`;
const TAGS_REMOVE_M = `mutation($id:ID!,$tags:[String!]!){ tagsRemove(id:$id,tags:$tags){ userErrors{ field message } } }`;

const isConfirmButton = (buttonId) =>
  CONFIRM_BUTTON_IDS.has(String(buttonId || '').trim().toLowerCase());

// Recent enrolments for this profile that ended saying the customer never answered.
// Deliberately NOT filtered by journey id: the journey can be re-versioned or renamed, and
// the `relay-c2p-no-response` tag on the order (checked below) is the real discriminator.
async function recentNoResponseEnrolments(env, profileId) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const r = await A.sbComms(
    `/rest/v1/enrolments?profile_id=eq.${A.enc(profileId)}&status=eq.no_response` +
    `&ended_at=gte.${A.enc(since)}&select=id,context,ended_at` +
    `&order=ended_at.desc&limit=${MAX_ENROLMENTS}`, env);
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

// The order this enrolment was about. The interpreter reads the same shopify_order_id off the
// pinned trigger event, so resolving it the same way keeps the repair aimed at exactly the
// order `noresp_tag` wrote to.
async function orderIdForEnrolment(env, enrolment) {
  const evId = enrolment?.context?.trigger_event_id;
  if (!evId) return null;
  const r = await A.sbComms(
    `/rest/v1/events?id=eq.${A.enc(evId)}&select=properties&limit=1`, env);
  if (!r.ok) return null;
  const p = r.data?.[0]?.properties || {};
  return p.shopify_order_id ?? p.order_id ?? null;
}

// Best-effort by construction: every failure returns a reason and the webhook carries on.
// A missed repair leaves exactly the state we had before this module existed, which is bad
// but survivable; a thrown error here would 500 the webhook and make Meta redeliver the whole
// batch, re-running the opt-out and window writes alongside it.
async function repairLateConfirm(env, { profileId, buttonId, providerMessageId }) {
  if (!isConfirmButton(buttonId)) return { ok: true, skipped: 'not_a_confirm_button' };
  if (!profileId) return { ok: true, skipped: 'no_profile' };

  const enrolments = await recentNoResponseEnrolments(env, profileId);
  if (!enrolments.length) return { ok: true, skipped: 'no_recent_no_response_enrolment' };

  for (const en of enrolments) {
    const oid = await orderIdForEnrolment(env, en);
    if (!oid) continue;
    const gid = String(oid).startsWith('gid://') ? String(oid) : `gid://shopify/Order/${oid}`;

    let order;
    try {
      const q = await SH.shopifyGraphQL(env, ORDER_TAGS_Q, { id: gid });
      order = q?.order;
    } catch (e) {
      console.log('c2p_late_confirm_order_read_failed', JSON.stringify({
        enrolment_id: en.id, reason: String(e?.message || e).slice(0, 120) }));
      continue;
    }
    if (!order) continue;

    const tags = (Array.isArray(order.tags) ? order.tags : []).map((t) => String(t).toLowerCase());

    // Only ever touch an order that is actually carrying the wrong tag. This is what makes the
    // module safe to run on every confirm tap: a customer who answered inside the window has no
    // no-response tag, so their order is left completely alone.
    if (!tags.includes(NO_RESPONSE_TAG)) continue;

    // Idempotency. Meta redelivers webhooks, and a customer can tap twice.
    if (tags.includes(REPAIRED_TAG) || tags.includes(AFTER_CANCEL_TAG)) {
      return { ok: true, skipped: 'already_repaired', order: order.name };
    }

    // Already cancelled → do NOT quietly tag it confirmed. The order is gone; re-tagging it
    // would only make the record read as if nothing went wrong, and the customer is owed a
    // call, not a tag. Mark it for CS and alert a human.
    if (order.cancelledAt) {
      await SH.shopifyGraphQL(env, TAGS_ADD_M, { id: gid, tags: [AFTER_CANCEL_TAG] }).catch(() => {});
      await AL.alert(env, `:telephone_receiver: C2P LATE CONFIRM ON A CANCELLED ORDER — ${order.name}: the customer tapped "${buttonId}" after we had already tagged them no-response and cancelled. They wanted the order. Please call them back. (Tagged \`${AFTER_CANCEL_TAG}\`.)`).catch(() => {});
      console.log('c2p_late_confirm_after_cancel', JSON.stringify({
        order: order.name, enrolment_id: en.id, provider_message_id: providerMessageId || null }));
      return { ok: true, outcome: 'after_cancel', order: order.name };
    }

    // The repair itself. Remove first, then add: if the second call fails the order is left
    // untagged rather than carrying both "no response" and "confirmed", which is the one
    // combination no human could read correctly.
    const rm = await SH.shopifyGraphQL(env, TAGS_REMOVE_M, { id: gid, tags: [NO_RESPONSE_TAG] })
      .catch((e) => ({ __err: String(e?.message || e) }));
    if (rm?.__err || (rm?.tagsRemove?.userErrors || []).length) {
      console.log('c2p_late_confirm_untag_failed', JSON.stringify({
        order: order.name, reason: rm?.__err || JSON.stringify(rm.tagsRemove.userErrors).slice(0, 120) }));
      return { ok: false, error: 'untag_failed', order: order.name };
    }
    await SH.shopifyGraphQL(env, TAGS_ADD_M, { id: gid, tags: [CONFIRMED_TAG, REPAIRED_TAG] })
      .catch((e) => { console.log('c2p_late_confirm_tag_failed', JSON.stringify({
        order: order.name, reason: String(e?.message || e).slice(0, 120) })); });

    console.log('c2p_late_confirm_repaired', JSON.stringify({
      order: order.name, enrolment_id: en.id, button_id: buttonId,
      ended_at: en.ended_at, provider_message_id: providerMessageId || null }));
    return { ok: true, outcome: 'repaired', order: order.name };
  }

  return { ok: true, skipped: 'no_matching_order' };
}

module.exports = { repairLateConfirm, isConfirmButton, CONFIRM_BUTTON_IDS,
                   NO_RESPONSE_TAG, CONFIRMED_TAG, REPAIRED_TAG, AFTER_CANCEL_TAG };
