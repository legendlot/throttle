import {
  Gauge, Factory, Truck, Bell,
  Clock, ShieldCheck, GitBranch, ClipboardCheck, AlertTriangle, Users,
  FilePlus2, Workflow, BarChart3,
  ArrowLeftRight,
  Undo2, ScanLine, Edit3, Wrench,
  CalendarClock, LayoutGrid, ClipboardList, QrCode, Printer,
  BookOpen, History, Coins,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════
   Redesign IA (handoff §4): 4 primary destinations + Setup
   drawer + ⌘K. Leftover legacy screens folded into the closest
   group (Afshaan, 2026-06-12): New Run / Line Flush / Reporting
   under Production; Repack Reports under Dispatch. The old
   /dispatch + /dispatch/lines overview pages are ⌘K-only.
   ════════════════════════════════════════════════════════════ */

/* S152 reorg: the old flat 10-item Production group split into lifecycle-ordered
   groups (Plan → Floor → Quality → Reports). Planner / Line Setup / Line Design
   promoted out of the Setup drawer into Plan (daily prep, not done-once config).
   Inbox renamed Activities. Dispatch dropped lower (it's just a Depot pointer +
   the still-here Repack screens). */
export const NAV_PRIMARY = [
  { id: 'overview', label: 'Overview', icon: Gauge, route: '/exec', perm: 'dashboard' },
  {
    id: 'plan', label: 'Plan', icon: CalendarClock, perm: 'run_request',
    children: [
      { id: 'planner',     label: 'Planner',     route: '/planner',     icon: CalendarClock },
      { id: 'new-run',     label: 'New Run',     route: '/new-run',     icon: FilePlus2 },
      { id: 'line-setup',  label: 'Line Setup',  route: '/line-setup',  icon: ClipboardList },
      { id: 'line-design', label: 'Line Design', route: '/line-design', icon: LayoutGrid },
    ],
  },
  {
    id: 'floor', label: 'Floor', icon: Factory, perm: 'run_request',
    children: [
      { id: 'lines',      label: 'Lines',      route: '/lines',      icon: GitBranch },
      { id: 'hourly',     label: 'Hourly',     route: '/hourly',     icon: Clock },
      { id: 'manpower',   label: 'Manpower',   route: '/manpower',   icon: Users },
      { id: 'line-flush', label: 'Line Flush', route: '/line-flush', icon: Workflow },
    ],
  },
  {
    id: 'quality', label: 'Quality', icon: ShieldCheck, perm: 'deviation_propose',
    children: [
      { id: 'qc',         label: 'QC',         route: '/qc',                 icon: ShieldCheck },
      { id: 'audit',      label: 'Audit',      route: '/audit',              icon: ClipboardCheck },
      { id: 'deviations', label: 'Deviations', route: '/process-deviations', icon: AlertTriangle },
    ],
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart3, perm: 'reports',
    children: [
      { id: 'prod-history', label: 'Production History', route: '/production-history', icon: History },
      { id: 'reporting',    label: 'Reporting',          route: '/reporting',          icon: BarChart3 },
    ],
  },
  {
    id: 'costs', label: 'Costs', icon: Coins, perm: 'factory_cost_view',
    children: [
      { id: 'costs-daily',   label: 'Daily Cost',    route: '/costs',              icon: Coins },
      { id: 'costs-monthly', label: 'Monthly Cost',  route: '/costs/monthly',      icon: BarChart3 },
      { id: 'productivity',  label: 'Productivity',  route: '/costs/productivity', icon: Users },
    ],
  },
  {
    id: 'inbox', label: 'Activities', icon: Bell, badged: true, perm: 'dashboard',
    children: [
      { id: 'alerts',      label: 'Alerts',      route: '/alerts',       icon: Bell,    badgeKey: 'alerts' },
      { id: 'returns',     label: 'Returns',     route: '/returns',      icon: Undo2,   badgeKey: 'returns' },
      { id: 'scans',       label: 'Scans',       route: '/scans',        icon: ScanLine },
      { id: 'corrections', label: 'Corrections', route: '/corrections',  icon: Edit3 },
      { id: 'repair',      label: 'Repair',      route: '/repair-queue', icon: Wrench },
    ],
  },
  {
    // Dispatch carved out into Depot (depot.legendoftoys.com) — S152 cutover.
    // Group kept only as a pointer + the still-here Repack screens (repack stays
    // in Redline as a production activity; its tab placement is a later decision).
    id: 'dispatch', label: 'Dispatch', icon: Truck, perm: 'repack_run_manage',
    children: [
      { id: 'dispatch-moved', label: 'Moved to Depot →', route: '/dispatch',           icon: Truck },
      { id: 'repack',         label: 'Repack',           route: '/repack-runs',         icon: ArrowLeftRight },
      { id: 'repack-reports', label: 'Repack Reports',   route: '/repack-runs/reports', icon: BarChart3 },
    ],
  },
];

export const NAV_MANUAL = { id: 'manual', label: 'System Manual', icon: BookOpen, route: '/manual' };

/* Setup = done-once admin config only (planning moved to the Plan group, S152). */
export const NAV_SETUP = [
  { id: 'upc',       label: 'UPC Generator', route: '/upc',       icon: QrCode,   perm: 'bag_sticker' },
  { id: 'operators', label: 'Operators',     route: '/operators', icon: Users,    perm: 'users_manage' },
  /* Print Center is an explicit allow-list (store.print_reprint_access → the resolved
     `print_reprint` key), NOT bag_sticker — Mrudula 2026-09-03. The real control is the
     worker guard on postPrintCenterReprint; this only hides the entry.
     ⛔ /upc above stays on bag_sticker — the UPC Generator was left alone deliberately. */
  { id: 'print',     label: 'Print',         route: '/print',     icon: Printer,  perm: 'print_reprint' },
];

/* ⌘K-only destinations — pages that exist but live outside the sidebar.
   (Dispatch overview/lines removed S152 — dispatch lives in Depot now.) */
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
