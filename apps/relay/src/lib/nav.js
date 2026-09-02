import {
  LayoutDashboard, Send, GitBranch, Filter, Contact, Mail, BarChart3,
  Shield, Users, SlidersHorizontal, AtSign, Cable, Activity, Images, Link2, FlaskConical,
  BookOpen, ShieldOff,
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
      // Beside Campaigns, not under Build & measure — it is a log OF campaigns (cross-campaign,
      // read-only), not a thing you build. Same view permission as Campaigns; only campaign_build
      // gates recording a learning, and that stays where it already lives (VariantResults.js).
      { id: 'experiments', label: 'Experiment log', route: '/experiments', icon: FlaskConical, requires: 'relay_view' },
      { id: 'journeys',  label: 'Journeys',  route: '/journeys',  icon: GitBranch, requires: 'relay_view' },
    ],
  },
  {
    id: 'audience', label: 'Audience',
    items: [
      { id: 'activity', label: 'Activity', route: '/activity', icon: Activity, requires: 'relay_view' },
      { id: 'segments', label: 'Segments', route: '/segments', icon: Filter,  requires: 'relay_view' },
      { id: 'contacts', label: 'Contacts', route: '/contacts', icon: Contact, requires: 'relay_view' },
    ],
  },
  {
    id: 'build', label: 'Build & measure',
    items: [
      { id: 'templates', label: 'Templates', route: '/templates', icon: Mail,      requires: 'relay_view' },
      // Library sits beside Templates because it is the thing templates draw FROM.
      // It began life as a modal inside the template editor, which meant the only way
      // to load images was to first open some template you might not want to edit —
      // so bulk upload, the actual job, had nowhere to happen.
      { id: 'library',   label: 'Library',   route: '/library',   icon: Images,    requires: 'relay_view' },
      // Links sits beside Library for the same reason: it is an asset campaigns draw FROM, not a
      // send surface. It is also the only place a link's destination can be changed after the
      // artwork carrying it has been printed.
      { id: 'links',     label: 'Links',     route: '/links',     icon: Link2,     requires: 'relay_view' },
      { id: 'analytics', label: 'Analytics', route: '/analytics', icon: BarChart3, requires: 'relay_view' },
    ],
  },
  // The System Manual, a flat entry before the Admin group (the house pattern across every
  // LOT app). No `requires` beyond being signed in: the manual is role-FILTERABLE inside the
  // viewer, so gating the nav item as well would hide the docs from exactly the people most
  // likely to need them.
  {
    id: 'manual', label: 'System Manual', flat: true, route: '/manual', icon: BookOpen,
  },
  {
    id: 'admin', label: 'Admin',
    items: [
      { id: 'admin-roles',      label: 'Roles',             route: '/admin/roles',      icon: Shield,            requires: 'relay_super_admin' },
      { id: 'admin-users',      label: 'Users',             route: '/admin/users',      icon: Users,             requires: 'relay_admin' },
      { id: 'admin-settings',   label: 'Approval & Caps',   route: '/admin/settings',   icon: SlidersHorizontal, requires: 'relay_super_admin' },
      { id: 'admin-senders',    label: 'Sender Identities', route: '/admin/senders',    icon: AtSign,            requires: 'connector_channel_manage' },
      { id: 'admin-connectors', label: 'Connectors',        route: '/admin/connectors', icon: Cable,             requires: 'connector_channel_manage' },
      // `data_consent_admin`, not `relay_view`: every action on this page (lifting a block) is
      // gated on it in the worker, so showing it to a viewer would be a page whose only control
      // 403s. Same key the per-contact Delivery-blocks panel uses to decide whether to offer Lift.
      { id: 'admin-suppressions', label: 'Suppressions',    route: '/suppressions',     icon: ShieldOff,         requires: 'data_consent_admin' },
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
// Longest-prefix wins — the SAME rule as chrome/navMatch.js matchActive, so the
// breadcrumb and the sidebar active item can never disagree on a nested route.
export function crumbFor(groups, pathname) {
  let best = null, bestLen = -1;
  for (const g of groups) {
    const items = g.flat ? [{ route: g.route, label: g.label }] : (g.items || []);
    for (const it of items) {
      if (!it.route) continue;
      const hit = pathname === it.route || (it.route !== '/' && pathname.startsWith(it.route + '/'));
      if (hit && it.route.length > bestLen) {
        best = { group: g.flat ? 'HOME' : g.label.toUpperCase(), page: it.label.toUpperCase() };
        bestLen = it.route.length;
      }
    }
  }
  return best || { group: 'RELAY', page: '' };
}
