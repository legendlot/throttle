'use client';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, AppLauncher } from '@throttle/ui';
import { LayoutDashboard, Receipt, Store, Boxes, Megaphone, Filter, GitMerge, PlugZap, Upload, ShieldCheck, LogOut, ChevronDown, ChevronRight, Landmark, Gauge, PackageSearch } from 'lucide-react';
import { FAMILY_ORDER, FAMILIES } from '../../lib/families.js';
import { FreshnessProvider, FreshnessChip } from '../../components/Freshness.js';

const CHANNEL_CHILDREN = FAMILY_ORDER.map(k => ({ route: `/channels/${k}`, label: FAMILIES[k].label }));
const PRODUCT_CHILDREN = [{ route: '/products/drr', label: 'DRR' }, { route: '/products/pnl', label: 'P&L' }];
const PNL_CHILDREN = [{ route: '/pnl/overall', label: 'Overall' }, ...FAMILY_ORDER.map(k => ({ route: `/pnl/${k}`, label: FAMILIES[k].label }))];

const NAV = [
  { route: '/',            label: 'Dashboard',   icon: LayoutDashboard, perm: 'sales_view' },
  { route: '/performance', label: 'Performance', icon: Receipt,         perm: 'sales_view' },
  { group: 'channels',     base: '/channels',    label: 'Channels',    icon: Store,     perm: 'sales_view', children: CHANNEL_CHILDREN },
  { group: 'products',     base: '/products',    label: 'Products',    icon: Boxes,     perm: 'sales_view', children: PRODUCT_CHILDREN },
  { group: 'pnl',          base: '/pnl',         label: 'P&L',         icon: Landmark,  perm: 'sales_view', children: PNL_CHILDREN },
  { route: '/marketing',   label: 'Marketing',   icon: Megaphone,       perm: 'sales_view' },
  { route: '/dyno',        label: 'Dyno',        icon: Gauge,           perm: 'sales_view' },
  { route: '/funnel',      label: 'Funnel',      icon: Filter,          perm: 'sales_view' },
  { route: '/inventory',   label: 'Inventory',   icon: PackageSearch,   perm: 'sales_view' },
  { route: '/mapping',     label: 'Mapping',     icon: GitMerge,        perm: 'sales_view' },
  { route: '/connectors',  label: 'Connectors',  icon: PlugZap,         perm: 'sales_view' },
  { route: '/uploads',     label: 'Uploads',     icon: Upload,          perm: 'sales_upload', adminAlt: 'salesops_admin' },
  { route: '/admin',       label: 'Admin',       icon: ShieldCheck,     perm: 'salesops_admin' },
];

export default function AuthLayout({ children }) {
  return <RequireAuth><FreshnessProvider><Shell>{children}</Shell></FreshnessProvider></RequireAuth>;
}

function Shell({ children }) {
  const { user, perms, signOut, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [openGroups, setOpenGroups] = useState({});
  if (loading && !user) return <Spinner />;
  const P = perms || {};
  const can = (item) => !!P[item.perm] || !!P.salesops_admin || (item.adminAlt && !!P[item.adminAlt]);
  const items = NAV.filter(can);
  const active = (route) => route === '/' ? pathname === '/' : (pathname === route || pathname.startsWith(route + '/'));
  const title = NAV.flatMap(n => n.children ? n.children : [n]).find(n => active(n.route))?.label
    || NAV.find(n => n.children && pathname.startsWith(n.base))?.label || 'Odo';

  return (
    <div className="so-app">
      <aside className="so-side">
        <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', borderBottom: '1px solid var(--border)' }}>
          <img src="/favicon.svg" alt="Odo" style={{ width: 28, height: 28, borderRadius: 7 }} />
          <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.08em', fontSize: 15, color: 'var(--t1)' }}>ODO</div>
        </div>
        <nav style={{ flex: 1, padding: '10px 0', overflowY: 'auto' }}>
          {items.map(it => {
            const Icon = it.icon;
            if (it.children) {
              const gActive = pathname.startsWith(it.base);
              const expanded = openGroups[it.group] ?? gActive;   // auto-open the active group
              return (
                <div key={it.group}>
                  <div className={`so-nav${gActive ? ' active' : ''}`} onClick={() => setOpenGroups(g => ({ ...g, [it.group]: !(g[it.group] ?? gActive) }))} style={{ justifyContent: 'space-between' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}><Icon size={16} /> {it.label}</span>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </div>
                  {expanded && it.children.map(c => (
                    <div key={c.route} className={`so-nav${active(c.route) ? ' active' : ''}`}
                      onClick={() => router.push(c.route)}
                      style={{ paddingLeft: 39, fontSize: 12.5 }}>
                      {c.label}
                    </div>
                  ))}
                </div>
              );
            }
            return (
              <div key={it.route} className={`so-nav${active(it.route) ? ' active' : ''}`} onClick={() => router.push(it.route)}>
                <Icon size={16} /> {it.label}
              </div>
            );
          })}
        </nav>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name || user?.email}</div>
          <button className="so-btn ghost" onClick={signOut} style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'center' }}><LogOut size={13} /> Sign out</button>
        </div>
      </aside>
      <div className="so-main">
        <header style={{ height: 56, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', flexShrink: 0 }}>
          <div style={{ fontFamily: 'var(--cond)', fontWeight: 600, fontSize: 16, letterSpacing: '0.04em', color: 'var(--t1)' }}>{title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <FreshnessChip />
            <AppLauncher current="odo" />
          </div>
        </header>
        <div className="so-scroll">{children}</div>
      </div>
    </div>
  );
}
