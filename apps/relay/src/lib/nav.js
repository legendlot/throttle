import {
  Send, GitBranch, Users, FileText, Mail, BarChart3, Settings, Shield,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'send', label: 'SEND', icon: Send,
    items: [
      { id: 'campaigns', label: 'Campaigns', route: '/campaigns', icon: Send,      requires: 'relay_view' },
      { id: 'journeys',  label: 'Journeys',  route: '/journeys',  icon: GitBranch, requires: 'relay_view' },
    ],
  },
  {
    id: 'build', label: 'BUILD', icon: FileText,
    items: [
      { id: 'segments',  label: 'Segments',  route: '/segments',  icon: Users,    requires: 'relay_view' },
      { id: 'templates', label: 'Templates', route: '/templates', icon: FileText, requires: 'relay_view' },
    ],
  },
  {
    id: 'data', label: 'DATA', icon: Mail,
    items: [
      { id: 'contacts',  label: 'Contacts',  route: '/contacts',  icon: Mail,      requires: 'relay_view' },
      { id: 'analytics', label: 'Analytics', route: '/analytics', icon: BarChart3, requires: 'relay_view' },
    ],
  },
  {
    id: 'admin', label: 'ADMIN', icon: Shield,
    items: [
      { id: 'admin-roles',     label: 'Roles',             route: '/admin/roles',      icon: Shield,   requires: 'relay_super_admin' },
      { id: 'admin-users',     label: 'Users',             route: '/admin/users',      icon: Users,    requires: 'relay_admin' },
      { id: 'admin-settings',  label: 'Approval & Caps',   route: '/admin/settings',   icon: Settings, requires: 'relay_super_admin' },
      { id: 'admin-senders',   label: 'Sender Identities', route: '/admin/senders',    icon: Mail,     requires: 'connector_channel_manage' },
      { id: 'admin-connectors', label: 'Connectors',       route: '/admin/connectors', icon: Settings, requires: 'connector_channel_manage' },
    ],
  },
];

// Items with no `requires` are always visible. Drop items the user lacks the perm for,
// then drop now-empty groups. (perms = the user's Relay permissions from getMe.)
export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => g.flat ? g : ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.flat || (g.items && g.items.length > 0));
}
