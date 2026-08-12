// The single ingestion seam. Any system (Shopify adapter, internal, delivery
// receipts; later Pitstop) POSTs here. Resolves identity (atomic RPC) → appends
// the event (idempotent) → derives attributes → (M7: fires journey triggers).
const A = require('./auth.js');

// Given the enrolment_waits rows matching (profile, event), produce ONE signal per
// instance (exit wins over response — a cancel/convert must pre-empt a nudge). The
// payload is what the parked JourneyWorkflow's #park reads.
function pickSignals(rows, eventName, eventId) {
  const byInstance = new Map();
  for (const r of rows || []) {
    const cur = byInstance.get(r.instance_id);
    if (!cur || (r.kind === 'exit' && cur.kind !== 'exit')) byInstance.set(r.instance_id, r);
  }
  return [...byInstance.values()].map((r) => ({
    instanceId: r.instance_id,
    payload: r.kind === 'exit'
      ? { kind: 'exit', outcome: r.outcome || 'exited', event: eventName, event_id: eventId }
      : { kind: 'response', event: eventName, event_id: eventId },
  }));
}

// Known-event attribute derivation (v1 — comms-relevant signals only). Mutates
// the survivor profile's attributes from the event. Kept in JS so rules evolve freely.
async function deriveAttributes(env, profileId, name, properties) {
  if (!profileId) return;
  let patch = null;
  if (name === 'order_placed') {
    // bump lifetime_orders + last_order_at + lifetime_value
    const r = await A.sbComms(
      `/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes`, env);
    const attrs = (r.ok && r.data?.[0]?.attributes) || {};
    const orders = Number(attrs.lifetime_orders || 0) + 1;
    const addValue = Number(properties?.total || properties?.total_price || 0);
    patch = {
      ...attrs,
      lifetime_orders: orders,
      last_order_at: properties?.occurred_at || new Date().toISOString(),
      lifetime_value: Number(attrs.lifetime_value || 0) + (isFinite(addValue) ? addValue : 0),
    };
  } else if (name === 'order_delivered') {
    const r = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes`, env);
    const attrs = (r.ok && r.data?.[0]?.attributes) || {};
    patch = { ...attrs, last_delivery_at: new Date().toISOString() };
  }
  if (patch) {
    await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}`, env, {
      method: 'PATCH', body: JSON.stringify({ attributes: patch, updated_at: new Date().toISOString() }),
    });
  }
}

// ingest({identifiers, name, occurred_at, properties, source, idempotency_key})
async function ingest(env, payload) {
  const { identifiers, name, occurred_at, properties, source, idempotency_key, profile_id } = payload || {};
  if (!name) return { ok: false, error: 'name_required' };
  // A caller that ALREADY knows the profile may pass profile_id and skip resolution. Needed by
  // the Uniware courier feed: Uniware masks customer contact ('********'), so there are no
  // identifiers to resolve — the profile is looked up from the order instead.
  const hasIds = Array.isArray(identifiers) && identifiers.length > 0;
  if (!hasIds && !profile_id) return { ok: false, error: 'identifiers_required' };

  let profileId = profile_id || null;
  if (!profileId) {
    // 1. resolve identity (atomic) → profile_id
    const rpc = await A.sbComms('/rest/v1/rpc/resolve_identity', env, {
      method: 'POST',
      body: JSON.stringify({ p_identifiers: identifiers, p_source: source || null }),
    });
    if (!rpc.ok) return { ok: false, error: 'resolve_failed:' + JSON.stringify(rpc.data) };
    profileId = rpc.data; // RPC returns the uuid scalar
  }

  // 2. append event — idempotent on idempotency_key (UNIQUE). ignore-duplicates so a
  //    retried webhook never double-counts; null key always inserts.
  const evRow = {
    profile_id: profileId,
    name,
    occurred_at: occurred_at || new Date().toISOString(),
    properties: properties || {},
    source: source || null,
    idempotency_key: idempotency_key || null,
  };
  const headers = idempotency_key ? { Prefer: 'resolution=ignore-duplicates,return=representation' } : {};
  const path = idempotency_key
    ? '/rest/v1/events?on_conflict=idempotency_key'
    : '/rest/v1/events';
  const ev = await A.sbComms(path, env, { method: 'POST', headers, body: JSON.stringify(evRow) });
  if (!ev.ok) return { ok: false, error: 'event_insert_failed:' + JSON.stringify(ev.data) };
  const deduped = Array.isArray(ev.data) && ev.data.length === 0; // ignored as duplicate
  const eventId = (Array.isArray(ev.data) && ev.data[0]?.id) || null;

  // 3. derive attributes (only on first occurrence, not on dedup replays)
  if (!deduped) await deriveAttributes(env, profileId, name, { ...properties, occurred_at });

  // 4. (M7) fire journey triggers — match ACTIVE event-triggered journeys on this
  //    event name, enqueue an enrol per match (Queue keeps ingest fast + under the
  //    subrequest limit). First occurrence only (skip on dedup replays).
  if (!deduped) {
    try {
      const jr = await A.sbComms('/rest/v1/journeys?status=eq.active&select=id,trigger', env);
      const journeys = (jr.ok && jr.data) || [];

      // REACHABILITY PRECONDITION — `trigger.requires_identifier` (2026-07-29).
      //
      // WHY. A journey whose only step is a WhatsApp send is pointless for a profile with no
      // phone number, but it still costs a Workflow instance, a queue message, and a 30-minute
      // durable sleep before the send step discovers that. Measured on the add-to-cart journey:
      // 1,525 pixel-triggered enrolments, 1,374 skipped `no_phone_identifier`, and ZERO messages
      // that ever reached a customer — ~80% of all enrolment volume on the platform, burnt.
      //
      // Anonymous browsing is the norm (the pixel identifies ~1.3% of visitors; Shopflo carries
      // identity on essentially all of its events), so this is structural, not a blip.
      //
      // The cost is real but measured: 3 of 1,525 profiles gained a phone DURING the 30-minute
      // wait, so enrolling early does occasionally catch a late identification. None of those
      // produced a message that reached anyone — but if identity coverage improves, revisit this
      // rather than assuming it stays free.
      //
      // Deliberately a REACHABILITY test, not "is this event from the pixel": the pixel is only
      // today's proxy for anonymous, and a source-based filter would silently keep excluding the
      // pixel path even once it starts identifying people.
      //
      // Lazily resolved and memoised: journeys that don't declare it pay nothing, and a profile
      // is looked up at most once per ingest no matter how many journeys ask.
      let idTypes = null;
      const isReachable = async (want) => {
        const need = (Array.isArray(want) ? want : [want]).map((s) => String(s).toLowerCase());
        if (!need.length) return true;
        if (!profileId) return false;
        if (idTypes === null) {
          const ir = await A.sbComms(
            `/rest/v1/identifiers?profile_id=eq.${A.enc(profileId)}&select=type`, env);
          // Fail OPEN on a read error: a transient blip must not silently stop enrolling. The
          // send gate re-checks reachability anyway, so the worst case is the old behaviour.
          if (!ir.ok) { idTypes = null; return true; }
          idTypes = new Set((ir.data || []).map((r) => String(r.type).toLowerCase()));
        }
        return need.some((t) => idTypes.has(t));
      };

      for (const j of journeys) {
        const t = j.trigger || {};
        if (t.type !== 'event' || t.name !== name) continue;
        // optional simple property filter: trigger.filter = {prop: value} (all must match)
        // Case-INSENSITIVE, matching what condition nodes already do (`evalEventProperty`
        // lowercases both sides). They disagreed until 2026-07-31: a filter value of `True` or
        // `L.O.T CARS` matched nothing here while working fine in a condition, and the failure is
        // completely silent — the journey simply enrols zero, with no error anywhere to explain it.
        // A filter that matches nothing is indistinguishable from a feed that is not arriving,
        // which is the expensive kind of bug. Trim too: a trailing space is the same trap.
        const norm = (x) => String(x ?? '').trim().toLowerCase();
        // A filter value is EITHER a scalar (equality — the original and still the common form)
        // OR `{not: scalar}` (negation, S273).
        //
        // WHY NEGATION EXISTS. Without it, "everything except X" had to be inverted into an
        // equality on the other value — and that silently drops every event where the property
        // is ABSENT. Measured 2026-08-12: `primary_category` is absent on 42% of `product_viewed`
        // (100% of Shopflo-sourced ones, which never get category enrichment), while the category
        // we actually wanted to exclude, `L.O.T Build`, is 0.49%. So filtering the general browse
        // journey to `L.O.T Cars` to dodge 0.49% would have stopped enrolling 42% of its traffic —
        // a far bigger self-inflicted wound than the double-enrol it was meant to fix.
        //
        // ⚠️ ABSENT SATISFIES A NEGATION, DELIBERATELY. `{not:'X'}` means "not X", NOT "present
        // and not X" — an unclassified event passes. That fail-OPEN choice is the entire point:
        // it is what makes it safe to exclude a rare category from a journey whose feed is only
        // partly classified. If you ever need "present AND not X", that is two leaves, not a
        // tweak to this one — changing this comparison would silently re-introduce the 42% drop.
        const matches = (v, actual) =>
          (v && typeof v === 'object' && !Array.isArray(v) && 'not' in v)
            ? norm(actual) !== norm(v.not)
            : norm(actual) === norm(v);
        const f = t.filter;
        if (f && typeof f === 'object' &&
            !Object.entries(f).every(([k, v]) => matches(v, (properties || {})[k]))) continue;
        if (t.requires_identifier && !(await isReachable(t.requires_identifier))) continue;
        await env.BROADCAST_QUEUE.send({ kind: 'enrol', journeyId: j.id, profileId, eventId });
      }
    } catch (e) { /* triggers are best-effort; never fail the ingest write on a trigger error */ }

    // (J1) Wake parked enrolments: find every enrolment awaiting THIS event for THIS
    // profile (O(log n) via the enrolment_waits index) and signal each instance once.
    // Best-effort: a matcher failure must never fail the ingest write. The DB pre-check
    // in the interpreter is the correctness backbone; these signals are the immediacy path.
    try {
      const wr = await A.sbComms(
        `/rest/v1/enrolment_waits?profile_id=eq.${A.enc(profileId)}&awaited_event=eq.${A.enc(name)}` +
        `&expires_at=gt.${A.enc(new Date().toISOString())}&select=instance_id,kind,outcome`, env);
      const rows = (wr.ok && wr.data) || [];
      for (const sig of pickSignals(rows, name, eventId)) {
        try {
          const inst = await env.JOURNEY_WORKFLOW.get(sig.instanceId);
          await inst.sendEvent({ type: 'signal', payload: sig.payload });
        } catch (e) { /* instance already ended / not waiting — benign; the row is swept later */ }
      }
    } catch (e) { /* matcher is best-effort; never fail the ingest write */ }
  }

  return { ok: true, profile_id: profileId, event_id: eventId, deduped };
}

module.exports = { ingest, deriveAttributes, pickSignals };
