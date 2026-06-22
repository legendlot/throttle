import {
  Gauge, Send, Network, FileText, PackageCheck,
  Undo2, RefreshCw, ArrowLeftRight, BarChart3,
  LayoutGrid, Truck, GitBranch, ScanLine, ClipboardList, Users, Tag, ClipboardCheck, BookOpen, Inbox,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════
   Depot IA (Session 147 reorg) — Depot IS the dispatch system,
   so a single catch-all "Dispatch" group was redundant + heavy.
   Pages are now grouped by purpose:
     • Outbound — the ship-out flow (pipeline → shipments → challans → counts)
     • Returns  — reverse logistics (restock + repack*)
     • Floor    — live floor views, the dispatch scan feed, roster + manpower
     • Setup    — done-once config (channels)
   The two live floor views (Live Floor / Lines) + the new Scan
   Feed are surfaced in the Floor group (previously ⌘K-only).
   * Repack is parked to move back to Redline (production activity);
     it stays here until the handover mechanism is decided.
   ════════════════════════════════════════════════════════════ */

export const NAV_PRIMARY = [
  { id: 'overview', label: 'Overview', icon: Gauge, route: '/dashboard' },
  {
    id: 'outbound', label: 'Outbound', icon: Send,
    children: [
      { id: 'fulfilment-requests', label: 'Fulfilment Requests', route: '/fulfilment-requests', icon: Inbox },
      { id: 'pipeline',        label: 'Pipeline',        route: '/dispatch-pipeline',  icon: Network },
      { id: 'shipments',       label: 'Shipments',       route: '/dispatch-shipments', icon: Send },
      { id: 'challans',        label: 'Challans',        route: '/dispatch-challans',  icon: FileText },
      { id: 'dispatch-counts', label: 'Dispatch Counts', route: '/dispatch-counts',    icon: PackageCheck },
    ],
  },
  {
    id: 'returns', label: 'Returns', icon: Undo2,
    children: [
      { id: 'restock',        label: 'Unit Restock',   route: '/restock',             icon: RefreshCw },
      { id: 'repack',         label: 'Repack',         route: '/repack-runs',         icon: ArrowLeftRight },
      { id: 'repack-reports', label: 'Repack Reports', route: '/repack-runs/reports', icon: BarChart3 },
    ],
  },
  {
    id: 'floor', label: 'Floor', icon: LayoutGrid,
    children: [
      { id: 'live-floor',      label: 'Live Floor',      route: '/dispatch',        icon: Truck },
      { id: 'lines',           label: 'Lines',           route: '/dispatch/lines',  icon: GitBranch },
      { id: 'scans',           label: 'Scan Feed',       route: '/scans',           icon: ScanLine },
      { id: 'stock-audit',     label: 'Stock Audit',     route: '/dispatch-audits', icon: ClipboardCheck },
      { id: 'dispatch-roster', label: 'Dispatch Roster', route: '/dispatch-roster', icon: ClipboardList },
      { id: 'manpower',        label: 'Manpower',        route: '/manpower',        icon: Users },
    ],
  },
];

export const NAV_SETUP = [
  { id: 'channels', label: 'Channels', route: '/dispatch-channels', icon: Tag },
];

/* Help — the in-app System Manual (also downloadable as PDF). */
export const NAV_MANUAL = { id: 'manual', label: 'System Manual', icon: BookOpen, route: '/manual' };

/* All live floor views now live in the Floor group; nothing is ⌘K-only. */
export const NAV_HIDDEN = [];

/* ── breadcrumb/title resolution for the topbar ─────────────── */
export function resolveNav(pathname) {
  const norm = (pathname || '/').replace(/\/+$/, '') || '/';
  const all = [];
  for (const g of NAV_PRIMARY) {
    if (g.route) all.push({ crumb: g.label, item: { ...g, label: g.label }, group: g });
    for (const c of g.children || []) all.push({ crumb: g.label, item: c, group: g });
  }
  for (const s of NAV_SETUP) all.push({ crumb: 'Setup', item: s, group: { id: '__setup' } });
  all.push({ crumb: 'Help', item: NAV_MANUAL, group: { id: '__manual' } });
  for (const h of NAV_HIDDEN) all.push({ crumb: 'Floor', item: h, group: { id: 'floor' } });

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
