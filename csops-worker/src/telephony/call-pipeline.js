// ── Vendor-neutral call pipeline ─────────────────────────────────────────────
//
// ONE implementation of "a call happened" for every telephony vendor. MyOperator
// and Exotel each normalise their own payload into a `NormalisedCall` and call in
// here; ticket creation, RULE-PITSTOP-018 coalescing, the Shopify lookup and agent
// attribution are written once.
//
// Why this exists (S301, 2026-08-20): LOT changed voice vendor once in three months
// (MyOperator → Exotel, 19 Aug). This seam — not owned infrastructure — is the answer
// to "what if we leave Exotel". Bolting a second vendor onto the original handlers
// would have duplicated the two incidents encoded below and let them drift apart.
//
// ⚠️ EXTRACTED WITH BEHAVIOUR UNCHANGED. Every branch here came from the MyOperator
// handlers in index.js and must stay byte-equivalent for `provider='myoperator'`.
// Two of them encode real incidents — read before "simplifying":
//   · pickConnectedLeg()  — S144: Maria missed → Sunitha answered, ticket credited Maria.
//   · the S156 ownership rule in attributeAgent() — an incoming call takes the ticket,
//     an outgoing one never steals a ticket it merely coalesced into.
//
// Dependency injection rather than imports: `sb`, `shopifyLookup` etc. all live in
// index.js, so importing them here would be circular. `makeCallPipeline(deps)` takes
// them instead.

// RULE-PITSTOP-018. 24h captures dropped-call + callback + same-day follow-up as one
// interaction. Every call is still its own cs_calls row — this de-duplicates TICKETS.
export const COALESCE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Who the audit trail credits an automated write to. Keeping 'MyOperator (auto)'
// byte-identical matters: it is what ~17,700 existing cs_ticket_history rows say,
// and the ticket timeline groups on it.
const ACTOR = {
  myoperator: 'MyOperator (auto)',
  exotel:     'Exotel (auto)',
};
const actorFor = (provider) => ACTOR[provider] || `${provider} (auto)`;

/**
 * How to find, and how to stamp, this provider's call row.
 *
 * MyOperator keeps its original key — UNIQUE (myop_account_id, call_session_id) —
 * because ~20 existing call sites and that constraint both depend on it.
 * Exotel keys on the partial UNIQUE (provider, provider_call_sid).
 *
 * `call_session_id` is NOT NULL in the DB and is what the app searches on, so an
 * Exotel row MIRRORS its CallSid into both columns rather than living only in
 * provider_call_sid.
 */
function callIdentity(norm) {
  if (norm.provider === 'myoperator') {
    // account_id may be null in theory; the filter must still be exact, and
    // PostgREST needs `is.null` rather than `eq.null`.
    const acct = norm.account_id
      ? `myop_account_id=eq.${norm.account_id}`
      : `myop_account_id=is.null`;
    return {
      match: `${acct}&call_session_id=eq.${encodeURIComponent(norm.call_session_id)}`,
      insert: {
        myop_account_id: norm.account_id || null,
        call_session_id: norm.call_session_id,
        provider: 'myoperator',
      },
    };
  }
  return {
    match: `provider=eq.${encodeURIComponent(norm.provider)}`
         + `&provider_call_sid=eq.${encodeURIComponent(norm.provider_call_sid)}`,
    insert: {
      provider: norm.provider,
      provider_call_sid: norm.provider_call_sid,
      call_session_id: norm.call_session_id,   // mirrored — NOT NULL, and what the app reads
      myop_account_id: norm.account_id || null,
    },
  };
}

/**
 * MyOperator delivers one leg per routing hop. On a ROUTED call (first agent misses
 * → it rings the next, who answers) the FIRST agent leg is the one who did NOT take
 * the call. Pick the leg that actually connected — not the first.
 *
 * ⚠️ S144 incident (Pruthvi): Maria missed → Sunitha answered, ticket credited Maria.
 * Do not re-derive this. Exotel's Details.Legs[] has the same shape problem, which is
 * why it lives in the shared pipeline rather than the MyOperator adapter.
 */
export function pickConnectedLeg(legs) {
  const arr = (Array.isArray(legs) ? legs : []).filter(l => l && l.agent && l.agent.email);
  if (!arr.length) return null;
  // status field name varies; treat as connected only when it positively says so
  const isConnected = (l) => {
    const s = String(l.status || l.leg_status || l.disposition || l.call_status || '').toLowerCase();
    if (!s) return null; // no status signal
    if (/no.?answer|missed|fail|reject|cancel|abandon|busy|unanswer/.test(s)) return false;
    return /answer|connect|complet|success|talk|bridge/.test(s);
  };
  const dur = (l) => Number(l.duration ?? l.duration_seconds ?? l.billsec ?? l.talk_time ?? 0) || 0;
  // 1) explicit connected leg → prefer the terminal one
  const connected = arr.filter(l => isConnected(l) === true);
  if (connected.length) return connected[connected.length - 1];
  // 2) positive-duration leg → prefer the terminal one
  const talked = arr.filter(l => dur(l) > 0);
  if (talked.length) return talked[talked.length - 1];
  // 3) no status/duration signal → the LAST agent leg beats the first for routed calls
  return arr[arr.length - 1];
}

export function agentEmailFromLegs(legs) {
  const l = pickConnectedLeg(legs);
  return (l && l.agent && l.agent.email) || null;
}

/**
 * Map a vendor's direction vocabulary onto the cs_calls CHECK, which admits exactly
 * {'incoming','outgoing'}.
 *
 * ⚠️ An unrecognised value returns NULL and LOGS — it is never passed through raw.
 * A CHECK passes on NULL, so the call is still logged (minus its direction) instead
 * of being rejected and vanishing. This is the metaAttachmentKind failure class that
 * silently dropped every shared Instagram reel.
 */
export function normaliseDirection(v, provider = 'call') {
  const d = String(v || '').toLowerCase().trim();
  if (d === 'incoming' || d === 'inbound' )                        return 'incoming';
  if (d === 'outgoing' || d === 'outbound')                        return 'outgoing';
  if (d === 'outbound-dial' || d === 'outbound-api')               return 'outgoing';  // Exotel
  if (d) console.log(`[${provider}] unmapped direction "${v}" — storing null so the call still records`);
  return null;
}

export function makeCallPipeline(deps) {
  const {
    env, sb, toE164, shopifyLookup, resolveAgentByEmail, inferOrderLink, SLA_DAYS,
  } = deps;

  async function insertHistorySystem(ticket_id, field_name, old_value, new_value, note, provider) {
    await sb(`/rest/v1/cs_ticket_history`, env, { method: 'POST', body: JSON.stringify({
      ticket_id, field_name,
      old_value: old_value == null ? null : String(old_value),
      new_value: new_value == null ? null : String(new_value),
      note,
      changed_by_user_id: null, changed_by_name: actorFor(provider),
    }) }).catch(() => {});
  }

  /**
   * Idempotent, additive upsert of one cs_calls row. Each vendor event (answered /
   * end / summary, or a poller reconcile) patches in its own fields.
   *
   * ⚠️ The INSERT result IS checked. The original did not, so a rejected insert
   * returned null and the caller carried on — a customer phoning us and leaving no
   * record anywhere. Same failure class as the dropped Instagram reels.
   */
  async function upsertCall(norm, patch) {
    const id = callIdentity(norm);
    const existing = await sb(
      `/rest/v1/cs_calls?${id.match}&select=id,ticket_id,status&limit=1`, env);
    if (existing.data?.[0]) {
      await sb(`/rest/v1/cs_calls?id=eq.${existing.data[0].id}`, env, {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      return existing.data[0];
    }
    const ins = await sb(`/rest/v1/cs_calls`, env, {
      method: 'POST',
      body: JSON.stringify({
        ...id.insert,
        cs_department_id: norm.department_id || null,
        direction:        norm.direction,
        did:              norm.exophone,
        exophone:         norm.exophone,
        customer_phone:   toE164(norm.customer_phone),
        ...patch,
      }),
    });
    if (!ins.ok) {
      console.error(`[${norm.provider}] cs_calls insert failed ${ins.status} `
        + `session=${norm.call_session_id} dir=${norm.direction} `
        + `${JSON.stringify(ins.data)?.slice(0, 200)}`);
      return null;
    }
    return ins.data?.[0] || null;
  }

  /**
   * Ensure this call has a ticket: reuse its own, coalesce into an open one for the
   * same phone + department inside the window, or create a new one.
   *
   * ⚠️ EVERY call gets a ticket. A suppression policy (skip trivial/short calls) was
   * proposed and REJECTED 2026-08-20 by Afshaan — the data refutes it: of 428 July
   * "nobody spoke" tickets, 337 (79%) had repeat calls coalesced in (customers failing
   * to get through) and 39 went on to host a WhatsApp conversation on that same ticket.
   * Suppressing them deletes the evidence of a service failure and breaks the container
   * later channels attach to. The cost of a trivial ticket is paid at the CLOSE, which
   * is one click (updateTicket → disposition 'query' fast-closes). Do not re-propose.
   */
  async function ensureTicket(norm) {
    const idq = callIdentity(norm).match;

    // Already has its own ticket (a repeat event for the same call) — just relink.
    const own = await sb(
      `/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(norm.call_session_id)}`
      + `&select=id,ticket_no&limit=1`, env);
    if (own.data?.[0]) {
      await sb(`/rest/v1/cs_calls?${idq}`, env, {
        method: 'PATCH', body: JSON.stringify({ ticket_id: own.data[0].id }),
      });
      return { ok: true, deduped: true, ticket_no: own.data[0].ticket_no, ticket_id: own.data[0].id };
    }

    const phone = toE164(norm.customer_phone);

    // RULE-PITSTOP-018 — coalesce repeat calls onto one ticket. Scope is
    // phone + department + recency, so distinct interactions days apart still get
    // their own ticket.
    if (phone) {
      const sinceIso = new Date(Date.now() - COALESCE_WINDOW_MS).toISOString();
      const dept = norm.department_id || null;
      const deptFilter = dept ? `&cs_department_id=eq.${dept}` : `&cs_department_id=is.null`;
      const open = await sb(
        `/rest/v1/cs_tickets?customer_phone=eq.${encodeURIComponent(phone)}`
        + `&stage=not.in.(closed,cancelled,rejected)`
        + `&created_at=gte.${encodeURIComponent(sinceIso)}`
        + deptFilter
        + `&select=id,ticket_no&order=created_at.desc&limit=1`, env);
      if (open.data?.[0]) {
        const keep = open.data[0];
        await sb(`/rest/v1/cs_calls?${idq}`, env, {
          method: 'PATCH', body: JSON.stringify({ ticket_id: keep.id }),
        });
        await insertHistorySystem(keep.id, 'call_coalesced', null, norm.call_session_id,
          `repeat call coalesced into this ticket (session ${norm.call_session_id}`
          + `${norm.direction ? ', ' + norm.direction : ''}) — see call log`, norm.provider);
        return { ok: true, coalesced_into: keep.ticket_no, ticket_id: keep.id };
      }
    }

    // usually null on the first event; backfilled by the summary / agent callback
    const agentEmail = norm.agent_ref?.email || agentEmailFromLegs(norm.legs);
    const [agent, shop] = await Promise.all([
      resolveAgentByEmail(agentEmail, env),
      shopifyLookup({ phone }, env),
    ]);

    const year = String(new Date().getFullYear());
    const seqRes = await sb(`/rest/v1/rpc/next_cs_ticket_seq`, env,
      { method: 'POST', body: JSON.stringify({ p_year: year }) });
    if (!seqRes.ok) return { ok: false, error: 'seq failed', status: 500 };
    const seq = Number(seqRes.data);
    if (!Number.isFinite(seq) || seq <= 0) return { ok: false, error: 'seq invalid', status: 500 };
    const ticket_no = `CS-${year}-${String(seq).padStart(5, '0')}`;

    const ins = await sb(`/rest/v1/cs_tickets`, env, { method: 'POST', body: JSON.stringify({
      ticket_no, call_session_id: norm.call_session_id, auto_created: true,
      myop_account_id: norm.account_id || null,
      cs_department_id: norm.department_id || null,
      created_by_user_id: null, created_by_name: actorFor(norm.provider),
      intake_channel: 'phone', call_direction: norm.direction, call_did: norm.exophone,
      call_answered_at: norm.started_at || new Date().toISOString(),
      customer_name: shop.found ? shop.customer.name : (phone ? `Caller ${phone}` : 'Unknown caller'),
      customer_phone: phone, customer_email: shop.found ? shop.customer.email : null,
      disposition: 'pending', issue_description: '[Pending — auto-created from call]',
      // Link the order when it is unambiguous — the Shopify lookup is already in hand,
      // so this costs no extra API call.
      ...(inferOrderLink(shop) || {}),
      due_at: new Date(Date.now() + (SLA_DAYS['pending'] ?? 7) * 24 * 60 * 60 * 1000).toISOString(),
      assigned_agent_id: agent.id, assigned_agent_name: agent.name,
      stage: 'intake',
    }) });
    if (!ins.ok) return { ok: false, error: `insert failed: ${JSON.stringify(ins.data)}`, status: ins.status };

    const ticket_id = ins.data[0].id;
    await sb(`/rest/v1/cs_calls?${idq}`, env, {
      method: 'PATCH',
      body: JSON.stringify({
        ticket_id,
        agent_user_id: agent.id,
        agent_name: agent.name,
        customer_name: shop.found ? shop.customer.name : null,
      }),
    });
    await insertHistorySystem(ticket_id, 'ticket_created', null, ticket_no,
      'auto-created from call', norm.provider);
    return { ok: true, ticket_no, ticket_id, created: true };
  }

  /**
   * Attribute a call to an agent and hand them the ticket.
   *
   * ⚠️ S156 ownership rule (Pruthvi) — do not simplify: a call's OWN ticket is found by
   * its session_id. A COALESCED repeat call has no ticket of its own, so fall back to
   * the ticket it was attached to — but ONLY for an INCOMING call. The agent who handled
   * the support call owns the ticket even when it was auto-created by an earlier OUTGOING
   * (e.g. COD-confirmation) call; an OUTGOING call never steals a ticket it merely
   * coalesced into. Before this, the summary keyed only on the new call's session_id, so
   * a coalesced incoming call never found the ticket and the outgoing agent kept credit.
   */
  async function attributeAgent(norm, { agent, callMeta }) {
    const idq = callIdentity(norm).match;

    if (!agent?.id) {
      if (callMeta) {
        await sb(`/rest/v1/cs_calls?${idq}`, env,
          { method: 'PATCH', body: JSON.stringify({ raw_meta: callMeta }) });
      }
      return { ok: true, skipped: 'no agent resolved' };
    }

    const patch = { agent_user_id: agent.id, agent_name: agent.name };
    if (callMeta) patch.raw_meta = callMeta;
    if (norm.agent_ref?.sip_id) patch.agent_sip_id = norm.agent_ref.sip_id;
    await sb(`/rest/v1/cs_calls?${idq}`, env, { method: 'PATCH', body: JSON.stringify(patch) });

    const existing = await sb(
      `/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(norm.call_session_id)}`
      + `&select=id&limit=1`, env);
    let ticketId = existing.data?.[0]?.id || null;
    if (!ticketId && norm.direction === 'incoming') {
      const callRow = await sb(`/rest/v1/cs_calls?${idq}&select=ticket_id`, env);
      ticketId = callRow.data?.[0]?.ticket_id || null;
    }
    if (ticketId) {
      await sb(`/rest/v1/cs_tickets?id=eq.${ticketId}`, env, {
        method: 'PATCH',
        body: JSON.stringify({ assigned_agent_id: agent.id, assigned_agent_name: agent.name }),
      });
      await insertHistorySystem(ticketId, 'assigned_agent_name', null, agent.name,
        norm.provider === 'myoperator'
          ? 'auto-assigned from call.summary'
          : 'auto-assigned from call', norm.provider);
    }
    return { ok: true, assigned: agent.name, ticket_id: ticketId };
  }

  /** Patch the ticket's denormalised call columns (duration, recording, refs). */
  async function patchTicketCallFields(norm, ticketPatch) {
    const r = await sb(
      `/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(norm.call_session_id)}`
      + `&select=id&limit=1`, env);
    if (!r.data?.[0]) return null;
    await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(norm.call_session_id)}`,
      env, { method: 'PATCH', body: JSON.stringify(ticketPatch) });
    return r.data[0].id;
  }

  return {
    upsertCall, ensureTicket, attributeAgent, patchTicketCallFields,
    insertHistorySystem, callIdentity,
  };
}
