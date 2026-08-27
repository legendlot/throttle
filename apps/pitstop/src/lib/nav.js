/* ════════════════════════════════════════════════════════════
   Pitstop "Volt" navigation (handoff §3 IA overhaul).
   5 WORK destinations + a SETUP·ADMIN group + System Manual.
   Icons are kit icon names (resolved by kit/Icon.js → lucide).
   `requires` = a permission key; filtered by filterNavByPerms.
   `badgeKey` = a key into the live counts the layout passes down.
   ════════════════════════════════════════════════════════════ */

export const NAV_PRIMARY = [
  { id: 'overview', label: 'Overview',   route: '/',       icon: 'grid' },
  { id: 'queue',    label: 'Queue',      route: '/queue',  icon: 'list',  badgeKey: 'open' },
  { id: 'new',      label: 'New Ticket', route: '/new',    icon: 'plus' },
  { id: 'calls',    label: 'Calls',      route: '/calls',  icon: 'phone', badgeKey: 'missed' },
  { id: 'inbox',    label: 'Inbox',      route: '/inbox',  icon: 'msg' },
  { id: 'analytics',label: 'Analytics',  route: '/analytics', icon: 'chart', requires: 'cs_reports_view' },
  { id: 'reports',  label: 'Reports',    route: '/reports',icon: 'chart', requires: 'cs_reports_view' },
  { id: 'history',  label: 'History',    route: '/history',icon: 'trend', requires: 'cs_reports_view' },
];

export const NAV_SETUP = [
  { id: 'shifts',      label: 'Shifts & Presence', route: '/admin/shifts',    icon: 'users', requires: 'cs_ticket_reassign' },
  { id: 'departments', label: 'Departments',   route: '/admin/departments',  icon: 'users', requires: 'cs_ticket_admin' },
  { id: 'myop',        label: 'MyOp Accounts', route: '/admin/myop',         icon: 'phone', requires: 'cs_ticket_admin' },
  { id: 'telephony',   label: 'Telephony',     route: '/admin/telephony',    icon: 'phone', requires: 'cs_ticket_admin' },
  { id: 'wa',          label: 'WA Templates',  route: '/admin/wa-templates', icon: 'msg',   requires: 'cs_ticket_admin' },
  { id: 'meta',        label: 'Meta Diagnostics', route: '/admin/meta',     icon: 'alert', requires: 'cs_ticket_admin' },
  { id: 'tags',        label: 'Tags',          route: '/admin/tags',         icon: 'list',  requires: 'cs_ticket_admin' },
  { id: 'canned',      label: 'Canned Responses', route: '/admin/canned',  icon: 'msg',   requires: 'cs_ticket_manage' },
];

export const NAV_MANUAL = { id: 'manual', label: 'System Manual', route: '/manual', icon: 'book' };

// Hidden routes that still need a crumb/title in the topbar (no sidebar entry).
export const NAV_HIDDEN = [
  { id: 'ticket', label: 'Ticket',      route: '/queue/detail', crumb: 'Work' },
  { id: 'call',   label: 'Call Detail', route: '/calls/detail', crumb: 'Work' },
];

// Topbar breadcrumb + title per screen.
const CRUMBS = {
  '/':                    { crumb: 'Customer Success', title: 'Overview' },
  '/queue/detail':        { crumb: 'Work',             title: 'Ticket' },
  '/queue':               { crumb: 'Work',             title: 'Ticket Queue' },
  '/calls/detail':        { crumb: 'Work',             title: 'Call Detail' },
  '/calls':               { crumb: 'Work',             title: 'Call Log' },
  '/inbox':               { crumb: 'Work',             title: 'Inbox' },
  '/new':                 { crumb: 'Work',             title: 'New Ticket' },
  '/analytics':           { crumb: 'Analyze',          title: 'Support Analytics' },
  '/reports':             { crumb: 'Analyze',          title: 'Reports' },
  '/history':             { crumb: 'Analyze',          title: 'Ticket History' },
  '/admin/shifts':        { crumb: 'Setup · Admin',    title: 'Shifts & Presence' },
  '/admin/departments':   { crumb: 'Setup · Admin',    title: 'Departments' },
  '/admin/myop':          { crumb: 'Setup · Admin',    title: 'MyOperator Accounts' },
  '/admin/telephony':     { crumb: 'Setup · Admin',    title: 'Telephony' },
  '/admin/wa-templates':  { crumb: 'Setup · Admin',    title: 'WhatsApp Templates' },
  '/admin/meta':          { crumb: 'Setup · Admin',    title: 'Meta Diagnostics' },
  '/admin/tags':          { crumb: 'Setup · Admin',    title: 'Tags' },
  '/admin/canned':        { crumb: 'Setup · Admin',    title: 'Canned Responses' },
  '/manual':              { crumb: 'Help',             title: 'System Manual' },
};

const norm = (p) => (p || '/').replace(/\/+$/, '') || '/';

export const routeMatch = (pathname, route) => {
  const a = norm(pathname);
  const r = norm(route);
  return r === '/' ? a === '/' : (a === r || a.startsWith(r + '/'));
};

/** Resolve the active screen's breadcrumb + title from the pathname. */
export function resolveNav(pathname) {
  const a = norm(pathname);
  // longest-prefix match (so /queue/detail beats /queue)
  const keys = Object.keys(CRUMBS).sort((x, y) => y.length - x.length);
  for (const k of keys) {
    if (k === '/' ? a === '/' : (a === norm(k) || a.startsWith(norm(k) + '/'))) return CRUMBS[k];
  }
  return { crumb: 'Pitstop', title: '' };
}

/** Drop items the user lacks the perm for. */
export function filterNav(items, perms) {
  return (items || []).filter(it => !it.requires || perms?.[it.requires]);
}

// Back-compat: a couple of older call sites import filterNavByPerms.
export function filterNavByPerms(items, perms) {
  return filterNav(items, perms);
}
