// Docket shell route model (ClickUp redesign P1). One place that turns the current
// route into: the rail item that's active, the sidebar row that's active, and the
// top-bar breadcrumb. Pure — the (auth) layout feeds it the route + getMe data.
//
// Replaces buildNavGroups/NAV_GROUPS (the pre-S113 nav shape; it had no importers left).

// next.config has `trailingSlash: true`, so usePathname() can return '/tasks/' —
// every `pathname === '/tasks'` check used to miss, which is why the old topbar
// fell through to "Docket" on every page. Normalise once, here.
export function normPath(pathname) {
  const p = String(pathname || '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export const ADMIN_ITEMS = [
  { key: '/admin/roles',  label: 'Roles & permissions' },
  { key: '/admin/users',  label: 'Users' },
  { key: '/admin/spaces', label: 'Spaces' },
];

// `search` is a URLSearchParams-like (.get). Returns:
//   path      normalised pathname
//   activeKey the sidebar row key ('/tasks', '/tasks?space=<id>', '/tasks?program=<id>', '/tasks?lens=mine', or the path)
//   railKey   'tasks' | 'mine' | 'checklist' | 'scratchpad' | 'dashboard' | 'manual' | 'admin' | ''
//   crumbs    [{ label, href?, lock? }] — the last one is the current page
//   showCount whether the page publishes a task count (the board views)
//   spaceId   the real ?space id ('' for none / 'new')
export function routeModel(pathname, search, { spaces = [], programs = [] } = {}) {
  const path = normPath(pathname);
  const spaceParam = search?.get?.('space') || '';
  const spaceId = spaceParam && spaceParam !== 'new' ? spaceParam : '';
  const programId = search?.get?.('program') || '';
  const lens = search?.get?.('lens') || '';
  const spaceName = (id) => (spaces || []).find(s => s.id === id)?.name;
  const space = spaceId ? (spaces || []).find(s => s.id === spaceId) : null;

  if (path === '/tasks') {
    if (programId) {
      const p = (programs || []).find(x => x.id === programId);
      return { path, spaceId, activeKey: `/tasks?program=${programId}`, railKey: 'tasks', showCount: true,
        crumbs: [{ label: 'Programs' }, { label: p?.name || 'Program' }] };
    }
    // ?space=<General's id> is the General board, not a private space.
    if (spaceId && space && !space.is_private) {
      return { path, spaceId, activeKey: '/tasks', railKey: 'tasks', showCount: true,
        crumbs: [{ label: 'Tasks', href: '/tasks' }, { label: space.name || 'General' }] };
    }
    if (spaceId) {
      return { path, spaceId, activeKey: `/tasks?space=${spaceId}`, railKey: 'tasks', showCount: true,
        crumbs: [{ label: 'Tasks', href: '/tasks' }, { label: space?.name || 'Space', lock: space ? !!space.is_private : true }] };
    }
    if (lens === 'stale') {
      return { path, spaceId, activeKey: '/tasks?lens=mine', railKey: 'mine', showCount: true,
        crumbs: [{ label: 'My tasks', href: '/tasks?lens=mine' }, { label: 'Clean up' }] };
    }
    if (lens === 'mine') {
      return { path, spaceId, activeKey: '/tasks?lens=mine', railKey: 'mine', showCount: true, crumbs: [{ label: 'My tasks' }] };
    }
    return { path, spaceId, activeKey: '/tasks', railKey: 'tasks', showCount: true,
      crumbs: [{ label: 'Tasks', href: '/tasks' }, { label: 'General' }] };
  }
  const base = { path, spaceId, activeKey: path, showCount: false };
  if (path.startsWith('/tasks/detail')) return { ...base, railKey: 'tasks', crumbs: [{ label: 'Tasks', href: '/tasks' }, { label: 'Task' }] };
  if (path.startsWith('/tasks/new'))    return { ...base, railKey: 'tasks', crumbs: [{ label: 'Tasks', href: '/tasks' }, { label: 'New task' }] };
  if (path === '/checklist')  return { ...base, railKey: 'checklist',  crumbs: [{ label: 'Checklist' }] };
  if (path === '/scratchpad') return { ...base, railKey: 'scratchpad', crumbs: [{ label: 'Scratchpad' }] };
  if (path === '/manual')     return { ...base, railKey: 'manual',     crumbs: [{ label: 'Manual' }] };
  if (path === '/dashboard') {
    return { ...base, railKey: 'dashboard', crumbs: spaceId
      ? [{ label: 'Dashboard', href: '/dashboard' }, { label: spaceName(spaceId) || 'Space' }]
      : [{ label: 'Dashboard' }] };
  }
  if (path.startsWith('/admin')) {
    const item = ADMIN_ITEMS.find(a => path === a.key || path.startsWith(a.key + '/'));
    return { ...base, railKey: 'admin', crumbs: item ? [{ label: 'Admin', href: '/admin/roles' }, { label: item.label }] : [{ label: 'Admin' }] };
  }
  return { ...base, railKey: '', crumbs: [{ label: 'Docket' }] };
}

// True once the browser URL is `target` (path + query, trailing slash ignored).
// The app router updates history only after it commits the new tree, so a match
// means the target page's inputs are the ones in the DOM.
export function atRoute(target) {
  if (typeof window === 'undefined') return false;
  const [tp, tq = ''] = String(target).split('?');
  const here = new URLSearchParams(window.location.search);
  const want = new URLSearchParams(tq);
  if (normPath(window.location.pathname) !== normPath(tp)) return false;
  if ([...here.keys()].length !== [...want.keys()].length) return false;
  for (const [k, v] of want) if (here.get(k) !== v) return false;
  return true;
}

// Focus an element after a navigation to `route` lands (pass `route` whenever a
// router.push precedes the call — focusing before the swap focuses the OLD page's
// input, which React then remounts, and focus is lost). Retries every 50ms, ~2s.
// Used by the top-bar search trigger and + New.
export function focusWhenReady(selector, { route, select = false, tries = 40 } = {}) {
  if (typeof document === 'undefined') return;
  let n = 0;
  const tick = () => {
    const el = (!route || atRoute(route)) ? document.querySelector(selector) : null;
    if (el) { try { el.focus(); if (select) el.select?.(); } catch { /* ignore */ } return; }
    if (++n < tries) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}
