import { LayoutDashboard, ListChecks, ShieldCheck, UserCog, Settings, Hash, Plus, FolderLock, NotebookPen, BookOpen } from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'tasks', label: 'TASKS', icon: ListChecks,
    items: [
      // Dashboard is the founder/reviewer review surface. Visibility is shareable
      // (RULE-DOCKET-006): view_all OR the dashboard_public flag OR a per-person grant.
      // The layout feeds the computed `_dashboard` flag (from getMe.can_view_dashboard).
      { id: 'dashboard', label: 'Dashboard', route: '/dashboard', icon: LayoutDashboard, requires: '_dashboard' },
      // New tasks are added inline on the list (ClickUp/Asana-style) — no separate form in the nav.
      // Spaces are appended (indented) under Tasks, then Scratchpad below them — see buildNavGroups.
      { id: 'tasks',     label: 'Tasks',     route: '/tasks',     icon: ListChecks },
    ],
  },
  {
    id: 'manual', label: 'System Manual', flat: true, route: '/manual', icon: BookOpen,
  },
  {
    id: 'admin', label: 'ADMIN', icon: Settings,
    items: [
      { id: 'perm-roles', label: 'Roles & Permissions', route: '/admin/roles', icon: ShieldCheck, requires: 'docket_admin' },
      { id: 'perm-users', label: 'Users',                route: '/admin/users', icon: UserCog,     requires: 'docket_admin' },
    ],
  },
];

export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => g.flat ? g : ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.flat || (g.items && g.items.length > 0));
}

// Build the live nav: the static base, plus the caller's accessible private spaces as
// ClickUp-style items under TASKS (each routes to /tasks?space=<id>), a "New space"
// affordance, and an admin "Spaces" item (break-glass) under ADMIN. RULE-DOCKET-003.
export function buildNavGroups(perms, spaces = []) {
  const base = filterNavByPerms(NAV_GROUPS, perms);
  const privates = (spaces || []).filter(s => s.is_private);
  return base.map(g => {
    if (g.id === 'tasks') {
      // Spaces + New space are indented so they read as children of Tasks (RULE-DOCKET-003).
      const spaceItems = privates.map(s => ({ id: 'space-' + s.id, label: s.name, route: '/tasks?space=' + s.id, icon: Hash, indent: true }));
      const newSpace = { id: 'space-new', label: 'New space', route: '/tasks?space=new', icon: Plus, indent: true };
      // Scratchpad lives BELOW all tasks/spaces, at the same level as Tasks (no perm gate). RULE-DOCKET-005.
      const scratchpad = { id: 'scratchpad', label: 'Scratchpad', route: '/scratchpad', icon: NotebookPen };
      return { ...g, items: [...g.items, ...spaceItems, newSpace, scratchpad] };
    }
    if (g.id === 'admin' && perms?.docket_admin) {
      return { ...g, items: [...g.items, { id: 'admin-spaces', label: 'Spaces', route: '/admin/spaces', icon: FolderLock }] };
    }
    return g;
  });
}
