// The tool registry. One file per LOT system; this file only lists them.
// A tool: { system (mcp_access grant it needs, null = everyone), name, title, description, inputSchema,
//   annotations, needsSession, visible?(gate) → bool, deny?(gate) → refusal reason | null,
//   parse(args, nowMs) → { ok, value } | { ok:false, error }, run({ env, sbAccess, gate, input }) →
//   { ok, data } | { ok:false, reason } | { ok:false, userError } }.
import core from './core.js';
import odo from './odo.js';
import docket from './docket.js';
import snorkel from './snorkel.js';
import ops from './ops.js';

export const TOOLS = [...core, ...odo, ...docket, ...snorkel, ...ops];

const names = new Set();
for (const t of TOOLS) {
  if (names.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
  names.add(t.name);
}

// What a person sees in tools/list: tools for systems they are granted, and that their role can use.
export function toolsFor(gate) {
  const systems = (gate && Array.isArray(gate.systems)) ? gate.systems : [];
  return TOOLS
    .filter(t => t.system === null || systems.includes(t.system))
    .filter(t => !t.visible || t.visible(gate))
    .map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
}
export const findTool = name => TOOLS.find(t => t.name === name) || null;
