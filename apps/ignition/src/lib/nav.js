import {
  Inbox, Users, Flame, Star, ListChecks, BarChart3, Plus,
  Settings, Layers, FileSpreadsheet, CircleUser, CalendarDays, Wallet, Target,
  BookOpen, Gauge, Megaphone,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'work', label: 'WORK', icon: Inbox,
    items: [
      { id: 'dashboard',   label: 'Dashboard',    route: '/dashboard',    icon: Gauge },
      { id: 'connects',    label: 'Connects',     route: '/connects',     icon: Inbox, requires: 'ignition_connects' },
      { id: 'influencers', label: 'Influencers',  route: '/influencers',  icon: Users },
      { id: 'engagements', label: 'Engagements',  route: '/engagements',  icon: ListChecks },
      { id: 'schedule',    label: 'Schedule',     route: '/schedule',     icon: CalendarDays },
      { id: 'payments',    label: 'Payments',     route: '/payments',     icon: Wallet },
      // rail: false — New Deal lives in the top bar CTA on desktop (IgRail skips it); the route,
      // its `requires` gating and the mobile More sheet entry are unchanged.
      { id: 'new',         label: 'New Deal',     route: '/engagements/new', icon: Plus, accent: 'orange', rail: false },
    ],
  },
  {
    id: 'lists', label: 'LISTS', icon: Star,
    items: [
      { id: 'roster',         label: 'Roster',        route: '/roster',         icon: Star },
      { id: 'blist',          label: 'B-List',        route: '/blist',          icon: Layers },
      { id: 'ugc',            label: 'UGC',           route: '/ugc',            icon: Flame },
      { id: 'campaigns',      label: 'Campaigns',     route: '/campaigns',      icon: Megaphone },
      // Legacy pre-minted code pool retired from nav (S214 ⑧) — deals now use
      // Issue Gift/Affiliate codes on the engagement. Route + data kept for history.
    ],
  },
  {
    id: 'analyze', label: 'ANALYZE', icon: BarChart3,
    items: [
      { id: 'reports', label: 'Reports', route: '/reports', icon: BarChart3, requires: 'ignition_reports_view' },
      { id: 'targets', label: 'Targets', route: '/targets', icon: Target },
    ],
  },
  {
    id: 'manual', label: 'System Manual', flat: true, route: '/manual', icon: BookOpen,
  },
  {
    id: 'admin', label: 'ADMIN', icon: Settings,
    items: [
      { id: 'users',  label: 'Users',  route: '/admin/users',  icon: CircleUser,      requires: 'ignition_admin' },
      { id: 'import', label: 'Import', route: '/admin/import', icon: FileSpreadsheet, requires: 'ignition_admin' },
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
