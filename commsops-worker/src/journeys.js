// Journey CRUD + versioning + step-graph validation + enrol (enrol() added in a later task).
const A = require('./auth.js');
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
// at least one reachable exit, send steps reference an approved template. Returns { ok, errors:[] }.
async function compile(env, definition) {
  const errors = [];
  const steps = definition?.steps || {};
  const ids = Object.keys(steps);
  if (!definition?.entry || !steps[definition.entry]) errors.push('entry_missing_or_unknown');
  const targets = (s) => [s.next, s.if_true, s.if_false].filter(Boolean);
  for (const id of ids) {
    const s = steps[id];
    if (!['wait', 'condition', 'send', 'exit'].includes(s.type)) errors.push(`bad_type:${id}:${s.type}`);
    for (const t of targets(s)) if (!steps[t]) errors.push(`dangling_target:${id}->${t}`);
    if (s.type === 'condition' && (!steps[s.if_true] || !steps[s.if_false])) errors.push(`condition_branch_missing:${id}`);
    if (s.type === 'wait' && !s.duration) errors.push(`wait_no_duration:${id}`);
  }
  const seen = new Set(); const stack = definition?.entry ? [definition.entry] : [];
  while (stack.length) {
    const id = stack.pop(); if (seen.has(id) || !steps[id]) continue; seen.add(id);
    targets(steps[id]).forEach((t) => stack.push(t));
  }
  if (![...seen].some((id) => steps[id]?.type === 'exit')) errors.push('no_reachable_exit');
  const tplIds = [...seen].map((id) => steps[id]).filter((s) => s?.type === 'send' && s.templateId).map((s) => s.templateId);
  if (tplIds.length) {
    const inList = tplIds.map((t) => A.enc(t)).join(',');
    const r = await A.sbComms(`/rest/v1/templates?id=in.(${inList})&select=id,status`, env);
    const byId = Object.fromEntries(((r.ok && r.data) || []).map((t) => [t.id, t.status]));
    for (const t of tplIds) if (byId[t] !== 'active') errors.push(`template_not_active:${t}`);
  }
  return { ok: errors.length === 0, errors };
}

// Save = upsert journey header + (if definition changed) publish a NEW immutable version.
async function saveJourney(env, body, userId) {
  const { id, name, trigger, reenrolment, reenrol_cooldown_hours, definition, status } = body;
  if (definition) {
    const c = await compile(env, definition);
    if (!c.ok) return { ok: false, error: 'invalid_definition', details: c.errors };
  }
  let journeyId = id;
  if (!journeyId) {
    const ins = await A.sbComms('/rest/v1/journeys', env, {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name, trigger: trigger || {}, reenrolment: reenrolment || 'once_while_active',
        reenrol_cooldown_hours: reenrol_cooldown_hours || null, status: 'draft', created_by: userId }),
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
    await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  if (definition) {
    const cur = await A.sbComms(
      `/rest/v1/journey_versions?journey_id=eq.${A.enc(journeyId)}&select=version&order=version.desc&limit=1`, env);
    const nextV = Number(cur.data?.[0]?.version || 0) + 1;
    await A.sbComms('/rest/v1/journey_versions', env, {
      method: 'POST', body: JSON.stringify({ journey_id: journeyId, version: nextV, definition, created_by: userId }) });
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

module.exports = { listJourneys, getJourney, compile, saveJourney, setJourneyStatus };
