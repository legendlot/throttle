// F9 R9a — plan templates (spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §11). Pure helpers for
// /plan/templates: the editor's node list, the SHAPE rules (a copy of docket.plan_template_save's checks — the
// contract's B1 — so the editor blocks what the RPC would refuse; change both together), the apply preview,
// and the user-facing error text. The RPC stays the authority: anything it still refuses arrives as a code.
import { addDays, isDateStr } from './weeks.js';
import { planErrorText } from './plan.js';

export const AUDIENCES = ['founders', 'leads'];
export const NODE_KINDS = ['milestone', 'result', 'task'];
export const LIMITS = Object.freeze({ name: 120, description: 2000, title: 300, role: 40, done_when: 2000,
  nodes: 200, depth: 3, offset_min: -365, offset_max: 730 });
export const AUDIENCE_LABEL = { founders: 'Founders — under a theme', leads: 'Leads — under a milestone' };
export const KIND_LABEL = { milestone: 'Milestone', result: 'Result', task: 'Task' };

// What may be added under a parent (null = a root), per audience (B1).
//   founders: roots milestone; result under a milestone; task under a milestone or result.
//   leads:    roots result or task; task under a result. Tasks never have children.
export function childKinds(audience, parentKind = null) {
  if (audience === 'founders') {
    if (!parentKind) return ['milestone'];
    if (parentKind === 'milestone') return ['result', 'task'];
    if (parentKind === 'result') return ['task'];
    return [];
  }
  if (audience === 'leads') {
    if (!parentKind) return ['result', 'task'];
    if (parentKind === 'result') return ['task'];
    return [];
  }
  return [];
}

const trim = (s) => String(s ?? '').trim();
export const roleKey = (label) => trim(label).toLowerCase();

// Distinct role labels, first spelling kept, in node order (B1: case-insensitive, trimmed).
export function templateRoles(nodes = []) {
  const m = new Map();
  for (const n of nodes || []) { const k = roleKey(n?.role_label); if (k && !m.has(k)) m.set(k, trim(n.role_label)); }
  return [...m.values()];
}

// The nested order: siblings by sort then their place in the array. → [{ node, depth }]
export function orderedNodes(nodes = []) {
  const list = (nodes || []).filter(Boolean);
  const keys = new Set(list.map(n => n.key));
  const kids = new Map();
  list.forEach((n, i) => {
    const p = n.parent_key && keys.has(n.parent_key) ? n.parent_key : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push({ n, i });
  });
  for (const arr of kids.values()) arr.sort((a, b) => (Number(a.n.sort) || 0) - (Number(b.n.sort) || 0) || a.i - b.i);
  const out = [], seen = new Set();
  const walk = (p, depth) => {
    for (const { n } of kids.get(p) || []) {
      if (seen.has(n.key)) continue;
      seen.add(n.key);
      out.push({ node: n, depth });
      walk(n.key, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// ── the shape check (B1) ────────────────────────────────────────────────────
// → { ok, form: [{ field, code }], nodes: { [key]: [code…] } }. Codes are the RPC's.
export function validateTemplate(t = {}) {
  const form = [], nodeErr = {};
  const bad = (key, code) => { (nodeErr[key] = nodeErr[key] || []).includes(code) || nodeErr[key].push(code); };
  const name = trim(t.name);
  if (!name) form.push({ field: 'name', code: 'name_required' });
  else if (name.length > LIMITS.name) form.push({ field: 'name', code: 'name_too_long' });
  if (String(t.description ?? '').length > LIMITS.description) form.push({ field: 'description', code: 'description_too_long' });
  if (!AUDIENCES.includes(t.audience)) form.push({ field: 'audience', code: 'bad_audience' });
  const nodes = (t.nodes || []).filter(Boolean);
  if (nodes.length > LIMITS.nodes) form.push({ field: 'nodes', code: 'too_many_nodes' });

  const byKey = new Map();
  for (const n of nodes) {
    if (!n.key || byKey.has(n.key)) { bad(n.key || '?', 'duplicate_key'); continue; }
    byKey.set(n.key, n);
  }
  const hasKids = new Set(nodes.filter(n => n.parent_key).map(n => n.parent_key));
  for (const n of byKey.values()) {
    const k = n.key;
    if (!NODE_KINDS.includes(n.kind)) { bad(k, 'bad_node'); continue; }
    const title = trim(n.title);
    if (!title || title.length > LIMITS.title) bad(k, 'bad_node');
    const role = trim(n.role_label);
    if (!role) bad(k, 'role_required');
    else if (role.length > LIMITS.role) bad(k, 'bad_node');
    const off = n.offset_days;
    if (off === '' || off == null || !Number.isInteger(Number(off)) || Number(off) < LIMITS.offset_min || Number(off) > LIMITS.offset_max) bad(k, 'bad_offset');
    if (String(n.done_when ?? '').length > LIMITS.done_when) bad(k, 'bad_node');
    // shape: the parent's kind must allow this kind; depth ≤ 3; no cycles
    let parentKind = null;
    if (n.parent_key) {
      const p = byKey.get(n.parent_key);
      if (!p) { bad(k, 'bad_shape'); continue; }
      parentKind = p.kind;
    }
    if (!childKinds(t.audience, parentKind).includes(n.kind)) bad(k, 'bad_shape');
    let depth = 1, cur = n, hops = 0;
    while (cur.parent_key && hops <= LIMITS.nodes) { cur = byKey.get(cur.parent_key); if (!cur) break; depth++; hops++; if (cur.key === k) { depth = Infinity; break; } }
    if (depth > LIMITS.depth) bad(k, 'bad_shape');
    // done_when: every result; a milestone that has children (it is created agreed)
    if (n.kind === 'result' && !trim(n.done_when)) bad(k, 'done_when_required');
    if (n.kind === 'milestone' && hasKids.has(k) && !trim(n.done_when)) bad(k, 'done_when_required');
  }
  return { ok: form.length === 0 && Object.keys(nodeErr).length === 0, form, nodes: nodeErr };
}

// ── editor operations (pure; the page keeps the array) ──────────────────────
let seq = 0;
export function newKey() { seq += 1; return `n${Date.now().toString(36)}${seq}`; }
const siblings = (nodes, parentKey) => nodes.filter(n => (n.parent_key || null) === (parentKey || null));
export function addNode(nodes = [], parentKey, kind, key = newKey()) {
  const sib = siblings(nodes, parentKey);
  const sort = sib.length ? Math.max(...sib.map(n => Number(n.sort) || 0)) + 10 : 10;
  const parent = parentKey ? nodes.find(n => n.key === parentKey) : null;
  return [...nodes, { key, parent_key: parentKey || null, kind, title: '', role_label: parent?.role_label || '',
    offset_days: parent ? Number(parent.offset_days) || 0 : 0, done_when: '', sort }];
}
// Removes the node and everything under it.
export function removeNode(nodes = [], key) {
  const drop = new Set([key]);
  let grew = true;
  while (grew) { grew = false; for (const n of nodes) if (n.parent_key && drop.has(n.parent_key) && !drop.has(n.key)) { drop.add(n.key); grew = true; } }
  return nodes.filter(n => !drop.has(n.key));
}
export function updateNode(nodes = [], key, patch) { return nodes.map(n => (n.key === key ? { ...n, ...patch } : n)); }
// Up / down within its parent; siblings renumbered 10, 20, …
export function moveNode(nodes = [], key, dir) {
  const me = nodes.find(n => n.key === key);
  if (!me) return nodes;
  const sib = orderedNodes(nodes).map(x => x.node).filter(n => (n.parent_key || null) === (me.parent_key || null));
  const i = sib.findIndex(n => n.key === key), j = i + dir;
  if (i < 0 || j < 0 || j >= sib.length) return nodes;
  [sib[i], sib[j]] = [sib[j], sib[i]];
  const sort = new Map(sib.map((n, x) => [n.key, (x + 1) * 10]));
  return nodes.map(n => (sort.has(n.key) ? { ...n, sort: sort.get(n.key) } : n));
}

// getTemplate nodes → editor nodes; editor nodes → the saveTemplate body (sort = the nested order).
export function fromServerNodes(nodes = []) {
  return (nodes || []).filter(Boolean).map(n => ({ key: n.id, parent_key: n.parent_node_id || null, kind: n.kind, title: n.title || '',
    role_label: n.role_label || '', offset_days: n.offset_days ?? 0, done_when: n.done_when || '', sort: Number(n.sort) || 0 }));
}
export function toSaveBody(t = {}) {
  const ordered = orderedNodes(t.nodes);
  const idx = new Map();
  return {
    ...(t.id ? { id: t.id } : {}),
    name: trim(t.name), description: trim(t.description) || null, audience: t.audience,
    nodes: ordered.map(({ node: n }) => {
      const p = n.parent_key || null;
      const s = (idx.get(p) || 0) + 1; idx.set(p, s);
      const out = { key: n.key, parent_key: p, kind: n.kind, title: trim(n.title), role_label: trim(n.role_label),
        offset_days: Number(n.offset_days), sort: s * 10 };
      if (trim(n.done_when)) out.done_when = trim(n.done_when);
      return out;
    }),
  };
}

// ── apply ───────────────────────────────────────────────────────────────────
export function nodeDate(anchorDate, offset) {
  return isDateStr(anchorDate) && Number.isInteger(Number(offset)) ? addDays(anchorDate, Number(offset)) : null;
}
export function dayHint(offset) {
  const n = Number(offset);
  if (!Number.isInteger(n)) return '';
  return n === 0 ? 'the anchor day' : n > 0 ? `day ${n} after` : `${-n} day${n === -1 ? '' : 's'} before`;
}
// Every node with its depth, computed date and the person its role maps to (roles: { label: employee id }).
export function applyPreview(nodes = [], anchorDate, roles = {}, employees = []) {
  const byRole = new Map(Object.entries(roles || {}).map(([l, id]) => [roleKey(l), id]));
  const name = new Map((employees || []).map(e => [e.id, e.full_name]));
  return orderedNodes(nodes.map(n => (n.key ? n : { ...n, key: n.id, parent_key: n.parent_node_id || null }))).map(({ node, depth }) => {
    const emp = byRole.get(roleKey(node.role_label)) || null;
    return { key: node.key, kind: node.kind, title: node.title, depth, role_label: node.role_label || '',
      date: node.offset_days == null ? null : nodeDate(anchorDate, node.offset_days), employee_id: emp, person: emp ? (name.get(emp) || null) : null };
  });
}
// The applyTemplate body; null while a role has no person or the date is bad.
export function applyBody(templateId, { anchorId, anchorDate, roles = {}, labels = [], spaceId = '' } = {}) {
  if (!templateId || !anchorId || !isDateStr(anchorDate)) return null;
  const out = {};
  for (const l of labels) { const id = roles[l]; if (!id) return null; out[l] = id; }
  return { id: templateId, anchor_id: anchorId, anchor_date: anchorDate, roles: out, ...(spaceId ? { space_id: spaceId } : {}) };
}
// P3b: the spaces a template's tasks can land in (live ones the caller can open, never General) and the default —
// the caller's team's home space if they can open it, else their Personal space.
export function applySpaces(spaces = [], myDepartmentId = null) {
  // Never General; never the Founders' space (a restricted theme puts them there on its own — review #9).
  const opts = (spaces || []).filter(s => s && s.is_private && !s.is_founders)
    .map(s => ({ value: s.id, label: s.is_personal ? 'Personal (only you)' : s.name, home: s.home_department_id || null, personal: !!s.is_personal }));
  const def = (myDepartmentId && opts.find(o => o.home === myDepartmentId)) || opts.find(o => o.personal) || null;
  return { options: opts.map(({ value, label }) => ({ value, label })), defaultId: def ? def.value : '' };
}
export function spanText(span) {
  if (!span || span.min_offset == null || span.max_offset == null) return '';
  const a = Number(span.min_offset), b = Number(span.max_offset);
  return a === b ? `day ${a}` : `day ${a} → ${b}`;
}

// Nav (§C): "Templates" shows when the caller may create one, or can see any (getTemplates).
export function showTemplatesNav(d) {
  return !!(d && (d.can_create?.founders || d.can_create?.leads || (Array.isArray(d.templates) && d.templates.length > 0)));
}

// ── errors (save / archive / apply) → words, never a code ───────────────────
const TEMPLATE_ERR = {
  forbidden: 'You can’t do that with this template.',
  not_found: 'That template isn’t available to you.',
  archived: 'This template is archived — unarchive it first.',
  name_required: 'Give the template a name.',
  name_too_long: `Keep the name under ${LIMITS.name} characters.`,
  description_too_long: `Keep the description under ${LIMITS.description} characters.`,
  bad_audience: 'Pick who the template is for.',
  bad_node: 'Every step needs a title (and nothing too long).',
  bad_shape: 'That step can’t sit there — check what it’s under.',
  too_many_nodes: `A template can hold at most ${LIMITS.nodes} steps.`,
  done_when_required: 'Add “done when” — every result, and any milestone with steps under it, needs one.',
  role_required: 'Give every step a role (e.g. “Lead”, “Designer”).',
  bad_offset: `Days must be a whole number from ${LIMITS.offset_min} to ${LIMITS.offset_max}.`,
  duplicate_key: 'Two steps clash — remove one and add it again.',
  bad_anchor: 'Pick an agreed item to apply it under.',
  anchor_not_found: 'That item isn’t one you can apply a template under.',
  role_unmapped: 'Pick a person for every role.',
  owner_inactive: 'One of the people picked is no longer active.',
  bad_role: 'A role in the request isn’t one this template uses — reload and try again.',
  bad_date: 'Pick a valid anchor date.',
  bad_source: 'Something went wrong — try again.',
  forbidden_space: 'You can’t add tasks to that space — nothing was created.',
  founders_space_missing: 'There’s no Founders’ space to put these tasks in — ask an admin.',
};
export function templateErrorText(e, { nodeTitle } = {}) {
  const code = e?.message || String(e || '');
  const d = e?.detail || {};
  // An apply aborted inside plan_create returns plan_create's own code — word it the plan way when known.
  const plan = code ? planErrorText(e) : '';
  const base = TEMPLATE_ERR[code] || (plan && plan !== code ? plan : (code ? 'That didn’t go through — nothing was changed.' : 'Something went wrong.'));
  if (d.label && (code === 'role_unmapped' || code === 'owner_inactive' || code === 'bad_role')) return `${base} (role “${d.label}”)`;
  const t = d.key && nodeTitle ? nodeTitle(d.key) : '';
  return t ? `${base} (“${t}”)` : base;
}
export function errorCodeText(code) { return TEMPLATE_ERR[code] || 'Check this step.'; }
