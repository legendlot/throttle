import { hasPermission } from '@throttle/auth';
import {
  LayoutDashboard, Activity, BarChart3, Target,
  Boxes, Inbox, PackageOpen,
  Cog, ClipboardList, Workflow,
  ListChecks, CheckSquare, History, UserCog,
  Undo2,
  BookOpen, Download, Wrench, Scale, Route,
  RefreshCw,
  ShoppingCart, FileText,
  Users,
  Package, Factory, Store,
  Send,
  Bell,
  AlertTriangle,
  ClipboardCheck, ArrowUpDown, PackageCheck,
  Gift, Truck,
} from 'lucide-react';

// Mirrors legacy 04_stores/index.html nav structure (lines 1018–1080):
// OVERVIEW · INVENTORY · PRODUCTION · STORE · RETURNS · LIBRARY · PROCUREMENT · USERS

const GROUPS = [
  {
    id: 'overview', label: 'OVERVIEW', icon: LayoutDashboard,
    items: [
      { id: 'alerts',    label: 'Alerts',       route: '/alerts',    icon: Bell,            badgeColor: 'red' },
      { id: 'dashboard', label: 'Dashboard',    route: '/dashboard', icon: LayoutDashboard, gate: (p) => hasPermission(p, 'dashboard') },
      { id: 'activity',  label: 'Activity Log', route: '/activity',  icon: Activity,        gate: (p) => hasPermission(p, 'reports') || hasPermission(p, 'users_view') },
      { id: 'reports',         label: 'Reports',        route: '/reports',         icon: BarChart3, gate: (p) => hasPermission(p, 'reports') },
      { id: 'producibility',   label: 'Producibility',  route: '/producibility',   icon: Target,    gate: (p) => hasPermission(p, 'dashboard') },
    ],
  },
  {
    id: 'inventory', label: 'INVENTORY', icon: Package,
    items: [
      { id: 'stock',     label: 'Stock Ledger', route: '/stock',     icon: Boxes,       gate: (p) => hasPermission(p, 'stock') },
      { id: 'grn',       label: 'GRN Entry',    route: '/grn',       icon: Inbox,       gate: (p) => hasPermission(p, 'grn') },
      { id: 'receiving', label: 'Receiving',    route: '/receiving', icon: PackageOpen, gate: (p) => hasPermission(p, 'receiving') },
    ],
  },
  {
    id: 'production', label: 'PRODUCTION', icon: Factory,
    items: [
      { id: 'production-runs',    label: 'Production Runs',    route: '/production-runs',    icon: Cog },
      { id: 'work-orders',        label: 'Ad Hoc Requests',    route: '/work-orders',        icon: ClipboardList, gate: (p) => hasPermission(p, 'work_order') },
    ],
  },
  {
    id: 'store', label: 'STORE', icon: Store,
    items: [
      { id: 'issue-queue',       label: 'Issue Queue',       route: '/issue-queue',        icon: ListChecks,    gate: (p) => hasPermission(p, 'stock_issue') },
      { id: 'flush-verify',      label: 'Flush Verify',      route: '/flush-verify',       icon: CheckSquare,   gate: (p) => hasPermission(p, 'line_flush_verify') },
      { id: 'damage-ledger',     label: 'Damage Ledger',     route: '/damage-ledger',      icon: AlertTriangle, gate: (p) => hasPermission(p, 'stock') || hasPermission(p, 'damage_manage') },
      { id: 'cycle-counts',      label: 'Cycle Counts',      route: '/cycle-counts',       icon: ClipboardCheck, gate: (p) => hasPermission(p, 'cycle_count_record') || hasPermission(p, 'cycle_count_admin') },
      { id: 'stock-adjustments', label: 'Stock Adjustments', route: '/stock-adjustments',  icon: ArrowUpDown,    gate: (p) => hasPermission(p, 'cycle_count_record') || hasPermission(p, 'cycle_count_approve_l1') || hasPermission(p, 'cycle_count_approve_l2') },
      { id: 'unit-counts',       label: 'Dispatch Counts',   route: '/dispatch/unit-counts', icon: PackageCheck, gate: (p) => hasPermission(p, 'cycle_count_record') || hasPermission(p, 'cycle_count_admin') },
      { id: 'direct-issuance',   label: 'Direct Issuance',   route: '/direct-issuance',    icon: Gift,         gate: (p) => hasPermission(p, 'direct_issuance_request') || hasPermission(p, 'direct_issuance_approve') || hasPermission(p, 'users_manage') },
      { id: 'restock',           label: 'Unit Restock',      route: '/restock',            icon: RefreshCw,    gate: (p) => hasPermission(p, 'dispatch_restock') || hasPermission(p, 'users_manage') },
      { id: 'store-history',     label: 'Store History',     route: '/store-history',      icon: History },
      { id: 'gate-pass',         label: 'Gate Pass',         route: '/gate-pass',          icon: Truck,        gate: (p) => hasPermission(p, 'gate_pass') },
      { separator: true },
      { id: 'manpower',      label: 'Manpower',      route: '/manpower',      icon: UserCog,     gate: (p) => hasPermission(p, 'dashboard') },
      { id: 'dispatch',      label: 'Dispatch',      route: '/dispatch',      icon: Send,        gate: (p) => hasPermission(p, 'dashboard') },
    ],
  },
  {
    id: 'returns', label: 'RETURNS', flat: true, route: '/returns/shipments',
    icon: Undo2,
    gate: (p) => hasPermission(p, 'returns'),
  },
  {
    id: 'library', label: 'LIBRARY', icon: BookOpen,
    items: [
      { id: 'library-downloads', label: 'Downloads',      route: '/library/downloads', icon: Download },
      { id: 'library-parts',     label: 'Parts Database', route: '/library/parts',     icon: Wrench },
      { id: 'library-journey',   label: 'Part Journey',   route: '/library/journey',   icon: Route },
      { id: 'library-bag-sizes', label: 'Bag Sizes',      route: '/library/bag-sizes', icon: Scale,   gate: (p) => hasPermission(p, 'users_manage') },
    ],
  },
  // PROCUREMENT moved to Snorkel (snorkel.legendoftoys.com) — Session 94. All actionable
  // procurement (raise/edit/approve POs, vendors, forwarders, reorders, new product, addresses)
  // now lives there. Garage keeps ONE read-only Purchase Orders reference view with a banner
  // pointing to Snorkel; the page dirs for everything else were deleted.
  {
    id: 'procurement', label: 'PROCUREMENT', icon: ShoppingCart,
    items: [
      { id: 'procurement-pos', label: 'Purchase Orders', route: '/procurement/pos', icon: FileText, gate: (p) => hasPermission(p, 'procurement_view') },
    ],
  },
  {
    id: 'manual', label: 'System Manual', flat: true, route: '/manual',
    icon: BookOpen,
  },
  {
    id: 'users', label: 'USERS', flat: true, route: '/users',
    icon: Users,
    gate: (p) => hasPermission(p, 'users_view') || hasPermission(p, 'users_manage'),
  },
];

export function useNavGroups(perms) {
  return GROUPS
    .map((g) => {
      if (g.flat) {
        if (g.gate && !g.gate(perms)) return null;
        return g;
      }
      const items = (g.items || []).filter((i) => i.separator || !i.gate || i.gate(perms));
      const cleaned = [];
      items.forEach((i) => {
        if (i.separator) {
          if (!cleaned.length || cleaned[cleaned.length - 1].separator) return;
          cleaned.push(i);
        } else {
          cleaned.push(i);
        }
      });
      while (cleaned.length && cleaned[cleaned.length - 1].separator) cleaned.pop();
      return { ...g, items: cleaned };
    })
    .filter((g) => g && (g.flat || (g.items && g.items.length > 0)));
}
