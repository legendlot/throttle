import {
  Factory, GitBranch, ShieldCheck,
  Bell, Undo2, ScanLine, Edit3,
  Truck, Network, Send, Tag,
  Wrench,
  BarChart3, Clock,
  QrCode, Users, Printer,
  CalendarClock, LayoutGrid, ClipboardList,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'production', label: 'PRODUCTION', icon: Factory,
    items: [
      { id: 'exec',     label: 'Dashboard', route: '/exec',     icon: BarChart3 },
      { id: 'planner',     label: 'Planner',     route: '/planner',     icon: CalendarClock },
      { id: 'line-design', label: 'Line Design', route: '/line-design', icon: LayoutGrid },
      { id: 'line-setup',  label: 'Line Setup',  route: '/line-setup',  icon: ClipboardList },
      { id: 'lines',       label: 'Lines',       route: '/lines',       icon: GitBranch },
      { id: 'manpower', label: 'Manpower',  route: '/manpower', icon: Users },
      { id: 'hourly',   label: 'Hourly',    route: '/hourly',   icon: Clock },
      { id: 'qc',       label: 'QC',        route: '/qc',       icon: ShieldCheck },
    ],
  },
  {
    id: 'activity', label: 'ACTIVITY', icon: Bell,
    items: [
      { id: 'alerts',      label: 'Alerts',      route: '/alerts',      icon: Bell,     badgeColor: 'red' },
      { id: 'returns',     label: 'Returns',     route: '/returns',     icon: Undo2,    badgeColor: 'orange' },
      { id: 'scans',       label: 'Scans',       route: '/scans',       icon: ScanLine },
      { id: 'corrections', label: 'Corrections', route: '/corrections', icon: Edit3 },
    ],
  },
  {
    id: 'dispatch', label: 'DISPATCH', icon: Truck,
    items: [
      { id: 'dispatch',           label: 'Overview',        route: '/dispatch',           icon: Truck },
      { id: 'dispatch-pipeline',  label: 'Pipeline',        route: '/dispatch-pipeline',  icon: Network },
      { id: 'dispatch-shipments', label: 'Shipments',       route: '/dispatch-shipments', icon: Send },
      { id: 'dispatch-channels',  label: 'Channel Master',  route: '/dispatch-channels',  icon: Tag },
    ],
  },
  {
    id: 'repair', label: 'REPAIR', icon: Wrench,
    items: [
      { id: 'repair-queue', label: 'Queue', route: '/repair-queue', icon: Wrench },
    ],
  },
  {
    id: 'reporting', label: 'REPORTING', icon: BarChart3,
    items: [
      { id: 'reporting', label: 'Reporting', route: '/reporting', icon: BarChart3 },
    ],
  },
  {
    id: 'admin', label: 'ADMIN', icon: Users,
    items: [
      { id: 'upc',       label: 'UPC Generator', route: '/upc',       icon: QrCode },
      { id: 'operators', label: 'Operators',     route: '/operators', icon: Users },
      { id: 'print',     label: 'Print',         route: '/print',     icon: Printer },
    ],
  },
];
