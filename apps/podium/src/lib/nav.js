import {
  Users, Network, Briefcase, Building2, BarChart3, Plus, Settings, UserPlus,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'people', label: 'PEOPLE', icon: Users,
    items: [
      { id: 'dashboard',   label: 'Dashboard',   route: '/dashboard',   icon: BarChart3 },
      { id: 'people',      label: 'Directory',   route: '/people',      icon: Users },
      { id: 'org',         label: 'Org Chart',   route: '/org',         icon: Network },
      { id: 'new',         label: 'New Person',  route: '/people/new',  icon: UserPlus, accent: 'orange', requires: 'podium_hr' },
    ],
  },
  {
    id: 'org', label: 'ORG DESIGN', icon: Briefcase,
    items: [
      { id: 'roles',       label: 'Roles & KPIs', route: '/roles',       icon: Briefcase },
      { id: 'departments', label: 'Departments',  route: '/departments', icon: Building2 },
    ],
  },
  {
    id: 'admin', label: 'ADMIN', icon: Settings,
    items: [
      { id: 'settings', label: 'Settings', route: '/admin/settings', icon: Settings, requires: 'podium_admin' },
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
