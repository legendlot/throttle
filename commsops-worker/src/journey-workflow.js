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
    // Later task replaces this with the full step-graph walk.
  }
}

export { JourneyWorkflow };
