'use client';
import { usePathname, useRouter } from 'next/navigation';

// Segmented tab nav across the three admin routes (Roles & Permissions / Users /
// Spaces). The 3 routes are kept; this just presents them as one control per the
// redesign. The page title ("Admin") comes from the topbar.
const TABS = [
  { route: '/admin/roles', label: 'Roles & Permissions' },
  { route: '/admin/users', label: 'Users' },
  { route: '/admin/spaces', label: 'Spaces' },
];

export function AdminTabs() {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div className="seg admin-tabs">
      {TABS.map(t => {
        const active = pathname === t.route || pathname.startsWith(t.route + '/');
        return (
          <button key={t.route} className={active ? 'on' : ''} onClick={() => router.push(t.route)}>{t.label}</button>
        );
      })}
    </div>
  );
}

export default AdminTabs;
