import {
  LayoutDashboard, Send, GitBranch, Filter, Contact, Mail, BarChart3,
  Shield, Users, SlidersHorizontal, AtSign, Cable,
} from 'lucide-react';

// COMMAND IA (handoff §4): a standalone Overview + task-based groups.
// Routes are unchanged from the previous build — this only regroups/relabels
// and adds Overview. Perm keys are exactly what each page itself enforces.
export const NAV_GROUPS = [
  {
    id: 'overview', label: 'Overview', flat: true, route: '/', icon: LayoutDashboard,
    requires: 'relay_view',
  },
  {
    id: 'send', label: 'Send',
    items: [
      { id: 'campaigns', label: 'Campaigns', route: '/campaigns', icon: Send,      requires: 'relay_view' },
      { id: 'journeys',  label: 'Journeys',  route: '/journeys',  icon: GitBranch, requires: 'relay_view' },
    ],
  },
  {
    id: 'audience', label: 'Audience',
    items: [
      { id: 'segments', label: 'Segments', route: '/segments', icon: Filter,  requires: 'relay_view' },
      { id: 'contacts', label: 'Contacts', route: '/contacts', icon: Contact, requires: 'relay_view' },
    ],
  },
  {
    id: 'build', label: 'Build & measure',
    items: [
      { id: 'templates', label: 'Templates', route: '/templates', icon: Mail,      requires: 'relay_view' },
      { id: 'analytics', label: 'Analytics', route: '/analytics', icon: BarChart3, requires: 'relay_view' },
    ],
  },
  {
    id: 'admin', label: 'Admin',
    items: [
      { id: 'admin-roles',      label: 'Roles',             route: '/admin/roles',      icon: Shield,            requires: 'relay_super_admin' },
      { id: 'admin-users',      label: 'Users',             route: '/admin/users',      icon: Users,             requires: 'relay_admin' },
      { id: 'admin-settings',   label: 'Approval & Caps',   route: '/admin/settings',   icon: SlidersHorizontal, requires: 'relay_super_admin' },
      { id: 'admin-senders',    label: 'Sender Identities', route: '/admin/senders',    icon: AtSign,            requires: 'connector_channel_manage' },
      { id: 'admin-connectors', label: 'Connectors',        route: '/admin/connectors', icon: Cable,             requires: 'connector_channel_manage' },
    ],
  },
];

// Items with no `requires` are always visible. Drop items the user lacks the perm for,
// then drop now-empty groups. Flat groups (Overview) carry their own `requires`.
// (perms = the user's Relay permissions from getMe.)
export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => g.flat ? g : ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.flat
      ? (!g.requires || perms?.[g.requires])
      : (g.items && g.items.length > 0));
}

// Breadcrumb map (top context bar): GROUP / SCREEN in mono uppercase.
export function crumbFor(groups, pathname) {
  for (const g of groups) {
    const items = g.flat ? [{ route: g.route, label: g.label }] : (g.items || []);
    for (const it of items) {
      if (pathname === it.route || (it.route !== '/' && pathname.startsWith(it.route + '/')) || (it.route === '/' && pathname === '/')) {
        return { group: g.flat ? 'HOME' : g.label.toUpperCase(), page: it.label.toUpperCase() };
      }
    }
  }
  return { group: 'RELAY', page: '' };
}
