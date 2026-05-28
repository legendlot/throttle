import {
  Inbox, Users, Flame, Star, ListChecks, BarChart3, Plus,
  Settings, Tag, Layers, FileSpreadsheet, UserCircle,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'work', label: 'WORK', icon: Inbox,
    items: [
      { id: 'dashboard',   label: 'Dashboard',    route: '/dashboard',    icon: BarChart3 },
      { id: 'influencers', label: 'Influencers',  route: '/influencers',  icon: Users },
      { id: 'engagements', label: 'Engagements',  route: '/engagements',  icon: ListChecks },
      { id: 'new',         label: 'New Deal',     route: '/engagements/new', icon: Plus, accent: 'orange' },
    ],
  },
  {
    id: 'lists', label: 'LISTS', icon: Star,
    items: [
      { id: 'roster',         label: 'Roster',        route: '/roster',         icon: Star },
      { id: 'blist',          label: 'B-List',        route: '/blist',          icon: Layers },
      { id: 'ugc',            label: 'UGC',           route: '/ugc',            icon: Flame },
      { id: 'campaigns',      label: 'Campaigns',     route: '/campaigns',      icon: Layers },
      { id: 'discount-codes', label: 'Codes',         route: '/discount-codes', icon: Tag },
    ],
  },
  {
    id: 'analyze', label: 'ANALYZE', icon: BarChart3,
    items: [
      { id: 'reports', label: 'Reports', route: '/reports', icon: BarChart3, requires: 'ignition_reports_view' },
    ],
  },
  {
    id: 'admin', label: 'ADMIN', icon: Settings,
    items: [
      { id: 'users',  label: 'Users',  route: '/admin/users',  icon: UserCircle,      requires: 'ignition_admin' },
      { id: 'import', label: 'Import', route: '/admin/import', icon: FileSpreadsheet, requires: 'ignition_admin' },
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
