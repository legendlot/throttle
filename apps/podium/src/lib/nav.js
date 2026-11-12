import {
  Users, Network, Briefcase, Building2, BarChart3, Settings, UserPlus,
  Star, Activity, ShieldCheck, UserCog, ClipboardCheck, BookOpen, Factory, Wallet,
  TrendingUp, Target, ClipboardList, FileSignature, LogOut, ListChecks, IdCard, UserCheck, ScrollText, CalendarClock,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    id: 'people', label: 'PEOPLE', icon: Users,
    items: [
      // Browse surfaces require podium_view — a self-only user (no role) sees only My Performance.
      { id: 'dashboard',   label: 'Dashboard',   route: '/dashboard',   icon: BarChart3, requires: 'podium_view' },
      { id: 'people',      label: 'Directory',   route: '/people',      icon: Users,     requires: 'podium_view' },
      { id: 'org',         label: 'Org Chart',   route: '/org',         icon: Network,   requires: 'podium_view' },
      { id: 'new',         label: 'New Person',  route: '/people/new',  icon: UserPlus, accent: 'orange', requires: 'podium_hr' },
      // X1 — open exits, Google accounts to action, the backfill review (HR; the worker gates getExits).
      { id: 'exits',       label: 'Exits',       route: '/exits',       icon: LogOut,    requires: 'podium_hr' },
      // J2 — joiners' onboarding, the profile campaign, PAN / bank change requests, the XPayroll export (HR).
      { id: 'onboarding',  label: 'Onboarding',  route: '/onboarding',  icon: UserCheck, requires: 'podium_hr' },
    ],
  },
  {
    id: 'performance', label: 'PERFORMANCE', icon: Activity,
    items: [
      { id: 'me',   label: 'My Performance', route: '/me',   icon: Star },
      // J2 — your own profile / documents / policies (+ "Your first weeks" for a joiner). No requires: a joiner
      // has no Podium role, and this is where the banner sends them.
      { id: 'welcome', label: 'My Profile', route: '/welcome', icon: IdCard },
      // Everyone: your self-appraisal + the reports you must review, for the open cycle.
      { id: 'reviews', label: 'Reviews', route: '/reviews', icon: ClipboardList },
      { id: 'okrs', label: 'OKRs',           route: '/okrs', icon: Target,   requires: 'podium_view' },
      { id: 'team', label: 'Team',           route: '/team', icon: Activity, requires: 'podium_view' },
      // Cycles, the all-employees grid and calibration: super admins only (Vinay + Afshaan), S396.
      { id: 'appraisals', label: 'Appraisals', route: '/appraisals', icon: ClipboardCheck, requires: 'podium_super_admin' },
      { id: 'analytics', label: 'Analytics', route: '/analytics', icon: TrendingUp, requires: 'podium_hr' },
    ],
  },
  {
    // Hiring (C1 openings + C2 candidates). podium_hiring_access is getMe's display flag:
    // podium_hiring OR a people manager OR on any opening's chain — the worker self-scopes every action.
    id: 'hiring', label: 'HIRING', icon: UserPlus,
    items: [
      { id: 'openings',   label: 'Openings',   route: '/hiring/openings', icon: Briefcase, requires: 'podium_hiring_access' },
      { id: 'candidates', label: 'Candidates', route: '/hiring',          icon: Users,     requires: 'podium_hiring_access' },
      // O2 (D9): podium_interviews_access = getMe's display flag for a seat on any non-cancelled interview panel.
      // Separate from podium_hiring_access, so a pure interviewer sees only this item. The badge is the overdue count.
      { id: 'interviews', label: 'My interviews', route: '/hiring/interviews', icon: CalendarClock, requires: 'podium_interviews_access' },
    ],
  },
  {
    id: 'org', label: 'ORG DESIGN', icon: Briefcase,
    items: [
      { id: 'roles',       label: 'Roles & KPIs', route: '/roles',       icon: Briefcase, requires: 'podium_view' },
      { id: 'departments', label: 'Departments',  route: '/departments', icon: Building2,  requires: 'podium_view' },
    ],
  },
  {
    id: 'manual', label: 'System Manual', flat: true, route: '/manual', icon: BookOpen,
  },
  {
    id: 'admin', label: 'ADMIN', icon: Settings,
    items: [
      { id: 'perm-roles', label: 'Roles & Permissions', route: '/admin/roles',    icon: ShieldCheck, requires: 'podium_admin' },
      { id: 'perm-users', label: 'Users',               route: '/admin/users',    icon: UserCog,     requires: 'podium_admin' },
      { id: 'settings',   label: 'Settings',            route: '/admin/settings', icon: Settings,    requires: 'podium_admin' },
      // Payouts + Factory Cost are salary-tier; gated to podium_admin in the sidebar (the comp
      // group are all admins today) — the worker enforces the comp allow-list server-side.
      { id: 'payouts',    label: 'Payouts',             route: '/admin/payouts',  icon: Wallet,      requires: 'podium_admin' },
      { id: 'factory-cost', label: 'Factory Cost',      route: '/admin/factory-cost', icon: Factory, requires: 'podium_admin' },
      // Hiring C3 — offer templates + signatories. podium_offer_templates is getMe's display flag
      // (salary allow-list OR podium_admin, = the worker's canAdminOfferTemplates).
      { id: 'offer-templates', label: 'Offer Templates', route: '/admin/offer-templates', icon: FileSignature, requires: 'podium_offer_templates' },
      // X1 — the no-dues template + tools list (HR / admin; the worker gates with isHr).
      { id: 'exit-checklist', label: 'Exit Checklist', route: '/admin/exit-checklist', icon: ListChecks, requires: 'podium_hr' },
      // J2 — the onboarding template + policies (HR / admin; the worker gates with isHr).
      { id: 'onboarding-checklist', label: 'Onboarding Checklist', route: '/admin/onboarding-checklist', icon: ListChecks, requires: 'podium_hr' },
      { id: 'policies', label: 'Policies', route: '/admin/policies', icon: ScrollText, requires: 'podium_hr' },
    ],
  },
];

export function filterNavByPerms(groups, perms) {
  return groups
    .map(g => g.flat ? g : ({
      ...g,
      items: (g.items || []).filter(it => !it.requires || perms?.[it.requires]),
    }))
    .filter(g => g.flat || (g.items && g.items.length > 0));
}
