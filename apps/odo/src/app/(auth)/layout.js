'use client';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, AppLauncher } from '@throttle/ui';
import { LayoutDashboard, Megaphone, Filter, GitMerge, PlugZap, Upload, ShieldCheck, LogOut } from 'lucide-react';

const NAV = [
  { route: '/',           label: 'Dashboard',  icon: LayoutDashboard, perm: 'sales_view' },
  { route: '/marketing',  label: 'Marketing',  icon: Megaphone,       perm: 'sales_view' },
  { route: '/funnel',     label: 'Funnel',     icon: Filter,          perm: 'sales_view' },
  { route: '/mapping',    label: 'Mapping',    icon: GitMerge,        perm: 'sales_view' },
  { route: '/connectors', label: 'Connectors', icon: PlugZap,         perm: 'sales_view' },
  { route: '/uploads',    label: 'Uploads',    icon: Upload,          perm: 'sales_upload', adminAlt: 'salesops_admin' },
  { route: '/admin',      label: 'Admin',      icon: ShieldCheck,     perm: 'salesops_admin' },
];

export default function AuthLayout({ children }) {
  return <RequireAuth><Shell>{children}</Shell></RequireAuth>;
}

function Shell({ children }) {
  const { user, perms, signOut, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  if (loading && !user) return <Spinner />;
  const P = perms || {};
  const can = (item) => !!P[item.perm] || !!P.salesops_admin || (item.adminAlt && !!P[item.adminAlt]);
  const items = NAV.filter(can);
  const active = (route) => route === '/' ? pathname === '/' : (pathname === route || pathname.startsWith(route + '/'));
  const title = (NAV.find(n => active(n.route)) || {}).label || 'Odo';

  return (
    <div className="so-app">
      <aside className="so-side">
        <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', borderBottom: '1px solid var(--border)' }}>
          <img src="/favicon.svg" alt="Odo" style={{ width: 28, height: 28, borderRadius: 7 }} />
          <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.08em', fontSize: 15, color: 'var(--t1)' }}>ODO</div>
        </div>
        <nav style={{ flex: 1, padding: '10px 0' }}>
          {items.map(it => {
            const Icon = it.icon;
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
          <AppLauncher current="odo" />
        </header>
        <div className="so-scroll">{children}</div>
      </div>
    </div>
  );
}
