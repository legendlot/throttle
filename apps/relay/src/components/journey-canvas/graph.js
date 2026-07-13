// Pure mapping between the canvas graph (React Flow nodes/edges) and the engine
// definition ({entry, steps:{id:{type,...,outcomes,layout}}}). CJS on purpose —
// plain `node graph.test.js` runs it; webpack interops require/module.exports fine.
//
// Reads BOTH shapes (legacy next/if_true/if_false or outcomes); ALWAYS writes the
// new outcomes shape + per-step layout + trigger_layout. The interpreter ignores
// layout keys entirely.

const TRIGGER_ID = '__trigger';

// outcome handles each J0 step type declares (spec §3 palette)
const HANDLES = { send: ['next'], wait: ['next'], condition: ['if_true', 'if_false'], exit: [] };

function targetsOf(step) {
  if (step.outcomes) return Object.entries(step.outcomes).filter(([, t]) => t);
  return ['next', 'if_true', 'if_false']
    .filter((h) => step[h])
    .map((h) => [h, step[h]]);
}

// BFS depth from entry → column; discovery order within a column → row.
function autoPositions(def) {
  const pos = { [TRIGGER_ID]: { x: 40, y: 160 } };
  const colCount = {};
  const seen = new Set();
  const q = def.entry ? [[def.entry, 1]] : [];
  while (q.length) {
    const [id, col] = q.shift();
    if (seen.has(id) || !def.steps[id]) continue;
    seen.add(id);
    const row = (colCount[col] = (colCount[col] || 0) + 1);
    pos[id] = { x: 40 + col * 290, y: 40 + row * 130 };
    targetsOf(def.steps[id]).forEach(([, t]) => q.push([t, col + 1]));
  }
  // orphans (unreachable steps) — park them in a bottom row so they're visible
  let orphan = 0;
  for (const id of Object.keys(def.steps || {}))
    if (!pos[id]) pos[id] = { x: 40 + ++orphan * 290, y: 560 };
  return pos;
}

// (journey, definition|null) → { nodes, edges } for React Flow.
function fromDefinition(journey, def) {
  const d = def && def.steps ? def : { entry: null, steps: {} };
  const auto = autoPositions(d);
  const nodes = [{
    id: TRIGGER_ID, type: 'trigger',
    position: d.trigger_layout || auto[TRIGGER_ID],
    data: { trigger: (journey && journey.trigger) || {} },
  }];
  const edges = [];
  if (d.entry && d.steps[d.entry]) {
    edges.push({ id: `e:${TRIGGER_ID}->${d.entry}`, source: TRIGGER_ID, sourceHandle: 'entry', target: d.entry });
  }
  for (const [id, s] of Object.entries(d.steps)) {
    const { outcomes, layout, next, if_true, if_false, ...config } = s;
    nodes.push({ id, type: 'step', position: layout || auto[id], data: { config } });
    for (const [handle, target] of targetsOf(s)) {
      edges.push({ id: `e:${id}:${handle}`, source: id, sourceHandle: handle, target });
    }
  }
  return { nodes, edges };
}

// (nodes, edges) → definition in the NEW shape. Throws on structural impossibilities
// the lint should have caught (no entry edge) so callers can't save garbage.
function toDefinition(nodes, edges) {
  const entryEdge = edges.find((e) => e.source === TRIGGER_ID);
  if (!entryEdge) throw new Error('no_entry_edge');
  const steps = {};
  let trigger_layout = null;
  for (const n of nodes) {
    if (n.id === TRIGGER_ID) { trigger_layout = { x: Math.round(n.position.x), y: Math.round(n.position.y) }; continue; }
    const outcomes = {};
    for (const e of edges) if (e.source === n.id && e.sourceHandle) outcomes[e.sourceHandle] = e.target;
    steps[n.id] = {
      ...n.data.config,
      ...(Object.keys(outcomes).length ? { outcomes } : {}),
      layout: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    };
  }
  return { entry: entryEdge.target, steps, ...(trigger_layout ? { trigger_layout } : {}) };
}

// Cheap client-side lint (spec §3 canvas UX) — compile() on the worker stays the
// authority; this catches the obvious while the author drags things around.
function localLint(nodes, edges) {
  const out = [];
  if (!edges.some((e) => e.source === TRIGGER_ID)) out.push('trigger is not connected to an entry step');
  const stepNodes = nodes.filter((n) => n.id !== TRIGGER_ID);
  if (!stepNodes.some((n) => n.data?.config?.type === 'exit')) out.push('no exit node — every journey needs at least one');
  for (const n of stepNodes) {
    const declared = HANDLES[n.data?.config?.type] || [];
    for (const h of declared)
      if (!edges.some((e) => e.source === n.id && e.sourceHandle === h))
        out.push(`${n.id}: outcome "${h}" is not wired`);
  }
  return out;
}

module.exports = { fromDefinition, toDefinition, localLint, HANDLES, TRIGGER_ID };
