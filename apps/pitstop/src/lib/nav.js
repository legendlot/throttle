import {
  ListChecks, Inbox, BarChart3, Plus, Settings, LifeBuoy,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'work', label: 'WORK', icon: Inbox,
    items: [
      { id: 'queue',  label: 'Queue',      route: '/queue',  icon: ListChecks },
      { id: 'new',    label: 'New Ticket', route: '/new',    icon: Plus,    accent: 'red' },
    ],
  },
  {
    id: 'analyze', label: 'ANALYZE', icon: BarChart3,
    items: [
      { id: 'reports', label: 'Reports', route: '/reports', icon: BarChart3, requires: 'cs_reports_view' },
    ],
  },
];

/**
 * Filter NAV_GROUPS based on the user's permissions.
 * Items with `requires` are dropped if the user lacks that perm.
 */
export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.items.length > 0);
}
