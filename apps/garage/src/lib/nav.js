import { hasPermission } from '@throttle/auth';

const GROUPS = [
  {
    id: 'store', label: 'STORE',
    items: [
      { id: 'dashboard',      label: 'Dashboard',      route: '/dashboard',      gate: (p) => hasPermission(p, 'dashboard') },
      { id: 'stock',          label: 'Stock',          route: '/stock',          gate: (p) => hasPermission(p, 'stock') },
      { id: 'grn',            label: 'GRN',            route: '/grn',            gate: (p) => hasPermission(p, 'grn') },
      { id: 'receiving',      label: 'Receiving',      route: '/receiving',      gate: (p) => hasPermission(p, 'receiving') },
      { id: 'issue-queue',    label: 'Issue Queue',    route: '/issue-queue',    gate: (p) => hasPermission(p, 'stock_issue') },
      { id: 'flush-verify',   label: 'Flush Verify',   route: '/flush-verify',   gate: (p) => hasPermission(p, 'line_flush_verify') },
      { id: 'line-flush',     label: 'Line Flush',     route: '/line-flush',     gate: (p) => hasPermission(p, 'line_flush_create') || hasPermission(p, 'line_flush_verify') },
      { id: 'store-history',  label: 'Store History',  route: '/store-history' },
      { id: 'manpower',       label: 'Manpower',       route: '/manpower',       gate: (p) => hasPermission(p, 'dashboard') },
    ],
  },
  {
    id: 'production', label: 'PRODUCTION',
    items: [
      // TODO: TD-005 — wire production_runs gate from G-W7
      { id: 'production-runs', label: 'Production Runs', route: '/production-runs' },
      { id: 'work-orders',     label: 'Ad Hoc Requests', route: '/work-orders', gate: (p) => hasPermission(p, 'work_order') },
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
    id: 'returns', label: 'RETURNS',
    items: [
      { id: 'returns-shipments', label: 'Shipments', route: '/returns/shipments', gate: (p) => hasPermission(p, 'returns') },
      { id: 'returns-process',   label: 'Process',   route: '/returns/process',   gate: (p) => hasPermission(p, 'returns') },
      { id: 'returns-losses',    label: 'Losses',    route: '/returns/losses',    gate: (p) => hasPermission(p, 'returns') },
      { id: 'returns-channels',  label: 'Channels',  route: '/returns/channels',  gate: (p) => hasPermission(p, 'returns') },
    ],
  },
  {
    id: 'reports', label: 'REPORTS',
    items: [
      { id: 'reports',  label: 'Reports',  route: '/reports',  gate: (p) => hasPermission(p, 'reports') },
      { id: 'activity', label: 'Activity', route: '/activity', gate: (p) => hasPermission(p, 'reports') || hasPermission(p, 'users_view') },
    ],
  },
  {
    id: 'admin', label: 'ADMIN',
    items: [
      { id: 'users',    label: 'Users',     route: '/users',             gate: (p) => hasPermission(p, 'users_view') || hasPermission(p, 'users_manage') },
      { id: 'library-downloads', label: 'Downloads', route: '/library/downloads' },
      { id: 'library-parts',     label: 'Parts',     route: '/library/parts' },
    ],
  },
];

export function useNavGroups(perms) {
  return GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.gate || i.gate(perms)) }))
    .filter((g) => g.items.length > 0);
}
