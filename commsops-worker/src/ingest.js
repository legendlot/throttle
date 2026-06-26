// The single ingestion seam. Any system (Shopify adapter, internal, delivery
// receipts; later Pitstop) POSTs here. Resolves identity (atomic RPC) → appends
// the event (idempotent) → derives attributes → (M7: fires journey triggers).
const A = require('./auth.js');

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
  const { identifiers, name, occurred_at, properties, source, idempotency_key } = payload || {};
  if (!name) return { ok: false, error: 'name_required' };
  if (!Array.isArray(identifiers) || identifiers.length === 0)
    return { ok: false, error: 'identifiers_required' };

  // 1. resolve identity (atomic) → profile_id
  const rpc = await A.sbComms('/rest/v1/rpc/resolve_identity', env, {
    method: 'POST',
    body: JSON.stringify({ p_identifiers: identifiers, p_source: source || null }),
  });
  if (!rpc.ok) return { ok: false, error: 'resolve_failed:' + JSON.stringify(rpc.data) };
  const profileId = rpc.data; // RPC returns the uuid scalar

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
      for (const j of journeys) {
        const t = j.trigger || {};
        if (t.type !== 'event' || t.name !== name) continue;
        // optional simple property filter: trigger.filter = {prop: value} (all must match)
        const f = t.filter;
        if (f && typeof f === 'object' &&
            !Object.entries(f).every(([k, v]) => String((properties || {})[k]) === String(v))) continue;
        await env.BROADCAST_QUEUE.send({ kind: 'enrol', journeyId: j.id, profileId, eventId });
      }
    } catch (e) { /* triggers are best-effort; never fail the ingest write on a trigger error */ }
  }

  return { ok: true, profile_id: profileId, event_id: eventId, deduped };
}

module.exports = { ingest, deriveAttributes };
