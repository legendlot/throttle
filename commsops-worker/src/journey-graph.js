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
function stepTargets(step) {
  if (!step) return [];
  if (step.outcomes) return Object.values(step.outcomes).filter(Boolean);
  return LEGACY_HANDLES.map((h) => step[h]).filter(Boolean);
}

// Which identifier type a journey send must resolve for a channel (spec §4.2 —
// #doSend previously hardcoded email; WA/SMS/voice sends need the phone identifier).
const ID_TYPE_FOR_CHANNEL = { email: 'email', whatsapp: 'phone', sms: 'phone', voice: 'phone' };

module.exports = { resolveTarget, stepTargets, ID_TYPE_FOR_CHANNEL };
