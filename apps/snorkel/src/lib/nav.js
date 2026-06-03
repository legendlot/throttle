import {
  ShoppingCart, BarChart3, FileText, RefreshCw, Building, Truck, Package, BookOpen,
  Inbox, Wallet, Shield, Users, Boxes, Settings, Store, ClipboardList, HandCoins,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    // Requests = everyone's front door. No `requires` → visible to any authed user.
    id: 'requests', label: 'REQUESTS', icon: Inbox,
    items: [
      { id: 'requests',     label: 'PO Requests', route: '/requests',     icon: Inbox },
      { id: 'requests-new', label: 'New Request',  route: '/requests/new', icon: FileText, accent: 'orange' },
    ],
  },
  {
    id: 'procurement', label: 'PROCUREMENT', icon: ShoppingCart,
    items: [
      { id: 'procurement-overview',   label: 'Overview',        route: '/procurement',            icon: BarChart3, requires: 'procurement_view' },
      { id: 'procurement-pos',        label: 'Purchase Orders', route: '/procurement/pos',        icon: FileText,  requires: 'procurement_view' },
      { id: 'procurement-reorders',   label: 'Reorders',        route: '/procurement/reorders',   icon: RefreshCw, requires: 'procurement_view' },
      { id: 'procurement-vendors',    label: 'Vendors',         route: '/procurement/vendors',    icon: Building,  requires: 'vendor_manage' },
      { id: 'procurement-forwarders', label: 'Forwarders',      route: '/procurement/forwarders', icon: Truck,     requires: 'vendor_manage' },
      { id: 'products-register',      label: 'New Product',     route: '/products/register',      icon: Package,   requires: 'po_china' },
    ],
  },
  {
    id: 'payments', label: 'PAYMENTS', icon: Wallet,
    items: [
      { id: 'payments', label: 'Payment Queue', route: '/payments', icon: Wallet, requires: 'payment_route' },
    ],
  },
  {
    id: 'sales', label: 'OFFLINE SALES', icon: Store,
    items: [
      { id: 'sales-orders',      label: 'Sales Orders',  route: '/sales/orders',      icon: ClipboardList, requires: 'sales_view' },
      { id: 'sales-collections', label: 'Collections',   route: '/sales/collections', icon: HandCoins,     requires: 'sales_view' },
      { id: 'sales-partners',    label: 'Partners',      route: '/sales/partners',    icon: Building,      requires: 'sales_view' },
      { id: 'sales-settings',    label: 'Channels',      route: '/sales/settings',    icon: Settings,      requires: 'sales_partner_manage' },
    ],
  },
  {
    id: 'assets', label: 'ASSETS', icon: Boxes,
    items: [
      { id: 'assets',          label: 'Asset Register',         route: '/assets',          icon: Boxes,    requires: 'asset_view' },
      { id: 'assets-settings', label: 'Categories & Locations', route: '/assets/settings', icon: Settings, requires: 'asset_manage' },
    ],
  },
  {
    id: 'library', label: 'LIBRARY', icon: BookOpen,
    items: [
      { id: 'library-addresses', label: 'Addresses', route: '/library/addresses', icon: Building, requires: 'company_address_manage' },
    ],
  },
  {
    id: 'admin', label: 'ADMIN', icon: Shield,
    items: [
      { id: 'admin-roles', label: 'Roles & Permissions', route: '/admin/roles', icon: Shield, requires: 'snorkel_admin' },
      { id: 'admin-users', label: 'Users',                route: '/admin/users', icon: Users,  requires: 'snorkel_admin' },
    ],
  },
];

// Items with no `requires` are always visible. Drop items the user lacks the perm for,
// then drop now-empty groups. (perms = the user's Snorkel permissions from getMe.)
export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.items.length > 0);
}
