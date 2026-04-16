'use client';
import { useAuth } from '@/lib/auth';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect } from 'react';

const NAV_ITEMS = [
  { label: 'Requests', href: '/requests/', roles: ['requester', 'member', 'lead', 'admin'] },
  { label: 'Board', href: '/board/', roles: ['member', 'lead', 'admin'] },
  { label: 'Sprints', href: '/sprints/', roles: ['lead', 'admin'] },
  { label: 'Dashboard', href: '/dashboard/', roles: ['lead', 'admin'] },
  { label: 'Settings', href: '/settings/', roles: ['admin'] },
];

export default function Layout({ children }) {
  const { session, brandUser, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !session) router.replace('/login/');
  }, [session, loading, router]);

  if (loading) return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <p className="text-zinc-600 text-sm">Loading...</p>
    </div>
  );

  if (!brandUser) return null;

  const visibleNav = NAV_ITEMS.filter(item => item.roles.includes(brandUser.role));

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Top nav */}
      <header className="border-b border-zinc-800 px-6 py-0 flex items-center justify-between h-12">
        <div className="flex items-center gap-8">
          <span className="text-white font-bold text-sm tracking-widest uppercase">
            Throttle
          </span>
          <nav className="flex items-center gap-1">
            {visibleNav.map(item => (
              <a
                key={item.href}
                href={item.href}
                className={`px-3 py-3 text-xs font-medium transition-colors border-b-2 ${
                  pathname?.startsWith(item.href)
                    ? 'text-white border-white'
                    : 'text-zinc-500 border-transparent hover:text-zinc-300'
                }`}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-zinc-500 text-xs">{brandUser.name}</span>
          <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
            {brandUser.role}
          </span>
          <button
            onClick={signOut}
            className="text-zinc-600 text-xs hover:text-zinc-400 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Page content */}
      <main className="px-6 py-6">
        {children}
      </main>
    </div>
  );
}
