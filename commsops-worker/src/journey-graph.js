// Pure step-graph helpers shared by compile() (journeys.js) and the Workflow
// interpreter (journey-workflow.js) so validator and runtime can't drift.
//
// J0 schema generalization: a step's targets live EITHER in the legacy fields
// (next / if_true / if_false) OR in the generalized `outcomes: {<handle>: <stepId>}`
// map. `outcomes` wins when both exist. Interpreter must keep reading BOTH shapes
// forever — in-flight enrolments are pinned to old-shape immutable versions.

const LEGACY_HANDLES = ['next', 'if_true', 'if_false'];

// The step's target for a named outcome handle, or null.
function resolveTarget(step, handle) {
  if (!step) return null;
  if (step.outcomes && Object.prototype.hasOwnProperty.call(step.outcomes, handle))
    return step.outcomes[handle] || null;
  if (LEGACY_HANDLES.includes(handle)) return step[handle] || null;
  return null;
}

// Outcome handles a step declares, DYNAMIC per step (J3): an `action` node's handles
// depend on its kind (interactive buttons / action kinds are data, not fixed). Compile,
// interpreter, and the canvas all read handles through here so they can't drift.
function handlesFor(step) {
  if (!step) return [];
  if (step.type === 'action') {
    if (step.kind === 'payment_link') return ['next', 'failed'];
    return ['next']; // set_attr (and any future no-branch action) → next
  }
  return HANDLES[step.type] || [];
}

// Every non-empty target the step declares (for reachability / dangling checks).
// Handle-aware: each handle resolves through resolveTarget so a mixed-shape step
// (outcomes for one handle + a legacy field for another) validates exactly the
// targets the runtime will follow — no validator/runtime drift.
function stepTargets(step) {
  if (!step) return [];
  const handles = new Set([...(step.outcomes ? Object.keys(step.outcomes) : []), ...LEGACY_HANDLES, ...handlesFor(step)]);
  return [...handles].map((h) => resolveTarget(step, h)).filter(Boolean);
}

// Which identifier type a journey send must resolve for a channel (spec §4.2 —
// #doSend previously hardcoded email; WA/SMS/voice sends need the phone identifier).
const ID_TYPE_FOR_CHANNEL = { email: 'email', whatsapp: 'phone', sms: 'phone', voice: 'phone' };

// Outcome handles each step type declares (kept in sync with the app's graph.js HANDLES).
// wait_response is the J1 escalation gate: responded (awaited event arrived) vs timeout.
const HANDLES = {
  send: ['next'], wait: ['next'], condition: ['if_true', 'if_false'],
  wait_response: ['responded', 'timeout'], exit: [],
};

// Internal step names the interpreter uses as step.do/step names — never valid user ids.
const RESERVED_STEP_IDS = [
  'load-definition', 'load-enrolment', 'load-trigger', 'load-journey-name', 'load-journey-cfg',
  'boot', 'register-waits', 'clear-waits',
];

// Parse a human duration string ("6 hours", "30 minutes", "2 days", "90 seconds")
// to milliseconds. Returns null on anything unrecognised. Used for expires_at math;
// the durable wait itself passes the raw string to step.waitForEvent (all waits are
// interruptible waitForEvent now — step.sleep is no longer used by the interpreter).
const _UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
function durationToMs(str) {
  const m = String(str || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * _UNIT_MS[m[2]]);
}

// Did a send() result actually leave the building? (vs a gate skip/suppression/failure)
function sendWentOut(res) {
  return !!res && (res.status === 'sent' || res.status === 'delivered' || res.status === 'deduped');
}

// Decide where a send step goes after send() returns, honoring on_skip (spec §4.2).
//  - sent/delivered/deduped → plain 'next'.
//  - skipped/suppressed/failed with on_skip:
//      'continue' (default) → plain 'next' (customer not re-targeted on another leg either).
//      'exit'               → terminate with on_skip_outcome (default 'skipped').
//      'advance'            → skip the pointless downstream wait: if 'next' is a wait_response,
//                             jump to ITS 'timeout' target (the next channel) and report skippedWait.
// Returns { next } | { next, skippedWait } | { terminate }.
function resolveSendNext(step, res, def) {
  const plainNext = resolveTarget(step, 'next');
  if (sendWentOut(res)) return { next: plainNext };
  const policy = step.on_skip || 'continue';
  if (policy === 'exit') return { terminate: step.on_skip_outcome || 'skipped' };
  if (policy === 'advance') {
    const nx = def.steps && def.steps[plainNext];
    if (nx && nx.type === 'wait_response') return { next: resolveTarget(nx, 'timeout'), skippedWait: plainNext };
  }
  return { next: plainNext };
}

module.exports = { resolveTarget, stepTargets, handlesFor, ID_TYPE_FOR_CHANNEL, HANDLES, RESERVED_STEP_IDS, durationToMs, sendWentOut, resolveSendNext };
