// Which nav item's route best-prefix-matches the current pathname (longest wins).
// Shared by the Sidebar (active section/item) and ContextBar (breadcrumb + tabs).
export function matchActive(groups, pathname) {
  let best = null, bestLen = -1;
  for (const g of groups) {
    const items = g.flat ? [{ route: g.route, id: g.id, label: g.label }] : (g.items || []);
    for (const it of items) {
      if (!it.route) continue;
      const hit = pathname === it.route || pathname.startsWith(it.route + '/');
      if (hit && it.route.length > bestLen) { best = { group: g, item: it }; bestLen = it.route.length; }
    }
  }
  return best;
}
