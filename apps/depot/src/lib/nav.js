import {
  Gauge, Truck, Users,
  Network, Send, ArrowLeftRight, FileText, RefreshCw, PackageCheck,
  BarChart3, GitBranch, Tag,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════
   Depot IA — dispatch is the PRIMARY destination here (it was a
   cramped group inside Redline). Phase 1: Overview (placeholder)
   + the full Dispatch group + Manpower, with Channels in the
   Setup drawer and the two live floor-views (Dispatch Overview /
   Lines) as ⌘K-only destinations. No System Manual yet.
   ════════════════════════════════════════════════════════════ */

export const NAV_PRIMARY = [
  { id: 'overview', label: 'Overview', icon: Gauge, route: '/dashboard' },
  {
    id: 'dispatch', label: 'Dispatch', icon: Truck,
    children: [
      { id: 'pipeline',        label: 'Pipeline',        route: '/dispatch-pipeline',   icon: Network },
      { id: 'shipments',       label: 'Shipments',       route: '/dispatch-shipments',  icon: Send },
      { id: 'repack',          label: 'Repack',          route: '/repack-runs',         icon: ArrowLeftRight },
      { id: 'repack-reports',  label: 'Repack Reports',  route: '/repack-runs/reports', icon: BarChart3 },
      { id: 'challans',        label: 'Challans',        route: '/dispatch-challans',   icon: FileText },
      { id: 'restock',         label: 'Unit Restock',    route: '/restock',             icon: RefreshCw },
      { id: 'dispatch-roster', label: 'Dispatch Roster', route: '/dispatch-roster',     icon: Users },
      { id: 'dispatch-counts', label: 'Dispatch Counts', route: '/dispatch-counts',     icon: PackageCheck },
    ],
  },
  { id: 'manpower', label: 'Manpower', icon: Users, route: '/manpower' },
];

export const NAV_SETUP = [
  { id: 'channels', label: 'Channels', route: '/dispatch-channels', icon: Tag },
];

/* ⌘K-only destinations — live floor views that exist outside the sidebar */
export const NAV_HIDDEN = [
  { id: 'dispatch-overview', label: 'Dispatch Overview', route: '/dispatch',       icon: Truck },
  { id: 'dispatch-lines',    label: 'Dispatch Lines',    route: '/dispatch/lines', icon: GitBranch },
];

/* ── breadcrumb/title resolution for the topbar ─────────────── */
export function resolveNav(pathname) {
  const norm = (pathname || '/').replace(/\/+$/, '') || '/';
  const all = [];
  for (const g of NAV_PRIMARY) {
    if (g.route) all.push({ crumb: g.label, item: { ...g, label: g.label }, group: g });
    for (const c of g.children || []) all.push({ crumb: g.label, item: c, group: g });
  }
  for (const s of NAV_SETUP) all.push({ crumb: 'Setup', item: s, group: { id: '__setup' } });
  for (const h of NAV_HIDDEN) all.push({ crumb: 'Dispatch', item: h, group: { id: 'dispatch' } });

  // longest matching route wins (handles /dispatch-challans/new etc.)
  let best = null;
  for (const e of all) {
    const r = e.item.route.replace(/\/+$/, '');
    if (norm === r || norm.startsWith(r + '/')) {
      if (!best || r.length > best.item.route.replace(/\/+$/, '').length) best = e;
    }
  }
  return best; // { crumb, item, group } | null
}
