'use client';
import { usePathname, useRouter } from 'next/navigation';

// Board | Matrix tab bar — shared by the operational board (/dyno) and the strategic
// coverage matrix (/dyno/matrix). Router-driven so each tab is its own route; the sidebar
// "Dyno" item stays active on both (layout active() uses startsWith).
export function DynoTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const active = pathname.startsWith('/dyno/matrix') ? 'matrix' : 'board';
  return (
    <div className="so-seg" style={{ marginBottom: 14 }}>
      <button className={active === 'board' ? 'on' : ''} onClick={() => router.push('/dyno')}
        style={{ padding: '6px 15px', fontSize: 12.5 }}>Board</button>
      <button className={active === 'matrix' ? 'on' : ''} onClick={() => router.push('/dyno/matrix')}
        style={{ padding: '6px 15px', fontSize: 12.5 }}>Matrix</button>
    </div>
  );
}
