// M7 journey engine — one Workflow instance per enrolment. Generic interpreter
// over the pinned, immutable journey definition. NOTE: the ONLY esm `import` in
// this file is `cloudflare:workers` (required for WorkflowEntrypoint); everything
// else uses require() to match the rest of the worker (esbuild bundles the interop).
import { WorkflowEntrypoint } from 'cloudflare:workers';
const A = require('./auth.js');
const { send } = require('./send.js');
const G = require('./journey-graph.js');
const CF = require('./cashfree.js');
const SH = require('./shopify.js');

const MAX_TRANSITIONS = 100; // safety against a mis-validated cyclic definition

// order_modify (COD→prepaid reconciliation) Shopify Admin API ops. Needs write_orders.
const ORDER_STATUS_Q = `query($id:ID!){ order(id:$id){ id displayFulfillmentStatus displayFinancialStatus createdAt cancelledAt } }`;
const ORDER_MARK_PAID_M = `mutation($input:OrderMarkAsPaidInput!){ orderMarkAsPaid(input:$input){ order{ id displayFinancialStatus } userErrors{ field message } } }`;
const ORDER_CANCEL_M = `mutation($orderId:ID!,$reason:OrderCancelReason!,$refund:Boolean!,$restock:Boolean!){ orderCancel(orderId:$orderId,reason:$reason,refund:$refund,restock:$restock){ job{ id } orderCancelUserErrors{ field message } userErrors{ field message } } }`;
const TAGS_ADD_M = `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ field message } } }`;

class JourneyWorkflow extends WorkflowEntrypoint {
  // params: { enrolmentId, journeyId, journeyVersion, profileId }
  async run(event, step) {
    const { enrolmentId, journeyId, journeyVersion, profileId } = event.payload;
    const env = this.env;

    // Load the IMMUTABLE pinned definition once (deterministic input for the whole run).
    const def = await step.do('load-definition', async () => {
      const r = await A.sbComms(
        `/rest/v1/journey_versions?journey_id=eq.${A.enc(journeyId)}&version=eq.${journeyVersion}&select=definition&limit=1`, env);
      if (!r.ok) throw new Error('load_definition_failed:' + JSON.stringify(r.data));
      return r.data?.[0]?.definition || null;
    });
    if (!def?.entry || !def?.steps) { await this.#end(env, step, enrolmentId, 'failed', null); return; }

    const enr = await step.do('load-enrolment', async () => {
      const r = await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolmentId)}&select=enrolled_at,context&limit=1`, env);
      if (!r.ok) throw new Error('load_enrolment_failed:' + JSON.stringify(r.data));
      const row = r.data?.[0] || {};
      return { enrolledAt: row.enrolled_at || null, triggerEventId: row.context?.trigger_event_id || null };
    });
    const enrolledAt = enr.enrolledAt;

    // Load the trigger event's properties once, so send steps can bind event vars
    // (e.g. the abandoned-cart template's {checkout_url}). No trigger / no event → {},
    // and event-sourced template vars fall back to their declared default.
    const triggerProps = await step.do('load-trigger', async () => {
      if (!enr.triggerEventId) return {};
      const r = await A.sbComms(`/rest/v1/events?id=eq.${A.enc(enr.triggerEventId)}&select=properties&limit=1`, env);
      if (!r.ok) throw new Error('load_trigger_failed:' + JSON.stringify(r.data));
      return r.data?.[0]?.properties || {};
    });

    // Journey name → utm_campaign on marketing sends (GA4/Odo attribution).
    const journeyName = await step.do('load-journey-name', async () => {
      const r = await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=name&limit=1`, env);
      if (!r.ok) throw new Error('load_journey_name_failed:' + JSON.stringify(r.data));
      return r.data?.[0]?.name || null;
    });

    // J1: journey-level escalation config (exit rules + lifetime cap).
    const jcfg = await step.do('load-journey-cfg', async () => {
      const r = await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=exit_rules,max_duration&limit=1`, env);
      if (!r.ok) throw new Error('load_journey_cfg_failed:' + JSON.stringify(r.data));
      const row = r.data?.[0] || {};
      return { exitRules: Array.isArray(row.exit_rules) ? row.exit_rules : [], maxDuration: row.max_duration || '30 days' };
    });
    const expiresAt = new Date(Date.parse(enrolledAt || new Date().toISOString()) + (G.durationToMs(jcfg.maxDuration) || 2592000000)).toISOString();

    // Register ambient exit-rule rows so an incoming customer event can find + wake this
    // parked instance (instance_id == enrolmentId). Idempotent upsert (unique index).
    if (jcfg.exitRules.length) {
      await step.do('register-waits', async () => {
        for (const rule of jcfg.exitRules) {
          if (!rule?.event || !rule?.outcome) continue;
          const w = await A.sbComms('/rest/v1/enrolment_waits?on_conflict=enrolment_id,awaited_event,kind', env, {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ enrolment_id: enrolmentId, instance_id: String(enrolmentId), profile_id: profileId,
              awaited_event: rule.event, kind: 'exit', outcome: rule.outcome, expires_at: expiresAt }) });
          if (!w.ok) throw new Error('wait_register_failed:' + JSON.stringify(w.data));
        }
        return true;
      });
    }
    const exitEventSet = new Set(jcfg.exitRules.map((r) => r && r.event).filter(Boolean));
    const exitOutcomeFor = (evName) => (jcfg.exitRules.find((r) => r.event === evName) || {}).outcome || 'exited';

    let cur = def.entry;
    for (let i = 0; i < MAX_TRANSITIONS; i++) {
      const s = def.steps[cur];
      if (!s) { await this.#end(env, step, enrolmentId, 'failed', cur); return; }

      if (s.type === 'wait') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { duration: s.duration });
        // Exit pre-check uses enrolledAt (ambient): exit rules span the whole enrolment
        // and are terminal, so detecting a matching exit event from ANYWHERE in the
        // journey history and ending is always correct (no "stale exit" hazard — the
        // first detection ends the journey). enrolledAt also closes the boot→first-wait
        // gap where an exit's live signal is lost because the instance isn't parked yet.
        const pre = exitEventSet.size
          ? await step.do(`precheck:${cur}`, async () => this.#eventSince(env, profileId, [...exitEventSet], enrolledAt))
          : null;
        if (pre) { await this.#end(env, step, enrolmentId, exitOutcomeFor(pre), cur); return; }
        // Interruptible sleep: timeout = normal completion (→ next); exit signal → terminate.
        const r = await this.#park(step, cur, s.duration);
        if (r.kind === 'exit') { await this.#end(env, step, enrolmentId, r.outcome, cur); return; }
        cur = G.resolveTarget(s, 'next');
      } else if (s.type === 'wait_response') {
        // Per-step entry timestamp: the RESPONSE pre-check bound must be when THIS step
        // started, not enrol — else a re-awaited event that fired earlier short-circuits
        // to 'responded' on a STALE event. (The EXIT pre-check below uses enrolledAt
        // instead — ambient + terminal, so catching a missed exit anywhere in the
        // enrolment is always correct.) Residual: a sub-second response arriving during
        // the immediately-preceding send is caught only by the live signal path
        // (documented v1 limitation, consistent with profile-level correlation).
        const since = await step.do(`since:${cur}`, async () => new Date().toISOString());
        // Register the response rows for the awaited events, then park.
        await step.do(`waitreg:${cur}`, async () => {
          for (const evName of (s.awaited || [])) {
            const w = await A.sbComms('/rest/v1/enrolment_waits?on_conflict=enrolment_id,awaited_event,kind', env, {
              method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
              body: JSON.stringify({ enrolment_id: enrolmentId, instance_id: String(enrolmentId), profile_id: profileId,
                awaited_event: evName, kind: 'response', step_id: cur, expires_at: expiresAt }) });
            if (!w.ok) throw new Error('wait_register_failed:' + JSON.stringify(w.data));
          }
          return true;
        });
        // J2: track current_step on ENTRY (so a parked enrolment reports as held here via
        // journey_funnel.parked) but DON'T write an enrolment_steps row yet — the row is
        // written once at RESOLUTION carrying the resolved outcome (responded|timeout|exit),
        // which is what gives the escalation gate its per-branch funnel counts. (#logStep is
        // keyed step.do(log:<id>) → once per step, so it can't be called on both entry+exit.)
        await step.do(`enter:${cur}`, async () => {
          await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolmentId)}`, env,
            { method: 'PATCH', body: JSON.stringify({ current_step: cur }) });
          return true;
        });
        // Exit pre-check uses enrolledAt (ambient/terminal); response pre-check uses per-step
        // since (avoids stale reuse). Exit wins over an awaited response.
        let outHandle = null, terminateOutcome = null;
        const preExit = exitEventSet.size
          ? await step.do(`precheckx:${cur}`, async () => this.#eventSince(env, profileId, [...exitEventSet], enrolledAt))
          : null;
        if (preExit) terminateOutcome = exitOutcomeFor(preExit);
        else {
          const preResp = await step.do(`precheck:${cur}`, async () => this.#eventSince(env, profileId, (s.awaited || []), since));
          if (preResp) outHandle = 'responded';
          else {
            const r = await this.#park(step, cur, s.within);
            if (r.kind === 'exit') terminateOutcome = r.outcome;
            else if (r.kind === 'response') outHandle = 'responded';
            else outHandle = 'timeout';
          }
        }
        // Clear this step's response rows (delete-on-transition).
        await step.do(`waitclr:${cur}`, async () => {
          const del = await A.sbComms(`/rest/v1/enrolment_waits?enrolment_id=eq.${A.enc(enrolmentId)}&kind=eq.response&step_id=eq.${A.enc(cur)}`, env, { method: 'DELETE' });
          if (!del.ok) throw new Error('wait_clear_failed:' + JSON.stringify(del.data));
          return true;
        });
        // J2: log the wait_response step ONCE, at resolution, with the outcome it took —
        // responded | timeout | exit:<outcome> — so journey_funnel shows per-branch counts.
        await this.#logStep(env, step, enrolmentId, cur, s.type,
          { awaited: s.awaited, within: s.within, outcome: terminateOutcome ? `exit:${terminateOutcome}` : outHandle });
        if (terminateOutcome) { await this.#end(env, step, enrolmentId, terminateOutcome, cur); return; }
        cur = G.resolveTarget(s, outHandle);
      } else if (s.type === 'condition') {
        const branch = await step.do(cur, async () => this.#evalCondition(env, s.check, profileId, enrolledAt));
        await this.#logStep(env, step, enrolmentId, cur, s.type, { branch });
        cur = G.resolveTarget(s, branch ? 'if_true' : 'if_false');
      } else if (s.type === 'send') {
        const res = await step.do(cur, async () => this.#doSend(env, s, profileId, enrolmentId, cur, triggerProps, journeyName));
        if (s.interactive) {
          // Interactive send (WA quick-reply buttons): after sending, park on the reply
          // event and route by which button was tapped (else no_reply on timeout). Inert
          // while WA is not live — the send skips → no_reply, no parking.
          const dec = await this.#interactiveBranch(env, step, s, res, profileId, enrolmentId, cur, expiresAt);
          await this.#logStep(env, step, enrolmentId, cur, s.type, { ...res, interactive: true, outcome: dec.terminate ? `exit:${dec.terminate}` : dec.handle });
          if (dec.terminate) { await this.#end(env, step, enrolmentId, dec.terminate, cur); return; }
          cur = G.resolveTarget(s, dec.handle);
        } else {
          // Quiet-hours DEFER, not drop. The gate's v1 quiet-hours check hard-skips
          // ("defer, don't drop" was always the stated intent — gate.js §4). For a
          // journey send that is a silent one-third loss on evening-peak triggers
          // (measured 33% of abandoned-cart sends land in 21:00–09:00 IST). So: park
          // interruptibly until quiet hours end, then retry ONCE. The park reuses the
          // wait-step machinery, so an ambient exit signal arriving overnight (e.g.
          // the customer purchased) still terminates WITHOUT sending — and the same
          // pre-check closes the skip→park gap. A second quiet_hours skip on the
          // retry (misconfig / boundary) falls through to normal on_skip routing —
          // deliberately no loop.
          let finalRes = res, deferred = false;
          if (res && res.status === 'skipped' && res.reason === 'quiet_hours') {
            const deferMs = await step.do(`qhcalc:${cur}`, async () => this.#msUntilQuietEnd(env));
            if (deferMs > 0) {
              const pre = exitEventSet.size
                ? await step.do(`qhprecheck:${cur}`, async () => this.#eventSince(env, profileId, [...exitEventSet], enrolledAt))
                : null;
              if (pre) { await this.#end(env, step, enrolmentId, exitOutcomeFor(pre), cur); return; }
              const woke = await this.#park(step, `qhwait:${cur}`, deferMs);
              if (woke.kind === 'exit') { await this.#end(env, step, enrolmentId, woke.outcome, cur); return; }
              finalRes = await step.do(`${cur}:qhretry`, async () =>
                this.#doSend(env, s, profileId, enrolmentId, `${cur}:qhretry`, triggerProps, journeyName));
              deferred = true;
            }
          }
          const decision = G.resolveSendNext(s, finalRes, def);
          await this.#logStep(env, step, enrolmentId, cur, s.type, { ...finalRes, ...(deferred ? { deferred_from: 'quiet_hours' } : {}), on_skip: s.on_skip || 'continue', skipped_wait: decision.skippedWait || null });
          if (decision.terminate) { await this.#end(env, step, enrolmentId, decision.terminate, cur); return; }
          cur = decision.next;
        }
      } else if (s.type === 'action') {
        // J3: side-effect nodes. Memoized by step id (step.do(cur)) so a durable retry
        // never re-executes the side effect. #doAction NEVER throws — it returns an
        // outcome handle ('next'|'failed') the graph routes on.
        const res = await step.do(cur, async () => this.#doAction(env, s, profileId, enrolmentId, cur, triggerProps));
        await this.#logStep(env, step, enrolmentId, cur, s.type, { kind: s.kind || null, ...res });
        cur = G.resolveTarget(s, res.outcome || 'next');
      } else if (s.type === 'exit') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { outcome: s.outcome || 'completed' });
        await this.#end(env, step, enrolmentId, s.outcome === 'exited' ? 'exited' : (s.outcome || 'completed'), cur);
        return;
      } else { await this.#end(env, step, enrolmentId, 'failed', cur); return; }

      if (!cur) { await this.#end(env, step, enrolmentId, 'completed', null); return; }
    }
    await this.#end(env, step, enrolmentId, 'failed', cur);  // transition cap hit
  }

  // Resolve recipient + call the M5 send() spine. dedupKey makes a retried durable step idempotent.
  // send() does NOT auto-resolve `to` from the profile (it loads the profile only for template
  // rendering; the adapter + gate use opts.to verbatim). So we resolve the identifier per the
  // step's channel (journey-graph ID_TYPE_FOR_CHANNEL: email→email, WA/SMS/voice→phone) and pass
  // it as `to`. No matching identifier → skip WITHOUT calling send().
  async #doSend(env, s, profileId, enrolmentId, stepId, triggerProps, journeyName) {
    const channel = s.channel || 'email';
    // spec §4.2: resolve the identifier TYPE the channel needs (email→email, WA/SMS/voice→phone).
    // Previously hardcoded email — a WA journey send could never resolve a recipient.
    const idType = G.ID_TYPE_FOR_CHANNEL[channel] || 'email';
    const idr = await A.sbComms(
      `/rest/v1/identifiers?profile_id=eq.${A.enc(profileId)}&type=eq.${A.enc(idType)}&select=value&order=last_seen.desc&limit=1`, env);
    if (!idr.ok) throw new Error('identifier_lookup_failed:' + JSON.stringify(idr.data));
    const to = idr.data?.[0]?.value;
    if (!to) return { status: 'skipped', reason: `no_${idType}_identifier` };
    return send(env, {
      channel, purpose: s.purpose || 'marketing', profileId, to,
      senderId: s.senderId || s.sender_id || undefined,   // optional per-node pin (routes to a specific number)
      templateId: s.templateId, constants: s.constants || {}, eventContext: triggerProps || {},
      tracking: { campaign: journeyName },
      source: `journey:${enrolmentId}`, dedupKey: `journey:${enrolmentId}:${stepId}`,
    });
  }

  // J3 action node. Side-effect steps that never send to the customer themselves
  // (delivery is a separate, gated `send` node). Returns an outcome handle. NEVER throws.
  //  - set_attr     — merge {attr:value} into the profile's attributes → 'next'.
  //  - payment_link — mint a Cashfree pay-link (J3 COD→prepaid) and stash its URL onto
  //    the profile so a downstream send template can bind {payment_link_url}. The paid/
  //    failed OUTCOME arrives later as the payment_link_paid/_failed webhook event → a
  //    wait_response node parks on it. INERT until comms.settings.payment_links_enabled
  //    is flipped on (mints nothing while off — the belt-and-braces go-live switch).
  async #doAction(env, s, profileId, enrolmentId, stepId, triggerProps) {
    const kind = s.kind;
    if (kind === 'set_attr') {
      if (!s.attr) return { outcome: 'next', skipped: 'no_attr' };
      const r = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes&limit=1`, env);
      const attrs = (r.ok && r.data?.[0]?.attributes) || {};
      attrs[s.attr] = s.value ?? null;
      await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}`, env,
        { method: 'PATCH', body: JSON.stringify({ attributes: attrs, updated_at: new Date().toISOString() }) });
      return { outcome: 'next', attr: s.attr };
    }
    if (kind === 'payment_link') {
      const setR = await A.sbComms('/rest/v1/settings?id=eq.1&select=payment_links_enabled&limit=1', env);
      if (!(setR.ok && setR.data?.[0]?.payment_links_enabled === true)) return { outcome: 'failed', reason: 'payment_links_disabled' };
      // Amount: a fixed step amount, else the trigger order's total (COD order → pay-link).
      const amount = Number(s.amount) || Number(triggerProps?.total ?? triggerProps?.total_price ?? triggerProps?.total_payable ?? triggerProps?.order_amount) || null;
      const idr = await A.sbComms(`/rest/v1/identifiers?profile_id=eq.${A.enc(profileId)}&type=eq.phone&select=value&order=last_seen.desc&limit=1`, env);
      const phone = idr.ok ? idr.data?.[0]?.value : null;
      if (!phone) return { outcome: 'failed', reason: 'no_phone' };
      if (!amount || amount <= 0) return { outcome: 'failed', reason: 'no_amount' };
      const orderId = triggerProps?.order_id ?? triggerProps?.shopflo_order_id ?? triggerProps?.order_name ?? null;
      const r = await CF.createPaymentLink(env, {
        amount, phone,
        purpose: s.purpose || 'Complete your order payment',
        // Deterministic id → the Cashfree mint is idempotent + the paid webhook's
        // link_notes echo these refs back for order reconciliation.
        linkId: `relay-${enrolmentId}-${stepId}`,
        notes: { enrolment: String(enrolmentId), ...(orderId ? { order_id: String(orderId) } : {}) },
      });
      if (!r.ok) return { outcome: 'failed', reason: r.error };
      const pr = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes&limit=1`, env);
      const attrs = (pr.ok && pr.data?.[0]?.attributes) || {};
      attrs.payment_link_url = r.link_url; attrs.payment_link_id = r.link_id;
      await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}`, env,
        { method: 'PATCH', body: JSON.stringify({ attributes: attrs, updated_at: new Date().toISOString() }) });
      return { outcome: 'next', link_id: r.link_id };
    }
    if (kind === 'order_modify') {
      // The Shopify COD→prepaid reconciliation (mirrors BiteSpeed's Modify Order node —
      // pure Shopify; Shiprocket picks up the prepaid status via its Shopify sync). Gated
      // by the same go-live switch, and needs write_orders (fails gracefully → not_done).
      const op = s.op; // 'convert_to_prepaid' | 'cancel' | 'add_tag'
      if (op !== 'add_tag') {   // add_tag is harmless; the consequential ops are flag-gated
        const setR = await A.sbComms('/rest/v1/settings?id=eq.1&select=payment_links_enabled&limit=1', env);
        if (!(setR.ok && setR.data?.[0]?.payment_links_enabled === true)) return { outcome: 'not_done', reason: 'cod_flow_disabled' };
      }
      const oid = triggerProps?.shopify_order_id ?? triggerProps?.order_id ?? null;
      if (!oid) return { outcome: 'not_done', reason: 'no_order_id' };
      const gid = String(oid).startsWith('gid://') ? String(oid) : `gid://shopify/Order/${oid}`;
      try {
        if (op === 'add_tag') {
          await SH.shopifyGraphQL(env, TAGS_ADD_M, { id: gid, tags: (Array.isArray(s.tags) && s.tags.length ? s.tags : ['relay-cod-confirmed']) });
          return { outcome: 'done', op };
        }
        // convert_to_prepaid + cancel: guard on the order NOT being fulfilled yet (mirrors
        // "Disable Modify Order on Fulfillment" — once shipped, COD is locked to the courier)
        // + an optional within-hours window (mirrors "Disable Modify Order After X Hours").
        const q = await SH.shopifyGraphQL(env, ORDER_STATUS_Q, { id: gid });
        const order = q?.order;
        if (!order) return { outcome: 'not_done', reason: 'order_not_found' };
        if (order.cancelledAt) return { outcome: 'not_done', reason: 'already_cancelled' };
        if (order.displayFulfillmentStatus && order.displayFulfillmentStatus !== 'UNFULFILLED')
          return { outcome: 'not_done', reason: `fulfilled:${order.displayFulfillmentStatus}` };
        if (s.within_hours && order.createdAt &&
            (Date.now() - Date.parse(order.createdAt)) > Number(s.within_hours) * 3600000)
          return { outcome: 'not_done', reason: 'too_old' };
        if (op === 'convert_to_prepaid') {
          // Money already collected via Cashfree → mark the Shopify order paid (out-of-band).
          if (order.displayFinancialStatus === 'PAID') { await SH.shopifyGraphQL(env, TAGS_ADD_M, { id: gid, tags: ['relay-c2p-converted'] }).catch(() => {}); return { outcome: 'done', op, already_paid: true }; }
          const r = await SH.shopifyGraphQL(env, ORDER_MARK_PAID_M, { input: { id: gid } });
          const errs = r?.orderMarkAsPaid?.userErrors || [];
          if (errs.length) return { outcome: 'not_done', reason: errs.map((e) => e.message).join('; ').slice(0, 120) };
          await SH.shopifyGraphQL(env, TAGS_ADD_M, { id: gid, tags: ['relay-c2p-converted'] }).catch(() => {});
          return { outcome: 'done', op };
        }
        if (op === 'cancel') {
          const r = await SH.shopifyGraphQL(env, ORDER_CANCEL_M, { orderId: gid, reason: 'CUSTOMER', refund: false, restock: true });
          const errs = (r?.orderCancel?.orderCancelUserErrors || []).concat(r?.orderCancel?.userErrors || []);
          if (errs.length) return { outcome: 'not_done', reason: errs.map((e) => e.message).join('; ').slice(0, 120) };
          await SH.shopifyGraphQL(env, TAGS_ADD_M, { id: gid, tags: ['relay-cod-cancelled'] }).catch(() => {});
          return { outcome: 'done', op };
        }
        return { outcome: 'not_done', reason: `unknown_op:${op}` };
      } catch (e) {
        // write_orders missing / API error → graceful not_done (never throws).
        return { outcome: 'not_done', reason: String(e?.message || e).slice(0, 120) };
      }
    }
    return { outcome: 'failed', reason: `unknown_action_kind:${kind}` };
  }

  // Interactive send → branch. Reuses the J1 wait machinery: register a response wait on
  // the reply event, park until it arrives or `within` elapses, then route by button_id.
  // Returns { handle } or { terminate }.
  async #interactiveBranch(env, step, s, res, profileId, enrolmentId, stepId, expiresAt) {
    if (!G.sendWentOut(res)) return { handle: 'no_reply' };   // send skipped (WA inert) → no_reply
    const replyEvent = s.reply_event || 'whatsapp_reply';
    const since = await step.do(`isince:${stepId}`, async () => new Date().toISOString());
    await step.do(`ireg:${stepId}`, async () => {
      const w = await A.sbComms('/rest/v1/enrolment_waits?on_conflict=enrolment_id,awaited_event,kind', env, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ enrolment_id: enrolmentId, instance_id: String(enrolmentId), profile_id: profileId,
          awaited_event: replyEvent, kind: 'response', step_id: stepId, expires_at: expiresAt }) });
      if (!w.ok) throw new Error('wait_register_failed:' + JSON.stringify(w.data));
      return true;
    });
    const pre = await step.do(`iprecheck:${stepId}`, async () => this.#eventSince(env, profileId, [replyEvent], since));
    const woke = pre ? { kind: 'response' } : await this.#park(step, `iwait:${stepId}`, s.within);
    await step.do(`iclr:${stepId}`, async () => {
      const del = await A.sbComms(`/rest/v1/enrolment_waits?enrolment_id=eq.${A.enc(enrolmentId)}&kind=eq.response&step_id=eq.${A.enc(stepId)}`, env, { method: 'DELETE' });
      if (!del.ok) throw new Error('wait_clear_failed:' + JSON.stringify(del.data));
      return true;
    });
    if (woke.kind === 'exit') return { terminate: woke.outcome };
    if (woke.kind !== 'response') return { handle: 'no_reply' };   // timeout
    const btn = await step.do(`ibtn:${stepId}`, async () => this.#latestButtonId(env, profileId, replyEvent, since));
    const declared = new Set((s.buttons || []).map((b) => b && b.id).filter(Boolean));
    return { handle: (btn && declared.has(btn)) ? btn : 'no_reply' };
  }

  // Latest reply event since the send → its button id (WA button payload). The matcher's
  // wake signal doesn't carry properties, so we re-read the event for the tapped button.
  async #latestButtonId(env, profileId, name, sinceIso) {
    const r = await A.sbComms(
      `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=eq.${A.enc(name)}` +
      `&occurred_at=gte.${A.enc(sinceIso)}&select=properties&order=occurred_at.desc&limit=1`, env);
    if (!r.ok) return null;
    const p = r.data?.[0]?.properties || {};
    return p.button_id || p.button || p.payload || null;
  }

  // ms from now until the next quiet-hours END boundary in IST (default 09:00).
  // Settings unreadable → default end hour 9 (mirrors gate.js's fail-safe defaults).
  // The boundary math is G.msUntilIstHour (pure, unit-tested).
  async #msUntilQuietEnd(env) {
    let end = 9;
    try {
      const r = await A.sbComms('/rest/v1/settings?id=eq.1&select=quiet_hours_end&limit=1', env);
      if (r.ok && r.data?.[0]?.quiet_hours_end != null) end = Number(r.data[0].quiet_hours_end);
    } catch (_) { /* default */ }
    return G.msUntilIstHour(Date.now(), end);
  }

  // Park on the single 'signal' event type with a timeout. Returns:
  //   { kind:'timeout' }             — the timeout elapsed (waitForEvent threw). Normal wait completion.
  //   { kind:'response', event }     — an awaited response event arrived (wait_response).
  //   { kind:'exit', outcome, event }— an ambient exit / expiry signal arrived → terminate.
  // NOTE: waitForEvent THROWS on timeout (spike-verified) — the catch IS the timeout path.
  async #park(step, stepName, within) {
    try {
      const ev = await step.waitForEvent(stepName, { type: 'signal', timeout: within });
      const p = (ev && ev.payload) || {};
      if (p.kind === 'exit') return { kind: 'exit', outcome: p.outcome || 'exited', event: p.event };
      return { kind: 'response', event: p.event };
    } catch (e) {
      // waitForEvent signals BOTH timeout and infra errors by throwing. Compile-time duration
      // validation (Task 22) removes the config-error case; anything else is logged so a
      // masked infra failure is at least visible in the step row (review H14).
      console.log('park_exit', stepName, String(e?.message || e).slice(0, 140));
      return { kind: 'timeout' };
    }
  }

  // Before parking, cheaply check whether a qualifying event ALREADY happened since
  // enrol (closes the tiny window where an event lands while the instance is between
  // waits, i.e. not inside waitForEvent). Reuses the events-since-enrol read.
  async #eventSince(env, profileId, names, sinceIso) {
    if (!names.length) return null;
    const inList = names.map((n) => A.enc(n)).join(',');
    const r = await A.sbComms(
      `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=in.(${inList})` +
      `&occurred_at=gte.${A.enc(sinceIso)}&select=name&order=occurred_at.asc&limit=1`, env);
    if (!r.ok) return null;
    return r.data?.[0]?.name || null;
  }

  // condition v1
  async #evalCondition(env, check, profileId, enrolledAt) {
    if (check?.kind === 'no_event_since_enrol') {
      const r = await A.sbComms(
        `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=eq.${A.enc(check.event)}` +
        `&occurred_at=gte.${A.enc(enrolledAt)}&select=id&limit=1`, env);
      if (!r.ok) throw new Error('condition_read_failed:' + JSON.stringify(r.data));
      return !r.data?.length;   // true = NO such event → take if_true (e.g. send the nudge)
    }
    if (check?.kind === 'event_since_enrol') {
      const r = await A.sbComms(
        `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=eq.${A.enc(check.event)}` +
        `&occurred_at=gte.${A.enc(enrolledAt)}&select=id&limit=1`, env);
      if (!r.ok) throw new Error('condition_read_failed:' + JSON.stringify(r.data));
      return !!r.data?.length;
    }
    if (check?.kind === 'attribute') {       // {kind:'attribute', attr, op:'eq'|'gt'|'lt', value}
      const r = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes&limit=1`, env);
      if (!r.ok) throw new Error('condition_read_failed:' + JSON.stringify(r.data));
      const v = r.data?.[0]?.attributes?.[check.attr];
      if (check.op === 'gt') return Number(v) > Number(check.value);
      if (check.op === 'lt') return Number(v) < Number(check.value);
      return String(v) === String(check.value);
    }
    return false;
  }

  async #logStep(env, step, enrolmentId, stepId, stepType, result) {
    await step.do(`log:${stepId}`, async () => {
      await A.sbComms('/rest/v1/enrolment_steps', env, { method: 'POST',
        body: JSON.stringify({ enrolment_id: enrolmentId, step_id: stepId, step_type: stepType, result: result || {} }) });
      await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolmentId)}`, env,
        { method: 'PATCH', body: JSON.stringify({ current_step: stepId }) });
      return true;
    });
  }

  // Terminal stop. Runs on EVERY terminal path (completion, exit, escalation-terminate,
  // transition-cap, and the failed guards): first clear this enrolment's wait-index rows
  // so no parked-but-terminated instance stays discoverable, then mark the enrolment ended.
  async #end(env, step, enrolmentId, status, lastStep) {
    await step.do(`end:${status}`, async () => {
      const del = await A.sbComms(`/rest/v1/enrolment_waits?enrolment_id=eq.${A.enc(enrolmentId)}`, env, { method: 'DELETE' });
      if (!del.ok) throw new Error('clear_waits_failed:' + JSON.stringify(del.data));
      await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolmentId)}`, env, { method: 'PATCH',
        body: JSON.stringify({ status, current_step: lastStep, ended_at: new Date().toISOString() }) });
      return true;
    });
  }
}

export { JourneyWorkflow };
