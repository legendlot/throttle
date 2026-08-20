// ── Customer context for the screen-pop ──────────────────────────────────────
//
// Afshaan, 2026-08-20: "as soon as the call is connected the agent should have all the
// info ready — who the customer is, what was their last purchase, is that order
// delivered or not, tracking details, is this the customer's first call or nth call…
// so the agent doesn't waste time digging for the basic info with the customer, which
// is very irritating if the customer has a grievance."
//
// Almost none of this is new capability. shopifyLookup() already returns the customer
// and their recent orders WITH shipment state attached (courier, AWB, tracking link,
// lifecycle label, COD, RTO alert), and the ticket history query already exists. What
// was missing is that nothing assembled them into one payload, and nothing fetched
// them before the agent picked up.
//
// ⚠️ Timing is the whole point. The greeting is ~6s and the ring up to 30s, so warming
// this while the caller waits gives ~35 seconds of runway — the card is ready before
// the agent says hello. Fetching it when the agent answers would show a spinner during
// the first words of a grievance call, which is the exact experience being fixed.

/**
 * @param deps { env, sb, toE164, shopifyLookup }
 */
export function makeCallContext(deps) {
  const { env, sb, toE164, shopifyLookup } = deps;

  /**
   * Assemble everything an agent should see before speaking.
   *
   * Every source is fetched CONCURRENTLY and every one degrades independently: a
   * Shopify timeout must not cost the agent the call history, and no failure here may
   * ever block a live call. Errors become `null` sections, never a thrown request.
   */
  async function assemble({ phone, excludeCallId = null }) {
    const e164 = toE164(phone);
    if (!e164) return { known: false, reason: 'no caller id' };

    const since90 = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const enc = encodeURIComponent(e164);

    const safe = (p, label) => p.catch(e => {
      console.log(`[context] ${label} failed: ${e?.message || e}`);
      return null;
    });

    const [shop, callHist, tickets, openTicket, waThread] = await Promise.all([
      safe(shopifyLookup({ phone: e164 }, env), 'shopify'),
      // Nth-caller. Counts CALLS, not tickets: coalescing means three calls can share
      // one ticket, and "3rd call this week" is what makes a caller feel recognised.
      safe(sb(`/rest/v1/cs_calls?customer_phone=eq.${enc}`
        + `&started_at=gte.${encodeURIComponent(since90)}`
        + `&select=id,started_at,status,direction&order=started_at.desc&limit=50`, env), 'calls'),
      safe(sb(`/rest/v1/cs_tickets?customer_phone=eq.${enc}`
        + `&select=ticket_no,disposition,issue_category,stage,created_at,closed_at`
        + `&order=created_at.desc&limit=5`, env), 'tickets'),
      safe(sb(`/rest/v1/cs_tickets?customer_phone=eq.${enc}`
        + `&stage=not.in.(closed,cancelled,rejected)`
        + `&select=id,ticket_no,disposition,stage,assigned_agent_name,created_at`
        + `&order=created_at.desc&limit=1`, env), 'open_ticket'),
      // An open WhatsApp conversation matters: answering a call without knowing the
      // customer is mid-thread on WhatsApp is how the same issue gets handled twice.
      safe(sb(`/rest/v1/cs_wa_threads?customer_phone=eq.${enc}`
        + `&thread_state=not.eq.closed`
        + `&select=id,channel,last_message_at,assigned_agent_name,has_unread_inbound`
        + `&order=last_message_at.desc&limit=1`, env), 'wa_thread'),
    ]);

    const priorCalls = (callHist?.data || []).filter(c => c.id !== excludeCallId);
    const lastCall = priorCalls[0] || null;
    const orders = shop?.recent_orders || [];
    const lastOrder = orders[0] || null;

    return {
      known: Boolean(shop?.found) || priorCalls.length > 0,
      phone: e164,
      customer: shop?.found ? {
        name: shop.customer?.name || null,
        email: shop.customer?.email || null,
        orders_total: shop.customer?.orders_count ?? null,
        spend_total: shop.customer?.total_spent ?? null,
        city: shop.customer?.city || null,
      } : null,
      shopify_configured: shop?.configured !== false,

      // "First-time caller" vs "4th call in 90 days" — the line that makes a customer
      // feel recognised instead of processed.
      call_history: {
        prior_calls: priorCalls.length,
        is_first_call: priorCalls.length === 0,
        last_call_at: lastCall?.started_at || null,
        last_call_status: lastCall?.status || null,
        // Repeat callers in a short window are the ones who could not get through:
        // 79% of "nobody spoke" tickets in July had repeat calls coalesced in.
        calls_last_24h: priorCalls.filter(c =>
          Date.now() - new Date(c.started_at).getTime() < 24 * 3600 * 1000).length,
      },

      // The order card. `shipment` is already attached by attachShipments() and carries
      // the delivery lifecycle — Shopify's own fulfilment stops at "dispatched" and
      // never moves, so "where is my order" cannot be answered from Shopify alone.
      last_order: lastOrder ? {
        order_no: lastOrder.order_no,
        placed_at: lastOrder.created_at,
        total: lastOrder.total,
        financial_status: lastOrder.financial_status,
        items: lastOrder.line_items || lastOrder.items || null,
        admin_url: lastOrder.admin_url || null,
        shipment: lastOrder.shipment || null,
      } : null,
      order_count_recent: orders.length,

      open_ticket: openTicket?.data?.[0] || null,
      recent_tickets: tickets?.data || [],
      open_conversation: waThread?.data?.[0] || null,
      assembled_at: new Date().toISOString(),
    };
  }

  /**
   * Assemble and persist onto the call row.
   *
   * ⚠️ Best-effort by design and NEVER throws. This runs off a webhook that Exotel
   * fires while a customer is on the line; a failure here must cost a screen-pop, not
   * a call.
   */
  async function warm(callId, phone) {
    try {
      const ctx = await assemble({ phone, excludeCallId: callId });
      await sb(`/rest/v1/cs_calls?id=eq.${encodeURIComponent(callId)}`, env, {
        method: 'PATCH',
        body: JSON.stringify({ customer_context: ctx, context_warmed_at: new Date().toISOString() }),
      });
      return ctx;
    } catch (e) {
      console.log(`[context] warm failed call=${callId}: ${e?.message || e}`);
      return null;
    }
  }

  return { assemble, warm };
}
