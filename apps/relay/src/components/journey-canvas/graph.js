// Pure mapping between the canvas graph (React Flow nodes/edges) and the engine
// definition ({entry, steps:{id:{type,...,outcomes,layout}}}). CJS on purpose —
// plain `node graph.test.js` runs it; webpack interops require/module.exports fine.
//
// Reads BOTH shapes (legacy next/if_true/if_false or outcomes); ALWAYS writes the
// new outcomes shape + per-step layout + trigger_layout. The interpreter ignores
// layout keys entirely.

const TRIGGER_ID = '__trigger';
const LEGACY_HANDLES = ['next', 'if_true', 'if_false'];

// outcome handles each step type declares (spec §3 palette; wait_response added J1;
// message/collect/handoff/end are BOT-mode steps — S312, same handle discipline)
const HANDLES = {
  send: ['next'], wait: ['next'], condition: ['if_true', 'if_false'], exit: [],
  wait_response: ['responded', 'timeout'],
  message: ['next'], collect: ['next'], handoff: [], end: [],
};

// J3: an `action` node's handles are DYNAMIC by kind. Mirrors the worker's
// journey-graph.handlesFor (and bot-engine.validateBotDef for bot kinds) so canvas
// lint + edge validation match the engine.
function handlesFor(cfg) {
  if (!cfg) return [];
  if (cfg.type === 'send' && cfg.interactive) {
    const ids = Array.isArray(cfg.buttons) ? cfg.buttons.map((b) => b && b.id).filter(Boolean) : [];
    return [...ids, 'no_reply'];
  }
  // Bot-mode menu (S312): one handle per button + fallback (2 misses -> fallback path).
  if (cfg.type === 'menu') {
    const ids = Array.isArray(cfg.buttons) ? cfg.buttons.map((b) => b && b.id).filter(Boolean) : [];
    return [...ids, 'fallback'];
  }
  // Bot-mode collect (S355): a second invalid answer leaves by `fallback`, not `next`.
  if (cfg.type === 'collect') return ['next', 'fallback'];
  // Bot-mode subflow (S355): the shared flow's end returns to this step's `next`.
  if (cfg.type === 'subflow') return ['next'];
  if (cfg.type === 'action') {
    if (cfg.kind === 'payment_link') return ['next', 'failed'];
    if (cfg.kind === 'order_modify') return ['done', 'not_done'];
    if (cfg.kind === 'order_status') return ['found', 'not_found'];   // bot mode (S312)
    return ['next'];
  }
  return HANDLES[cfg.type] || [];
}

// [handle, target] for every non-empty target a step declares. Handle-aware union of
// outcomes-keys ∪ legacy handles (outcomes wins per handle) — mirrors the worker's
// journey-graph.stepTargets so a mixed-shape step (outcomes for one handle + a legacy
// field for another) never silently drops an edge on load. Pure-shape steps are unaffected.
function targetsOf(step) {
  const handles = new Set([...(step.outcomes ? Object.keys(step.outcomes) : []), ...LEGACY_HANDLES]);
  const out = [];
  for (const h of handles) {
    const t = step.outcomes && Object.prototype.hasOwnProperty.call(step.outcomes, h)
      ? step.outcomes[h] : step[h];
    if (t) out.push([h, t]);
  }
  return out;
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
    id: TRIGGER_ID, type: 'trigger', deletable: false,
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

// Monotonic suffix for duplicated node ids. Date.now() alone collides when a node is
// duplicated twice inside the same millisecond, and a duplicate id silently overwrites
// the first twin in toDefinition()'s `steps` map.
let dupSeq = 0;

// Copy of a step node with its config, DELIBERATELY unconnected (Pruthvi, #bugs
// 2026-07-15 for journeys; 2026-09-11 for bots — shared here so both builders behave
// the same). Copying the outcome edges too would silently give the source's next step
// a second inbound edge — the author wants a second variant to wire up, not a parallel
// branch they did not draw. toDefinition() derives `outcomes` purely from the edge
// list, so an unwired copy compiles as a terminal step and localLint flags its handles.
// Returns null for the trigger / chat-start anchor, which is never duplicable.
function duplicateNode(src) {
  if (!src || src.id === TRIGGER_ID) return null;
  // Reuse the SOURCE's id prefix rather than deriving one from config.type: node ids
  // are opaque keys (toDefinition writes them verbatim; only __trigger is special),
  // and the prefix came from the palette key, which type alone cannot reconstruct —
  // set_attr and order_modify both carry type 'action'.
  const prefix = String(src.id).replace(/_[a-z0-9]+$/i, '') || 'step';
  return {
    ...src,
    id: `${prefix}_${Date.now().toString(36)}${(dupSeq++).toString(36)}`,
    selected: false,
    position: { x: (src.position?.x || 0) + 48, y: (src.position?.y || 0) + 48 },
    // Deep clone: several step configs carry arrays/objects (buttons, awaited, check)
    // and a shallow copy would leave the twin sharing them, so editing one would
    // silently edit the other. Config is JSON-only by construction. Menu button ids are
    // copied verbatim on purpose — handles are per-node, and the bot engine matches a
    // tapped button against the CURRENT step's buttons only (commsops bot-engine.js, menu step).
    data: { ...src.data, config: JSON.parse(JSON.stringify(src.data?.config || {})) },
  };
}

// Cheap client-side lint (spec §3 canvas UX) — compile() on the worker stays the
// authority; this catches the obvious while the author drags things around.
// mode 'bot' (S312): the terminal requirement is a handoff/end node, not an exit,
// and the entry anchor reads as "chat start" — same TRIGGER_ID mechanism.
function localLint(nodes, edges, mode = 'journey') {
  const out = [];
  if (!edges.some((e) => e.source === TRIGGER_ID))
    out.push(mode === 'bot' ? 'chat start is not connected to a first step' : 'trigger is not connected to an entry step');
  const stepNodes = nodes.filter((n) => n.id !== TRIGGER_ID);
  if (mode === 'bot') {
    if (!stepNodes.some((n) => ['handoff', 'end'].includes(n.data?.config?.type)))
      out.push('no way out — every bot needs a Hand to agent or End chat node');
    // WhatsApp interactive limits, mirrored from the worker's compile lint (S355).
    // localLint has no channel, so these are ADVISORY for every bot — the worker
    // enforces them per channel at publish.
    for (const n of stepNodes) {
      const cfg = n.data?.config; if (cfg?.type !== 'menu') continue;
      const btns = cfg.buttons || [];
      if (cfg.style === 'list') { if (btns.length > 10) out.push(`${n.id}: a WhatsApp list holds at most 10 rows`); if (btns.some((b) => (b.label || '').length > 24)) out.push(`${n.id}: list row titles are max 24 characters on WhatsApp`); }
      else { if (btns.length > 3) out.push(`${n.id}: more than 3 buttons — switch this menu to a List`); if (btns.some((b) => (b.label || '').length > 20)) out.push(`${n.id}: button labels are max 20 characters on WhatsApp`); }
    }
  } else if (!stepNodes.some((n) => n.data?.config?.type === 'exit')) out.push('no exit node — every journey needs at least one');
  for (const n of stepNodes) {
    const declared = handlesFor(n.data?.config);
    for (const h of declared)
      if (!edges.some((e) => e.source === n.id && e.sourceHandle === h))
        out.push(`${n.id}: outcome "${h}" is not wired`);
  }
  // Waterfall check: back-to-back marketing sends (directly, or across a wait_response
  // whose responded OR timeout branch falls straight into another marketing send) risk
  // the frequency cap. Reply-then-re-send (the responded branch) is the common case.
  const configOf = (id) => stepNodes.find((s) => s.id === id)?.data?.config;
  const targetOf = (id, handle) => edges.find((e) => e.source === id && e.sourceHandle === handle)?.target;
  const isMarketingSend = (cfg) => cfg?.type === 'send' && cfg.purpose === 'marketing';
  for (const n of stepNodes) {
    const cfg = n.data?.config;
    if (!isMarketingSend(cfg)) continue;
    const nextId = targetOf(n.id, 'next');
    if (!nextId) continue;
    const nextCfg = configOf(nextId);
    const chained = nextCfg?.type === 'wait_response'
      ? ['responded', 'timeout'].map((h) => configOf(targetOf(nextId, h)))
      : [nextCfg];
    if (chained.some(isMarketingSend))
      out.push(`waterfall: consecutive marketing sends near "${n.id}" may hit the frequency cap`);
  }
  return out;
}

module.exports = { fromDefinition, toDefinition, localLint, duplicateNode, HANDLES, handlesFor, TRIGGER_ID };
