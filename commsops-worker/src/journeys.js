// Journey CRUD + versioning + step-graph validation + enrol (enrol() added in a later task).
const A = require('./auth.js');
const G = require('./journey-graph.js');
const nowIso = () => new Date().toISOString();

async function listJourneys(env) {
  const r = await A.sbComms('/rest/v1/journeys?select=*&order=updated_at.desc', env);
  return (r.ok && r.data) || [];
}

async function getJourney(env, id) {
  const r = await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  const j = (r.ok && r.data?.[0]) || null;
  if (!j) return null;
  const v = await A.sbComms(
    `/rest/v1/journey_versions?journey_id=eq.${A.enc(id)}&select=version,definition,created_at&order=version.desc`, env);
  return { ...j, versions: (v.ok && v.data) || [] };
}

// Validate the step graph: single declared entry, every next/branch target exists,
// at least one reachable exit, send steps reference an approved template, wait_response
// steps have valid awaited/within/handlers, on_skip is a known policy, and (when a journey
// is passed) journey-level exit_rules + max_duration are well-formed. Returns { ok, errors:[] }.
async function compile(env, definition, journey) {
  const errors = [];
  const steps = definition?.steps || {};
  const ids = Object.keys(steps);
  if (!definition?.entry || !steps[definition.entry]) errors.push('entry_missing_or_unknown');
  const targets = (s) => G.stepTargets(s);
  for (const id of ids) {
    const s = steps[id];
    if (G.RESERVED_STEP_IDS.includes(id) || /^(log:|end:|precheck:|precheckx:|waitreg:|waitclr:|since:|clear-waits:|isince:|ireg:|iclr:|iwait:|iprecheck:|ibtn:)/.test(id))
      errors.push(`reserved_step_id:${id}`);
    if (!['wait', 'condition', 'send', 'wait_response', 'exit', 'action'].includes(s.type)) errors.push(`bad_type:${id}:${s.type}`);
    for (const t of targets(s)) if (!steps[t]) errors.push(`dangling_target:${id}->${t}`);
    if (s.type === 'action') {
      if (!['payment_link', 'set_attr', 'order_modify'].includes(s.kind)) errors.push(`bad_action_kind:${id}:${s.kind}`);
      if (s.kind === 'set_attr' && !s.attr) errors.push(`set_attr_no_attr:${id}`);
      if (s.kind === 'order_modify' && !['convert_to_prepaid', 'cancel', 'add_tag'].includes(s.op)) errors.push(`bad_order_op:${id}:${s.op}`);
      // every outcome handle the kind declares must route somewhere (no dangling branch)
      for (const h of G.handlesFor(s)) if (!steps[G.resolveTarget(s, h)]) errors.push(`action_handle_missing:${id}:${h}`);
    }
    if (s.type === 'send' && s.interactive) {
      const btns = Array.isArray(s.buttons) ? s.buttons.filter((b) => b && b.id) : [];
      if (!btns.length) errors.push(`interactive_send_no_buttons:${id}`);
      if (btns.length > 3) errors.push(`interactive_send_too_many_buttons:${id}`);   // WA quick-reply cap
      if (!s.within || G.durationToMs(s.within) === null) errors.push(`interactive_send_bad_within:${id}`);
      for (const h of G.handlesFor(s)) if (!steps[G.resolveTarget(s, h)]) errors.push(`interactive_handle_missing:${id}:${h}`);
    }
    if (s.type === 'condition' &&
        (!steps[G.resolveTarget(s, 'if_true')] || !steps[G.resolveTarget(s, 'if_false')]))
      errors.push(`condition_branch_missing:${id}`);
    // A missing duration AND an unparseable one (e.g. a typo'd "3 dayz") are both compile
    // errors — the interpreter's #park catch-all can't tell "bad config" from "real
    // timeout", so a typo silently fires the drip instantly instead of failing loud here
    // (review H14).
    if (s.type === 'wait') {
      if (!s.duration) errors.push(`wait_no_duration:${id}`);
      else if (G.durationToMs(s.duration) === null) errors.push(`wait_bad_duration:${id}`);
    }
    if (s.type === 'wait_response') {
      if (!Array.isArray(s.awaited) || s.awaited.length === 0) errors.push(`wait_response_no_awaited:${id}`);
      if (!s.within || G.durationToMs(s.within) === null) errors.push(`wait_response_bad_within:${id}`);
      if (!G.resolveTarget(s, 'responded') || !G.resolveTarget(s, 'timeout')) errors.push(`wait_response_handle_missing:${id}`);
    }
    if (s.type === 'send' && s.on_skip !== undefined &&
        !['continue', 'advance', 'exit'].includes(s.on_skip)) errors.push(`bad_on_skip:${id}`);
    // 'active' is the live-enrolment status — a terminal outcome equal to it would strand
    // a terminated enrolment as active (and corrupt the funnel aggregation).
    if (s.type === 'exit' && s.outcome === 'active') errors.push(`reserved_outcome:${id}`);
    if (s.type === 'send' && s.on_skip_outcome === 'active') errors.push(`reserved_outcome:${id}`);
  }
  const seen = new Set(); const stack = definition?.entry ? [definition.entry] : [];
  while (stack.length) {
    const id = stack.pop(); if (seen.has(id) || !steps[id]) continue; seen.add(id);
    targets(steps[id]).forEach((t) => stack.push(t));
  }
  if (![...seen].some((id) => steps[id]?.type === 'exit')) errors.push('no_reachable_exit');
  // Reject cycles — the interpreter keys durable steps by step id, so a revisited
  // step returns cached results and spins to the transition cap. True loops are a
  // deferred feature; for now a cyclic graph is a compile error.
  const GREY = 1, BLACK = 2;
  const color = {};
  const hasCycle = (id) => {
    if (!steps[id]) return false;
    color[id] = GREY;
    for (const t of G.stepTargets(steps[id])) {
      if (color[t] === GREY) return true;
      if (color[t] === undefined && hasCycle(t)) return true;
    }
    color[id] = BLACK;
    return false;
  };
  if (definition?.entry && hasCycle(definition.entry)) errors.push('cycle_detected');
  const tplIds = [...seen].map((id) => steps[id]).filter((s) => s?.type === 'send' && s.templateId).map((s) => s.templateId);
  if (tplIds.length) {
    const inList = tplIds.map((t) => A.enc(t)).join(',');
    const r = await A.sbComms(`/rest/v1/templates?id=in.(${inList})&select=id,status`, env);
    const byId = Object.fromEntries(((r.ok && r.data) || []).map((t) => [t.id, t.status]));
    for (const t of tplIds) if (byId[t] !== 'active') errors.push(`template_not_active:${t}`);
  }
  // Journey-level escalation config (optional; passed from saveJourney).
  if (journey) {
    if (journey.max_duration !== undefined && journey.max_duration !== null &&
        G.durationToMs(journey.max_duration) === null) errors.push('bad_max_duration');
    if (journey.exit_rules !== undefined && journey.exit_rules !== null) {
      if (!Array.isArray(journey.exit_rules)) errors.push('bad_exit_rules');
      else journey.exit_rules.forEach((r, i) => {
        if (!r || !r.event) errors.push(`exit_rule_no_event:${i}`);
        if (!r || !r.outcome) errors.push(`exit_rule_no_outcome:${i}`);
        if (r && r.outcome === 'active') errors.push(`exit_rule_reserved_outcome:${i}`);
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

// Save = upsert journey header + (if definition changed) publish a NEW immutable version.
async function saveJourney(env, body, userId) {
  const { id, name, trigger, reenrolment, reenrol_cooldown_hours, definition, status, exit_rules, max_duration } = body;
  if (definition) {
    const c = await compile(env, definition, body);
    if (!c.ok) return { ok: false, error: 'invalid_definition', details: c.errors };
  }
  let journeyId = id;
  if (!journeyId) {
    const ins = await A.sbComms('/rest/v1/journeys', env, {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name, trigger: trigger || {}, reenrolment: reenrolment || 'once_while_active',
        reenrol_cooldown_hours: reenrol_cooldown_hours || null, status: 'draft', created_by: userId,
        exit_rules: Array.isArray(exit_rules) ? exit_rules : [],
        max_duration: max_duration || '30 days' }),
    });
    journeyId = ins.data?.[0]?.id;
    if (!journeyId) return { ok: false, error: 'create_failed' };
  } else {
    const patch = { updated_at: nowIso() };
    if (name !== undefined) patch.name = name;
    if (trigger !== undefined) patch.trigger = trigger;
    if (reenrolment !== undefined) patch.reenrolment = reenrolment;
    if (reenrol_cooldown_hours !== undefined) patch.reenrol_cooldown_hours = reenrol_cooldown_hours;
    if (status !== undefined) patch.status = status;
    if (exit_rules !== undefined) patch.exit_rules = Array.isArray(exit_rules) ? exit_rules : [];
    if (max_duration !== undefined) patch.max_duration = max_duration || '30 days'; // coalesce: column is NOT NULL (a cleared field → default, never a 23502 that silently drops the whole PATCH)
    await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  if (definition) {
    const cur = await A.sbComms(
      `/rest/v1/journey_versions?journey_id=eq.${A.enc(journeyId)}&select=version&order=version.desc&limit=1`, env);
    const nextV = Number(cur.data?.[0]?.version || 0) + 1;
    const ins = await A.sbComms('/rest/v1/journey_versions', env, {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ journey_id: journeyId, version: nextV, definition, created_by: userId }) });
    // Verify the version actually landed BEFORE bumping active_version — a failed/empty
    // insert here previously fell through silently, leaving active_version pointing at a
    // version row that was never written (review H13). A blank canvas / a crashed enrol()
    // pinned to that phantom version is the failure mode this closes.
    if (!ins.ok || !ins.data?.[0])
      return { ok: false, error: 'version_insert_failed' };   // never point active_version at a ghost (review H13)
    await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}`, env,
      { method: 'PATCH', body: JSON.stringify({ active_version: nextV, updated_at: nowIso() }) });
  }
  return { ok: true, journey_id: journeyId };
}

// activate/pause/archive — flips journeys.status (trigger matching only fires on 'active').
async function setJourneyStatus(env, id, status) {
  if (!['draft', 'active', 'paused', 'archived'].includes(status)) return { ok: false, error: 'bad_status' };
  const j = await getJourney(env, id);
  if (status === 'active' && !j?.active_version) return { ok: false, error: 'no_published_version' };
  await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(id)}`, env,
    { method: 'PATCH', body: JSON.stringify({ status, updated_at: nowIso() }) });
  return { ok: true };
}

// enrol(env, {journeyId, profileId, eventId?}) — respects re-enrolment policy,
// creates the enrolment row pinned to active_version, starts the Workflow instance.
async function enrol(env, { journeyId, profileId, eventId }) {
  // A failed READ is a transient infra blip, not "this journey doesn't exist" — throw so
  // the queue consumer's catch retries the message instead of acking a lost enrolment
  // (review H10). Only a genuinely missing/inactive journey returns the soft {ok:false}.
  const jr = await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=*&limit=1`, env);
  if (!jr.ok) throw new Error('journey_read_failed:' + jr.status);
  const j = jr.data?.[0];
  if (!j || j.status !== 'active' || !j.active_version) return { ok: false, error: 'journey_not_active' };

  // Policy normalization (review H12): an unrecognised/legacy reenrolment value falls back
  // to the SAFEST policy (once_while_active) rather than skipping dedup entirely, and a
  // cooldown journey with null/0 hours still dedups — using a 24h default window — instead
  // of silently taking the 'no policy matched' fall-through (the old double-enrol hole).
  const policy = ['once_while_active', 'once_ever', 'cooldown', 'always'].includes(j.reenrolment)
    ? j.reenrolment : 'once_while_active';
  const cooldownH = policy === 'cooldown' ? (Number(j.reenrol_cooldown_hours) || 24) : null;

  // re-enrolment policy — only 'always' skips the dedup check entirely.
  if (policy === 'once_while_active' || policy === 'once_ever') {
    const statusFilter = policy === 'once_ever' ? '' : '&status=eq.active';
    const ex = await A.sbComms(
      `/rest/v1/enrolments?journey_id=eq.${A.enc(journeyId)}&profile_id=eq.${A.enc(profileId)}${statusFilter}&select=id&limit=1`, env);
    if (!ex.ok) throw new Error('dedup_check_failed:' + ex.status);   // don't enrol blind on a failed dedup read
    if (ex.data?.length) return { ok: false, skipped: 'reenrolment_policy' };
  } else if (policy === 'cooldown') {
    const since = new Date(Date.now() - cooldownH * 3600e3).toISOString();
    const ex = await A.sbComms(
      `/rest/v1/enrolments?journey_id=eq.${A.enc(journeyId)}&profile_id=eq.${A.enc(profileId)}&enrolled_at=gte.${A.enc(since)}&select=id&limit=1`, env);
    if (!ex.ok) throw new Error('dedup_check_failed:' + ex.status);
    if (ex.data?.length) return { ok: false, skipped: 'cooldown' };
  }

  const ins = await A.sbComms('/rest/v1/enrolments', env, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ journey_id: journeyId, journey_version: j.active_version, profile_id: profileId,
      status: 'active', context: { trigger_event_id: eventId || null, enrolled_at: new Date().toISOString() } }),
  });
  const enrolment = ins.data?.[0];
  // A failed/empty insert is transient (or a schema surprise) — throw so the queue retries
  // (review H10). The unique index added alongside this fix (see migration 0026) means a
  // retry that races a still-active duplicate now fails at the DB with a constraint
  // violation (ins.ok === false) rather than silently double-enrolling.
  if (!ins.ok || !enrolment?.id) throw new Error('enrolment_insert_failed:' + ins.status);

  // start the durable Workflow — instance id = enrolment id (unique → idempotent against
  // double-fan-out AND against a queue redelivery of this same enrol() message: a retry
  // reaches this point with the SAME enrolment row already inserted — no, actually a
  // retried enrol() call re-runs the dedup check above first, which will now find that
  // very enrolment row (status='active') and skip before ever reaching the insert. So the
  // insert path only runs once per successful enrolment; a THROW here still leaves the
  // enrolment row 'active' with no workflow instance — mark it 'failed' and rethrow so the
  // queue retries. On retry, dedup sees the 'failed' row (once_while_active only matches
  // status=active) and proceeds to insert a fresh enrolment + create() attempt — no
  // double-workflow, because create()'s target id is always this NEW enrolment's id.
  try {
    await env.JOURNEY_WORKFLOW.create({ id: enrolment.id,
      params: { enrolmentId: enrolment.id, journeyId, journeyVersion: j.active_version, profileId } });
  } catch (e) {
    // create throws on duplicate id (already started) → benign, instance is already
    // running under this id; otherwise mark the enrolment failed and THROW so the queue
    // retries the whole enrol() (review H10) instead of leaving a dangling active row.
    if (!String(e?.message || '').toLowerCase().includes('already')) {
      await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolment.id)}`, env,
        { method: 'PATCH', body: JSON.stringify({ status: 'failed', ended_at: new Date().toISOString() }) });
      throw new Error('workflow_start_failed:' + (e?.message || ''));
    }
  }
  return { ok: true, enrolment_id: enrolment.id };
}

module.exports = { listJourneys, getJourney, compile, saveJourney, setJourneyStatus, enrol };
