'use client';
// Manifest "Pit Wall" — single-page screen switcher shell.
import React, { useEffect, useState } from 'react';
import { Sidebar, Topbar, Tweaks } from './Chrome.js';
import { Drawer } from './Drawer.js';
import { SCREENS } from './screens.js';
import { ACCENTS } from './nav.js';

const DENSITY = {
  comfortable: { '--gap': '16px', '--cardpad': '18px 20px', '--rowpy': '11px' },
  compact:     { '--gap': '11px', '--cardpad': '14px 16px', '--rowpy': '7px' },
};

const ls = (k, fallback) => {
  if (typeof window === 'undefined') return fallback;
  try { const v = window.localStorage.getItem(k); return v == null ? fallback : v; } catch { return fallback; }
};

export default function ManifestApp() {
  const [screen, setScreen] = useState('dashboard');
  const [collapsed, setCollapsed] = useState(false);
  const [drill, setDrill] = useState(null);
  const [accent, setAccent] = useState('#F2CD1A');
  const [density, setDensity] = useState('comfortable');
  const [hydrated, setHydrated] = useState(false);

  // hydrate from localStorage after mount (static export = client render)
  useEffect(() => {
    setScreen(ls('mf_screen', 'dashboard'));
    setCollapsed(ls('mf_sb', '0') === '1');
    setAccent(ACCENTS.includes(ls('mf_accent', '')) ? ls('mf_accent', '#F2CD1A') : '#F2CD1A');
    setDensity(ls('mf_density', 'comfortable') === 'compact' ? 'compact' : 'comfortable');
    setHydrated(true);
  }, []);

  const persist = (k, v) => { try { window.localStorage.setItem(k, v); } catch {} };
  const nav = (s) => { setDrill(null); setScreen(s); persist('mf_screen', s); };
  const toggle = () => setCollapsed((c) => { persist('mf_sb', c ? '0' : '1'); return !c; });
  const chooseAccent = (c) => { setAccent(c); persist('mf_accent', c); };
  const chooseDensity = (d) => { setDensity(d); persist('mf_density', d); };

  const Screen = SCREENS[screen] || SCREENS.dashboard;
  const themeVars = { '--accent': accent, ...DENSITY[density] };

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden', ...themeVars, visibility: hydrated ? 'visible' : 'hidden' }}>
      <Sidebar collapsed={collapsed} onToggle={toggle} screen={screen} onNav={nav} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <Topbar screen={screen} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 60px' }}>
          <Screen onNav={nav} openDrill={setDrill} />
        </main>
      </div>
      {drill && <Drawer entry={drill} onClose={() => setDrill(null)} onNav={nav} />}
      <Tweaks accent={accent} setAccent={chooseAccent} density={density} setDensity={chooseDensity} />
    </div>
  );
}
