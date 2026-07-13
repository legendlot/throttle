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

// Every non-empty target the step declares (for reachability / dangling checks).
// Handle-aware: each handle resolves through resolveTarget so a mixed-shape step
// (outcomes for one handle + a legacy field for another) validates exactly the
// targets the runtime will follow — no validator/runtime drift.
function stepTargets(step) {
  if (!step) return [];
  const handles = new Set([...(step.outcomes ? Object.keys(step.outcomes) : []), ...LEGACY_HANDLES]);
  return [...handles].map((h) => resolveTarget(step, h)).filter(Boolean);
}

// Which identifier type a journey send must resolve for a channel (spec §4.2 —
// #doSend previously hardcoded email; WA/SMS/voice sends need the phone identifier).
const ID_TYPE_FOR_CHANNEL = { email: 'email', whatsapp: 'phone', sms: 'phone', voice: 'phone' };

module.exports = { resolveTarget, stepTargets, ID_TYPE_FOR_CHANNEL };
