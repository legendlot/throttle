import { hasPermission } from '@throttle/auth';

// Mirrors legacy 04_stores/index.html nav structure (lines 1018–1080):
// OVERVIEW · INVENTORY · PRODUCTION · STORE · RETURNS · LIBRARY · PROCUREMENT · USERS
// Returns / Procurement / Users render as flat single-button tabs (no dropdown carat).

const GROUPS = [
  {
    id: 'overview', label: 'OVERVIEW',
    items: [
      { id: 'dashboard', label: 'Dashboard',    route: '/dashboard', gate: (p) => hasPermission(p, 'dashboard') },
      { id: 'activity',  label: 'Activity Log', route: '/activity',  gate: (p) => hasPermission(p, 'reports') || hasPermission(p, 'users_view') },
      { id: 'reports',   label: 'Reports',      route: '/reports',   gate: (p) => hasPermission(p, 'reports') },
    ],
  },
  {
    id: 'inventory', label: 'INVENTORY',
    items: [
      { id: 'stock',     label: 'Stock Ledger', route: '/stock',     gate: (p) => hasPermission(p, 'stock') },
      { id: 'grn',       label: 'GRN Entry',    route: '/grn',       gate: (p) => hasPermission(p, 'grn') },
      { id: 'receiving', label: 'Receiving',    route: '/receiving', gate: (p) => hasPermission(p, 'receiving') },
    ],
  },
  {
    id: 'production', label: 'PRODUCTION',
    items: [
      // TODO: TD-005 — wire production_runs gate from G-W7
      { id: 'production-runs', label: 'Production Runs', route: '/production-runs' },
      { id: 'work-orders',     label: 'Ad Hoc Requests', route: '/work-orders', gate: (p) => hasPermission(p, 'work_order') },
      { id: 'line-flush',      label: 'Line Flush',      route: '/line-flush',  gate: (p) => hasPermission(p, 'line_flush_create') || hasPermission(p, 'line_flush_verify') },
    ],
  },
  {
    id: 'store', label: 'STORE',
    items: [
      { id: 'issue-queue',   label: 'Issue Queue',   route: '/issue-queue',   gate: (p) => hasPermission(p, 'stock_issue') },
      { id: 'flush-verify',  label: 'Flush Verify',  route: '/flush-verify',  gate: (p) => hasPermission(p, 'line_flush_verify') },
      { id: 'store-history', label: 'Store History', route: '/store-history' },
      { separator: true },
      { id: 'manpower',      label: 'Manpower',      route: '/manpower',      gate: (p) => hasPermission(p, 'dashboard') },
    ],
  },
  {
    id: 'returns', label: 'RETURNS', flat: true, route: '/returns/shipments',
    gate: (p) => hasPermission(p, 'returns'),
  },
  {
    id: 'library', label: 'LIBRARY',
    items: [
      { id: 'library-downloads', label: 'Downloads',      route: '/library/downloads' },
      { id: 'library-parts',     label: 'Parts Database', route: '/library/parts' },
    ],
  },
  {
    id: 'procurement', label: 'PROCUREMENT',
    items: [
      { id: 'procurement-overview',   label: 'Overview',         route: '/procurement',               gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-pos',        label: 'Purchase Orders',  route: '/procurement/pos',           gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-reorders',   label: 'Reorders',         route: '/procurement/reorders',      gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-vendors',    label: 'Vendors',          route: '/procurement/vendors',       gate: (p) => hasPermission(p, 'procurement_view') },
      { id: 'procurement-forwarders', label: 'Forwarders',       route: '/procurement/forwarders',    gate: (p) => hasPermission(p, 'procurement_view') },
    ],
  },
  {
    id: 'users', label: 'USERS', flat: true, route: '/users',
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
      // Drop leading/trailing/consecutive separators
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
