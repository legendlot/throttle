// Tools every signed-in person gets (no system grant needed). No business data.
const whoami = {
  system: null,
  name: 'whoami',
  title: 'Who am I connected as',
  description: 'Shows which LOT account this Claude is connected as and which LOT systems that account has been granted. Returns no business data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  needsSession: false,
  parse: () => ({ ok: true, value: {} }),
  run: async ({ gate }) => ({ ok: true, data: { connected_as: gate.email, name: gate.full_name, systems_granted: gate.systems } }),
};
export default [whoami];
