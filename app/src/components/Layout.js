'use client';
import { useAuth } from '@/lib/auth';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect } from 'react';

const NAV_ITEMS = [
  { label: 'Requests',  href: '/requests/',  roles: ['requester', 'member', 'lead', 'admin'] },
  { label: 'Board',     href: '/board/',      roles: ['member', 'lead', 'admin'] },
  { label: 'Sprints',   href: '/sprints/',    roles: ['lead', 'admin'] },
  { label: 'Dashboard', href: '/dashboard/',  roles: ['lead', 'admin'] },
  { label: 'Settings',  href: '/settings/',   roles: ['admin'] },
];

function ThrottleLogo() {
  const cells = [1,0,1,0, 0,1,0,1, 1,0,1,0, 0,1,0,1];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 5px)', gap: 0, flexShrink: 0 }}>
        {cells.map((v, i) => (
          <div key={i} style={{ width: 5, height: 5, background: v ? '#F2CD1A' : '#1e1e1e' }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 12, letterSpacing: '.25em', color: '#F2CD1A', textTransform: 'uppercase', lineHeight: 1 }}>
          Throttle
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '.3em', color: 'var(--t3)', textTransform: 'uppercase' }}>
          Brand OS
        </span>
      </div>
    </div>
  );
}

export default function Layout({ children }) {
  const { session, brandUser, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !session) router.replace('/login/');
  }, [session, loading, router]);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.2em', textTransform: 'uppercase' }}>
        Loading...
      </span>
    </div>
  );

  if (!brandUser) return null;

  const visibleNav = NAV_ITEMS.filter(item => item.roles.includes(brandUser.role));

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Top nav */}
      <header style={{
        borderBottom: '1px solid var(--b1)',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        height: 48,
        background: 'var(--s1)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        <ThrottleLogo />

        {/* Separator */}
        <div style={{ width: 1, height: 24, background: 'var(--b1)', margin: '0 16px' }} />

        {/* Nav */}
        <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {visibleNav.map(item => {
            const isActive = pathname?.startsWith(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  textDecoration: 'none',
                  padding: '4px 10px',
                  borderRadius: 4,
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'all .15s',
                  background: isActive ? '#F2CD1A' : 'transparent',
                  color: isActive ? '#080808' : 'var(--t3)',
                  fontWeight: isActive ? 700 : 400,
                }}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* Right side */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '.08em' }}>
            {brandUser.name}
          </span>
          <span style={{
            fontSize: 9,
            background: 'var(--s3)',
            color: 'var(--t2)',
            padding: '2px 7px',
            borderRadius: 3,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            fontFamily: 'var(--mono)',
          }}>
            {brandUser.role}
          </span>
          <button
            onClick={signOut}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--t3)',
              background: 'none',
              border: '1px solid var(--b1)',
              borderRadius: 4,
              padding: '3px 8px',
              cursor: 'pointer',
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              transition: 'all .15s',
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Page content */}
      <main style={{ padding: '24px 20px' }}>
        {children}
      </main>
    </div>
  );
}
