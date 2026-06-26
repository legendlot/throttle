# Relay M7 — Journey Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, versioned journey engine to Relay so the marketing team can build event-triggered, multi-step automated flows (wait → branch → send) without engineering, and ship the first journey (abandoned cart) end-to-end.

**Architecture:** Each enrolment runs as **one Cloudflare Workflow instance** — `step.sleep()` gives durable multi-day waits with zero resource cost while sleeping, and `step.do()` gives retryable, replay-safe send/condition units. The Workflow is a **generic interpreter** over the pinned, immutable journey definition (step graph), so any v1 journey shape runs on one class. Triggers fan out through the **existing `commsops-broadcast` Queue** (a discriminated `kind:'enrol'` message), reusing the campaign consumer pattern. **No Durable Object is added** — the per-enrolment timer/state that the original foundation plan assigned to a DO is fully subsumed by the Workflow instance, and frequency-cap/quiet-hours already live in the central `gate.js` enforced at `send()`. Every send funnels through the existing M5 `send()` spine (suppression → consent → freq cap → quiet hours → channel rule), so journeys inherit all governance for free.

**Tech Stack:** Cloudflare Workers (ESM entry + CommonJS internals via esbuild interop), **Cloudflare Workflows** (`WorkflowEntrypoint`, `step.do`/`step.sleep` — new to this monorepo), Cloudflare Queues (existing `commsops-broadcast`), Supabase Postgres `comms` schema via PostgREST, Resend (email). Relay app = Next.js 14 static export on `@throttle/{ui,auth,db}`.

---

## Architecture Decision Record (changes from the foundation plan)

The foundation plan (`2026-06-25-relay-phase1-foundation.md`, M7 section) listed **Workflows + Durable Objects + Queues**. After verifying the current CF Workflows API (skill `cloudflare`, `references/workflows/*`, 2026-06-26), this sub-plan **drops the Durable Object** for v1:

| Concern (orig. assigned to DO) | v1 resolution |
|---|---|
| Per-enrolment durable timer (the `wait` step) | `step.sleep(name, duration)` — native, durable to weeks, free while sleeping, doesn't count toward concurrency/step limits |
| Per-enrolment state/cursor | Workflow instance state (persisted `step.do` returns) + the `comms.enrolments` row |
| Frequency-cap / quiet-hours atomicity | Already enforced centrally in `gate.js` at every `send()` — journeys call `send()`, so they inherit it. No per-enrolment DO lock needed at v1 volume |
| Dedup of a retried send step | `messages.dedup_key` UNIQUE (existing) — `send()` already reserves+dedups |

**Net:** the only **new** wrangler binding is `[[workflows]]`. The Queue binding already exists. This is the minimal-surface, lowest-risk path and matches the canonical CF "User Lifecycle" pattern. Revisit a DO only if a future journey needs sub-`send()` rate coordination the gate can't express.

**Re-enrolment default:** `once_while_active` (skip enrol if the profile already has an `active` enrolment on this journey).

**Versioning (THE critical rule):** an enrolment is pinned to its `journey_version` at enrol time; the Workflow captures the immutable `journey_versions.definition` at start. Editing a journey publishes version N+1 and moves `active_version`; in-flight enrolments finish on their pinned version, new enrols use N+1. Editing never mutates a running flow.

---

## Pre-flight facts (verified this session — do not re-derive)

- **`comms` journey tables already exist** (migration `0001`): `journeys` (status/active_version/trigger/reenrolment), `journey_versions` (version + immutable `definition` jsonb, UNIQUE(journey_id,version)), `enrolments` (journey_version pin, status active|completed|exited|failed, current_step, context), `enrolment_steps` (append-only step log). RLS-on, service_role-only.
- **The worker entry `src/index.js` is ESM** (`export default { fetch, queue }`) but uses `require()` for internal modules — esbuild bundles the interop. Adding a `WorkflowEntrypoint` class requires `import { WorkflowEntrypoint } from 'cloudflare:workers'` (ESM). **TOP BUILD RISK:** mixing `import` (for `cloudflare:workers`) and `require` (for `./send.js` etc.) in the Workflow file. Mitigation: keep the Workflow class file's only ESM `import` the `cloudflare:workers` one; use `require()` for everything else; **dry-run before any deploy** (Task 1 Step 5).
- **`send()` signature** (`src/send.js`): `send(env, {channel, purpose, profileId, to, templateId, constants, source, dedupKey})` → `{status, reason, message_id}`. Gate-fail writes a skipped/suppressed row (never silent).
- **Queue consumer** lives in `index.js` `async queue(batch, env)` → `CAMP.processQueueMessage(env, msg.body)`. Messages today are campaign fan-out `{campaignId, after}`. We add a discriminated `{kind:'enrol', ...}`.
- **`ingest()`** (`src/ingest.js`) has the marked seam `// 4. (M7) fire journey triggers here.` after attribute derivation.
- **`compatibility_date = "2026-05-28"`** in `wrangler.toml` — well past the Workflows minimum (2024-10-22). No bump needed.
- **commsops serves nothing live until cutover** — deploying it cannot break any production system (foundation-plan deploy-safety note). Still: dry-run first; the Queue/Workflow bindings change the deploy surface.
- **No unit-test harness exists in `commsops-worker`** (M0–M6 were verified by `wrangler dev` + synthetic ingest/sends + DB SELECTs). This plan's "tests" are therefore **integration checks** in that same style — local `wrangler dev` and live synthetic events with DB verification — not a unit framework. Honor the per-task "independently verifiable" rule via those checks.

---

## File structure

```
05_Throttle/commsops-worker/
├── wrangler.toml                 # MODIFY — add [[workflows]] binding (⚠ PERMISSION GATE, Task 1)
├── src/
│   ├── index.js                  # MODIFY — export JourneyWorkflow; route journey GET/POST; queue() dispatch by kind
│   ├── journeys.js               # CREATE — journeys/versions CRUD, compile()/validate, enrol()
│   ├── journey-workflow.js       # CREATE — WorkflowEntrypoint: the generic step-graph interpreter
│   └── ingest.js                 # MODIFY — trigger fan-out: matching event → enqueue {kind:'enrol'}
└── migrations/
    └── 0008_comms_journey_seed.sql   # CREATE — checkout_started event def + abandoned-cart template + the journey+version rows

05_Throttle/apps/relay/src/app/(auth)/journeys/
└── page.js                       # MODIFY — replace placeholder with list + builder (config-driven step editor)
```

Journey **definition** JSON shape (stored in `journey_versions.definition`, immutable per version):

```json
{
  "entry": "wait1",
  "steps": {
    "wait1":  { "type": "wait",      "duration": "24 hours", "next": "cond1" },
    "cond1":  { "type": "condition", "check": { "kind": "no_event_since_enrol", "event": "order_placed" },
                "if_true": "send1", "if_false": "exit1" },
    "send1":  { "type": "send", "channel": "email", "purpose": "marketing",
                "templateId": "<uuid>", "next": "exit1" },
    "exit1":  { "type": "exit", "outcome": "completed" }
  }
}
```

Step types (v1): `wait` (duration string), `condition` (branch), `send` (channel+template), `exit` (terminal, `outcome` = completed|goal|exited). `goal` is modelled as an `exit` with `outcome:'goal'`. Each step id is unique within a definition and is used **verbatim as the Workflow step name** → deterministic across replays.

---

## Task 1: wrangler bindings + minimal Workflow class + dry-run  ⚠ PERMISSION GATE

**Files:**
- Modify: `05_Throttle/commsops-worker/wrangler.toml`
- Create: `05_Throttle/commsops-worker/src/journey-workflow.js`
- Modify: `05_Throttle/commsops-worker/src/index.js`

> **STOP — `wrangler.toml` edits require Afshaan's explicit permission (CLAUDE.md). Do not apply Step 1 until he approves the exact binding block below.** Everything else in this plan is autonomous.

- [ ] **Step 1: Add the `[[workflows]]` binding to `wrangler.toml`** (append after the existing queue consumer block)

```toml
# Journey engine (M7) — each enrolment is one durable Workflow instance.
# step.sleep handles multi-day waits with no resource cost; step.do gives
# retryable send/condition units. New infra for the monorepo (Workflows-only,
# no Durable Object — the Queue producer/consumer above is reused for enrol fan-out).
[[workflows]]
name = "commsops-journey"
binding = "JOURNEY_WORKFLOW"
class_name = "JourneyWorkflow"
```

- [ ] **Step 2: Create `src/journey-workflow.js` with a minimal interpreter skeleton** (real interpreter lands in Task 4 — this proves the binding/build first)

```javascript
// M7 journey engine — one Workflow instance per enrolment. Generic interpreter
// over the pinned, immutable journey definition. NOTE: the ONLY esm `import` in
// this file is `cloudflare:workers` (required for WorkflowEntrypoint); everything
// else uses require() to match the rest of the worker (esbuild bundles the interop).
import { WorkflowEntrypoint } from 'cloudflare:workers';

class JourneyWorkflow extends WorkflowEntrypoint {
  // params: { enrolmentId, journeyId, journeyVersion, profileId }
  async run(event, step) {
    const p = event.payload;
    await step.do('boot', async () => ({ enrolmentId: p.enrolmentId, started: true }));
    // Task 4 replaces this with the full step-graph walk.
  }
}

export { JourneyWorkflow };
```

- [ ] **Step 3: Re-export the class from `index.js`** so wrangler can resolve `class_name`. Add at the very top of `src/index.js` (after the existing `require` lines), and keep `export default {…}` as-is:

```javascript
// Workflow class must be a named export of the entry module (wrangler class_name).
export { JourneyWorkflow } from './journey-workflow.js';
```

- [ ] **Step 4: Confirm the entry stays a valid ESM module** — `index.js` now has both `export { … }` (named) and `export default { … }`. That is valid ESM. No other change.

- [ ] **Step 5: Dry-run the build (NO deploy)** — this is the make-or-break check for the import/require interop and the new binding.

Run: `cd 05_Throttle/commsops-worker && npx wrangler deploy --dry-run --outdir /tmp/commsops-dryrun`
Expected: build succeeds; output mentions the `JOURNEY_WORKFLOW` Workflow binding and the `commsops-broadcast` queue producer/consumer; **no** "Could not resolve cloudflare:workers" / "require is not defined" / mixed-format errors. If it fails on import/require mixing, convert `journey-workflow.js` internal `require`s to top-level `import` (ESM) and retry.

- [ ] **Step 6: Commit**

```bash
git -C 05_Throttle add commsops-worker/wrangler.toml commsops-worker/src/journey-workflow.js commsops-worker/src/index.js
git -C 05_Throttle commit -m "relay(m7): add Workflows binding + JourneyWorkflow skeleton (dry-run green)"
```

---

## Task 2: journeys.js — CRUD + version pinning + compile/validate

**Files:**
- Create: `05_Throttle/commsops-worker/src/journeys.js`
- Modify: `05_Throttle/commsops-worker/src/index.js` (route the new GET/POST actions)

- [ ] **Step 1: Create `src/journeys.js` with CRUD + compile**

```javascript
// Journey CRUD + versioning + step-graph validation + enrol (Task 3 adds enrol()).
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

// Validate the step graph: single declared entry, every `next`/branch target exists,
// at least one reachable exit, send steps reference an approved template. Returns
// { ok, errors:[] }.
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
  // reachability from entry → at least one exit
  const seen = new Set(); const stack = definition?.entry ? [definition.entry] : [];
  while (stack.length) {
    const id = stack.pop(); if (seen.has(id) || !steps[id]) continue; seen.add(id);
    targets(steps[id]).forEach((t) => stack.push(t));
  }
  if (![...seen].some((id) => steps[id]?.type === 'exit')) errors.push('no_reachable_exit');
  // approved templates on reachable send steps
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
```

- [ ] **Step 2: Route the actions in `index.js`** — add to `handleGet` switch:

```javascript
    case 'getJourneys': { const J = require('./journeys.js');
      return ok(await J.listJourneys(env)); }
    case 'getJourney': { const J = require('./journeys.js');
      return ok(await J.getJourney(env, url.searchParams.get('id'))); }
```

…and to `handlePost` switch (gate with the journey-build permission — reuse `campaign_build`/`segment_manage` family; use `canBuild` if defined in auth.js, else `A.has(auth.permissions,'campaign_build')`):

```javascript
    case 'saveJourney': { if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const J = require('./journeys.js'); const r = await J.saveJourney(env, body, auth.userId);
      return r.ok ? ok(r) : err(r.error, 400); }
    case 'compileJourney': { const J = require('./journeys.js');
      return ok(await J.compile(env, body.definition)); }
    case 'setJourneyStatus': { if (!A.canBuild(auth.permissions)) return err('forbidden', 403);
      const J = require('./journeys.js'); const r = await J.setJourneyStatus(env, body.id, body.status);
      return r.ok ? ok(r) : err(r.error, 400); }
```

> **Verify before writing:** open `src/auth.js` and confirm the exact permission-gate helper names (`canBuild`/`canView`/`canSuperAdmin`…) and the `A.has(...)` helper. Use the real names; do not invent `canBuild` if it isn't there — fall back to the lowest gate that includes `campaign_build`.

- [ ] **Step 3: Dry-run build**

Run: `cd 05_Throttle/commsops-worker && npx wrangler deploy --dry-run --outdir /tmp/commsops-dryrun`
Expected: build succeeds, no missing-symbol errors.

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add commsops-worker/src/journeys.js commsops-worker/src/index.js
git -C 05_Throttle commit -m "relay(m7): journeys CRUD + step-graph compile/validate + version publish"
```

---

## Task 3: enrol() + Queue dispatch + re-enrolment policy

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journeys.js` (add `enrol`)
- Modify: `05_Throttle/commsops-worker/src/index.js` (queue() dispatch by `kind`)

- [ ] **Step 1: Add `enrol()` to `journeys.js`** (export it too)

```javascript
// enrol(env, {journeyId, profileId, eventId?}) — respects re-enrolment policy,
// creates the enrolment row pinned to active_version, starts the Workflow instance.
async function enrol(env, { journeyId, profileId, eventId }) {
  const jr = await A.sbComms(`/rest/v1/journeys?id=eq.${A.enc(journeyId)}&select=*&limit=1`, env);
  const j = jr.ok && jr.data?.[0];
  if (!j || j.status !== 'active' || !j.active_version) return { ok: false, error: 'journey_not_active' };

  // re-enrolment policy
  if (j.reenrolment === 'once_while_active' || j.reenrolment === 'once_ever') {
    const statusFilter = j.reenrolment === 'once_ever' ? '' : '&status=eq.active';
    const ex = await A.sbComms(
      `/rest/v1/enrolments?journey_id=eq.${A.enc(journeyId)}&profile_id=eq.${A.enc(profileId)}${statusFilter}&select=id&limit=1`, env);
    if (ex.ok && ex.data?.length) return { ok: true, skipped: 'reenrolment_policy' };
  } else if (j.reenrolment === 'cooldown' && j.reenrol_cooldown_hours) {
    const since = new Date(Date.now() - j.reenrol_cooldown_hours * 3600e3).toISOString();
    const ex = await A.sbComms(
      `/rest/v1/enrolments?journey_id=eq.${A.enc(journeyId)}&profile_id=eq.${A.enc(profileId)}&enrolled_at=gte.${A.enc(since)}&select=id&limit=1`, env);
    if (ex.ok && ex.data?.length) return { ok: true, skipped: 'cooldown' };
  }

  const ins = await A.sbComms('/rest/v1/enrolments', env, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ journey_id: journeyId, journey_version: j.active_version, profile_id: profileId,
      status: 'active', context: { trigger_event_id: eventId || null, enrolled_at: new Date().toISOString() } }),
  });
  const enrolment = ins.data?.[0];
  if (!enrolment?.id) return { ok: false, error: 'enrolment_insert_failed' };

  // start the durable Workflow — instance id = enrolment id (unique → idempotent against double-fan-out)
  try {
    await env.JOURNEY_WORKFLOW.create({ id: enrolment.id,
      params: { enrolmentId: enrolment.id, journeyId, journeyVersion: j.active_version, profileId } });
  } catch (e) {
    // create throws on duplicate id (already started) → benign; otherwise mark failed
    if (!String(e?.message || '').toLowerCase().includes('already')) {
      await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolment.id)}`, env,
        { method: 'PATCH', body: JSON.stringify({ status: 'failed', ended_at: new Date().toISOString() }) });
      return { ok: false, error: 'workflow_start_failed:' + (e?.message || '') };
    }
  }
  return { ok: true, enrolment_id: enrolment.id };
}
```

Add `enrol` to `module.exports`.

- [ ] **Step 2: Make `queue()` in `index.js` dispatch by message kind** — replace the body of `async queue(batch, env)`:

```javascript
  async queue(batch, env) {
    const J = require('./journeys.js');
    for (const msg of batch.messages) {
      try {
        const b = msg.body || {};
        if (b.kind === 'enrol') {
          await J.enrol(env, { journeyId: b.journeyId, profileId: b.profileId, eventId: b.eventId });
        } else {
          await CAMP.processQueueMessage(env, b);   // campaign fan-out (default, back-compat)
        }
        msg.ack();
      } catch (e) {
        msg.retry();
      }
    }
  },
```

- [ ] **Step 3: Dry-run build** — `cd 05_Throttle/commsops-worker && npx wrangler deploy --dry-run --outdir /tmp/commsops-dryrun` → succeeds.

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add commsops-worker/src/journeys.js commsops-worker/src/index.js
git -C 05_Throttle commit -m "relay(m7): enrol() with re-enrolment policy + Queue kind-dispatch (enrol vs campaign)"
```

---

## Task 4: the generic Workflow interpreter

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journey-workflow.js`

- [ ] **Step 1: Replace the skeleton `run()` with the full step-graph interpreter**

```javascript
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
      return (r.ok && r.data?.[0]?.definition) || null;
    });
    if (!def?.entry || !def?.steps) { await this.#end(env, step, enrolmentId, 'failed', null); return; }

    // enrolled_at anchor (for "since enrol" conditions) — read once, deterministically.
    const enrolledAt = await step.do('load-enrolment', async () => {
      const r = await A.sbComms(`/rest/v1/enrolments?id=eq.${A.enc(enrolmentId)}&select=enrolled_at,context&limit=1`, env);
      return r.ok && r.data?.[0]?.enrolled_at;
    });

    let cur = def.entry;
    for (let i = 0; i < MAX_TRANSITIONS; i++) {
      const s = def.steps[cur];
      if (!s) { await this.#end(env, step, enrolmentId, 'failed', cur); return; }

      // step name = the definition step id (unique + stable → replay-deterministic)
      if (s.type === 'wait') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { duration: s.duration });
        await step.sleep(cur, s.duration);          // durable, free while sleeping
        cur = s.next;
      } else if (s.type === 'condition') {
        const branch = await step.do(cur, async () => this.#evalCondition(env, s.check, profileId, enrolledAt));
        await this.#logStep(env, step, enrolmentId, cur, s.type, { branch });
        cur = branch ? s.if_true : s.if_false;
      } else if (s.type === 'send') {
        const res = await step.do(cur, async () => send(env, {
          channel: s.channel || 'email', purpose: s.purpose || 'marketing', profileId,
          templateId: s.templateId, constants: s.constants || {},
          source: `journey:${enrolmentId}`, dedupKey: `journey:${enrolmentId}:${cur}`,
        }));
        await this.#logStep(env, step, enrolmentId, cur, s.type, res);
        cur = s.next;
      } else if (s.type === 'exit') {
        await this.#logStep(env, step, enrolmentId, cur, s.type, { outcome: s.outcome || 'completed' });
        await this.#end(env, step, enrolmentId,
          s.outcome === 'exited' ? 'exited' : 'completed', cur);
        return;
      } else { await this.#end(env, step, enrolmentId, 'failed', cur); return; }

      if (!cur) { await this.#end(env, step, enrolmentId, 'completed', null); return; }
    }
    await this.#end(env, step, enrolmentId, 'failed', cur);  // transition cap hit
  }

  // condition v1: "no_event_since_enrol" → true when the profile has NO matching event since enrol.
  async #evalCondition(env, check, profileId, enrolledAt) {
    if (check?.kind === 'no_event_since_enrol') {
      const r = await A.sbComms(
        `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=eq.${A.enc(check.event)}` +
        `&occurred_at=gte.${A.enc(enrolledAt)}&select=id&limit=1`, env);
      return !(r.ok && r.data?.length);   // true = NO such event → take if_true (e.g. send the nudge)
    }
    if (check?.kind === 'event_since_enrol') {
      const r = await A.sbComms(
        `/rest/v1/events?profile_id=eq.${A.enc(profileId)}&name=eq.${A.enc(check.event)}` +
        `&occurred_at=gte.${A.enc(enrolledAt)}&select=id&limit=1`, env);
      return !!(r.ok && r.data?.length);
    }
    if (check?.kind === 'attribute') {       // {kind:'attribute', attr, op:'eq'|'gt'|'lt', value}
      const r = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes&limit=1`, env);
      const v = (r.ok && r.data?.[0]?.attributes?.[check.attr]);
      if (check.op === 'gt') return Number(v) > Number(check.value);
      if (check.op === 'lt') return Number(v) < Number(check.value);
      return String(v) === String(check.value);
    }
    return false;   // unknown check → false (safe: take if_false / exit)
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
```

> **Determinism note for the implementer:** every `step.*` name is either a static literal (`load-definition`, `end:completed`) or a definition step id / `log:<id>` / `end:<status>` — all stable across replays. Do NOT introduce `Date.now()`-derived step names or branch on time outside a `step.do`. `new Date().toISOString()` is only ever called **inside** a `step.do`/`step.sleep` callback (allowed — it's part of the persisted step result), never to choose control flow.

- [ ] **Step 2: Dry-run build** — `cd 05_Throttle/commsops-worker && npx wrangler deploy --dry-run --outdir /tmp/commsops-dryrun` → succeeds; confirm no `import`/`require` interop error now that the file pulls in `./send.js` + `./auth.js`. **If it errors on mixing**, switch the two `require` lines to `import A from './auth.js'` / `import { send } from './send.js'` — but those files are CommonJS (`module.exports`), so prefer keeping `require` and, if needed, add `"type"` handling; the dry-run is the arbiter.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add commsops-worker/src/journey-workflow.js
git -C 05_Throttle commit -m "relay(m7): generic durable step-graph interpreter (wait/condition/send/exit + step log)"
```

---

## Task 5: ingest trigger fan-out

**Files:**
- Modify: `05_Throttle/commsops-worker/src/ingest.js`

- [ ] **Step 1: Replace the `// 4. (M7) fire journey triggers here.` seam** with the trigger match + enqueue

```javascript
  // 4. (M7) fire journey triggers — match ACTIVE event-triggered journeys on this
  //    event name, enqueue an enrol per match (Queue keeps ingest fast + under the
  //    subrequest limit regardless of how many journeys match). First occurrence only.
  if (!deduped) {
    try {
      const jr = await A.sbComms(
        `/rest/v1/journeys?status=eq.active&trigger->>type=eq.event&trigger->>name=eq.${A.enc(name)}&select=id,trigger`, env);
      const journeys = (jr.ok && jr.data) || [];
      for (const j of journeys) {
        // optional simple property filter: trigger.filter = {prop: value} (all must match)
        const f = j.trigger?.filter;
        if (f && typeof f === 'object' && !Object.entries(f).every(([k, v]) => String((properties || {})[k]) === String(v))) continue;
        await env.BROADCAST_QUEUE.send({ kind: 'enrol', journeyId: j.id, profileId, eventId });
      }
    } catch (e) { /* triggers are best-effort; never fail the ingest write on a trigger error */ }
  }
```

> **Verify before writing:** confirm PostgREST jsonb-path filter syntax against the deployed instance — `trigger->>type=eq.event`. If the operator form differs on this Supabase/PostgREST version, fall back to selecting `status=eq.active&trigger->>type=eq.event` only, or fetch all active journeys and match `name` in JS (cheap — few journeys). Decide via the Task 8 live check, not assumption.

- [ ] **Step 2: Dry-run build** — succeeds.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add commsops-worker/src/ingest.js
git -C 05_Throttle commit -m "relay(m7): ingest fires journey enrol via Queue on matching active event trigger"
```

---

## Task 6: seed the abandoned-cart journey (migration)

**Files:**
- Create: `05_Throttle/commsops-worker/migrations/0008_comms_journey_seed.sql`

Applied via Supabase MCP `apply_migration` (non-destructive → autonomous).

- [ ] **Step 1: Write `0008_comms_journey_seed.sql`** — checkout_started event def + an abandoned-cart email template + the journey + its v1 definition. (Template uses the existing `templates` shape: `content` = `{subject, html_body, text_body}`, `variables` array.)

```sql
-- M7 seed: abandoned-cart journey + its template + the trigger event definition.
-- Idempotent (ON CONFLICT) so re-applying is a no-op.

INSERT INTO comms.event_definitions (name, description, expected_props)
VALUES ('checkout_started', 'Shopify checkout created but not completed (abandoned-cart trigger)',
        '{"checkout_url":"string","cart_value":"number"}')
ON CONFLICT (name) DO NOTHING;

-- Abandoned-cart email template (marketing/email, active).
WITH t AS (
  INSERT INTO comms.templates (name, channel, purpose, language, status, version, content, variables, created_by)
  VALUES ('Abandoned Cart — 24h', 'email', 'marketing', 'en', 'active', 1,
    jsonb_build_object(
      'subject', 'You left something behind 🛒',
      'html_body', '<p>Hi {{first_name}},</p><p>Your cart is still waiting. Come back and finish up:</p><p><a href="{{checkout_url}}">Complete your order</a></p><p style="font-size:12px;color:#888">If you''d rather not hear from us, <a href="{{unsubscribe_url}}">unsubscribe</a>.</p>',
      'text_body', 'Hi {{first_name}}, your cart is still waiting: {{checkout_url}}'),
    jsonb_build_array(
      jsonb_build_object('token','first_name','source','profile','field','display_name','fallback','there'),
      jsonb_build_object('token','checkout_url','source','event','field','checkout_url','fallback','https://legendoftoys.com')
    ),
    'system')
  RETURNING id
),
-- The journey header (event-triggered, once_while_active).
j AS (
  INSERT INTO comms.journeys (name, status, trigger, reenrolment, created_by)
  VALUES ('Abandoned Cart', 'draft',
          jsonb_build_object('type','event','name','checkout_started'),
          'once_while_active', 'system')
  RETURNING id
)
-- v1 definition referencing the template id, and set active_version=1.
INSERT INTO comms.journey_versions (journey_id, version, definition, created_by)
SELECT j.id, 1,
  jsonb_build_object(
    'entry','wait1',
    'steps', jsonb_build_object(
      'wait1', jsonb_build_object('type','wait','duration','24 hours','next','cond1'),
      'cond1', jsonb_build_object('type','condition',
                'check', jsonb_build_object('kind','no_event_since_enrol','event','order_placed'),
                'if_true','send1','if_false','exit1'),
      'send1', jsonb_build_object('type','send','channel','email','purpose','marketing',
                'templateId',(SELECT id FROM t),'next','exit1'),
      'exit1', jsonb_build_object('type','exit','outcome','completed')
    )),
  'system'
FROM j;

UPDATE comms.journeys SET active_version = 1
WHERE name = 'Abandoned Cart' AND active_version IS NULL;
```

- [ ] **Step 2: Apply via MCP** — `apply_migration` name `0008_comms_journey_seed`. Then verify:

```sql
SELECT j.name, j.status, j.active_version, jv.definition->'entry' AS entry
FROM comms.journeys j JOIN comms.journey_versions jv ON jv.journey_id=j.id AND jv.version=j.active_version
WHERE j.name='Abandoned Cart';
```
Expected: one row, `active_version=1`, entry `"wait1"`. **Leave status `draft`** — Task 8 activates it for the live test.

- [ ] **Step 3: Commit the migration file**

```bash
git -C 05_Throttle add commsops-worker/migrations/0008_comms_journey_seed.sql
git -C 05_Throttle commit -m "relay(m7): seed abandoned-cart journey + template + checkout_started event def"
```

---

## Task 7: Relay /journeys UI

**Files:**
- Modify: `05_Throttle/apps/relay/src/app/(auth)/journeys/page.js` (replace placeholder)

Follow the exact conventions of the existing `segments/page.js` + `campaigns/page.js` (S174): `useAuth()`, `garageFetch` (GET) / `workerFetch` (POST → `{ok,data}`), `@/components/ui.js` + `redesign.css`, list↔form toggle, the standing internal-test-gate banner.

- [ ] **Step 1: Read the sibling page for conventions first**

Run: `sed -n '1,60p' 05_Throttle/apps/relay/src/app/\(auth\)/segments/page.js`
(Mirror its imports, `useAuth` perm gating, fetch helpers, and component style.)

- [ ] **Step 2: Build the journeys page** — list (name/status/active_version/trigger) + a builder that edits the definition as a small fixed **step list** (v1: the abandoned-cart shape — a `wait` duration, a `condition` event, a `send` template picker, an `exit`), Submit → `saveJourney`, plus **Activate/Pause** buttons (`setJourneyStatus`). A read-only **enrolment count** per journey (GET an aggregate or list recent enrolments) is a nice-to-have; if no count action exists, show the journey's `active_version` + status only and defer counts to the analytics page. Gate edit on the same permission the worker enforces (`campaign_build`); `relay_view` to look.

> Keep the builder **config-driven but minimal** — a full visual graph editor is explicitly out of v1 scope (foundation PRD §13). One linear wait→condition→send→exit form that round-trips the definition JSON is the target. Nested/multi-branch authoring can come later; the engine already supports arbitrary graphs.

- [ ] **Step 3: Build the Relay app**

Run: `cd 05_Throttle && npx turbo build --filter=@throttle/relay`
Expected: green build, zero errors. (CI only runs `next build`; a red build must never merge.)

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add "apps/relay/src/app/(auth)/journeys/page.js"
git -C 05_Throttle commit -m "relay(m7): /journeys list + minimal step-builder wired to commsops"
```

---

## Task 8: deploy + end-to-end live verification

**Files:** none (deploy + synthetic test).

> **Deploy-safety review (do first):** `commsops` serves no live system, but this deploy adds the `[[workflows]]` binding. Confirm the dry-run from Task 1/4 was clean. Deploy is `cd 05_Throttle/commsops-worker && npx wrangler deploy` (per CORE.md worker table). The first deploy that includes a Workflow registers the `commsops-journey` Workflow on the account.

- [ ] **Step 1: Deploy commsops**

```bash
cd 05_Throttle/commsops-worker && npx wrangler deploy
```
Expected: deploy succeeds; output lists the `JOURNEY_WORKFLOW` Workflow + `commsops-broadcast` queue bindings. Confirm with `npx wrangler workflows list` → `commsops-journey` present.

- [ ] **Step 2: Create a FAST test journey** (so the durable cycle is observable in ~1 min, not 24h). Via `apply_migration` or a one-off SQL insert: clone the abandoned-cart definition but with `wait1.duration = '45 seconds'`, name `TEST — Abandoned Cart (fast)`, `status='active'`, `active_version=1`, same `checkout_started` trigger. Use a throwaway template or the seeded one.

- [ ] **Step 3: Seed a test profile with marketing consent** (so the gate passes) — insert/resolve a profile with a deliverable internal email (e.g. afshaan@legendoftoys.com) + an `opted_in` marketing email consent row. (Reuse the M3/M5 verification approach from S170.)

- [ ] **Step 4: Fire the trigger** — POST `/ingest` (INGEST_TOKEN bearer):

```bash
curl -s -X POST https://commsops.afshaan.workers.dev/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"identifiers":[{"type":"email","value":"afshaan@legendoftoys.com"}],"name":"checkout_started","properties":{"checkout_url":"https://legendoftoys.com/checkout/abc"},"idempotency_key":"m7-test-1"}'
```
Expected: `{ok:true, profile_id, event_id, deduped:false}`.

- [ ] **Step 5: Verify enrolment started**

```sql
SELECT id, status, current_step, journey_version FROM comms.enrolments ORDER BY enrolled_at DESC LIMIT 3;
```
Expected: a new `active` enrolment on the fast journey within seconds. Also `npx wrangler workflows instances list commsops-journey` → one instance, `waiting` (sleeping).

- [ ] **Step 6: Wait out the 45s, verify the branch + send.** Since NO `order_placed` was sent, the condition is `no_event_since_enrol=true` → it should send.

```sql
SELECT step_id, step_type, result FROM comms.enrolment_steps
WHERE enrolment_id = '<id>' ORDER BY entered_at;
SELECT status, source, to_address FROM comms.messages WHERE source = 'journey:<id>';
SELECT status, current_step, ended_at FROM comms.enrolments WHERE id='<id>';
```
Expected: step log shows `wait1`→`cond1(branch=true)`→`send1`→`exit1`; one `messages` row `source='journey:<id>'` `status='sent'`; enrolment `status='completed'`. Confirm the email arrived.

- [ ] **Step 7: Verify the SUPPRESSION branch** — re-run with a SECOND fast enrolment, but this time POST an `order_placed` event for the same profile during the wait. Expected: `cond1` branch=false → `exit1` with NO send (no new `journey:` message). This proves the condition + the M5 gate path.

- [ ] **Step 8: Verify version pinning** — while an enrolment is sleeping, `saveJourney` a new definition (publish v2) on the fast journey. Expected: the in-flight enrolment completes on v1 (its `journey_version=1`, behaviour unchanged); a fresh trigger enrols on v2.

- [ ] **Step 9: Clean up test data + activate the real journey**

```sql
DELETE FROM comms.enrolments WHERE journey_id IN (SELECT id FROM comms.journeys WHERE name LIKE 'TEST —%');
DELETE FROM comms.journeys WHERE name LIKE 'TEST —%';
-- leave the real 'Abandoned Cart' journey DRAFT until Afshaan signs off the internal-test gate.
```
> **GATE:** do NOT activate the real `Abandoned Cart` journey for live customer traffic — the internal-test-only gate ([[project_relay_internal_testing_gate]]) holds until Afshaan signs off. M7 ships the engine + a verified journey in draft, not a live customer flow.

- [ ] **Step 10: Final commit / knowledge update** is handled in the session-end ritual (update `systems/relay.md` + BACKLOG [relay] + archive).

---

## M7 Definition of Done

- A `checkout_started` event enrols a matching profile via the Queue; the durable Workflow waits, branches on a later `order_placed`, and sends (or exits) — **verified live** on a fast test journey (Task 8 Steps 4–7).
- Editing a journey publishes a new version while an in-flight enrolment completes on its pinned version (Task 8 Step 8).
- Every journey send passes through the M5 `send()` gate (suppression/consent/freq-cap/quiet-hours) and logs a `messages` row + `enrolment_steps` trail.
- The `/journeys` page lists journeys and round-trips the minimal step-builder.
- The real **Abandoned Cart** journey is seeded and engine-verified but left **draft** (internal-test gate held).
- `commsops` deploys clean with the new `[[workflows]]` binding; `wrangler workflows list` shows `commsops-journey`.

---

## Self-Review (writing-plans skill)

**1. Spec coverage** (vs foundation-plan M7 section):
- wrangler Workflow/DO/Queue bindings → **Task 1** (Workflows + reused Queue; DO dropped per ADR, justified). ✓
- journeys CRUD + version pinning (publish N+1, active_version) → **Task 2** + **Task 4** (Workflow reads pinned version). ✓
- compile(definition): single entry, reachable exit, declared+approved templates → **Task 2** `compile()`. ✓
- enrol respects re-enrolment policy + starts Workflow → **Task 3** `enrol()` (once_ever/once_while_active/cooldown). ✓
- Workflow run executes steps durably; send→`send()` spine; wait→`step.sleep`; condition branches; exit ends; each transition writes `enrolment_steps` → **Task 4**. ✓
- ingest trigger fan-out → **Task 5**. ✓
- one journey (abandoned cart): checkout_started → wait 24h → no order_placed? → send/exit → **Task 6** seed + **Task 8** live proof. ✓
- per-journey-version analytics → **partial**: `enrolment_steps` + `messages.source='journey:<id>'` give the raw funnel; the `/analytics` page render is deferred (still a placeholder, called out below). The DoD's "funnel analytics render" from the foundation plan is **scoped down to data-available**; the analytics *page* is its own follow-up (it's also a placeholder for campaigns). Flagged, not silently dropped.

**2. Placeholder scan:** every code step has concrete code. Two explicit "verify before writing" notes (auth.js gate names in Task 2; PostgREST jsonb-path operator in Task 5) are deliberate runtime-fact checks against the deployed instance, not placeholders — each has a concrete fallback. No TBD/TODO.

**3. Type/contract consistency:** `enrol({journeyId, profileId, eventId})` consistent across Task 3 def + Task 5 caller. Workflow params `{enrolmentId, journeyId, journeyVersion, profileId}` consistent Task 1/3/4. Queue message `{kind:'enrol', journeyId, profileId, eventId}` consistent Task 3 dispatch + Task 5 producer. `send()` opts match the verified `src/send.js` signature. Step name = definition step id used consistently in Task 4 + matches the definition shape seeded in Task 6. `journeys.status` enum (draft|active|paused|archived) consistent Task 2/3/6/8.

**Known scope-downs (by design, flagged):** the `/analytics` funnel render (deferred — placeholder page, shared with campaigns); a full visual journey-graph builder (PRD §13 non-goal — v1 is a linear form); a Durable Object (ADR — not needed at v1); SMS/WhatsApp journey channels (channel slot exists, no adapter).
