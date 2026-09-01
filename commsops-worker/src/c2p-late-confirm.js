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
// ✅ THE ACKNOWLEDGMENT NOW SHIPS (S326, 2026-09-01). The paragraph that stood here said it was
// "deliberately not done" because "commsops sends are under an explicit go-live gate". ⚠️ THAT
// GATE HAS BEEN OPEN SINCE S269 — `comms.settings.test_mode = false`, verified 2026-09-01, and
// journeys/campaigns have been messaging real customers for weeks. The blocker was stale, which
// is why the customer was still hearing silence a fortnight after the tag half was fixed.
// Measured 2026-09-01: 136 late confirms all-time, 17 since the S297 tag fix, 16 in the last 14
// days, most recent that morning — roughly one a day, every one of them answered with nothing.
//
// ⭐ THE COPY IS READ FROM THE LIVE JOURNEY, NEVER COPIED HERE. `sendLateConfirmAck` loads the
// `confirm_msg` step out of the C2P journey's ACTIVE version and sends exactly that. So a late
// confirm gets byte-identical wording to an in-window one, and editing the journey moves both.
// A second copy of customer-facing text in a worker file is a divergence with a date on it.

const A = require('./auth.js');
const SH = require('./shopify.js');
const AL = require('./alerts.js');
const { send } = require('./send.js');
const JG = require('./journey-graph.js');   // ID_TYPE_FOR_CHANNEL — one channel→identifier map, shared with journey-workflow

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
    `&ended_at=gte.${A.enc(since)}&select=id,journey_id,context,ended_at` +
    `&order=ended_at.desc&limit=${MAX_ENROLMENTS}`, env);
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

// The multi-order race (hostile review, S297 — 37 live instances of the shape at review time):
// a customer whose order A went no_response LAST week places order B this week and taps Confirm
// inside B's fresh window. The live journey answers B correctly — but A's enrolment is still in
// the 7-day lookback and A still carries the tag, so without this guard the repair would mark A
// confirmed on the strength of a tap that was about B. If ANY newer enrolment of the same
// journey exists, the tap is presumed to answer the newest ask and the old one is left alone —
// skipping is the safe side: the worst case of skipping is the pre-fix status quo, while the
// worst case of repairing is confirming an order the customer never answered for.
async function newerAskExists(env, profileId, enrolment) {
  if (!enrolment?.journey_id) return false;   // can't tell → let the tag checks decide
  const r = await A.sbComms(
    `/rest/v1/enrolments?profile_id=eq.${A.enc(profileId)}` +
    `&journey_id=eq.${A.enc(enrolment.journey_id)}` +
    `&enrolled_at=gt.${A.enc(enrolment.ended_at)}&select=id&limit=1`, env);
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

// The order this enrolment was about. The interpreter reads the same shopify_order_id off the
// pinned trigger event, so resolving it the same way keeps the repair aimed at exactly the
// order `noresp_tag` wrote to.
async function triggerPropsForEnrolment(env, enrolment) {
  const evId = enrolment?.context?.trigger_event_id;
  if (!evId) return null;
  const r = await A.sbComms(
    `/rest/v1/events?id=eq.${A.enc(evId)}&select=properties&limit=1`, env);
  if (!r.ok) return null;
  return r.data?.[0]?.properties || {};
}

async function orderIdForEnrolment(env, enrolment) {
  const p = await triggerPropsForEnrolment(env, enrolment);
  if (!p) return null;
  return p.shopify_order_id ?? p.order_id ?? null;
}

// The acknowledgment. Best-effort by construction, exactly like the repair around it: this runs
// AFTER the tags are already correct, and the tags are the load-bearing half (they are what CS
// reads before cancelling). A failure to send must never undo or block a completed repair, so
// every path here returns a reason and nothing throws.
//
// ⚠️ The 24h WhatsApp window is open by construction — this only ever runs because the customer
// just sent us a button tap, which is an inbound message. It is still not ASSUMED: the send goes
// through the normal gate, so if the window is somehow shut the message is logged `skipped`
// rather than shipped blind.
async function sendLateConfirmAck(env, { profileId, enrolment, journeyId }) {
  try {
    // Copy comes from the journey's ACTIVE version, so the late path can never drift from the
    // in-window one. No step (renamed/removed) → send NOTHING. Inventing wording here is how a
    // second, unreviewed customer message is born.
    const jr = await A.sbComms(
      `/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=active_version&limit=1`, env);
    const activeVersion = jr.ok ? jr.data?.[0]?.active_version : null;
    if (!activeVersion) return { ok: true, skipped: 'no_active_version' };
    const vr = await A.sbComms(
      `/rest/v1/journey_versions?journey_id=eq.${A.enc(journeyId)}` +
      `&version=eq.${activeVersion}&select=definition&limit=1`, env);
    const step = vr.ok ? vr.data?.[0]?.definition?.steps?.confirm_msg : null;
    const text = step && (step.text || step.body);
    if (!text) return { ok: true, skipped: 'no_confirm_msg_step' };

    const props = await triggerPropsForEnrolment(env, enrolment);
    if (!props) return { ok: true, skipped: 'no_trigger_props' };

    // ⚠️ Resolve the identifier TYPE from the shared map, not a hardcoded 'phone' — found by
    // hostile review 2026-09-01. journey-workflow.js uses G.ID_TYPE_FOR_CHANNEL for exactly this
    // lookup; a second hardcoded copy is the same duplicate-constant drift that put a fourth
    // literal DLT-marker regex in index.js earlier the same day. It resolves to 'phone' today, so
    // this is drift-proofing, not a live bug.
    const idType = JG.ID_TYPE_FOR_CHANNEL.whatsapp || 'phone';
    const idr = await A.sbComms(
      `/rest/v1/identifiers?profile_id=eq.${A.enc(profileId)}&type=eq.${A.enc(idType)}` +
      `&select=value&order=last_seen.desc&limit=1`, env);
    const to = idr.ok ? idr.data?.[0]?.value : null;
    if (!to) return { ok: true, skipped: `no_${idType}_identifier` };

    const res = await send(env, {
      channel: 'whatsapp',
      // 'utility' matters twice: quiet hours do not apply to utility (reference/decisions.md),
      // and the gate lets transactional past everything but a hard suppression. Taken from the
      // step rather than hardcoded so it tracks the journey if that ever changes.
      purpose: step.purpose || 'utility',
      profileId, to,
      senderId: step.senderId || step.sender_id || undefined,
      eventContext: props,
      // Same inline-template shape journey-workflow.js uses for a free-form step: the body lives
      // on the step, not in the template library.
      template: { channel: 'whatsapp', name: 'c2p:late_confirm_ack',
                  content: { text }, variables: step.variables || [] },
      source: `c2p_late_confirm:${enrolment.id}`,
      // One ack per enrolment, ever. Meta redelivers webhooks and a customer can tap twice; the
      // tag-based idempotency above stops the repair repeating, and this stops the SEND repeating
      // even on a path that somehow reached here twice.
      dedupKey: `c2p_late_confirm_ack:${enrolment.id}`,
    });
    return { ok: true, send_status: res?.status || null, reason: res?.reason || null };
  } catch (e) {
    console.log('c2p_late_confirm_ack_failed', JSON.stringify({
      enrolment_id: enrolment?.id || null, reason: String(e?.message || e).slice(0, 140) }));
    return { ok: false, error: 'ack_failed' };
  }
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
    if (await newerAskExists(env, profileId, en)) {
      console.log('c2p_late_confirm_skipped_newer_ask', JSON.stringify({ enrolment_id: en.id }));
      return { ok: true, skipped: 'newer_ask_exists' };
    }
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

    // ⛔ The ack fires ONLY here, on a genuine repair — never on the after_cancel branch above.
    // That order is gone; "Order #X is set for Cash on Delivery" would be a false statement to a
    // customer whose order was cancelled, and they are owed the phone call that branch alerts
    // for, not a reassuring message. The early `return` up there is what keeps them apart.
    const ack = await sendLateConfirmAck(env, {
      profileId, enrolment: en, journeyId: en.journey_id });

    console.log('c2p_late_confirm_repaired', JSON.stringify({
      order: order.name, enrolment_id: en.id, button_id: buttonId,
      ended_at: en.ended_at, provider_message_id: providerMessageId || null,
      ack: ack?.send_status || ack?.skipped || ack?.error || null }));
    return { ok: true, outcome: 'repaired', order: order.name, ack };
  }

  return { ok: true, skipped: 'no_matching_order' };
}

module.exports = { repairLateConfirm, sendLateConfirmAck, isConfirmButton, CONFIRM_BUTTON_IDS,
                   NO_RESPONSE_TAG, CONFIRMED_TAG, REPAIRED_TAG, AFTER_CANCEL_TAG };
