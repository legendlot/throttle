// Manifest "Pit Wall" — nav structure + screen→nav mapping + breadcrumbs.
import {
  LayoutDashboard, Package, Ship, Scale, HandCoins, CreditCard,
  ArrowLeftRight, FileText, ShieldCheck, BookOpen,
} from 'lucide-react';

export const NAV = [
  { kind: 'item', id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { kind: 'section', label: 'Orders' },
  { kind: 'item', id: 'orders',    label: 'China Orders', icon: Package },
  { kind: 'item', id: 'shipments', label: 'Shipments',    icon: Ship },
  { kind: 'section', label: 'Finance' },
  { kind: 'item', id: 'recon',     label: 'Running Account', icon: Scale },
  { kind: 'item', id: 'drawdowns', label: 'Draw-downs',      icon: HandCoins },
  { kind: 'item', id: 'payments',  label: 'Payments',        icon: CreditCard },
  { kind: 'item', id: 'fx',        label: 'Exchange Rates',  icon: ArrowLeftRight },
  { kind: 'section', label: 'Workspace' },
  { kind: 'item', id: 'manual',    label: 'System Manual', icon: BookOpen },
  { kind: 'item', id: 'documents', label: 'Documents', icon: FileText },
  { kind: 'item', id: 'admin',     label: 'Admin',     icon: ShieldCheck, needs: (p) => !!(p && (p.manifest_admin || p.manifest_super_admin)) },
];

// which nav item is highlighted for a given screen
export function activeNav(screen) {
  if (screen === 'orderDetail' || screen === 'newOrder') return 'orders';
  if (screen === 'newDrawdown') return 'drawdowns';
  if (screen === 'shipmentDetail') return 'shipments';
  return screen;
}

// topbar breadcrumb + title per screen
export const CRUMB = {
  dashboard:   { eyebrow: 'OVERVIEW', title: 'Dashboard' },
  orders:      { eyebrow: 'ORDERS',   title: 'China Orders' },
  orderDetail: { eyebrow: 'ORDERS',   title: 'CN-2511-014' },
  recon:       { eyebrow: 'FINANCE',  title: 'Running Account' },
  drawdowns:   { eyebrow: 'FINANCE',  title: 'Draw-downs' },
  shipments:   { eyebrow: 'ORDERS',   title: 'Shipments' },
  shipmentDetail: { eyebrow: 'ORDERS', title: 'Shipment' },
  payments:    { eyebrow: 'FINANCE',  title: 'Payments → Solve Factory' },
  fx:          { eyebrow: 'FINANCE',  title: 'Exchange Rates' },
  documents:   { eyebrow: 'WORKSPACE', title: 'Documents' },
  manual:      { eyebrow: 'WORKSPACE', title: 'System Manual' },
  admin:       { eyebrow: 'WORKSPACE', title: 'Admin' },
  newOrder:    { eyebrow: 'ORDERS',   title: 'New China Order' },
  newDrawdown: { eyebrow: 'FINANCE',  title: 'Raise Draw-down' },
};

export const ACCENTS = ['#F2CD1A', '#213CE2', '#34D27B', '#FF8A3D'];
