// Build a forest from flat employee nodes (id, manager_id, …).
// Roots = nodes with no manager_id (or a manager_id not present in the set).
// Cycle-safe: a node already seen is not re-attached.

export function buildOrgForest(nodes) {
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });

  const roots = [];
  const seen = new Set();
  for (const n of nodes) {
    const node = byId.get(n.id);
    const parent = n.manager_id ? byId.get(n.manager_id) : null;
    if (parent && parent.id !== n.id && !seen.has(n.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    seen.add(n.id);
  }
  // stable sort children by name
  const sortRec = (arr) => {
    arr.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    arr.forEach(c => sortRec(c.children));
  };
  sortRec(roots);
  return roots;
}

export function countDescendants(node) {
  let n = node.children.length;
  for (const c of node.children) n += countDescendants(c);
  return n;
}
