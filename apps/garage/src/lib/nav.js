import { hasPermission } from '@throttle/auth';
import {
  LayoutDashboard, Activity, BarChart3, Target,
  Boxes, Inbox, PackageOpen,
  Cog, ClipboardList, Workflow,
  ListChecks, CheckSquare, History, UserCog,
  Undo2,
  BookOpen, Download, Wrench, Scale,
  ShoppingCart, FileText, RefreshCw, Building, Truck,
  Users,
  Package, Factory, Store,
  Send,
  Bell,
  AlertTriangle,
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
      { id: 'production-runs', label: 'Production Runs', route: '/production-runs', icon: Cog },
      { id: 'work-orders',     label: 'Ad Hoc Requests', route: '/work-orders',     icon: ClipboardList, gate: (p) => hasPermission(p, 'work_order') },
      { id: 'line-flush',      label: 'Line Flush',      route: '/line-flush',      icon: Workflow,      gate: (p) => hasPermission(p, 'line_flush_create') || hasPermission(p, 'line_flush_verify') },
    ],
  },
  {
    id: 'store', label: 'STORE', icon: Store,
    items: [
      { id: 'issue-queue',    label: 'Issue Queue',    route: '/issue-queue',    icon: ListChecks,    gate: (p) => hasPermission(p, 'stock_issue') },
      { id: 'flush-verify',   label: 'Flush Verify',   route: '/flush-verify',   icon: CheckSquare,   gate: (p) => hasPermission(p, 'line_flush_verify') },
      { id: 'damage-ledger',  label: 'Damage Ledger',  route: '/damage-ledger',  icon: AlertTriangle, gate: (p) => hasPermission(p, 'stock') || hasPermission(p, 'damage_manage') },
      { id: 'store-history',  label: 'Store History',  route: '/store-history',  icon: History },
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
      { id: 'library-bag-sizes', label: 'Bag Sizes',      route: '/library/bag-sizes', icon: Scale,   gate: (p) => hasPermission(p, 'users_manage') },
    ],
  },
  {
    id: 'procurement', label: 'PROCUREMENT', icon: ShoppingCart,
    items: [
      { id: 'procurement-overview',   label: 'Overview',         route: '/procurement',               icon: BarChart3,  gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-pos',        label: 'Purchase Orders',  route: '/procurement/pos',           icon: FileText,   gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-reorders',   label: 'Reorders',         route: '/procurement/reorders',      icon: RefreshCw,  gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-vendors',    label: 'Vendors',          route: '/procurement/vendors',       icon: Building,   gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-forwarders', label: 'Forwarders',       route: '/procurement/forwarders',    icon: Truck,      gate: (p) => hasPermission(p, 'procurement_view') },
      { separator: true },
      // New Product Registration — gated on procurement_china (same restriction as China POs).
      { id: 'products-register',      label: 'New Product',      route: '/products/register',         icon: Package,    gate: (p) => hasPermission(p, 'procurement_china') },
    ],
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
