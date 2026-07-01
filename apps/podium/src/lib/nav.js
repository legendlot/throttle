import {
  Users, Network, Briefcase, Building2, BarChart3, Settings, UserPlus,
  Star, Activity, ShieldCheck, UserCog, ClipboardCheck, BookOpen, Factory,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'people', label: 'PEOPLE', icon: Users,
    items: [
      // Browse surfaces require podium_view — a self-only user (no role) sees only My Performance.
      { id: 'dashboard',   label: 'Dashboard',   route: '/dashboard',   icon: BarChart3, requires: 'podium_view' },
      { id: 'people',      label: 'Directory',   route: '/people',      icon: Users,     requires: 'podium_view' },
      { id: 'org',         label: 'Org Chart',   route: '/org',         icon: Network,   requires: 'podium_view' },
      { id: 'new',         label: 'New Person',  route: '/people/new',  icon: UserPlus, accent: 'orange', requires: 'podium_hr' },
    ],
  },
  {
    id: 'performance', label: 'PERFORMANCE', icon: Activity,
    items: [
      { id: 'me',   label: 'My Performance', route: '/me',   icon: Star },
      { id: 'team', label: 'Team',           route: '/team', icon: Activity, requires: 'podium_view' },
      { id: 'appraisals', label: 'Appraisals', route: '/appraisals', icon: ClipboardCheck, requires: 'podium_hr' },
    ],
  },
  {
    id: 'org', label: 'ORG DESIGN', icon: Briefcase,
    items: [
      { id: 'roles',       label: 'Roles & KPIs', route: '/roles',       icon: Briefcase, requires: 'podium_view' },
      { id: 'departments', label: 'Departments',  route: '/departments', icon: Building2,  requires: 'podium_view' },
    ],
  },
  {
    id: 'manual', label: 'System Manual', flat: true, route: '/manual', icon: BookOpen,
  },
  {
    id: 'admin', label: 'ADMIN', icon: Settings,
    items: [
      { id: 'perm-roles', label: 'Roles & Permissions', route: '/admin/roles',    icon: ShieldCheck, requires: 'podium_admin' },
      { id: 'perm-users', label: 'Users',               route: '/admin/users',    icon: UserCog,     requires: 'podium_admin' },
      { id: 'settings',   label: 'Settings',            route: '/admin/settings', icon: Settings,    requires: 'podium_admin' },
      { id: 'factory-cost', label: 'Factory Cost',      route: '/admin/factory-cost', icon: Factory, requires: 'podium_comp' },
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
