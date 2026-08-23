'use client';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, AppLauncher } from '@throttle/ui';
import {
  LayoutDashboard, BarChart3, Store, Megaphone, Filter, Package, Landmark, Boxes,
  Gauge, Share2, Cable, Upload, Shield, LogOut, PanelLeftClose, Search, Radio, Menu, X,
} from 'lucide-react';
import { FreshnessProvider, FreshnessChip, useFreshness } from '../../components/Freshness.js';
import { feedStatus } from '../../lib/freshness.js';
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
    // Website-only, near-live. Sits under Overview next to the Dashboard because it answers the
    // same question at a different latency — not under Sales, where it would read as a channel.
    { route: '/live',        label: 'Live',        icon: Radio,           perm: 'sales_view' },
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
  const [sheet, setSheet] = useState(false);   // mobile "More" bottom sheet
  const cmd = useCommandPalette();

  // Mobile sheet closes itself on navigation — the tap already said where to go.
  useEffect(() => { setSheet(false); }, [pathname]);

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
              <span style={{ width: 34, height: 34, flex: 'none', borderRadius: 10, background: '#191b23',
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <img src="/odo-mark.svg" alt="Odo — expand sidebar" width={29} height={29} style={{ display: 'block' }} />
              </span>
            </button>
          ) : (
            <>
              <span style={{ width: 34, height: 34, flex: 'none', borderRadius: 10, background: '#191b23',
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <img src="/odo-mark.svg" alt="Odo" width={29} height={29} style={{ display: 'block' }} />
              </span>
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
        <header className="so-topbar" style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
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

      {/* ── mobile app chrome (≤767px — CSS decides, so desktop never renders it visibly) ── */}
      <MobileTabBar flat={flat} active={active} moreOpen={sheet}
        onGo={(r) => { setSheet(false); router.push(r); }} onMore={() => setSheet(s => !s)} />
      {sheet && (
        <MobileSheet groups={groups} active={active} user={user} P={P} signOut={signOut}
          onGo={(r) => router.push(r)} onClose={() => setSheet(false)}
          onConnectors={() => { setSheet(false); router.push('/connectors'); }} />
      )}
    </div>
  );
}

// ── mobile bottom tab bar ────────────────────────────────────────────────────
// Four primary destinations + More. Each tab must exist in the perm-filtered nav
// (`flat`) to render, so gating stays identical to the rail.
const MOBILE_TABS = [
  { route: '/',            label: 'Home'  },
  { route: '/live',        label: 'Live'  },
  { route: '/performance', label: 'Sales' },
  { route: '/pnl',         label: 'P&L'   },
];

function MobileTabBar({ flat, active, moreOpen, onGo, onMore }) {
  const tabs = MOBILE_TABS.map(t => ({ ...t, it: flat.find(i => i.route === t.route) })).filter(t => t.it);
  return (
    <nav className="so-tabbar">
      {tabs.map(t => {
        const Icon = t.it.icon;
        const on = !moreOpen && active(t.route);
        return (
          <button key={t.route} className={`so-tab${on ? ' active' : ''}`} onClick={() => onGo(t.it.to || t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flex: 'none' }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`so-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flex: 'none' }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ groups, active, user, P, signOut, onGo, onClose, onConnectors }) {
  return (
    <div className="so-sheetwrap" onMouseDown={onClose}>
      <div className="so-sheet" onMouseDown={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flex: 'none', borderRadius: 11, background: 'var(--accent-grad)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--cond)', fontWeight: 800, color: 'var(--accent-fg)', fontSize: 14 }}>
            {(user?.full_name || user?.email || '?').trim().charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.full_name || user?.email}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t4)' }}>
              {P.salesops_super_admin ? 'salesops · super admin' : P.salesops_admin ? 'salesops · admin' : 'salesops'}
            </div>
          </div>
          <button className="so-btn bare" onClick={signOut} title="Sign out" style={{ display: 'flex', padding: 6, borderRadius: 8 }}>
            <LogOut size={18} strokeWidth={1.75} style={{ color: 'var(--t3)' }} />
          </button>
          <button className="so-btn bare" onClick={onClose} title="Close" style={{ display: 'flex', padding: 6, borderRadius: 8 }}>
            <X size={19} strokeWidth={1.75} style={{ color: 'var(--t2)' }} />
          </button>
        </div>

        {groups.map(g => (
          <div key={g.label} style={{ marginBottom: 14 }}>
            <div className="so-navgroup" style={{ margin: 0, padding: '0 2px 7px' }}>{g.label}</div>
            <div className="so-sheet-grid">
              {g.items.map(it => {
                const Icon = it.icon;
                return (
                  <button key={it.route} className={`so-sheet-item${active(it.route) ? ' active' : ''}`}
                    onClick={() => onGo(it.to || it.route)}>
                    <Icon size={17} strokeWidth={1.75} style={{ flex: 'none' }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div style={{ margin: '0 -14px' }}>
          <FreshnessCard onClick={onConnectors} />
        </div>
      </div>
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
    <span className="so-clock" style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono)', fontSize: 10.5,
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
  // Health = "is this feed actually behind", via the SAME `feedStatus` the per-page chip uses —
  // never `!last_error`, which reported the last poll's luck rather than the data's age and flipped
  // this card amber for transient upstream blips that had already self-healed. See freshness.js.
  const healthy = enabled.filter(f => feedStatus(f) === 'ok').length;
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
