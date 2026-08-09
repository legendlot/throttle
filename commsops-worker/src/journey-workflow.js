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
const AL = require('./alerts.js');
const LINKS = require('./links.js');
const GATE = require('./gate.js');   // S268 — per-channel quiet window, so the park boundary
                                     // and the gate that produced the skip share one resolver

const MAX_TRANSITIONS = 100; // safety against a mis-validated cyclic definition

// order_modify (COD→prepaid reconciliation) Shopify Admin API ops. Needs write_orders.
const ORDER_STATUS_Q = `query($id:ID!){ order(id:$id){ id displayFulfillmentStatus displayFinancialStatus createdAt cancelledAt } }`;
const ORDER_MARK_PAID_M = `mutation($input:OrderMarkAsPaidInput!){ orderMarkAsPaid(input:$input){ order{ id displayFinancialStatus } userErrors{ field message } } }`;
const ORDER_CANCEL_M = `mutation($orderId:ID!,$reason:OrderCancelReason!,$refund:Boolean!,$restock:Boolean!){ orderCancel(orderId:$orderId,reason:$reason,refund:$refund,restock:$restock){ job{ id } orderCancelUserErrors{ field message } userErrors{ field message } } }`;
const TAGS_ADD_M = `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ field message } } }`;

// ── C2P cancel-and-recreate (op `recreate_as_prepaid`) ────────────────────────
// Needs write_draft_orders + read_draft_orders on top of write_orders. Design:
// docs/superpowers/specs/2026-07-29-c2p-cancel-and-recreate-design.md.
//
// WHY a NEW order rather than orderMarkAsPaid: LOT charges COD and prepaid customers
// DIFFERENT prices, and mark-as-paid cannot change what an order owes — it would settle
// the COD total, billing the customer the ₹50 COD fee plus the 3% they were promised for
// paying up front (~₹113 worse than checking out prepaid). A new order is the only way to
// deliver the prepaid price. It also makes the courier question moot: the original is
// cancelled outright, so no stale COD amount rides an AWB.
//
// Addresses use countryCode/provinceCode — `country`/`province` are deprecated on
// MailingAddressInput. Line prices use `priceOverride` (MoneyInput), which is the
// non-deprecated per-unit override and is honoured alongside `variantId`.
const ORDER_FOR_RECREATE_Q = `query($id:ID!){ order(id:$id){
  id name tags createdAt cancelledAt displayFulfillmentStatus displayFinancialStatus
  email phone
  currentTotalPriceSet{ shopMoney{ amount currencyCode } }
  customer{ id }
  shippingAddress{ firstName lastName address1 address2 city provinceCode countryCode zip phone company }
  billingAddress{ firstName lastName address1 address2 city provinceCode countryCode zip phone company }
  shippingLine{ title originalPriceSet{ shopMoney{ amount currencyCode } } }
  lineItems(first:100){ edges{ node{ quantity title sku variant{ id }
    discountedUnitPriceSet{ shopMoney{ amount currencyCode } } } } }
} }`;
const DRAFT_CREATE_M = `mutation($input:DraftOrderInput!){ draftOrderCreate(input:$input){
  draftOrder{ id totalPriceSet{ shopMoney{ amount currencyCode } } } userErrors{ field message } } }`;
const DRAFT_UPDATE_M = `mutation($id:ID!,$input:DraftOrderInput!){ draftOrderUpdate(id:$id,input:$input){
  draftOrder{ id totalPriceSet{ shopMoney{ amount currencyCode } } } userErrors{ field message } } }`;
// `paymentPending` is DEPRECATED and defaults to false, so it is omitted: the default
// completes the draft as a PAID order, which is exactly right for money already collected
// out-of-band via Cashfree.
const DRAFT_COMPLETE_M = `mutation($id:ID!){ draftOrderComplete(id:$id){
  draftOrder{ id order{ id name } } userErrors{ field message } } }`;
// Pre-flight for the C2P pay-link: can the REPLACEMENT order actually be stocked? Needs
// read_products for `variant`. See SH.stockShortfall for why this must run before the money.
const ORDER_STOCK_Q = `query($id:ID!){ order(id:$id){ id name
  lineItems(first:100){ edges{ node{ quantity title variant{ id inventoryQuantity } } } } } }`;

const money = (amount, currencyCode) => ({ amount: String(amount), currencyCode });
// Shopify money arrives as a string; compare in paise to dodge float drift.
const paise = (v) => Math.round(Number(v) * 100);
// What the customer actually paid, for the alert text. Best-effort and never throws — an alert
// must not be the thing that fails while reporting a failure.
const runCtxAmount = (ctx) => {
  const a = ctx?.prepaid_amount_display || ctx?.prepaid_amount;
  return a ? `₹${String(a).replace(/^₹/, '')}` : 'the prepaid amount';
};

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

    // Author-supplied utm_* for this journey (Relay UI → journeys.utm). Overrides the account
    // defaults and the auto-derived utm_campaign; a template's own utm still wins over it.
    // ⚠️ Deliberately a SEPARATE step rather than widening `load-journey-name` above: Workflows
    // cache step results BY NAME, so an in-flight instance replaying a widened step would be
    // handed its cached OLD value (the bare name string) and the utm would silently never apply.
    // A brand-new step name has no cache entry, so replaying instances execute it normally.
    const journeyUtm = await step.do('load-journey-utm', async () => {
      const r = await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=utm&limit=1`, env);
      if (!r.ok) return null;   // fail-soft: attribution config must never strand an enrolment
      return r.data?.[0]?.utm || null;
    });

    // Opt-in: re-resolve the trigger event at SEND time rather than using the one pinned at
    // enrolment. `once_while_active` swallows a second abandonment arriving during the wait, so
    // the message described the FIRST cart — measured 2026-08-07 at 12.2% of ATC-Cart and 3.3%
    // of Cart Recovery enrolments over 14 days. Fixing it by loosening re-enrolment would have
    // re-opened the double-send hole that policy exists to close, so nothing about enrolment
    // moves: only which event the send binds its variables from.
    //
    // ⚠️ DEFAULT FALSE AND MUST STAY THAT WAY. Correct only where the trigger payload describes
    // a MUTATING thing (a cart). Order Placed / Order Cancelled / Shipment Update are also
    // `once_while_active`, and refreshing there would describe the customer's LATEST order
    // instead of the one being confirmed — an attribution fix turned into a transactional defect.
    //
    // Separate step name, per the `load-journey-utm` note above: widening an existing step would
    // hand in-flight instances their cached old value and the flag would silently never apply.
    const refreshCfg = await step.do('load-refresh-cfg', async () => {
      const r = await A.sbComms(
        `/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=refresh_trigger_on_send,trigger&limit=1`, env);
      if (!r.ok) return { on: false, event: null };   // fail-soft: never strand an enrolment over this
      const row = r.data?.[0] || {};
      return { on: row.refresh_trigger_on_send === true, event: row.trigger?.name || null };
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

    // RUN CONTEXT — the trigger event's properties PLUS anything actions have since produced.
    //
    // WHY. `triggerProps` is loaded once at boot and is immutable, so a send step could only ever
    // bind what the triggering event carried. That makes whole classes of message unwritable: the
    // C2P payment message cannot state the amount (the pay-link action computes it) and the
    // "paid" message cannot give the new order id (the recreate action mints it). An undeclared
    // token throws `unresolved_variables` and the send fails, so those facts simply had to be
    // left out of the copy.
    //
    // Actions opt IN by returning a `context` object — a blanket spread of the action's result
    // would leak control keys (`outcome`, `reason`) into the customer-facing variable namespace
    // and could silently shadow a trigger property of the same name.
    //
    // REPLAY-SAFE: every action runs inside `step.do(cur, …)`, so a durable retry replays the
    // memoised result rather than re-executing. The merge order is the (deterministic) graph
    // walk, so runCtx reconstructs identically on resume.
    let runCtx = { ...(triggerProps || {}) };
    // Tracked SEPARATELY as well as merged into runCtx, purely so a refreshed trigger event
    // cannot shadow a value an action computed. Action context is derived (the C2P amount, the
    // recreated order id) and must outrank raw event properties whichever event they came from.
    // Without this, refreshing would silently undo an action's contribution on any shared key.
    let actionCtx = {};

    // Build the variable context for ONE send attempt. Refresh off ⇒ returns runCtx unchanged,
    // so every journey that has not opted in is byte-identical to before.
    //
    // ⚠️ The newer event is taken WHOLESALE, never merged key-by-key, and only when its keys are
    // a SUPERSET of the pinned event's. `add_to_cart` has two payload shapes (Shopflo carries
    // cart_token/total/product_names; shopify_pixel carries cart_id/sku/variant_id). A shallow
    // merge across those yields the NEW cart's link beside the OLD cart's product image — a
    // silent, customer-facing mismatch. A wholesale swap of a narrower shape throws
    // `unresolved_variables` and loses the send. Measured 2026-08-07: 127 of 956 ATC cases are
    // non-superset, and those correctly keep the pinned event rather than degrade either way.
    const ctxForSend = async (stepKey) => {
      // enrolledAt is the lower bound; without it "latest event" could reach back before the
      // enrolment and message a cart the customer has already checked out. Rather than widen
      // the window, fall back to the pinned event.
      if (!refreshCfg.on || !refreshCfg.event || !enrolledAt) return runCtx;
      const fresh = await step.do(`refresh:${stepKey}`, async () => {
        const r = await A.sbComms(
          `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=eq.${A.enc(refreshCfg.event)}` +
          `&occurred_at=gt.${A.enc(enrolledAt)}&select=properties&order=occurred_at.desc&limit=1`, env);
        if (!r.ok) return null;   // fail-soft: a read blip must not lose the send
        const p = r.data?.[0]?.properties || null;
        if (!p) return null;      // no newer event — the pinned one is still the truth
        const pinned = triggerProps || {};
        for (const k of Object.keys(pinned)) if (!(k in p)) return null;   // narrower shape → keep pinned
        return p;
      });
      return fresh ? { ...fresh, ...actionCtx } : runCtx;
    };

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
        const branch = await step.do(cur, async () => this.#evalCondition(env, s.check, profileId, enrolledAt, runCtx));
        await this.#logStep(env, step, enrolmentId, cur, s.type, { branch });
        cur = G.resolveTarget(s, branch ? 'if_true' : 'if_false');
      } else if (s.type === 'send') {
        const sendCtx = await ctxForSend(cur);
        const res = await step.do(cur, async () => this.#doSend(env, s, profileId, enrolmentId, cur, sendCtx, journeyName, journeyUtm));
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
            // S268: park to THIS CHANNEL's boundary. Before per-channel windows this read one
            // global end hour, so an SMS send skipped at 21:30 would have woken at WhatsApp's
            // 08:00 — an hour before SMS is deliverable — and burned its single retry on a
            // second guaranteed skip.
            // `s.channel || 'email'` MIRRORS #doSend (~line 388). Passing s.channel raw would
            // resolve a channel-less step to the GLOBAL window here while the gate had judged it
            // as email — the two must agree or the retry wakes at a boundary the gate never used.
            // Unreachable while email is exempt (no quiet_hours skip → no park), which is exactly
            // why it would sit latent until someone turns email's quiet hours on.
            const deferMs = await step.do(`qhcalc:${cur}`, async () => this.#msUntilQuietEnd(env, s.channel || 'email'));
            if (deferMs > 0) {
              const pre = exitEventSet.size
                ? await step.do(`qhprecheck:${cur}`, async () => this.#eventSince(env, profileId, [...exitEventSet], enrolledAt))
                : null;
              if (pre) { await this.#end(env, step, enrolmentId, exitOutcomeFor(pre), cur); return; }
              const woke = await this.#park(step, `qhwait:${cur}`, deferMs);
              if (woke.kind === 'exit') { await this.#end(env, step, enrolmentId, woke.outcome, cur); return; }
              // Re-resolve for the retry rather than reusing sendCtx: this fires AFTER an
              // overnight park (up to ~10h), which is the longest staleness window in the
              // whole engine — the one attempt that most needs the current cart.
              const retryCtx = await ctxForSend(`${cur}:qhretry`);
              finalRes = await step.do(`${cur}:qhretry`, async () =>
                this.#doSend(env, s, profileId, enrolmentId, `${cur}:qhretry`, retryCtx, journeyName, journeyUtm));
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
        const res = await step.do(cur, async () => this.#doAction(env, s, profileId, enrolmentId, cur, runCtx));
        // Opt-in only: an action exposes values to later sends via `context`. See runCtx above.
        if (res && typeof res.context === 'object' && res.context) {
          runCtx = { ...runCtx, ...res.context };
          actionCtx = { ...actionCtx, ...res.context };   // so a refreshed event cannot shadow it
        }
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
  async #doSend(env, s, profileId, enrolmentId, stepId, triggerProps, journeyName, journeyUtm) {
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
      // Interactive step with NO template = a free-form session message carrying reply
      // buttons (the mid-flow confirm). With a template, the buttons are the ones Meta
      // already approved on it and must NOT be re-sent here.
      interactiveButtons: (s.interactive && !s.templateId) ? (s.buttons || []) : null,
      // send() takes an INLINE template object when there is no stored templateId — the body
      // text for a session reply lives on the step, not in the template library. Applies to
      // PLAIN free-text sends too, not just interactive ones: the first cut keyed this on
      // `s.interactive`, so a plain text step resolved no template at all and could never
      // send (the four confirmation replies in the COD→prepaid flow are exactly that shape).
      ...((!s.templateId && (s.text || s.body))
        ? { template: { channel: 'whatsapp', name: `journey:${stepId}`,
                        content: { text: s.text || s.body || '' }, variables: s.variables || [] } }
        : {}),
      tracking: { campaign: journeyName, utm: journeyUtm },
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
      const codTotal = Number(triggerProps?.total ?? triggerProps?.total_price ?? triggerProps?.total_payable ?? triggerProps?.order_amount) || null;
      let amount = Number(s.amount) || codTotal || null;
      let pricing = null;
      // C2P PRICING (`pricing: 'c2p_prepaid'` on the step). A COD→prepaid customer must pay what
      // a PREPAID customer pays, not the COD total — charging the COD amount would silently bill
      // them the ₹50 COD fee plus the 3% they were promised for paying up front.
      //
      //     prepaid = (COD total − cod_fee) × (1 − discount_pct/100)
      //
      // Verified to the paisa against 24 live COD price points (Afshaan + Pruthvi, 2026-07-29).
      // The fee is per ORDER, and because it is added AFTER any coupon, a coupon order carries
      // through automatically — no coupon lookup is needed or wanted here.
      // Both constants are SETTINGS: a pricing change must never require a deploy.
      if (s.pricing === 'c2p_prepaid' && codTotal) {
        const cfg = await A.sbComms('/rest/v1/settings?id=eq.1&select=c2p_cod_fee,c2p_prepaid_discount_pct&limit=1', env);
        const fee = Number(cfg.ok ? cfg.data?.[0]?.c2p_cod_fee : null);
        const pct = Number(cfg.ok ? cfg.data?.[0]?.c2p_prepaid_discount_pct : null);
        // Fail CLOSED on unreadable/absurd settings rather than charging a guessed amount.
        if (!Number.isFinite(fee) || !Number.isFinite(pct) || pct < 0 || pct >= 100 || fee < 0) {
          return { outcome: 'failed', reason: 'c2p_pricing_unavailable' };
        }
        const base = codTotal - fee;
        if (base <= 0) return { outcome: 'failed', reason: 'c2p_base_not_positive' };
        amount = Math.round(base * (1 - pct / 100) * 100) / 100;
        pricing = {
          cod_amount: codTotal,
          cod_amount_display: `₹${codTotal.toLocaleString('en-IN')}`,
          prepaid_amount: amount,
          prepaid_amount_display: `₹${amount.toLocaleString('en-IN')}`,
          saving: Math.round((codTotal - amount) * 100) / 100,
          saving_display: `₹${(Math.round((codTotal - amount) * 100) / 100).toLocaleString('en-IN')}`,
        };
      }
      // PRE-FLIGHT STOCK CHECK (2026-07-29) — C2P only, and deliberately BEFORE the link is
      // minted. `draftOrderComplete` reserves its own inventory while the original order is
      // still holding its units, so a conversion needs the replacement's quantity available on
      // top. Without it the draft cannot complete and we end up holding the customer's money
      // against a still-COD order. That happened once (for a different reason — a missing
      // scope), and the lesson generalises: never ask for money we cannot convert.
      //
      // Fails the step (→ the journey's `failed` branch) rather than throwing, and alerts,
      // because a declined conversion is an ops signal — it means a SKU is too thin for C2P.
      // Fails OPEN on an unreadable order: a transient Shopify blip must not silently switch
      // C2P off, and the recreate path still verifies before committing anything.
      if (s.pricing === 'c2p_prepaid') {
        const soid = triggerProps?.shopify_order_id ?? triggerProps?.order_id ?? null;
        if (soid) {
          const sgid = String(soid).startsWith('gid://') ? String(soid) : `gid://shopify/Order/${soid}`;
          try {
            const sq = await SH.shopifyGraphQL(env, ORDER_STOCK_Q, { id: sgid });
            const short = SH.stockShortfall(sq?.order);
            if (short.length) {
              const detail = short.map((x) => `${x.title || x.variant_id}: need ${x.need}, have ${x.have}`).join('; ');
              await AL.alert(env, `:warning: C2P declined on ${sq?.order?.name || soid} — not enough stock to build the replacement (${detail}). NO money was taken. The order stays COD.`);
              return { outcome: 'failed', reason: `insufficient_stock:${detail}`.slice(0, 160) };
            }
          } catch (e) {
            console.log('c2p_stock_precheck_skipped', String(e?.message || e).slice(0, 120));
          }
        }
      }
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

      // Wrap the Cashfree URL in our own /r/ redirect so the tap is MEASURABLE.
      //
      // WHY THIS ONE MATTERS MOST. Every other customer-facing link in Relay (cart, browse,
      // tracking) already goes through /r/. The payment link — the single most valuable click in
      // the business, a customer who has said they want to pay — was the only raw URL left, so
      // "never opened the link" and "opened it and abandoned on the payment page" were
      // indistinguishable. Measured 2026-08-07: of 11 links sent, 7 were READ and 0 paid; without
      // this there is no way to tell which of those two problems to fix.
      //
      // Fail-SOFT, unlike the template-button redirect which deliberately throws: there the
      // template is already approved as /r/{{1}} and a mint failure would ship a dead CTA, but
      // here the raw Cashfree URL is a perfectly good fallback. Never lose a payment to
      // instrumentation.
      //
      // ⚠️ `messageId` is null: this action runs BEFORE the send that carries the link, so no
      // message row exists yet. The click still records against the PROFILE (comms.link_click +
      // a link_clicked event), which is what answers "did they open the payment page" — but it
      // will NOT appear in a journey's `clicked` column, which joins on message_id.
      let payUrl = r.link_url;
      try {
        const base = await LINKS.getLinkBaseUrl(env);
        if (base) {
          const code = await LINKS.mintLink(env, {
            baseUrl: base, target: r.link_url, utm: null,
            messageId: null, profileId: profileId || null, channel: 'whatsapp',
          });
          if (code) payUrl = `${base.replace(/\/+$/, '')}/r/${code}`;
        }
      } catch (e) { /* keep the raw Cashfree URL */ }

      const pr = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes&limit=1`, env);
      const attrs = (pr.ok && pr.data?.[0]?.attributes) || {};
      attrs.payment_link_url = payUrl; attrs.payment_link_id = r.link_id;
      await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}`, env,
        { method: 'PATCH', body: JSON.stringify({ attributes: attrs, updated_at: new Date().toISOString() }) });
      // Expose the priced amounts to LATER send steps (see runCtx). Without this the payment
      // message cannot state what the customer is being asked to pay.
      return { outcome: 'next', link_id: r.link_id,
               context: { payment_link_url: payUrl, ...(pricing || {}) } };
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
        const recreate = op === 'recreate_as_prepaid';
        const q = await SH.shopifyGraphQL(env, recreate ? ORDER_FOR_RECREATE_Q : ORDER_STATUS_Q, { id: gid });
        const order = q?.order;
        if (!order) return { outcome: 'not_done', reason: 'order_not_found' };
        // IDEMPOTENCY, and it MUST precede the cancelled guard. A completed recreate leaves the
        // original CANCELLED, so checking `already_cancelled` first would report `not_done` on a
        // durable retry of a run that fully succeeded — routing the customer down the failure
        // branch ("do not pay the courier") after a clean conversion. step.do memoisation makes
        // the retry unlikely; this is the belt-and-braces the design doc asks for.
        if (recreate) {
          const prior = (Array.isArray(order.tags) ? order.tags : [])
            .find((t) => /^relay-c2p-replaced-by-/i.test(String(t)));
          if (prior) return { outcome: 'done', op, already_recreated: true, replaced_by: prior };
        }
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
        if (recreate) {
          const r = await this.#recreateAsPrepaid(env, s, gid, order, triggerProps, enrolmentId);
          // MONEY IS ALREADY COLLECTED BY THE TIME THIS RUNS — the journey only reaches
          // `recreate_as_prepaid` after `payment_link_paid`. So ANY not_done here means we hold the
          // customer's money against an order that is still COD. That must page a human.
          //
          // 2026-07-29: it didn't, and the very first real conversion failed on a missing
          // `read_products` scope. The customer got the do-not-pay-the-courier message and the
          // order got tagged, but nobody was told — it was caught only because a colleague happened
          // to be watching the test. Silent + money = the one combination worth alerting on
          // unconditionally, even though a tag and a message already exist.
          if (r && r.outcome === 'not_done') {
            await AL.alert(env, `:rotating_light: C2P PAID BUT NOT CONVERTED — ${order.name} `
              + `(${triggerProps?.order_number ?? '?'}). Customer has PAID `
              + `${runCtxAmount(triggerProps)} and the order is still COD. Reason: ${r.reason}. `
              + `Tagged relay-c2p-paid-not-recreated. Convert or refund by hand.`);
          }
          return r;
        }
        return { outcome: 'not_done', reason: `unknown_op:${op}` };
      } catch (e) {
        // write_orders missing / API error → graceful not_done (never throws).
        return { outcome: 'not_done', reason: String(e?.message || e).slice(0, 120) };
      }
    }
    return { outcome: 'failed', reason: `unknown_action_kind:${kind}` };
  }

  // C2P — build a PAID replacement order at the prepaid price, then cancel the COD original.
  //
  // ORDERING IS LOAD-BEARING: the replacement must exist and be confirmed paid BEFORE the
  // original is cancelled. If the draft dance fails we are left with the COD original intact —
  // the customer has paid and we owe them a manual fix, which is recoverable. The reverse order
  // risks cancelling the original and THEN failing to create the replacement, leaving a paying
  // customer with no order at all. `draftOrderComplete` returning an order id is the commit point.
  async #recreateAsPrepaid(env, s, gid, order, runCtx, enrolmentId) {
    // The amount is NOT recomputed here — it is what the pay-link actually billed, exposed by
    // the `payment_link` step through runCtx (`pricing:'c2p_prepaid'`). Recomputing would risk
    // the new order disagreeing with money already taken if a setting changed mid-enrolment.
    // Fail closed rather than guess.
    const prepaid = Number(runCtx?.prepaid_amount) || null;
    if (!prepaid || prepaid <= 0) return { outcome: 'not_done', reason: 'no_prepaid_amount' };

    // Replication is a pure, unit-tested builder in shopify.js — see buildC2PDraftInput.
    const built = SH.buildC2PDraftInput(order, enrolmentId);
    if (built.error) return { outcome: 'not_done', reason: built.error };
    const { input, currencyCode: cur } = built;

    // PHASE A — create the replica with NO discount and read back what Shopify actually totals
    // it at. The concession is derived from THAT, never from the original order's total: Shopify
    // recomputes tax and shipping, so a discount sized against the original could leave the
    // final total off. This makes the arithmetic exact by construction, not by assumption.
    const c = await SH.shopifyGraphQL(env, DRAFT_CREATE_M, { input });
    const cErr = c?.draftOrderCreate?.userErrors || [];
    if (cErr.length) return { outcome: 'not_done', reason: `draft_create:${cErr.map((e) => e.message).join('; ')}`.slice(0, 160) };
    const draftId = c?.draftOrderCreate?.draftOrder?.id;
    const replicated = c?.draftOrderCreate?.draftOrder?.totalPriceSet?.shopMoney?.amount;
    if (!draftId || replicated == null) return { outcome: 'not_done', reason: 'draft_create_no_id' };

    const concession = Math.round((Number(replicated) - prepaid) * 100) / 100;
    if (concession <= 0) return { outcome: 'not_done', reason: `concession_not_positive:${replicated}->${prepaid}` };

    // PHASE B — apply the concession as ONE explicit order-level discount. Line prices stay
    // truthful, the C2P giveaway is a visible auditable line rather than smeared across items
    // (which would also not sum exactly after per-line rounding), and refunds pro-rate off it.
    const u = await SH.shopifyGraphQL(env, DRAFT_UPDATE_M, { id: draftId, input: {
      appliedDiscount: {
        valueType: 'FIXED_AMOUNT', value: concession, amountWithCurrency: money(concession, cur),
        title: 'COD → Prepaid', description: `Prepaid pricing for ${order.name}`,
      } } });
    const uErr = u?.draftOrderUpdate?.userErrors || [];
    if (uErr.length) return { outcome: 'not_done', reason: `draft_discount:${uErr.map((e) => e.message).join('; ')}`.slice(0, 160) };
    const finalTotal = u?.draftOrderUpdate?.draftOrder?.totalPriceSet?.shopMoney?.amount;

    // VERIFY BEFORE COMMITTING. If the draft does not total what the customer paid, do NOT
    // complete it: a wrong-priced LIVE order is worse than a failed conversion, because the
    // failure path leaves the original intact and recoverable. One paisa of tolerance absorbs
    // tax-inclusive rounding; anything larger is a real mismatch and wants a human.
    if (finalTotal == null || Math.abs(paise(finalTotal) - paise(prepaid)) > 1) {
      await AL.alert(env, `:warning: C2P aborted before commit on ${order.name} — draft totalled ${finalTotal} but the customer paid ${prepaid}. Draft ${draftId} left for inspection; original NOT cancelled.`);
      return { outcome: 'not_done', reason: `total_mismatch:${finalTotal}!=${prepaid}` };
    }

    // PHASE C — commit. Omitting the deprecated `paymentPending` takes its default (false),
    // completing the draft as a PAID order: correct for money already collected via Cashfree,
    // and the same posture the old mark-as-paid op had.
    const done = await SH.shopifyGraphQL(env, DRAFT_COMPLETE_M, { id: draftId });
    const dErr = done?.draftOrderComplete?.userErrors || [];
    if (dErr.length) return { outcome: 'not_done', reason: `draft_complete:${dErr.map((e) => e.message).join('; ')}`.slice(0, 160) };
    const newOrder = done?.draftOrderComplete?.draftOrder?.order;
    if (!newOrder?.id) return { outcome: 'not_done', reason: 'draft_complete_no_order' };

    // ── past the commit point ──────────────────────────────────────────────────
    // Stamp the idempotency marker on the original FIRST, before attempting the cancel. The
    // marker records "a replacement exists", which is the thing that must never happen twice —
    // tagging it only on a successful cancel would let a retry after a failed cancel mint a
    // SECOND replacement.
    await SH.shopifyGraphQL(env, TAGS_ADD_M, { id: gid, tags: [`relay-c2p-replaced-by-${newOrder.name}`] }).catch(() => {});

    // Every remaining failure still reports `done` — the customer's conversion did succeed — but
    // must page ops, because the residue is two live orders for one purchase, the only outcome
    // that leaves LOT worse off than having done nothing.
    let cancelled = true, cancelError = null;
    try {
      const r = await SH.shopifyGraphQL(env, ORDER_CANCEL_M, {
        orderId: gid, reason: 'CUSTOMER', refund: false,
        // restock:TRUE — corrected 2026-07-29. The design doc said false, reasoning that "the
        // replacement order holds the same units", and that is simply not how Shopify works:
        // `draftOrderComplete` RESERVES ITS OWN INVENTORY ("inventory is reserved for the items
        // in the order" — Shopify docs, verified). So by the time we cancel, TWO units are
        // committed for ONE physical sale. Leaving the original decremented (restock:false)
        // would leak exactly one unit per conversion, silently, forever — the sort of drift
        // nobody traces back to a comms journey.
        //
        // Releasing the original's units is therefore correct, not a double-restock: the
        // replacement already took its own. NB this means a conversion transiently needs ONE
        // SPARE UNIT (original still committed while the replacement completes) — on a
        // low-stock SKU `draftOrderComplete` can fail for want of it, which is why the
        // pre-flight stock check is on the backlog.
        restock: true });
      const errs = (r?.orderCancel?.orderCancelUserErrors || []).concat(r?.orderCancel?.userErrors || []);
      if (errs.length) { cancelled = false; cancelError = errs.map((e) => e.message).join('; ').slice(0, 120); }
    } catch (e) { cancelled = false; cancelError = String(e?.message || e).slice(0, 120); }

    if (!cancelled) {
      // "WITH restocking" for the same reason the automated cancel above uses restock:true — the
      // replacement order has already reserved its own units, so the original's must come back or
      // stock silently drifts down by one. (This line said WITHOUT until 2026-07-29, which would
      // have had a human faithfully reproduce the bug by hand.)
      await AL.alert(env, `:rotating_light: C2P DUPLICATE ORDERS — ${order.name} could NOT be cancelled after replacement ${newOrder.name} went live (${cancelError}). Cancel ${order.name} by hand, WITH restocking (the replacement already took its own stock).`);
    }

    return {
      outcome: 'done', op: 'recreate_as_prepaid',
      new_order_id: newOrder.id, new_order_name: newOrder.name,
      charged: prepaid, concession, original_cancelled: cancelled,
      ...(cancelError ? { cancel_error: cancelError } : {}),
      // Makes `{new_order_number}` bindable in the downstream "payment received" message —
      // the token that had to be left out of the copy while the recreate action didn't exist.
      context: { new_order_number: newOrder.name, new_order_id: newOrder.id },
    };
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
    // The send FAILED — "we never reached them" is not "they ignored us", so this must never
    // fall through to the no_reply timeout below (that is what applies the No-Response tag and
    // inflates every no-response funnel number). Route it only if the author wired a
    // send_failed branch; otherwise TERMINATE with that outcome, because resolveTarget returns
    // null for an undeclared handle and the enrolment would otherwise end as a plain completion.
    if (woke.kind === 'send_failed') {
      return G.resolveTarget(s, 'send_failed') ? { handle: 'send_failed' } : { terminate: 'send_failed' };
    }
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
  // S268 — resolves the END of the quiet window for THIS channel (minute precision), reusing
  // gate.js's resolver so the park boundary can never disagree with the gate that caused it.
  // A channel that is exempt (email) can't reach here — the gate never returns quiet_hours for
  // it — but return 0 defensively so a misconfig degrades to "send now", not "park forever".
  async #msUntilQuietEnd(env, channel) {
    try {
      const [settings, cqh] = await Promise.all([GATE.getSettings(env), GATE.getChannelQuietHours(env)]);
      // Unreadable table → the gate returns gate_error, not quiet_hours, so this is unreachable
      // from a real skip. Park to the global end hour if it ever is: a wrong-but-bounded wake is
      // better than 0, which would retry immediately into the same failure.
      if (!cqh.ok) return G.msUntilIstHour(Date.now(), Number(settings.quiet_hours_end ?? 9));
      const win = GATE.resolveQuietWindow(cqh.rows, channel, settings);
      if (!win) return 0;
      return G.msUntilIstMinute(Date.now(), win.endMin);
    } catch (_) {
      return G.msUntilIstHour(Date.now(), 9);   // same fail-safe as before
    }
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
      // An async send failure (Meta 200s the send, then the status webhook flips it to `failed`
      // minutes later). Only ever reachable from the INTERACTIVE park: wa-webhooks only signals
      // when an `enrolment_waits` row exists whose step_id equals the failed send's own step,
      // and #interactiveBranch is the only place that registers one. A plain `wait`/
      // `wait_response` park therefore cannot receive this kind — which matters, because those
      // callers treat any non-exit wake as "advance", and an early advance would cut a wait short.
      if (p.kind === 'send_failed') return { kind: 'send_failed', reason: p.reason || null };
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
  async #evalCondition(env, check, profileId, enrolledAt, triggerProps) {
    // Branch on the trigger event's own properties (S232 — category-voice branching).
    // Pure comparator lives in journey-graph.js so it unit-tests without this class.
    if (check?.kind === 'event_property') return G.evalEventProperty(check, triggerProps || {});
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
