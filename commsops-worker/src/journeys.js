// Journey CRUD + versioning + step-graph validation + enrol (enrol() added in a later task).
const A = require('./auth.js');
const G = require('./journey-graph.js');
const { normalizeUtm } = require('./tracking.js');

// Server-side normalization of author-supplied utm_*. Reuses the SAME normalizeUtm the send path
// uses, so what is stored is exactly what will be sent. Enforced here and not only in the UI
// because saveJourney/saveCampaign are ordinary authed API actions anyone can call directly:
// blanks are dropped (blank means inherit) and every key is forced into the utm_ namespace, since
// these values become query params on customer-facing links and must never escape utm_*. All-blank collapses to NULL = inherit everything.
function sanitizeUtm(u) {
  if (u === null || u === undefined) return null;
  const clean = normalizeUtm(u);
  return Object.keys(clean).length ? clean : null;
}
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
      if (s.kind === 'order_modify' && !['convert_to_prepaid', 'recreate_as_prepaid', 'cancel', 'add_tag'].includes(s.op)) errors.push(`bad_order_op:${id}:${s.op}`);
      // every outcome handle the kind declares must route somewhere (no dangling branch)
      for (const h of G.handlesFor(s)) if (!steps[G.resolveTarget(s, h)]) errors.push(`action_handle_missing:${id}:${h}`);
    }
    // A send step must resolve to SOMETHING sendable. Two legitimate shapes: a stored
    // `templateId`, or an inline body (`text`/`body`) that journey-workflow turns into an
    // ad-hoc template — the latter is how C2P's 8 free-text session replies work, so this
    // must NOT be tightened to "templateId required". With NEITHER, the step passes compile
    // today (the template check below filters on `s.templateId`, so a null one is simply
    // skipped) and then fails EVERY send at runtime with `template_not_found`, because
    // journey-workflow only attaches an inline template when `text || body` is present.
    // A silent pass at activation followed by live per-send failures is a worse shape than
    // a compile error — this turns it back into one. `Review Request`'s `send1` is exactly
    // this: templateId null, no text, no body, and it would have activated cleanly.
    if (s.type === 'send' && !s.templateId
        && !String(s.text || s.body || '').trim()) errors.push(`send_no_template_or_body:${id}`);
    if (s.type === 'send' && s.interactive) {
      const btns = Array.isArray(s.buttons) ? s.buttons.filter((b) => b && b.id) : [];
      if (!btns.length) errors.push(`interactive_send_no_buttons:${id}`);
      if (btns.length > 3) errors.push(`interactive_send_too_many_buttons:${id}`);   // WA quick-reply cap
      if (!s.within || G.durationToMs(s.within) === null) errors.push(`interactive_send_bad_within:${id}`);
      // Every declared handle must route somewhere (no dangling branch) — EXCEPT `send_failed`,
      // which is deliberately OPTIONAL: it exists so the canvas can offer a "message never
      // reached them" branch, but leaving it unwired is the normal case and the interpreter
      // terminates the enrolment with outcome 'send_failed' instead of routing. Requiring it
      // would break compilation of every interactive journey already live, C2P included.
      for (const h of G.handlesFor(s)) {
        if (h === 'send_failed') continue;
        if (!steps[G.resolveTarget(s, h)]) errors.push(`interactive_handle_missing:${id}:${h}`);
      }
    }
    if (s.type === 'condition' &&
        (!steps[G.resolveTarget(s, 'if_true')] || !steps[G.resolveTarget(s, 'if_false')]))
      errors.push(`condition_branch_missing:${id}`);
    // event_property without a field can only ever evaluate '' — a silent always-false
    // branch is exactly the class of bug compile exists to catch (cf. wait_bad_duration).
    if (s.type === 'condition' && s.check?.kind === 'event_property' && !s.check.field)
      errors.push(`event_property_no_field:${id}`);
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
// S338b — the journey's exclusion block, coerced server-side exactly as saveCampaign coerces a
// campaign's (index.js): non-arrays become [], anything that is not a uuid string is DROPPED (a
// junk id would make the RPC's `= ANY($2)` compare against garbage rather than error), and the
// hours field is NULL unless it is a positive integer — a 0 or a stray '' means "rule off", never
// "exclude anyone contacted in the last 0 hours". saveJourney is an ordinary authed API action
// anyone can call directly, so the UI's own validation is not the guard.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && UUID_RE.test(x.trim())).map((x) => x.trim()) : []);
// Key-order-independent equality for a compiled journey definition (jsonb round-trips re-order
// object keys, so JSON.stringify on the raw objects would call every re-save "changed").
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v);
const sameDefinition = (a, b) => canon(a) === canon(b);

const exclusionPatch = (b) => {
  const hrs = Number(b.exclude_contacted_hours);
  return {
    exclude_segment_ids: uuidList(b.exclude_segment_ids),
    exclude_campaign_ids: uuidList(b.exclude_campaign_ids),
    exclude_contacted_hours: Number.isFinite(hrs) && hrs > 0 ? Math.round(hrs) : null,
  };
};

async function saveJourney(env, body, userId) {
  const { id, name, trigger, reenrolment, reenrol_cooldown_hours, definition, status, exit_rules, max_duration, utm } = body;
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
        utm: sanitizeUtm(utm),
        ...exclusionPatch(body),
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
    // nullable jsonb: an all-blank UI form sends null, which correctly means "inherit".
    if (utm !== undefined) patch.utm = sanitizeUtm(utm);
    // The three exclusion columns move together — the UI always sends the whole block, and any
    // absent/junk member coerces to "rule off" rather than being left at a stale prior value.
    if (body.exclude_segment_ids !== undefined || body.exclude_campaign_ids !== undefined
        || body.exclude_contacted_hours !== undefined) Object.assign(patch, exclusionPatch(body));
    if (max_duration !== undefined) patch.max_duration = max_duration || '30 days'; // coalesce: column is NOT NULL (a cleared field → default, never a 23502 that silently drops the whole PATCH)
    await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  if (definition) {
    const cur = await A.sbComms(
      `/rest/v1/journey_versions?journey_id=eq.${A.enc(journeyId)}&select=version,definition&order=version.desc&limit=1`, env);
    // S338: a settings-only save (exclusions, exit rules…) used to publish a byte-identical
    // version and bump active_version on every LIVE journey it touched — the editor always
    // sends `definition`. Compare canonically (jsonb re-orders keys) and skip the no-op publish.
    if (cur.ok && cur.data?.[0] && sameDefinition(cur.data[0].definition, definition))
      return { ok: true, journey_id: journeyId, version_unchanged: true };
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
//
// ⚠️ Flipping the status only closes the DOOR. Enrolments already in flight keep running on
// their own Workflow instances and WILL still send. S230: a real customer enrolled during a
// two-minute test window, and stopping them needed `wrangler workflows instances terminate`
// plus manual row cleanup, three minutes before the send. `stopInFlight` is the supported way.
//
// Deliberately OPT-IN, and never applied when activating. Draining in-flight enrolments is the
// right behaviour for a journey paused to tweak copy; stopping them is the right behaviour for
// a journey being pulled. Only the operator knows which, so the UI asks rather than this
// guessing — and the default stays exactly what it has always been.
async function setJourneyStatus(env, id, status, opts = {}) {
  if (!['draft', 'active', 'paused', 'archived'].includes(status)) return { ok: false, error: 'bad_status' };
  const j = await getJourney(env, id);
  if (status === 'active' && !j?.active_version) return { ok: false, error: 'no_published_version' };
  await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(id)}`, env,
    { method: 'PATCH', body: JSON.stringify({ status, updated_at: nowIso() }) });

  if (!opts.stopInFlight || status === 'active') return { ok: true };

  let found = 0, signalled = 0;
  // Paged, and bounded — a runaway loop here would hammer the Workflow binding.
  for (let page = 0; page < 10; page++) {
    const er = await A.sbComms(
      `/rest/v1/enrolments?journey_id=eq.${A.enc(id)}&status=eq.active&select=id&limit=200`, env);
    const rows = (er.ok && er.data) || [];
    if (!rows.length) break;
    found += rows.length;
    for (const e of rows) {
      try {
        // The SAME signal the J1 max-duration sweep sends, so a parked instance ends through
        // the ordinary #park -> #end path instead of being torn down underneath itself.
        const inst = await env.JOURNEY_WORKFLOW.get(String(e.id));
        await inst.sendEvent({ type: 'signal', payload: { kind: 'exit', outcome: 'journey_stopped', event: '__journey_stopped' } });
        signalled++;
      } catch (_) { /* not parked / already gone — the PATCH below is the backstop */ }
    }
    // Backstop, and the reason this is not signal-only: an instance that is mid-step is not
    // parked, so it never receives the signal and its row would sit `active` forever — the
    // journey would keep reading as live on /journeys and the next status flip would find the
    // same rows again. `#end` is idempotent about a row that is already ended.
    // NB the loop re-queries status=eq.active, so these rows drop out of the next page: this
    // is a drain, not an offset walk (an offset would skip rows as the set shrinks).
    await A.sbComms(`/rest/v1/enrolments?id=in.(${rows.map((r) => r.id).join(',')})`, env,
      { method: 'PATCH', body: JSON.stringify({ status: 'journey_stopped', ended_at: nowIso() }) });
    if (rows.length < 200) break;
  }
  return { ok: true, in_flight_found: found, signalled };
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

  // Concurrency key for the unique index enrolments_one_active_per_journey_profile_dedup
  // (journey_id, profile_id, dedup_key) WHERE status='active'.
  //   every policy but 'always' → the constant, so the index enforces one active enrolment per
  //     journey+profile exactly as it has since migration 0026. Unchanged behaviour.
  //   'always' → one key per TRIGGERING ENTITY, so a customer's 2nd COD order enrols and gets
  //     its own C2P ask instead of being silently refused, while a REPLAYED webhook carrying
  //     the same event id still collides and is skipped by the 23505 branch below.
  // The no-event-id fallback must be unique, never a shared constant: collapsing those onto one
  // key would re-introduce the very refusal this fixes for any 'always' trigger without an event.
  const dedupKey = policy !== 'always' ? 'one_active'
    : (eventId ? `evt:${eventId}`
               : `uniq:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.round(Math.random() * 1e9)}`}`);

  const ins = await A.sbComms('/rest/v1/enrolments', env, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ journey_id: journeyId, journey_version: j.active_version, profile_id: profileId,
      status: 'active', dedup_key: dedupKey,
      context: { trigger_event_id: eventId || null, enrolled_at: new Date().toISOString() } }),
  });
  const enrolment = ins.data?.[0];
  // A 23505 here is NOT transient and must NEVER be retried: retrying replays the same losing
  // insert 3×, dead-letters the message, writes a comms.queue_failures row and pages
  // #relay-alerts for a state that is already settled. It means either the insert lost a race
  // against an enrolment the dedup check above could not yet see, or — on policy 'always' — a
  // REPLAYED trigger event whose event id already has an active enrolment. In both cases the
  // customer is already enrolled, so ack it as a skip.
  // NB a `queue_failures` row with kind='enrol' meant "a concurrent enrolment was refused",
  // NOT a dropped customer — the profile's first enrolment always exists.
  if (!ins.ok && ins.status === 409 && ins.data?.code === '23505') {
    console.log('enrol_duplicate_skipped', journeyId, profileId,
      String(ins.data?.message || '').slice(0, 160));
    return { ok: false, skipped: 'concurrent_active_enrolment' };
  }
  // Any OTHER failed/empty insert is transient (or a schema surprise) — throw so the queue
  // retries (review H10).
  if (!ins.ok || !enrolment?.id) throw new Error('enrolment_insert_failed:' + ins.status);

  // start the durable Workflow — instance id = enrolment id (unique → idempotent against
  // double-fan-out AND against a queue redelivery of this same enrol() message: a retried
  // enrol() call re-runs the dedup check above first, which will now find that very
  // enrolment row (status='active') and skip before ever reaching the insert.
  // ⚠️ THAT IS TRUE FOR once_while_active / once_ever / cooldown ONLY — policy 'always'
  // runs NO dedup check, so a retry goes straight back to the insert and hits the unique
  // index again. That gap is why a 2nd concurrent enrolment used to dead-letter, and it is
  // handled explicitly by the 23505 branch above. Do not "simplify" that branch away.
  // So the insert path only runs once per successful enrolment; a THROW here still leaves the
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
      // ⛔ THIS PATCH IS LOAD-BEARING AND ITS RESULT USED TO BE UNCHECKED (S228 reviewer item
      // (a), fixed S327). The whole retry story above depends on this row reaching 'failed':
      // the throw makes the queue retry enrol(), and the retry's dedup check matches
      // status='active' — so if the PATCH silently failed, the retry finds the still-ACTIVE row,
      // returns skipped:'reenrolment_policy', and ACKS. Net effect: an enrolment that is
      // 'active' with no Workflow instance, blocking every future enrolment of that profile on
      // this journey, and a customer who never receives the journey at all — silently.
      //
      // ⚠️ The J1 max-duration sweep is NOT a fix for this, only a mop: it stamps such rows
      // 'expired' after the journey's max_duration (3–30 days), which unblocks re-enrolment
      // eventually but never delivers the message that was owed. So the PATCH has to land.
      //
      // Bounded retry, then say so loudly. Three attempts because the failure this guards is a
      // transient blip; anything durable enough to survive three tries needs a human, and going
      // quiet there is exactly the original defect.
      let patched = false;
      for (let attempt = 1; attempt <= 3 && !patched; attempt++) {
        const pf = await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolment.id)}`, env,
          { method: 'PATCH', body: JSON.stringify({ status: 'failed', ended_at: new Date().toISOString() }) })
          .catch(() => ({ ok: false }));      // a transport rejection must not escape as an unrelated throw
        patched = !!pf?.ok;   // optional-chain: sbProfile can hand back a non-object, and a
        // TypeError here would escape as an unrelated throw — the exact class this block fixes.
      }
      if (!patched) {
        // Named + greppable: this enrolment id is now an active row with no workflow, and the
        // retry will skip it. Recovery is a one-row PATCH to 'failed'.
        console.log('enrol_failed_patch_stuck_active', enrolment.id, journeyId, profileId);
        throw new Error('workflow_start_failed_and_enrolment_stuck_active:' + enrolment.id
          + ':' + (e?.message || ''));
      }
      throw new Error('workflow_start_failed:' + (e?.message || ''));
    }
  }
  return { ok: true, enrolment_id: enrolment.id };
}

module.exports = { listJourneys, getJourney, compile, saveJourney, setJourneyStatus, enrol, sanitizeUtm,
  // S338b exclusions + no-op publish guard — exported for unit tests
  exclusionPatch, sameDefinition };
