// M7 journey engine — one Workflow instance per enrolment. Generic interpreter
// over the pinned, immutable journey definition. NOTE: the ONLY esm `import` in
// this file is `cloudflare:workers` (required for WorkflowEntrypoint); everything
// else uses require() to match the rest of the worker (esbuild bundles the interop).
import { WorkflowEntrypoint } from 'cloudflare:workers';
const A = require('./auth.js');
const { send } = require('./send.js');
const G = require('./journey-graph.js');

const MAX_TRANSITIONS = 100; // safety against a mis-validated cyclic definition

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
        await this.#logStep(env, step, enrolmentId, cur, s.type, { awaited: s.awaited, within: s.within });
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
        if (terminateOutcome) { await this.#end(env, step, enrolmentId, terminateOutcome, cur); return; }
        cur = G.resolveTarget(s, outHandle);
      } else if (s.type === 'condition') {
        const branch = await step.do(cur, async () => this.#evalCondition(env, s.check, profileId, enrolledAt));
        await this.#logStep(env, step, enrolmentId, cur, s.type, { branch });
        cur = G.resolveTarget(s, branch ? 'if_true' : 'if_false');
      } else if (s.type === 'send') {
        const res = await step.do(cur, async () => this.#doSend(env, s, profileId, enrolmentId, cur, triggerProps, journeyName));
        const decision = G.resolveSendNext(s, res, def);
        await this.#logStep(env, step, enrolmentId, cur, s.type, { ...res, on_skip: s.on_skip || 'continue', skipped_wait: decision.skippedWait || null });
        if (decision.terminate) { await this.#end(env, step, enrolmentId, decision.terminate, cur); return; }
        cur = decision.next;
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
      templateId: s.templateId, constants: s.constants || {}, eventContext: triggerProps || {},
      tracking: { campaign: journeyName },
      source: `journey:${enrolmentId}`, dedupKey: `journey:${enrolmentId}:${stepId}`,
    });
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
