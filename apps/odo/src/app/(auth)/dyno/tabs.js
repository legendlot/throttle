'use client';
import { usePathname, useRouter } from 'next/navigation';

// Board | Screen | Scaling | Matrix tab bar — shared by the operational boards (/dyno, /dyno/screen,
// /dyno/scaling) and the strategic coverage matrix (/dyno/matrix). Router-driven so each tab is its
// own route; the sidebar "Dyno" item stays active on all of them (layout active() uses startsWith).
// /dyno IS the Board — the default landing tab.
const TABS = [
  { key: 'board',   label: 'Board',   href: '/dyno' },
  { key: 'screen',  label: 'Screen',  href: '/dyno/screen', tip: 'Gate 1 — the cheap ATC screen (CTR · CPATC · CBO spend-share)' },
  { key: 'scaling', label: 'Scaling', href: '/dyno/scaling' },
  { key: 'matrix',  label: 'Matrix',  href: '/dyno/matrix' },
];

export function DynoTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const active = pathname.startsWith('/dyno/matrix') ? 'matrix'
    : pathname.startsWith('/dyno/scaling') ? 'scaling'
    : pathname.startsWith('/dyno/screen') ? 'screen' : 'board';
  return (
    <div className="so-seg" style={{ alignSelf: 'flex-start' }}>
      {TABS.map(t => (
        <button key={t.key} className={active === t.key ? 'on' : ''} onClick={() => router.push(t.href)}
          title={t.tip} style={{ padding: '6px 15px', fontSize: 12 }}>{t.label}</button>
      ))}
    </div>
  );
}
