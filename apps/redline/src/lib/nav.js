export const NAV_GROUPS = [
  {
    id: 'production', label: 'PRODUCTION',
    items: [
      { id: 'exec',  label: 'Dashboard', route: '/exec' },
      { id: 'lines', label: 'Lines',     route: '/lines' },
      { id: 'qc',    label: 'QC',        route: '/qc' },
    ],
  },
  {
    id: 'activity', label: 'ACTIVITY',
    items: [
      { id: 'alerts',      label: 'Alerts',      route: '/alerts',      badgeColor: 'red' },
      { id: 'returns',     label: 'Returns',     route: '/returns',     badgeColor: 'orange' },
      { id: 'scans',       label: 'Scans',       route: '/scans' },
      { id: 'corrections', label: 'Corrections', route: '/corrections' },
    ],
  },
  {
    id: 'dispatch', label: 'DISPATCH',
    items: [
      { id: 'dispatch',           label: 'Overview',        route: '/dispatch' },
      { id: 'dispatch-pipeline',  label: 'Pipeline',        route: '/dispatch-pipeline' },
      { id: 'dispatch-shipments', label: 'Shipments',       route: '/dispatch-shipments' },
      { id: 'dispatch-channels',  label: 'Channel Master',  route: '/dispatch-channels' },
    ],
  },
  {
    id: 'repair', label: 'REPAIR',
    items: [
      { id: 'repair-queue', label: 'Queue', route: '/repair-queue' },
    ],
  },
  {
    id: 'reporting', label: 'REPORTING',
    items: [
      { id: 'reporting', label: 'Reporting', route: '/reporting' },
    ],
  },
  {
    id: 'admin', label: 'ADMIN',
    items: [
      { id: 'upc',       label: 'UPC Generator', route: '/upc' },
      { id: 'operators', label: 'Operators',     route: '/operators' },
      { id: 'print',     label: 'Print',         route: '/print' },
    ],
  },
];
