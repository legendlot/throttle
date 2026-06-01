import {
  ShoppingCart, BarChart3, FileText, RefreshCw, Building, Truck, Package, BookOpen,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'procurement', label: 'PROCUREMENT', icon: ShoppingCart,
    items: [
      { id: 'procurement-overview',   label: 'Overview',        route: '/procurement',            icon: BarChart3, requires: 'procurement_view' },
      { id: 'procurement-pos',        label: 'Purchase Orders', route: '/procurement/pos',        icon: FileText,  requires: 'procurement_view' },
      { id: 'procurement-reorders',   label: 'Reorders',        route: '/procurement/reorders',   icon: RefreshCw, requires: 'procurement_view' },
      { id: 'procurement-vendors',    label: 'Vendors',         route: '/procurement/vendors',    icon: Building,  requires: 'procurement_view' },
      { id: 'procurement-forwarders', label: 'Forwarders',      route: '/procurement/forwarders', icon: Truck,     requires: 'procurement_view' },
      { id: 'products-register',      label: 'New Product',     route: '/products/register',      icon: Package,   requires: 'procurement_china' },
    ],
  },
  {
    id: 'library', label: 'LIBRARY', icon: BookOpen,
    items: [
      { id: 'library-addresses', label: 'Addresses', route: '/library/addresses', icon: Building, requires: 'company_address_manage' },
    ],
  },
];

// Mirrors the ignition/pitstop pattern: drop items the user lacks `requires` for,
// then drop now-empty groups. Items with no `requires` are always visible.
export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.items.length > 0);
}
