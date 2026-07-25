'use client';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, AppLauncher } from '@throttle/ui';
import {
  LayoutDashboard, BarChart3, Store, Megaphone, Filter, Package, Landmark, Boxes,
  Gauge, Share2, Cable, Upload, Shield, LogOut, PanelLeftClose, Search,
} from 'lucide-react';
import { FreshnessProvider, FreshnessChip, useFreshness } from '../../components/Freshness.js';
import { CommandPalette, useCommandPalette, paletteEntries } from '../../components/CommandPalette.js';

// ── IA (handoff §4) ──────────────────────────────────────────────────────────
// Five task-based groups. ROUTES ARE UNCHANGED — this only regroups + relabels.
// Channels / P&L / Products no longer spill their children into the rail; each has an
// in-page scope-tab strip instead, and every scope is reachable from ⌘K.
// `perm` / `adminAlt` gating is copied verbatim from the previous rail — a screen a
// user could see before is still visible, and one they couldn't is still hidden.
const NAV = [
  { label: 'Overview', items: [
    { route: '/',            label: 'Dashboard',   icon: LayoutDashboard, perm: 'sales_view' },
  ] },
  { label: 'Sales', items: [
    { route: '/performance', label: 'Performance', icon: BarChart3,       perm: 'sales_view' },
    { route: '/channels',    label: 'Channels',    icon: Store,           perm: 'sales_view', to: '/channels/website' },
    { route: '/marketing',   label: 'Marketing',   icon: Megaphone,       perm: 'sales_view' },
    { route: '/funnel',      label: 'Funnel',      icon: Filter,          perm: 'sales_view' },
  ] },
  { label: 'Catalog', items: [
    { route: '/products',    label: 'Products',    icon: Package,         perm: 'sales_view', to: '/products/drr' },
    { route: '/pnl',         label: 'P&L',         icon: Landmark,        perm: 'sales_view', to: '/pnl/overall' },
    { route: '/inventory',   label: 'Inventory',   icon: Boxes,           perm: 'sales_view' },
  ] },
  { label: 'Pipeline', items: [
    { route: '/dyno',        label: 'Dyno',        icon: Gauge,           perm: 'sales_view' },
    { route: '/mapping',     label: 'Mapping',     icon: Share2,          perm: 'sales_view' },
    { route: '/connectors',  label: 'Connectors',  icon: Cable,           perm: 'sales_view' },
    { route: '/uploads',     label: 'Uploads',     icon: Upload,          perm: 'sales_upload', adminAlt: 'salesops_admin' },
  ] },
  { label: 'Admin', items: [
    { route: '/admin',       label: 'Admin',       icon: Shield,          perm: 'salesops_admin' },
  ] },
];

const RAIL_KEY = 'odo-rail-collapsed';

export default function AuthLayout({ children }) {
  return <RequireAuth><FreshnessProvider><Shell>{children}</Shell></FreshnessProvider></RequireAuth>;
}

function Shell({ children }) {
  const { user, perms, signOut, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const cmd = useCommandPalette();

  // Rail state persists across reloads. Read after mount so the static export's first
  // paint matches the server HTML (no hydration mismatch), then snap to the stored value.
  useEffect(() => {
    setMounted(true);
    try { setCollapsed(localStorage.getItem(RAIL_KEY) === '1'); } catch { /* private mode */ }
  }, []);
  const toggleRail = () => setCollapsed(c => {
    const n = !c;
    try { localStorage.setItem(RAIL_KEY, n ? '1' : '0'); } catch { /* private mode */ }
    return n;
  });

  const P = perms || {};
  const can = (item) => !!P[item.perm] || !!P.salesops_admin || (item.adminAlt && !!P[item.adminAlt]);
  // Groups whose every item is gated out disappear entirely (no orphan header).
  const groups = NAV.map(g => ({ ...g, items: g.items.filter(can) })).filter(g => g.items.length);

  // `startsWith` is what lets /dyno/screen|scaling|matrix, /channels/*, /pnl/* and
  // /products/* all hold their rail item.
  const active = (route) => route === '/' ? pathname === '/' : (pathname === route || pathname.startsWith(route + '/'));
  const flat = groups.flatMap(g => g.items.map(it => ({ ...it, group: g.label })));
  const here = flat.find(it => active(it.route));

  const entries = useMemo(() => paletteEntries(groups), [groups]);

  if (loading && !user) return <Spinner />;

  return (
    <div className="so-app">
      <aside className={`so-side${collapsed ? ' collapsed' : ''}`}>
        {/* header — wordmark + rail toggle.
            Collapsed, the rail is 70px wide (46px inside the gutter), which cannot hold the
            34px mark AND a separate toggle button side by side. So collapsed the MARK IS the
            toggle: one centred button, tooltipped, that expands the rail again. */}
        <div style={{ height: 58, flex: 'none', display: 'flex', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start', gap: 11,
          padding: collapsed ? '0 8px' : '0 16px', borderBottom: '1px solid var(--border-2)' }}>
          {collapsed ? (
            <button className="so-btn bare" onClick={toggleRail} title="Expand sidebar"
              style={{ display: 'flex', alignItems: 'center', padding: 3, borderRadius: 12 }}>
              <img src="/favicon.svg" alt="Odo — expand sidebar" style={{ width: 34, height: 34, display: 'block', borderRadius: 11 }} />
            </button>
          ) : (
            <>
              <img src="/favicon.svg" alt="Odo" style={{ width: 34, height: 34, flex: 'none', borderRadius: 11 }} />
              <div style={{ flex: 1, minWidth: 0, lineHeight: 1 }}>
                <div style={{ fontFamily: 'var(--cond)', fontWeight: 800, fontSize: 16, letterSpacing: '.1em', color: 'var(--t1)' }}>ODO</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.14em', color: 'var(--t4)', marginTop: 3 }}>SALES OPS</div>
              </div>
              <button className="so-btn bare" onClick={toggleRail} title="Collapse sidebar"
                style={{ display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6 }}>
                <PanelLeftClose size={18} strokeWidth={1.75} style={{ color: 'var(--t3)' }} />
              </button>
            </>
          )}
        </div>

        {/* ⌘K launcher */}
        {!collapsed && (
          <button onClick={() => cmd.setOpen(true)}
            style={{ margin: '12px 14px 4px', display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer',
              background: 'var(--control)', border: '1px solid var(--border-table)', borderRadius: 11,
              padding: '9px 11px', textAlign: 'left' }}>
            <Search size={16} strokeWidth={1.75} style={{ color: 'var(--t3)', flex: 'none' }} />
            {/* --t3, not --t4: this is 13px prose, and --t4/--t5 are mono-micro-label-only tokens
                (--t4 measures 3.87:1 here, under the 4.5:1 AA floor). */}
            <span style={{ flex: 1, fontSize: 13, color: 'var(--t3)', fontFamily: 'var(--ui)' }}>Search or jump to…</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)', border: '1px solid #2c2f36', borderRadius: 5, padding: '2px 6px' }}>⌘K</span>
          </button>
        )}

        <nav className="so-navscroll">
          {groups.map(g => (
            <div key={g.label}>
              {collapsed
                ? <div className="so-navrule" />
                : <div className="so-navgroup">{g.label}</div>}
              {g.items.map(it => {
                const Icon = it.icon;
                const on = active(it.route);
                return (
                  // `title` ONLY when collapsed — expanded, the label is right there and a native
                  // tooltip just throws a black box over the rail on every hover.
                  <button key={it.route} className={`so-nav${on ? ' active' : ''}`}
                    title={collapsed ? it.label : undefined}
                    onClick={() => router.push(it.to || it.route)}>
                    <Icon size={18} strokeWidth={1.75} style={{ flex: 'none' }} />
                    {!collapsed && <span className="so-navlbl">{it.label}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {!collapsed && <FreshnessCard onClick={() => router.push('/connectors')} />}

        <div style={{ borderTop: '1px solid var(--border-2)', flex: 'none', padding: '12px 14px',
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <div title={user?.full_name || user?.email} style={{ width: 32, height: 32, flex: 'none', borderRadius: 10,
            background: 'var(--accent-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--cond)', fontWeight: 800, color: 'var(--accent-fg)', fontSize: 13 }}>
            {(user?.full_name || user?.email || '?').trim().charAt(0).toUpperCase()}
          </div>
          {!collapsed && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user?.full_name || user?.email}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t4)' }}>
                  {P.salesops_super_admin ? 'salesops · super admin' : P.salesops_admin ? 'salesops · admin' : 'salesops'}
                </div>
              </div>
              <button className="so-btn bare" onClick={signOut} title="Sign out" style={{ display: 'flex', padding: 4, borderRadius: 6 }}>
                <LogOut size={17} strokeWidth={1.75} style={{ color: 'var(--t4)' }} />
              </button>
            </>
          )}
        </div>
      </aside>

      <div className="so-main">
        {/* top context bar — breadcrumb left, live/search/launcher right */}
        <header style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 26px', borderBottom: '1px solid #16171c', background: 'var(--topbar)', backdropFilter: 'blur(8px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--mono)', fontSize: 10.5,
            letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--t3)', minWidth: 0 }}>
            <span>{here?.group || 'Odo'}</span>
            <span style={{ color: 'var(--border-strong)' }}>/</span>
            <span style={{ color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{here?.label || 'Odo'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <LiveClock mounted={mounted} />
            <FreshnessChip />
            <button className="so-btn bare" onClick={() => cmd.setOpen(true)} title="Search (⌘K)" style={{ display: 'flex', padding: 3, borderRadius: 6 }}>
              <Search size={18} strokeWidth={1.75} style={{ color: 'var(--t3)' }} />
            </button>
            <AppLauncher current="odo" />
          </div>
        </header>
        <div className="so-scroll">{children}</div>
      </div>

      <CommandPalette open={cmd.open} onClose={() => cmd.setOpen(false)} entries={entries} onGo={(r) => router.push(r)} />
    </div>
  );
}

// LIVE · h:mm IST — a STATUS indicator on the existing refresh cadence, not a new poll.
// Renders only after mount: the clock differs between the static export and the client.
function LiveClock({ mounted }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  if (!mounted) return null;
  const ist = new Date(now + 5.5 * 3600 * 1000);
  const hh = String(ist.getUTCHours()).padStart(2, '0'), mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono)', fontSize: 10.5,
      letterSpacing: '.1em', color: 'var(--t3)', whiteSpace: 'nowrap' }}>
      <span className="so-dot" style={{ background: '#34d399', animation: 'opulse 2.4s infinite' }} />
      LIVE · {hh}:{mm} IST
    </span>
  );
}

// Ambient "is this data trustworthy" signal, derived entirely from the freshness poll the
// shell already runs — no extra request.
function FreshnessCard({ onClick }) {
  const { feeds, loading, oldestOkAt } = useFreshness();
  const enabled = (feeds || []).filter(f => f.enabled);
  if (loading || !enabled.length) return null;
  const healthy = enabled.filter(f => f.last_ok_at && !f.last_error).length;
  const allWell = healthy === enabled.length;
  const hue = allWell ? '52,211,153' : '245,158,11';
  const fg = allWell ? '#34d399' : '#F59E0B';
  return (
    <button onClick={onClick} title="Connector health — open /connectors"
      style={{ margin: '8px 14px', flex: 'none', padding: '12px 13px', textAlign: 'left', cursor: 'pointer', width: 'calc(100% - 28px)',
        background: `linear-gradient(150deg, rgba(${hue},.12), rgba(${hue},.02))`,
        border: `1px solid rgba(${hue},.24)`, borderRadius: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="so-dot" style={{ width: 8, height: 8, background: fg, animation: allWell ? 'opulse 2.2s infinite' : 'none' }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.16em', color: fg }}>
          {allWell ? 'DATA LIVE' : 'DATA DRIFTING'}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 8, lineHeight: 1.4 }}>
        {healthy} of {enabled.length} connectors healthy
      </div>
      {oldestOkAt && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t3)', marginTop: 3 }}>synced {relAge(oldestOkAt)} ago</div>}
    </button>
  );
}

function relAge(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}
