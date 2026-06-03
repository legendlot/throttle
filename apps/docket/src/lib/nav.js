import { LayoutDashboard, ListChecks, ShieldCheck, UserCog, Settings } from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'tasks', label: 'TASKS', icon: ListChecks,
    items: [
      // Dashboard is the founder/reviewer review surface — requires org-wide visibility.
      { id: 'dashboard', label: 'Dashboard', route: '/dashboard', icon: LayoutDashboard, requires: 'docket_view_all' },
      // New tasks are added inline on the list (ClickUp/Asana-style) — no separate form in the nav.
      { id: 'tasks',     label: 'Tasks',     route: '/tasks',     icon: ListChecks },
    ],
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
    .map(g => ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.items.length > 0);
}
