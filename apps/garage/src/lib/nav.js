import { hasPermission, hasWritePermission } from '@throttle/auth';
import {
  LayoutDashboard, Activity, BarChart3, Target,
  Boxes, Inbox, PackageOpen,
  ListChecks, CheckSquare, History, UserCog,
  Undo2,
  BookOpen, Download, Wrench, Scale, Route, ScanLine,
  RefreshCw,
  FileText,
  Users,
  Package, Store,
  Send,
  AlertTriangle,
  ClipboardCheck, ArrowUpDown, PackageCheck,
  Gift, Truck, Tags,
  Layers, Settings,
} from 'lucide-react';

// ════════════════════════════════════════════════════════════════════
// Garage navigation — IA overhaul (redesign S128).
//
// The old flat 7-group / ~30-item always-expanded sidebar is replaced by
// FOUR primary work destinations (Overview · Inventory · Fulfilment ·
// Returns) rendered as an accordion (only the active group expands), a
// collapsed "Setup & More" drawer for done-once config / reference, a
// user-managed Pinned section, and a ⌘K command palette (see GarageSidebar
// / GarageCommandPalette). Routes, gates and screen behaviour are UNCHANGED
// — only the grouping changes.
//
//   · Alerts is folded into the Overview triage (no standalone item).
//   · Reports / Activity / Producibility / Manpower → drawer (insight, not
//     daily action).
//   · Pick Scans moves OUT of Library INTO Fulfilment, right after Issue
//     Queue (it is the store team's per-run issuing audit). Route stays
//     /library/pick-scans.
//   · Library (parts / journey / bag-sizes / downloads), Purchase Orders,
//     Users, System Manual → drawer.
// ════════════════════════════════════════════════════════════════════

// ── Four primary destinations ──────────────────────────────────────────
export const GARAGE_NAV_PRIMARY = [
  {
    id: 'overview', label: 'Overview', icon: LayoutDashboard, single: true,
    route: '/dashboard', gate: (p) => hasPermission(p, 'dashboard'),
    desc: 'Triage — what needs you now',
  },
  {
    id: 'inventory', label: 'Inventory', icon: Package,
    items: [
      { id: 'stock',             label: 'Stock Ledger',      route: '/stock',             icon: Boxes,         desc: 'Part-level stock, movements, reorder', gate: (p) => hasPermission(p, 'stock') },
      { id: 'grn',               label: 'GRN Entry',         route: '/grn',               icon: Inbox,         desc: 'Goods receipt notes', gate: (p) => hasPermission(p, 'grn') },
      { id: 'receiving',         label: 'Receiving',         route: '/receiving',         icon: PackageOpen,   desc: 'Inbound shipments to dock', gate: (p) => hasPermission(p, 'receiving') },
      { id: 'bag-stickers',      label: 'Bag Stickers',      route: '/bag-stickers',      icon: Tags,          desc: 'Print bag labels', gate: (p) => hasPermission(p, 'bag_sticker') },
      { id: 'cycle-counts',      label: 'Cycle Counts',      route: '/cycle-counts',      icon: ClipboardCheck, desc: 'Scheduled count sheets', gate: (p) => hasPermission(p, 'cycle_count_record') || hasPermission(p, 'cycle_count_admin') },
      { id: 'stock-adjustments', label: 'Stock Adjustments', route: '/stock-adjustments', icon: ArrowUpDown,   desc: 'Approve count variances', gate: (p) => hasPermission(p, 'cycle_count_record') || hasPermission(p, 'cycle_count_approve_l1') || hasPermission(p, 'cycle_count_approve_l2') },
      { id: 'damage-ledger',     label: 'Damage Ledger',     route: '/damage-ledger',     icon: AlertTriangle, desc: 'Damaged-stock log', gate: (p) => hasPermission(p, 'stock') || hasPermission(p, 'damage_manage') },
    ],
  },
  {
    id: 'fulfil', label: 'Fulfilment', icon: Store,
    items: [
      { id: 'issue-queue',        label: 'Issue Queue',     route: '/issue-queue',        icon: ListChecks,  desc: 'Pick & issue parts to runs', gate: (p) => hasPermission(p, 'stock_issue') },
      // Pick Scans relocated from Library → Fulfilment (S128): per-run store-issue
      // scan audit, belongs next to Issue Queue. Route unchanged (/library/pick-scans).
      { id: 'library-pick-scans', label: 'Pick Scans',      route: '/library/pick-scans', icon: ScanLine,    desc: 'Bags scanned per run at store issue' },
      { id: 'flush-verify',       label: 'Flush Verify',    route: '/flush-verify',       icon: CheckSquare, desc: 'Verify line-flush returns', gate: (p) => hasPermission(p, 'line_flush_verify') },
      { id: 'direct-issuance',    label: 'Direct Issuance', route: '/direct-issuance',    icon: Gift,        desc: 'Issue outside a run', gate: (p) => hasPermission(p, 'direct_issuance_request') || hasPermission(p, 'direct_issuance_approve') || hasPermission(p, 'users_manage') },
      { id: 'restock',            label: 'Unit Restock',    route: '/restock',            icon: RefreshCw,   desc: 'Replenish dispatch stock', gate: (p) => hasPermission(p, 'dispatch_restock') || hasPermission(p, 'users_manage') },
      { id: 'dispatch',           label: 'Dispatch',        route: '/dispatch',           icon: Send,        desc: 'Outbound unit dispatch', gate: (p) => hasPermission(p, 'dashboard') },
      { id: 'unit-counts',        label: 'Dispatch Counts', route: '/dispatch/unit-counts', icon: PackageCheck, desc: 'Count finished units', gate: (p) => hasPermission(p, 'cycle_count_record') || hasPermission(p, 'cycle_count_admin') },
      { id: 'gate-pass',          label: 'Gate Pass',       route: '/gate-pass',          icon: Truck,       desc: 'Outward gate passes', gate: (p) => hasPermission(p, 'gate_pass') },
      { id: 'store-history',      label: 'Store History',   route: '/store-history',      icon: History,     desc: 'All store transactions' },
    ],
  },
  {
    id: 'returns', label: 'Returns', icon: Undo2,
    gate: (p) => hasPermission(p, 'returns'),
    items: [
      { id: 'ret-ship',   label: 'Return Shipments', route: '/returns/shipments',   icon: Undo2,         desc: 'Inbound returns', gate: (p) => hasPermission(p, 'returns') },
      { id: 'ret-proc',   label: 'Process Returns',  route: '/returns/process',     icon: ClipboardCheck, desc: 'Inspect & disposition', gate: (p) => hasPermission(p, 'returns') },
      { id: 'ret-repair', label: 'Repair Pool',      route: '/returns/repair-pool', icon: Wrench,        desc: 'Repairable units', gate: (p) => hasPermission(p, 'returns') },
      { id: 'ret-udr',    label: 'UDR Pool',         route: '/returns/udr-pool',    icon: Layers,        desc: 'Un-dispatchable returns', gate: (p) => hasPermission(p, 'returns') },
      { id: 'ret-chan',   label: 'Channels',         route: '/returns/channels',    icon: Route,         desc: 'Return channels', gate: (p) => hasPermission(p, 'returns') },
      { id: 'ret-loss',   label: 'Losses',           route: '/returns/losses',      icon: AlertTriangle, desc: 'Write-off ledger', gate: (p) => hasPermission(p, 'returns') },
    ],
  },
];

// ── Setup & More drawer (done-once config / reference / insight) ────────
export const GARAGE_NAV_DRAWER = {
  id: 'more', label: 'Setup & More', icon: Settings,
  items: [
    { id: 'reports',           label: 'Reports',        route: '/reports',           icon: BarChart3, desc: 'Operational reports', gate: (p) => hasPermission(p, 'reports') },
    { id: 'activity',          label: 'Activity Log',   route: '/activity',          icon: Activity,  desc: 'System activity feed', gate: (p) => hasPermission(p, 'reports') || hasPermission(p, 'users_view') },
    { id: 'producibility',     label: 'Producibility',  route: '/producibility',     icon: Target,    desc: 'How many units can we build', gate: (p) => hasPermission(p, 'dashboard') },
    { id: 'manpower',          label: 'Manpower',       route: '/manpower',          icon: UserCog,   desc: 'Store floor manpower', gate: (p) => hasPermission(p, 'dashboard') },
    { id: 'library-parts',     label: 'Parts Database', route: '/library/parts',     icon: Wrench,    desc: 'Master parts catalogue' },
    { id: 'library-journey',   label: 'Part Journey',   route: '/library/journey',   icon: Route,     desc: 'Trace a part end-to-end' },
    { id: 'library-bag-sizes', label: 'Bag Sizes',      route: '/library/bag-sizes', icon: Scale,     desc: 'Bag size reference', gate: (p) => hasWritePermission(p, 'grn') },
    { id: 'library-downloads', label: 'Downloads',      route: '/library/downloads', icon: Download,  desc: 'Exports & sheets' },
    { id: 'procurement-pos',   label: 'Purchase Orders', route: '/procurement/pos',  icon: FileText,  desc: 'Read-only PO reference', gate: (p) => hasPermission(p, 'procurement_view') },
    { id: 'users',             label: 'Users',          route: '/users',             icon: Users,     desc: 'Accounts & roles', gate: (p) => hasPermission(p, 'users_view') || hasPermission(p, 'users_manage') },
    { id: 'manual',            label: 'System Manual',  route: '/manual',            icon: BookOpen,  desc: 'Operations manual' },
  ],
};

// Default pinned screens (user-managed thereafter, persisted to localStorage g-pins).
export const DEFAULT_PINS = ['/issue-queue', '/stock', '/grn'];

const passesGate = (item, perms) => !item.gate || item.gate(perms);

/**
 * Returns the permission-filtered nav for the current user:
 *   { primary: [...groups], drawer: {...} }
 * A primary group is dropped if its own gate fails or it has no visible items.
 * Singles (Overview) survive on their own gate.
 */
export function useGarageNav(perms = {}) {
  const primary = GARAGE_NAV_PRIMARY
    .map((g) => {
      if (g.single) return passesGate(g, perms) ? g : null;
      if (g.gate && !g.gate(perms)) return null;
      const items = (g.items || []).filter((i) => passesGate(i, perms));
      return items.length ? { ...g, items } : null;
    })
    .filter(Boolean);

  const drawer = {
    ...GARAGE_NAV_DRAWER,
    items: GARAGE_NAV_DRAWER.items.filter((i) => passesGate(i, perms)),
  };

  return { primary, drawer };
}

/** Flat list of every visible destination — used by breadcrumbs + ⌘K palette. */
export function allNavItems(nav) {
  const out = [];
  for (const g of nav.primary) {
    if (g.single) { out.push({ ...g, group: 'Overview' }); continue; }
    for (const i of g.items) out.push({ ...i, group: g.label });
  }
  for (const i of nav.drawer.items) out.push({ ...i, group: nav.drawer.label });
  return out;
}

/** Resolve the group label that owns a route (for the topbar breadcrumb). */
export function groupLabelForRoute(nav, pathname) {
  for (const g of nav.primary) {
    if (g.single) { if (matchRoute(g.route, pathname)) return g.label; continue; }
    if (g.items.some((i) => matchRoute(i.route, pathname))) return g.label;
  }
  if (nav.drawer.items.some((i) => matchRoute(i.route, pathname))) return nav.drawer.label;
  return 'Garage';
}

/** Resolve the screen title for a route (for the topbar title + palette). */
export function titleForRoute(nav, pathname) {
  const all = allNavItems(nav);
  // Prefer the longest matching route so /dispatch/unit-counts beats /dispatch.
  let best = null;
  for (const i of all) {
    if (matchRoute(i.route, pathname) && (!best || i.route.length > best.route.length)) best = i;
  }
  return best ? best.label : '';
}

export function matchRoute(route, pathname) {
  if (!route || !pathname) return false;
  return pathname === route || pathname.startsWith(route + '/');
}
