import {
  Gauge, Factory, Truck, Bell,
  Clock, ShieldCheck, GitBranch, ClipboardCheck, AlertTriangle, Users,
  FilePlus2, Workflow, BarChart3,
  Network, Send, ArrowLeftRight, FileText,
  Undo2, ScanLine, Edit3, Wrench,
  CalendarClock, LayoutGrid, ClipboardList, Tag, QrCode, Printer,
  BookOpen,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════
   Redesign IA (handoff §4): 4 primary destinations + Setup
   drawer + ⌘K. Leftover legacy screens folded into the closest
   group (Afshaan, 2026-06-12): New Run / Line Flush / Reporting
   under Production; Repack Reports under Dispatch. The old
   /dispatch + /dispatch/lines overview pages are ⌘K-only.
   ════════════════════════════════════════════════════════════ */

export const NAV_PRIMARY = [
  { id: 'overview', label: 'Overview', icon: Gauge, route: '/exec' },
  {
    id: 'production', label: 'Production', icon: Factory,
    children: [
      { id: 'new-run',     label: 'New Run',    route: '/new-run',            icon: FilePlus2 },
      { id: 'hourly',      label: 'Hourly',     route: '/hourly',             icon: Clock },
      { id: 'qc',          label: 'QC',         route: '/qc',                 icon: ShieldCheck },
      { id: 'lines',       label: 'Lines',      route: '/lines',              icon: GitBranch },
      { id: 'audit',       label: 'Audit',      route: '/audit',              icon: ClipboardCheck },
      { id: 'deviations',  label: 'Deviations', route: '/process-deviations', icon: AlertTriangle },
      { id: 'manpower',    label: 'Manpower',   route: '/manpower',           icon: Users },
      { id: 'line-flush',  label: 'Line Flush', route: '/line-flush',         icon: Workflow },
      { id: 'reporting',   label: 'Reporting',  route: '/reporting',          icon: BarChart3 },
    ],
  },
  {
    id: 'dispatch', label: 'Dispatch', icon: Truck,
    children: [
      { id: 'pipeline',       label: 'Pipeline',       route: '/dispatch-pipeline',  icon: Network },
      { id: 'shipments',      label: 'Shipments',      route: '/dispatch-shipments', icon: Send },
      { id: 'repack',         label: 'Repack',         route: '/repack-runs',        icon: ArrowLeftRight },
      { id: 'repack-reports', label: 'Repack Reports', route: '/repack-runs/reports', icon: BarChart3 },
      { id: 'challans',       label: 'Challans',       route: '/dispatch-challans',  icon: FileText },
    ],
  },
  {
    id: 'inbox', label: 'Inbox', icon: Bell, badged: true,
    children: [
      { id: 'alerts',      label: 'Alerts',      route: '/alerts',       icon: Bell,    badgeKey: 'alerts' },
      { id: 'returns',     label: 'Returns',     route: '/returns',      icon: Undo2,   badgeKey: 'returns' },
      { id: 'scans',       label: 'Scans',       route: '/scans',        icon: ScanLine },
      { id: 'corrections', label: 'Corrections', route: '/corrections',  icon: Edit3 },
      { id: 'repair',      label: 'Repair',      route: '/repair-queue', icon: Wrench },
    ],
  },
];

export const NAV_MANUAL = { id: 'manual', label: 'System Manual', icon: BookOpen, route: '/manual' };

export const NAV_SETUP = [
  { id: 'planner',     label: 'Planner',       route: '/planner',           icon: CalendarClock },
  { id: 'line-design', label: 'Line Design',   route: '/line-design',       icon: LayoutGrid },
  { id: 'line-setup',  label: 'Line Setup',    route: '/line-setup',        icon: ClipboardList },
  { id: 'channels',    label: 'Channels',      route: '/dispatch-channels', icon: Tag },
  { id: 'upc',         label: 'UPC Generator', route: '/upc',               icon: QrCode },
  { id: 'operators',   label: 'Operators',     route: '/operators',         icon: Users },
  { id: 'print',       label: 'Print',         route: '/print',             icon: Printer },
];

/* ⌘K-only destinations — pages that exist but live outside the sidebar */
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
  all.push({ crumb: 'Help', item: NAV_MANUAL, group: { id: 'manual' } });
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

/* Legacy export shape — nothing imports this anymore, kept for safety */
export const NAV_GROUPS = NAV_PRIMARY;
