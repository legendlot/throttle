// M7 journey engine — one Workflow instance per enrolment. Generic interpreter
// over the pinned, immutable journey definition. NOTE: the ONLY esm `import` in
// this file is `cloudflare:workers` (required for WorkflowEntrypoint); everything
// else uses require() to match the rest of the worker (esbuild bundles the interop).
import { WorkflowEntrypoint } from 'cloudflare:workers';
const A = require('./auth.js');
const { send } = require('./send.js');

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

    let cur = def.entry;
    for (let i = 0; i < MAX_TRANSITIONS; i++) {
      const s = def.steps[cur];
      if (!s) { await this.#end(env, step, enrolmentId, 'failed', cur); return; }

      if (s.type === 'wait') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { duration: s.duration });
        await step.sleep(cur, s.duration);
        cur = s.next;
      } else if (s.type === 'condition') {
        const branch = await step.do(cur, async () => this.#evalCondition(env, s.check, profileId, enrolledAt));
        await this.#logStep(env, step, enrolmentId, cur, s.type, { branch });
        cur = branch ? s.if_true : s.if_false;
      } else if (s.type === 'send') {
        const res = await step.do(cur, async () => this.#doSend(env, s, profileId, enrolmentId, cur, triggerProps));
        await this.#logStep(env, step, enrolmentId, cur, s.type, res);
        cur = s.next;
      } else if (s.type === 'exit') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { outcome: s.outcome || 'completed' });
        await this.#end(env, step, enrolmentId, s.outcome === 'exited' ? 'exited' : 'completed', cur);
        return;
      } else { await this.#end(env, step, enrolmentId, 'failed', cur); return; }

      if (!cur) { await this.#end(env, step, enrolmentId, 'completed', null); return; }
    }
    await this.#end(env, step, enrolmentId, 'failed', cur);  // transition cap hit
  }

  // Resolve recipient + call the M5 send() spine. dedupKey makes a retried durable step idempotent.
  // send() does NOT auto-resolve `to` from the profile (it loads the profile only for template
  // rendering; the adapter + gate use opts.to verbatim). So we resolve the profile's primary email
  // identifier here and pass it as `to`. No email → skip WITHOUT calling send().
  async #doSend(env, s, profileId, enrolmentId, stepId, triggerProps) {
    const channel = s.channel || 'email';
    const idr = await A.sbComms(
      `/rest/v1/identifiers?profile_id=eq.${A.enc(profileId)}&type=eq.email&select=value&order=last_seen.desc&limit=1`, env);
    if (!idr.ok) throw new Error('identifier_lookup_failed:' + JSON.stringify(idr.data));
    const to = idr.data?.[0]?.value;
    if (!to) return { status: 'skipped', reason: 'no_email_identifier' };
    return send(env, {
      channel, purpose: s.purpose || 'marketing', profileId, to,
      templateId: s.templateId, constants: s.constants || {}, eventContext: triggerProps || {},
      source: `journey:${enrolmentId}`, dedupKey: `journey:${enrolmentId}:${stepId}`,
    });
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

  async #end(env, step, enrolmentId, status, lastStep) {
    await step.do(`end:${status}`, async () => {
      await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolmentId)}`, env, { method: 'PATCH',
        body: JSON.stringify({ status, current_step: lastStep, ended_at: new Date().toISOString() }) });
      return true;
    });
  }
}

export { JourneyWorkflow };
