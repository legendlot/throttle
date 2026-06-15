import {
  LayoutDashboard, Package, Ship, Wallet, HandCoins, Banknote, Receipt,
  FileText, Scale, ArrowLeftRight, Shield, Users,
} from 'lucide-react';

// Nav gated by Manifest permission keys (from getMe). Items with no `requires`
// are visible to any signed-in user (LOT or SF). SF roles lack the LOT-only keys
// (payment_record, fx_manage, manifest_admin, china_po_sync) so those items drop.
export const NAV_GROUPS = [
  {
    id: 'overview', label: 'OVERVIEW', icon: LayoutDashboard,
    items: [
      { id: 'dashboard', label: 'Dashboard', route: '/dashboard', icon: LayoutDashboard, requires: 'manifest_view' },
    ],
  },
  {
    id: 'orders', label: 'ORDERS', icon: Package,
    items: [
      { id: 'orders',     label: 'China Orders', route: '/orders',     icon: Package,  requires: 'manifest_view' },
      { id: 'orders-new', label: 'New Order',    route: '/orders/new', icon: FileText, requires: 'order_manage', accent: 'orange' },
    ],
  },
  {
    id: 'shipments', label: 'SHIPMENTS', icon: Ship,
    items: [
      { id: 'shipments', label: 'Shipments', route: '/shipments', icon: Ship, requires: 'manifest_view' },
    ],
  },
  {
    id: 'money', label: 'MONEY', icon: Wallet,
    items: [
      { id: 'running-account', label: 'Running Account', route: '/money/running-account', icon: Scale,         requires: 'manifest_view' },
      { id: 'drawdowns',       label: 'Draw-downs',       route: '/money/drawdowns',       icon: HandCoins,     requires: 'manifest_view' },
      { id: 'payments',        label: 'Payments (→SF)',   route: '/money/payments',        icon: Banknote,      requires: 'payment_record' },
      { id: 'vendor-payments', label: 'Vendor Payments',  route: '/money/vendor-payments', icon: ArrowLeftRight, requires: 'manifest_view' },
      { id: 'fx',              label: 'Exchange Rates',   route: '/money/fx',              icon: Receipt,       requires: 'manifest_view' },
    ],
  },
  {
    id: 'documents', label: 'EVIDENCE', icon: FileText,
    items: [
      { id: 'documents', label: 'Documents', route: '/documents', icon: FileText, requires: 'manifest_view' },
    ],
  },
  {
    id: 'admin', label: 'ADMIN', icon: Shield,
    items: [
      { id: 'admin-roles', label: 'Roles & Permissions', route: '/admin/roles', icon: Shield, requires: 'manifest_admin' },
      { id: 'admin-users', label: 'Users',                route: '/admin/users', icon: Users,  requires: 'manifest_admin' },
    ],
  },
];

export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => g.flat ? g : ({ ...g, items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]) }))
    .filter(g => g.flat || (g.items && g.items.length > 0));
}
