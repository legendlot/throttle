// F9 R9a — plan templates (spec §11; migration 0028): the list row and the node view. Pure; no I/O. Rights and
// shape live in the docket.plan_template_* RPCs; the worker decides which templates a caller may see at all
// (a plan admin: every one; a lead: `leads` ones; anyone else: none) before these run.

// Distinct role labels (trimmed, compared case-insensitively; the first spelling wins), sorted.
export function templateRoles(nodes = []) {
  const seen = new Map();
  for (const n of nodes) {
    const l = String(n.role_label || '').trim();
    if (l && !seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
// { min_offset, max_offset } over the nodes (null when there are none).
export function templateSpan(nodes = []) {
  const offs = nodes.map(n => Number(n.offset_days)).filter(Number.isFinite);
  return offs.length ? { min_offset: Math.min(...offs), max_offset: Math.max(...offs) } : { min_offset: null, max_offset: null };
}
// The list / header row. `acc` = { isSuper }; can_edit = a plan admin, or the creator (the RPC decides the rest).
export function templateListRow(t, nodes = [], { names = {}, auth = {}, acc = {} } = {}) {
  const mine = !!auth.userId && t.created_by === auth.userId;
  return { id: t.id, name: t.name, description: t.description || null, audience: t.audience, node_count: nodes.length,
    roles: templateRoles(nodes), span: templateSpan(nodes), created_by_name: names[t.created_by] || null, mine,
    can_edit: !!acc.isSuper || mine, can_apply_kind: t.audience === 'founders' ? 'theme' : 'milestone', archived: !!t.archived_at };
}
// Editors get every field; anyone else the PREVIEW — titles and the shape only (spec "Previews show only node titles").
export function templateNodesFor(nodes = [], canEdit = false) {
  return nodes.map(n => (canEdit
    ? { id: n.id, parent_node_id: n.parent_node_id || null, kind: n.kind, title: n.title, role_label: n.role_label,
        offset_days: n.offset_days, done_when: n.done_when || null, sort: n.sort ?? 0 }
    : { id: n.id, parent_node_id: n.parent_node_id || null, kind: n.kind, title: n.title }));
}
